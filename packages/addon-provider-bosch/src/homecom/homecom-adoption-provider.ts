import { errMsg, type IScopedLogger } from '@camstack/types'
import type {
  AdoptionFilter,
  AdoptionStatus,
  DeviceType,
  DiscoveredChildDevice,
  IDeviceAdoptionProvider,
} from '@camstack/types'
import { buildHomeComCandidates } from './homecom-discovery.js'
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
    ReadonlyArray<{ readonly id: number; readonly config: Record<string, unknown> }>
  >
  readonly adoptDevice: (input: {
    readonly nativeId: string
    readonly integrationId: string
    readonly type: DeviceType
    readonly name: string
    readonly kind: 'heating-circuit' | 'dhw'
    readonly circuitId?: string
  }) => Promise<{ readonly deviceId: number }>
  readonly removeDevice: (camDeviceId: number) => Promise<void>
  readonly findDeviceConfig: (camDeviceId: number) => Promise<Record<string, unknown> | null>
  readonly logger: IScopedLogger
}

const DEVICES_FILTER: AdoptionFilter = { id: 'devices', label: 'Devices', isDefault: true } as const

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
      const adopted: { readonly childNativeId: string; readonly parentDeviceId: number }[] = []
      let failures = 0

      for (const nativeId of childNativeIds) {
        try {
          const dev = devices.find((d) => d.nativeId === nativeId)
          if (!dev) {
            failures++
            continue
          }
          const candidate = buildHomeComCandidates({ devices: [dev], adopted: new Map() })[0]
          if (!candidate) {
            failures++
            continue
          }
          const name = perCandidate?.[nativeId]?.name ?? dev.name
          const { deviceId } = await adoptDevice({
            nativeId,
            integrationId,
            type: candidate.type,
            name,
            kind: dev.kind,
            circuitId: dev.circuitId,
          })
          adopted.push({ childNativeId: nativeId, parentDeviceId: deviceId })
        } catch (err: unknown) {
          logger.warn('homecom adopt failed', {
            meta: { nativeId, integrationId, error: errMsg(err) },
          })
          failures++
        }
      }

      if (adopted.length === 0 && failures > 0) {
        throw new Error(`homecom adopt: all ${failures} adopt(s) failed`)
      }
      return { adopted: adopted.map((a) => ({ ...a, accessoryDeviceIds: [] as const })) }
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
