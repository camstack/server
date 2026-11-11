import { errMsg, type IScopedLogger } from '@camstack/types'
import type {
  AdoptionFilter,
  AdoptionStatus,
  DeviceType,
  DiscoveredChildDevice,
  IDeviceAdoptionProvider,
} from '@camstack/types'
import { planHomeComAdoption, type HomeComAdoptedRow } from './homecom-adoption-plan.js'
import { buildHomeComCandidates, homeComDeviceType } from './homecom-discovery.js'
import type { HomeComDiscoverableDevice } from './homecom-gateway.js'

export interface HomeComAdoptionRegistry {
  discoverables(integrationId: string): readonly HomeComDiscoverableDevice[]
  has(integrationId: string): boolean
}

export interface HomeComAdoptionProviderDeps {
  readonly registry: HomeComAdoptionRegistry
  readonly hasIntegration: (integrationId: string) => boolean
  readonly listIntegrations: () => readonly string[]
  readonly listAdopted: () => Promise<
    ReadonlyArray<HomeComAdoptedRow & { readonly config: Record<string, unknown> }>
  >
  readonly adoptDevice: (input: {
    readonly nativeId: string
    readonly integrationId: string
    readonly type: DeviceType
    readonly name: string
    readonly kind: 'heating-circuit' | 'dhw' | 'heat-pump' | 'gateway'
    readonly circuitId?: string
    readonly parentDeviceId: number | null
  }) => Promise<{ readonly deviceId: number }>
  readonly removeDevice: (camDeviceId: number) => Promise<void>
  readonly findDeviceConfig: (camDeviceId: number) => Promise<Record<string, unknown> | null>
  readonly logger: IScopedLogger
}

const DEVICES_FILTER: AdoptionFilter = { id: 'devices', label: 'Devices', isDefault: true } as const

const STAYED_TOP_LEVEL =
  'HomeCom device stayed top-level: it was already adopted, so it was not created again under the heat pump'

const ALREADY_PRESENT =
  'HomeCom device was not created again: a device with this stable id already exists'

interface AdoptedPick {
  readonly childNativeId: string
  readonly parentDeviceId: number
  readonly accessoryDeviceIds: readonly number[]
}

type AdoptOneResult =
  | {
      readonly ok: true
      readonly parentDeviceId: number
      readonly accessoryDeviceIds: readonly number[]
    }
  | { readonly ok: false }

interface AdoptOneInput {
  readonly dev: HomeComDiscoverableDevice
  readonly integrationId: string
  readonly name: string
  readonly known: readonly HomeComAdoptedRow[]
  readonly adoptDevice: HomeComAdoptionProviderDeps['adoptDevice']
  readonly logger: IScopedLogger
  readonly logOnce: (deviceId: number, message: string) => void
}

async function adoptOne(input: AdoptOneInput): Promise<AdoptOneResult> {
  const { dev, integrationId, name, known, adoptDevice, logger, logOnce } = input
  const plan = planHomeComAdoption(dev, integrationId, known)
  for (const skip of plan.stayedTopLevel) logOnce(skip.deviceId, STAYED_TOP_LEVEL)
  for (const skip of plan.alreadyPresent) logOnce(skip.deviceId, ALREADY_PRESENT)
  const root = plan.create[0]
  if (root === undefined) return { ok: false }
  let parentDeviceId: number
  try {
    const created = await adoptDevice({
      nativeId: root.nativeId,
      integrationId,
      type: homeComDeviceType(root.kind),
      name,
      kind: root.kind,
      ...(root.circuitId === undefined ? {} : { circuitId: root.circuitId }),
      parentDeviceId: null,
    })
    parentDeviceId = created.deviceId
  } catch (err: unknown) {
    logger.warn('homecom adopt failed', {
      meta: { nativeId: root.nativeId, integrationId, error: errMsg(err) },
    })
    return { ok: false }
  }
  const accessoryDeviceIds: number[] = []
  for (const child of plan.create.slice(1)) {
    try {
      const created = await adoptDevice({
        nativeId: child.nativeId,
        integrationId,
        type: homeComDeviceType(child.kind),
        name: child.name,
        kind: child.kind,
        ...(child.circuitId === undefined ? {} : { circuitId: child.circuitId }),
        parentDeviceId,
      })
      accessoryDeviceIds.push(created.deviceId)
    } catch (err: unknown) {
      logger.warn('homecom adopt child failed', {
        tags: { deviceId: parentDeviceId },
        meta: { nativeId: child.nativeId, integrationId, error: errMsg(err) },
      })
    }
  }
  return { ok: true, parentDeviceId, accessoryDeviceIds }
}

async function adoptedMapForIntegration(
  integrationId: string,
  listAdopted: HomeComAdoptionProviderDeps['listAdopted'],
): Promise<ReadonlyMap<string, number>> {
  const all = await listAdopted()
  const map = new Map<string, number>()
  for (const device of all) {
    if (device.config['system'] === 'homecom' && device.config['brokerId'] === integrationId) {
      const nativeId = device.config['nativeId']
      if (typeof nativeId === 'string') map.set(nativeId, device.id)
    }
  }
  return map
}

export function buildHomeComAdoptionProvider(
  deps: HomeComAdoptionProviderDeps,
): IDeviceAdoptionProvider {
  const {
    registry,
    hasIntegration,
    listIntegrations,
    listAdopted,
    adoptDevice,
    removeDevice,
    findDeviceConfig,
    logger,
  } = deps
  const logged = new Set<number>()
  const logOnce = (deviceId: number, message: string): void => {
    if (logged.has(deviceId)) return
    logged.add(deviceId)
    logger.info(message, { tags: { deviceId } })
  }

  async function allCandidatesForIntegration(
    integrationId: string,
  ): Promise<DiscoveredChildDevice[]> {
    const devices = registry.discoverables(integrationId)
    const adopted = await adoptedMapForIntegration(integrationId, listAdopted)
    return buildHomeComCandidates({ devices, adopted })
  }

  return {
    listCandidateFilters: async () => ({ filters: [DEVICES_FILTER] }),

    listCandidates: async ({ integrationId, page, pageSize }) => {
      const cands = await allCandidatesForIntegration(integrationId)
      const start = (page - 1) * pageSize
      return {
        candidates: cands.slice(start, start + pageSize),
        totalCount: cands.length,
        page,
        pageSize,
      }
    },

    getCandidate: async ({ integrationId, childNativeId }) => {
      const cands = await allCandidatesForIntegration(integrationId)
      return cands.find((c) => c.childNativeId === childNativeId) ?? null
    },

    getStatus: async () => {
      try {
        let candidateCount = 0
        for (const integrationId of listIntegrations()) {
          candidateCount += (await allCandidatesForIntegration(integrationId)).length
        }
        const adoptedCount = (await listAdopted()).filter(
          (d) => d.config['system'] === 'homecom',
        ).length
        return {
          lastDiscoveryAt: Date.now(),
          candidateCount,
          adoptedCount,
          lastError: null,
        } satisfies AdoptionStatus
      } catch (err: unknown) {
        return {
          lastDiscoveryAt: null,
          candidateCount: 0,
          adoptedCount: 0,
          lastError: errMsg(err),
        } satisfies AdoptionStatus
      }
    },

    refresh: async ({ integrationId }) => {
      const candidateCount = (await allCandidatesForIntegration(integrationId)).length
      const adoptedCount = (await adoptedMapForIntegration(integrationId, listAdopted)).size
      return {
        lastDiscoveryAt: Date.now(),
        candidateCount,
        adoptedCount,
        lastError: null,
      } satisfies AdoptionStatus
    },

    adopt: async ({ integrationId, childNativeIds, perCandidate }) => {
      if (!registry.has(integrationId)) {
        throw new Error(`homecom adopt: integration ${integrationId} not connected`)
      }
      const devices = registry.discoverables(integrationId)
      const known = await listAdopted()
      const adopted: AdoptedPick[] = []
      let failures = 0

      for (const nativeId of childNativeIds) {
        const dev = devices.find((d) => d.nativeId === nativeId)
        if (!dev) {
          failures++
          continue
        }
        const outcome = await adoptOne({
          dev,
          integrationId,
          name: perCandidate?.[nativeId]?.name ?? dev.name,
          known,
          adoptDevice,
          logger,
          logOnce,
        })
        if (!outcome.ok) {
          failures++
          continue
        }
        adopted.push({
          childNativeId: nativeId,
          parentDeviceId: outcome.parentDeviceId,
          accessoryDeviceIds: outcome.accessoryDeviceIds,
        })
      }

      if (adopted.length === 0 && failures > 0) {
        throw new Error(`homecom adopt: all ${failures} adopt(s) failed`)
      }
      return { adopted }
    },

    release: async ({ camDeviceId }) => {
      await removeDevice(camDeviceId)
    },

    resync: async ({ camDeviceId }) => {
      const cfg = await findDeviceConfig(camDeviceId)
      if (!cfg || cfg['system'] !== 'homecom') {
        throw new Error(`homecom resync: device ${camDeviceId} not found`)
      }
      const integrationId = String(cfg['brokerId'])
      const nativeId = String(cfg['nativeId'])
      if (!hasIntegration(integrationId)) {
        throw new Error(`homecom resync: integration ${integrationId} not connected`)
      }
      const present = registry.discoverables(integrationId).some((d) => d.nativeId === nativeId)
      if (!present) {
        throw new Error(`homecom resync: device ${nativeId} no longer present`)
      }
      return { changed: false, rebuiltChildren: 0 }
    },
  }
}
