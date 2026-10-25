import { errMsg, type IScopedLogger } from '@camstack/types'
import type {
  IDeviceAdoptionProvider,
  AdoptionStatus,
  AdoptionFilter,
  DiscoveredChildDevice,
  DeviceType,
} from '@camstack/types'
import { buildDreoCandidates, type DreoDiscoverable } from './dreo-discovery.js'

/**
 * Narrow registry surface consumed by the adoption provider. Reads the live
 * discovery info rows for an integration (published by the integration manager
 * on the shared connection resolver, keyed by integrationId). Structurally
 * compatible with the real resolver and with test fakes — no cast.
 */
export interface DreoAdoptionRegistry {
  infos(integrationId: string): readonly DreoDiscoverable[]
  has(integrationId: string): boolean
}

/**
 * `device-adoption` cap provider for the Dreo addon (account mode).
 *
 * Broker-less: candidates + adoption are resolved DIRECTLY by `integrationId` →
 * the per-integration connection surface (published on `dreoConnections` keyed by
 * integrationId). There is no `brokerId` indirection — an adopted device stores
 * its `integrationId` in the (unchanged) `brokerId` config field, which is how
 * the device classes resolve their live handle.
 *
 * The candidate/adopt OUTPUT shape and the device-class instantiation (Container
 * → fan/purifier/heater/humidifier + children) are IDENTICAL to the broker era —
 * only the connection resolution changed.
 */
export interface DreoAdoptionProviderDeps {
  readonly registry: DreoAdoptionRegistry
  /** True when a manager is registered for the integration. */
  readonly hasIntegration: (integrationId: string) => boolean
  /** The registered integration ids (one per account). */
  readonly listIntegrations: () => readonly string[]
  readonly listAdoptedDreo: () => Promise<
    ReadonlyArray<{ readonly id: number; readonly config: Record<string, unknown> }>
  >
  readonly adoptDevice: (input: {
    readonly dreoDeviceId: string
    readonly integrationId: string
    readonly type: DeviceType
    readonly name: string
    readonly model: string
  }) => Promise<{ readonly deviceId: number; readonly accessoryDeviceIds: readonly number[] }>
  readonly removeDevice: (camDeviceId: number) => Promise<void>
  readonly findDeviceConfig: (camDeviceId: number) => Promise<Record<string, unknown> | null>
  readonly logger: IScopedLogger
}

/** The single granularity this provider advertises: whole-device adoption. */
const DEVICES_FILTER: AdoptionFilter = { id: 'devices', label: 'Devices', isDefault: true } as const

/** Build a `dreoDeviceId → CamStack deviceId` map for a single integration. */
async function adoptedMapForIntegration(
  integrationId: string,
  listAdoptedDreo: DreoAdoptionProviderDeps['listAdoptedDreo'],
): Promise<ReadonlyMap<string, number>> {
  const all = await listAdoptedDreo()
  const map = new Map<string, number>()
  for (const device of all) {
    // `brokerId` now holds the integrationId (unchanged device-side field name).
    if (device.config['system'] === 'dreo' && device.config['brokerId'] === integrationId) {
      const dreoId = device.config['dreoDeviceId']
      if (typeof dreoId === 'string') map.set(dreoId, device.id)
    }
  }
  return map
}

/**
 * Construct the `device-adoption` cap provider for the Dreo addon. Pure builder:
 * all side-effecting deps are injected. Single `devices` granularity (one
 * Container per cloud device); resolves each account by `integrationId`.
 */
export function buildDreoAdoptionProvider(deps: DreoAdoptionProviderDeps): IDeviceAdoptionProvider {
  const {
    registry,
    hasIntegration,
    listIntegrations,
    listAdoptedDreo,
    adoptDevice,
    removeDevice,
    findDeviceConfig,
    logger,
  } = deps

  async function allCandidatesForIntegration(
    integrationId: string,
  ): Promise<DiscoveredChildDevice[]> {
    const devices = registry.infos(integrationId)
    const adopted = await adoptedMapForIntegration(integrationId, listAdoptedDreo)
    return buildDreoCandidates({ devices, adopted })
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
        const allAdopted = await listAdoptedDreo()
        const adoptedCount = allAdopted.filter((d) => d.config['system'] === 'dreo').length
        return {
          lastDiscoveryAt: Date.now(),
          candidateCount,
          adoptedCount,
          lastError: null,
        } satisfies AdoptionStatus
      } catch (err: unknown) {
        logger.warn('dreo adoption: getStatus failed', { meta: { error: errMsg(err) } })
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
      const adoptedCount = (await adoptedMapForIntegration(integrationId, listAdoptedDreo)).size
      return {
        lastDiscoveryAt: Date.now(),
        candidateCount,
        adoptedCount,
        lastError: null,
      } satisfies AdoptionStatus
    },

    adopt: async ({ integrationId, childNativeIds, perCandidate }) => {
      if (!registry.has(integrationId)) {
        throw new Error(`dreo adopt: integration ${integrationId} not connected`)
      }
      const devices = registry.infos(integrationId)

      const adopted: {
        readonly childNativeId: string
        readonly parentDeviceId: number
        readonly accessoryDeviceIds: readonly number[]
      }[] = []
      let failures = 0

      for (const dreoDeviceId of childNativeIds) {
        try {
          const dev = devices.find((d) => d.deviceId === dreoDeviceId)
          if (dev === undefined) {
            logger.warn('dreo adopt: device not found on integration — skipping', {
              meta: { dreoDeviceId, integrationId },
            })
            failures++
            continue
          }
          const candidate = buildDreoCandidates({ devices: [dev], adopted: new Map() })[0]
          if (candidate === undefined) {
            logger.warn('dreo adopt: device model unsupported — skipping', {
              meta: { dreoDeviceId, integrationId, model: dev.model },
            })
            failures++
            continue
          }
          const name = perCandidate?.[dreoDeviceId]?.name ?? dev.name ?? dreoDeviceId
          const { deviceId, accessoryDeviceIds } = await adoptDevice({
            dreoDeviceId,
            integrationId,
            type: candidate.type,
            name,
            model: dev.model,
          })
          adopted.push({
            childNativeId: dreoDeviceId,
            parentDeviceId: deviceId,
            accessoryDeviceIds,
          })
        } catch (err: unknown) {
          logger.warn('dreo adopt: failed to adopt device', {
            meta: { dreoDeviceId, integrationId, error: errMsg(err) },
          })
          failures++
        }
      }

      if (adopted.length === 0 && failures > 0) {
        throw new Error(`dreo adopt: all ${failures} adopt(s) failed`)
      }
      return { adopted }
    },

    release: async ({ camDeviceId }) => {
      await removeDevice(camDeviceId)
    },

    resync: async ({ camDeviceId }) => {
      const cfg = await findDeviceConfig(camDeviceId)
      if (cfg === null) {
        throw new Error(`dreo resync: device ${camDeviceId} not found`)
      }
      if (cfg['system'] !== 'dreo') {
        throw new Error(`dreo resync: device ${camDeviceId} is not a Dreo device`)
      }
      // `brokerId` holds the integrationId (unchanged device-side field name).
      const integrationId = String(cfg['brokerId'])
      const dreoDeviceId = String(cfg['dreoDeviceId'])
      if (!hasIntegration(integrationId)) {
        throw new Error(`dreo resync: integration ${integrationId} not connected`)
      }
      const present = registry.infos(integrationId).some((d) => d.deviceId === dreoDeviceId)
      if (!present) {
        throw new Error(
          `dreo resync: device ${dreoDeviceId} no longer present on integration ${integrationId}`,
        )
      }
      return { changed: false, rebuiltChildren: 0 }
    },
  }
}
