import { errMsg, type IScopedLogger } from '@camstack/types'
import type {
  AdoptionFilter,
  AdoptionStatus,
  DeviceType,
  DiscoveredChildDevice,
  IDeviceAdoptionProvider,
} from '@camstack/types'
import { buildHomeConnectCandidates } from './home-connect-discovery.js'
import type { HomeConnectApplianceInfo } from './home-connect-ws-client.js'

export interface HomeConnectAdoptionRegistry {
  appliances(integrationId: string): readonly HomeConnectApplianceInfo[]
  has(integrationId: string): boolean
}

export interface HomeConnectAdoptionProviderDeps {
  readonly registry: HomeConnectAdoptionRegistry
  readonly hasIntegration: (integrationId: string) => boolean
  readonly listIntegrations: () => readonly string[]
  readonly listAdopted: () => Promise<
    ReadonlyArray<{ readonly id: number; readonly config: Record<string, unknown> }>
  >
  readonly adoptDevice: (input: {
    readonly haId: string
    readonly integrationId: string
    readonly type: DeviceType
    readonly name: string
    readonly applianceType: string
  }) => Promise<{ readonly deviceId: number }>
  readonly removeDevice: (camDeviceId: number) => Promise<void>
  readonly findDeviceConfig: (camDeviceId: number) => Promise<Record<string, unknown> | null>
  readonly logger: IScopedLogger
}

const DEVICES_FILTER: AdoptionFilter = { id: 'devices', label: 'Devices', isDefault: true } as const

async function adoptedMapForIntegration(
  integrationId: string,
  listAdopted: HomeConnectAdoptionProviderDeps['listAdopted'],
): Promise<ReadonlyMap<string, number>> {
  const all = await listAdopted()
  const map = new Map<string, number>()
  for (const device of all) {
    if (device.config['system'] === 'home-connect' && device.config['brokerId'] === integrationId) {
      const haId = device.config['haId']
      if (typeof haId === 'string') map.set(haId, device.id)
    }
  }
  return map
}

export function buildHomeConnectAdoptionProvider(
  deps: HomeConnectAdoptionProviderDeps,
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
    const appliances = registry.appliances(integrationId)
    const adopted = await adoptedMapForIntegration(integrationId, listAdopted)
    return buildHomeConnectCandidates({ appliances, adopted })
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
          (d) => d.config['system'] === 'home-connect',
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
        throw new Error(`home-connect adopt: integration ${integrationId} not connected`)
      }
      const appliances = registry.appliances(integrationId)
      const adopted: { readonly childNativeId: string; readonly parentDeviceId: number }[] = []
      let failures = 0

      for (const haId of childNativeIds) {
        try {
          const app = appliances.find((a) => a.haId === haId)
          if (!app) {
            failures++
            continue
          }
          const candidate = buildHomeConnectCandidates({
            appliances: [app],
            adopted: new Map(),
          })[0]
          if (!candidate) {
            failures++
            continue
          }
          const name = perCandidate?.[haId]?.name ?? app.name
          const { deviceId } = await adoptDevice({
            haId,
            integrationId,
            type: candidate.type,
            name,
            applianceType: app.type,
          })
          adopted.push({ childNativeId: haId, parentDeviceId: deviceId })
        } catch (err: unknown) {
          logger.warn('home-connect adopt failed', {
            meta: { haId, integrationId, error: errMsg(err) },
          })
          failures++
        }
      }

      if (adopted.length === 0 && failures > 0) {
        throw new Error(`home-connect adopt: all ${failures} adopt(s) failed`)
      }
      return { adopted: adopted.map((a) => ({ ...a, accessoryDeviceIds: [] as const })) }
    },

    release: async ({ camDeviceId }) => {
      await removeDevice(camDeviceId)
    },

    resync: async ({ camDeviceId }) => {
      const cfg = await findDeviceConfig(camDeviceId)
      if (!cfg || cfg['system'] !== 'home-connect') {
        throw new Error(`home-connect resync: device ${camDeviceId} not found`)
      }
      const integrationId = String(cfg['brokerId'])
      const haId = String(cfg['haId'])
      if (!hasIntegration(integrationId)) {
        throw new Error(`home-connect resync: integration ${integrationId} not connected`)
      }
      const present = registry.appliances(integrationId).some((a) => a.haId === haId)
      if (!present) {
        throw new Error(`home-connect resync: appliance ${haId} no longer present`)
      }
      return { changed: false, rebuiltChildren: 0 }
    },
  }
}
