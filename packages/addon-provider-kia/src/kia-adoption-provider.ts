import { errMsg, type IScopedLogger } from '@dominevo/types'
import type {
  IDeviceAdoptionProvider,
  AdoptionStatus,
  AdoptionFilter,
  DiscoveredChildDevice,
} from '@dominevo/types'
import { buildKiaCandidates, type KiaDiscoverable } from './kia-discovery.js'

/**
 * Narrow registry surface consumed by the adoption provider. Reads the live
 * discovery info rows for an integration (published by the integration manager
 * on the shared connection resolver, keyed by integrationId). Structurally
 * compatible with the real resolver and with test fakes — no cast.
 */
export interface KiaAdoptionRegistry {
  infos(integrationId: string): readonly KiaDiscoverable[]
  has(integrationId: string): boolean
}

/**
 * `device-adoption` cap provider for the Kia addon (account mode).
 *
 * Candidates + adoption are resolved by `integrationId` → the per-integration
 * connection surface (published on `kiaConnections` keyed by integrationId). An
 * adopted device stores its `integrationId` in the `brokerId` config field (a name
 * that predates integration instances and stays, it is persisted), which is how
 * the device classes resolve their live handle.
 */
export interface KiaAdoptionProviderDeps {
  readonly registry: KiaAdoptionRegistry
  /** True when a manager is registered for the integration. */
  readonly hasIntegration: (integrationId: string) => boolean
  /** The registered integration ids (one per account). */
  readonly listIntegrations: () => readonly string[]
  readonly listAdoptedKia: () => Promise<
    ReadonlyArray<{ readonly id: number; readonly config: Record<string, unknown> }>
  >
  readonly adoptDevice: (input: {
    readonly kiaVehicleId: string
    readonly integrationId: string
    readonly name: string
    readonly model: string
  }) => Promise<{ readonly deviceId: number; readonly accessoryDeviceIds: readonly number[] }>
  readonly removeDevice: (camDeviceId: number) => Promise<void>
  readonly findDeviceConfig: (camDeviceId: number) => Promise<Record<string, unknown> | null>
  readonly logger: IScopedLogger
}

/** The single granularity this provider advertises: whole-device adoption. */
const DEVICES_FILTER: AdoptionFilter = { id: 'devices', label: 'Devices', isDefault: true } as const

/** Build a `kiaVehicleId → Dominevo deviceId` map for a single integration. */
async function adoptedMapForIntegration(
  integrationId: string,
  listAdoptedKia: KiaAdoptionProviderDeps['listAdoptedKia'],
): Promise<ReadonlyMap<string, number>> {
  const all = await listAdoptedKia()
  const map = new Map<string, number>()
  for (const device of all) {
    // The persisted `brokerId` field holds the integrationId.
    if (device.config['system'] === 'kia' && device.config['brokerId'] === integrationId) {
      const kiaId = device.config['kiaVehicleId']
      if (typeof kiaId === 'string') map.set(kiaId, device.id)
    }
  }
  return map
}

/**
 * Construct the `device-adoption` cap provider for the Kia addon. Pure builder:
 * all side-effecting deps are injected. Single `devices` granularity (one
 * Container per cloud device); resolves each account by `integrationId`.
 */
export function buildKiaAdoptionProvider(deps: KiaAdoptionProviderDeps): IDeviceAdoptionProvider {
  const {
    registry,
    hasIntegration,
    listIntegrations,
    listAdoptedKia,
    adoptDevice,
    removeDevice,
    findDeviceConfig,
    logger,
  } = deps

  async function allCandidatesForIntegration(
    integrationId: string,
  ): Promise<DiscoveredChildDevice[]> {
    const vehicles = registry.infos(integrationId)
    const adopted = await adoptedMapForIntegration(integrationId, listAdoptedKia)
    return buildKiaCandidates({ vehicles, adopted })
  }

  function applyCandidateTextFilter(
    cands: readonly DiscoveredChildDevice[],
    filterText: { search?: string; adoptedOnly?: boolean; unadoptedOnly?: boolean } | undefined,
  ): DiscoveredChildDevice[] {
    let filtered = [...cands]
    if (filterText === undefined) return filtered
    const { search, adoptedOnly, unadoptedOnly } = filterText
    if (search !== undefined && search.length > 0) {
      const lower = search.toLowerCase()
      filtered = filtered.filter(
        (c) =>
          c.name.toLowerCase().includes(lower) ||
          (c.metadata.model?.toLowerCase().includes(lower) ?? false) ||
          c.childNativeId.toLowerCase().includes(lower),
      )
    }
    if (adoptedOnly === true) filtered = filtered.filter((c) => c.alreadyAdopted)
    if (unadoptedOnly === true) filtered = filtered.filter((c) => !c.alreadyAdopted)
    return filtered
  }

  return {
    listCandidateFilters: async () => ({ filters: [DEVICES_FILTER] }),

    listCandidates: async ({ integrationId, page, pageSize, filterText }) => {
      const cands = await allCandidatesForIntegration(integrationId)
      const filtered = applyCandidateTextFilter(cands, filterText)
      const start = (page - 1) * pageSize
      const slice = filtered.slice(start, start + pageSize)
      return { candidates: slice, totalCount: filtered.length, page, pageSize }
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
        const allAdopted = await listAdoptedKia()
        const adoptedCount = allAdopted.filter((d) => d.config['system'] === 'kia').length
        return {
          lastDiscoveryAt: Date.now(),
          candidateCount,
          adoptedCount,
          lastError: null,
        } satisfies AdoptionStatus
      } catch (err: unknown) {
        logger.warn('kia adoption: getStatus failed', { meta: { error: errMsg(err) } })
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
      const adoptedCount = (await adoptedMapForIntegration(integrationId, listAdoptedKia)).size
      return {
        lastDiscoveryAt: Date.now(),
        candidateCount,
        adoptedCount,
        lastError: null,
      } satisfies AdoptionStatus
    },

    adopt: async ({ integrationId, childNativeIds, perCandidate }) => {
      if (!registry.has(integrationId)) {
        throw new Error(`kia adopt: integration ${integrationId} not connected`)
      }
      const vehicles = registry.infos(integrationId)

      const adopted: {
        readonly childNativeId: string
        readonly parentDeviceId: number
        readonly accessoryDeviceIds: readonly number[]
      }[] = []
      let failures = 0

      for (const kiaVehicleId of childNativeIds) {
        try {
          const dev = vehicles.find((v) => v.vehicleId === kiaVehicleId)
          if (dev === undefined) {
            logger.warn('kia adopt: device not found on integration — skipping', {
              meta: { kiaVehicleId, integrationId },
            })
            failures++
            continue
          }
          const candidate = buildKiaCandidates({ vehicles: [dev], adopted: new Map() })[0]
          if (candidate === undefined) {
            logger.warn('kia adopt: vehicle cannot be adopted — skipping', {
              meta: { kiaVehicleId, integrationId },
            })
            failures++
            continue
          }
          const name = perCandidate?.[kiaVehicleId]?.name ?? dev.name ?? kiaVehicleId
          const { deviceId, accessoryDeviceIds } = await adoptDevice({
            kiaVehicleId,
            integrationId,
            name,
            model: dev.model,
          })
          adopted.push({
            childNativeId: kiaVehicleId,
            parentDeviceId: deviceId,
            accessoryDeviceIds,
          })
        } catch (err: unknown) {
          logger.warn('kia adopt: failed to adopt device', {
            meta: { kiaVehicleId, integrationId, error: errMsg(err) },
          })
          failures++
        }
      }

      if (adopted.length === 0 && failures > 0) {
        throw new Error(`kia adopt: all ${failures} adopt(s) failed`)
      }
      return { adopted }
    },

    release: async ({ camDeviceId }) => {
      await removeDevice(camDeviceId)
    },

    resync: async ({ camDeviceId }) => {
      const cfg = await findDeviceConfig(camDeviceId)
      if (cfg === null) {
        throw new Error(`kia resync: device ${camDeviceId} not found`)
      }
      if (cfg['system'] !== 'kia') {
        throw new Error(`kia resync: device ${camDeviceId} is not a Kia device`)
      }
      // The persisted `brokerId` field holds the integrationId.
      const integrationId = String(cfg['brokerId'])
      const kiaVehicleId = String(cfg['kiaVehicleId'])
      if (!hasIntegration(integrationId)) {
        throw new Error(`kia resync: integration ${integrationId} not connected`)
      }
      const present = registry.infos(integrationId).some((v) => v.vehicleId === kiaVehicleId)
      if (!present) {
        throw new Error(
          `kia resync: device ${kiaVehicleId} no longer present on integration ${integrationId}`,
        )
      }
      return { changed: false, rebuiltChildren: 0 }
    },
  }
}
