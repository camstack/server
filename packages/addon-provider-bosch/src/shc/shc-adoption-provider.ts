import { errMsg, type IScopedLogger } from '@camstack/types'
import type {
  AdoptionFilter,
  AdoptionStatus,
  DiscoveredChildDevice,
  DeviceType,
  IDeviceAdoptionProvider,
} from '@camstack/types'
import { buildShcCandidates } from './shc-discovery.js'
import { classifyShcDevice, deviceTypeForShcKind } from './shc-domain-mapping.js'
import type { ShcDeviceSummary } from './shc-types.js'

export interface ShcAdoptionRegistry {
  devices(integrationId: string): readonly ShcDeviceSummary[]
  has(integrationId: string): boolean
}

export interface ShcAdoptionProviderDeps {
  readonly registry: ShcAdoptionRegistry
  readonly hasIntegration: (integrationId: string) => boolean
  readonly listIntegrations: () => readonly string[]
  readonly listAdoptedShc: () => Promise<
    ReadonlyArray<{ readonly id: number; readonly config: Record<string, unknown> }>
  >
  readonly adoptDevice: (input: {
    readonly shcDeviceId: string
    readonly integrationId: string
    readonly type: DeviceType
    readonly name: string
    readonly deviceModel: string
  }) => Promise<{ readonly deviceId: number }>
  readonly removeDevice: (camDeviceId: number) => Promise<void>
  readonly findDeviceConfig: (camDeviceId: number) => Promise<Record<string, unknown> | null>
  readonly logger: IScopedLogger
}

const DEVICES_FILTER: AdoptionFilter = { id: 'devices', label: 'Devices', isDefault: true } as const

async function adoptedMapForIntegration(
  integrationId: string,
  listAdoptedShc: ShcAdoptionProviderDeps['listAdoptedShc'],
): Promise<ReadonlyMap<string, number>> {
  const all = await listAdoptedShc()
  const map = new Map<string, number>()
  for (const device of all) {
    if (device.config['system'] === 'bosch-shc' && device.config['brokerId'] === integrationId) {
      const shcId = device.config['shcDeviceId']
      if (typeof shcId === 'string') map.set(shcId, device.id)
    }
  }
  return map
}

export function buildShcAdoptionProvider(deps: ShcAdoptionProviderDeps): IDeviceAdoptionProvider {
  const {
    registry,
    hasIntegration,
    listIntegrations,
    listAdoptedShc,
    adoptDevice,
    removeDevice,
    findDeviceConfig,
    logger,
  } = deps

  async function allCandidatesForIntegration(
    integrationId: string,
  ): Promise<DiscoveredChildDevice[]> {
    const devices = registry.devices(integrationId)
    const adopted = await adoptedMapForIntegration(integrationId, listAdoptedShc)
    return buildShcCandidates({ devices, adopted })
  }

  return {
    listCandidateFilters: async () => ({ filters: [DEVICES_FILTER] }),

    listCandidates: async ({ integrationId, page, pageSize, filterText }) => {
      let filtered = await allCandidatesForIntegration(integrationId)
      if (filterText?.search) {
        const lower = filterText.search.toLowerCase()
        filtered = filtered.filter(
          (c) =>
            c.name.toLowerCase().includes(lower) ||
            (c.metadata.model?.toLowerCase().includes(lower) ?? false) ||
            c.childNativeId.toLowerCase().includes(lower),
        )
      }
      if (filterText?.adoptedOnly === true) filtered = filtered.filter((c) => c.alreadyAdopted)
      if (filterText?.unadoptedOnly === true) filtered = filtered.filter((c) => !c.alreadyAdopted)
      const start = (page - 1) * pageSize
      return {
        candidates: filtered.slice(start, start + pageSize),
        totalCount: filtered.length,
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
        const allAdopted = await listAdoptedShc()
        const adoptedCount = allAdopted.filter((d) => d.config['system'] === 'bosch-shc').length
        return {
          lastDiscoveryAt: Date.now(),
          candidateCount,
          adoptedCount,
          lastError: null,
        } satisfies AdoptionStatus
      } catch (err: unknown) {
        logger.warn('bosch-shc adoption: getStatus failed', { meta: { error: errMsg(err) } })
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
      const adoptedCount = (await adoptedMapForIntegration(integrationId, listAdoptedShc)).size
      return {
        lastDiscoveryAt: Date.now(),
        candidateCount,
        adoptedCount,
        lastError: null,
      } satisfies AdoptionStatus
    },

    adopt: async ({ integrationId, childNativeIds, perCandidate }) => {
      if (!registry.has(integrationId)) {
        throw new Error(`bosch-shc adopt: integration ${integrationId} not connected`)
      }
      const devices = registry.devices(integrationId)
      const adopted: {
        readonly childNativeId: string
        readonly parentDeviceId: number
        readonly accessoryDeviceIds: readonly number[]
      }[] = []
      let failures = 0

      for (const shcDeviceId of childNativeIds) {
        try {
          const dev = devices.find((d) => d.id === shcDeviceId)
          if (dev === undefined) {
            failures++
            continue
          }
          const kind = classifyShcDevice(dev)
          if (kind === 'unsupported') {
            failures++
            continue
          }
          const name = perCandidate?.[shcDeviceId]?.name ?? dev.name
          const { deviceId } = await adoptDevice({
            shcDeviceId,
            integrationId,
            type: deviceTypeForShcKind(kind),
            name,
            deviceModel: dev.deviceModel,
          })
          adopted.push({
            childNativeId: shcDeviceId,
            parentDeviceId: deviceId,
            accessoryDeviceIds: [],
          })
        } catch (err: unknown) {
          logger.warn('bosch-shc adopt: failed', {
            meta: { shcDeviceId, integrationId, error: errMsg(err) },
          })
          failures++
        }
      }

      if (adopted.length === 0 && failures > 0) {
        throw new Error(`bosch-shc adopt: all ${failures} adopt(s) failed`)
      }
      return { adopted }
    },

    release: async ({ camDeviceId }) => {
      await removeDevice(camDeviceId)
    },

    resync: async ({ camDeviceId }) => {
      const cfg = await findDeviceConfig(camDeviceId)
      if (cfg === null) throw new Error(`bosch-shc resync: device ${camDeviceId} not found`)
      if (cfg['system'] !== 'bosch-shc') {
        throw new Error(`bosch-shc resync: device ${camDeviceId} is not SHC`)
      }
      const integrationId = String(cfg['brokerId'])
      const shcDeviceId = String(cfg['shcDeviceId'])
      if (!hasIntegration(integrationId)) {
        throw new Error(`bosch-shc resync: integration ${integrationId} not connected`)
      }
      const present = registry.devices(integrationId).some((d) => d.id === shcDeviceId)
      if (!present) {
        throw new Error(`bosch-shc resync: device ${shcDeviceId} no longer on integration`)
      }
      return { changed: false, rebuiltChildren: 0 }
    },
  }
}
