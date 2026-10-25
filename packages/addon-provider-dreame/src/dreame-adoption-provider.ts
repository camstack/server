import { errMsg, type IScopedLogger } from '@camstack/types'
import type {
  IDeviceAdoptionProvider,
  AdoptionStatus,
  AdoptionFilter,
  DiscoveredChildDevice,
  DeviceType,
} from '@camstack/types'
import { buildDreameCandidates, type DreameDiscoverable } from './dreame-discovery.js'

/**
 * Minimal facade surface the adoption provider reads from a Dreame connection.
 * Structurally compatible with the library's `Nodreame` facade (`.devices`) and
 * with test fakes — no cast.
 */
export interface DreameAdoptionFacade {
  readonly devices: readonly DreameDiscoverable[]
}

/**
 * `device-adoption` cap provider for the Dreame addon (account mode).
 *
 * Broker-less: candidates + adoption are resolved DIRECTLY by `integrationId` →
 * the per-integration {@link DreameClientRegistry} facade (published on
 * `dreameFacades` keyed by integrationId). There is no `brokerId` indirection —
 * an adopted device stores its `integrationId` in the (unchanged) `brokerId`
 * config field, which is how the device classes resolve their live handle.
 *
 * The candidate/adopt OUTPUT shape and the device-class instantiation (Container
 * → vacuum/mower + children) are IDENTICAL to the broker era — only the
 * connection resolution changed.
 */
export interface DreameAdoptionProviderDeps {
  /** The live facade for an integration, or null when unknown / disconnected. */
  readonly getFacade: (integrationId: string) => DreameAdoptionFacade | null
  /** True when a manager is registered for the integration. */
  readonly hasIntegration: (integrationId: string) => boolean
  /** The registered integration ids (one per account). */
  readonly listIntegrations: () => readonly string[]
  readonly listAdoptedDreame: () => Promise<
    ReadonlyArray<{ readonly id: number; readonly config: Record<string, unknown> }>
  >
  readonly adoptDevice: (input: {
    readonly dreameDeviceId: string
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

/** Build a `dreameDeviceId → CamStack deviceId` map for a single integration. */
async function adoptedMapForIntegration(
  integrationId: string,
  listAdoptedDreame: DreameAdoptionProviderDeps['listAdoptedDreame'],
): Promise<ReadonlyMap<string, number>> {
  const all = await listAdoptedDreame()
  const map = new Map<string, number>()
  for (const device of all) {
    // `brokerId` now holds the integrationId (unchanged device-side field name).
    if (device.config['system'] === 'dreame' && device.config['brokerId'] === integrationId) {
      const dreameId = device.config['dreameDeviceId']
      if (typeof dreameId === 'string') map.set(dreameId, device.id)
    }
  }
  return map
}

/**
 * Construct the `device-adoption` cap provider for the Dreame addon. Pure
 * builder: all side-effecting deps are injected. Single `devices` granularity
 * (one Container per cloud device); resolves each account by `integrationId`.
 */
export function buildDreameAdoptionProvider(
  deps: DreameAdoptionProviderDeps,
): IDeviceAdoptionProvider {
  const {
    getFacade,
    hasIntegration,
    listIntegrations,
    listAdoptedDreame,
    adoptDevice,
    removeDevice,
    findDeviceConfig,
    logger,
  } = deps

  async function allCandidatesForIntegration(
    integrationId: string,
  ): Promise<DiscoveredChildDevice[]> {
    const facade = getFacade(integrationId)
    const devices = facade?.devices ?? []
    const adopted = await adoptedMapForIntegration(integrationId, listAdoptedDreame)
    return buildDreameCandidates({ devices, adopted })
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
        const allAdopted = await listAdoptedDreame()
        const adoptedCount = allAdopted.filter((d) => d.config['system'] === 'dreame').length
        return {
          lastDiscoveryAt: Date.now(),
          candidateCount,
          adoptedCount,
          lastError: null,
        } satisfies AdoptionStatus
      } catch (err: unknown) {
        logger.warn('dreame adoption: getStatus failed', { meta: { error: errMsg(err) } })
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
      const adoptedCount = (await adoptedMapForIntegration(integrationId, listAdoptedDreame)).size
      return {
        lastDiscoveryAt: Date.now(),
        candidateCount,
        adoptedCount,
        lastError: null,
      } satisfies AdoptionStatus
    },

    adopt: async ({ integrationId, childNativeIds, perCandidate }) => {
      const facade = getFacade(integrationId)
      if (facade === null) {
        throw new Error(`dreame adopt: integration ${integrationId} not connected`)
      }
      const devices = facade.devices

      const adopted: {
        readonly childNativeId: string
        readonly parentDeviceId: number
        readonly accessoryDeviceIds: readonly number[]
      }[] = []
      let failures = 0

      for (const dreameDeviceId of childNativeIds) {
        try {
          const dev = devices.find((d) => d.deviceId === dreameDeviceId)
          if (dev === undefined) {
            logger.warn('dreame adopt: device not found on integration — skipping', {
              meta: { dreameDeviceId, integrationId },
            })
            failures++
            continue
          }
          const candidate = buildDreameCandidates({
            devices: [dev],
            adopted: new Map(),
          })[0]
          if (candidate === undefined) {
            logger.warn('dreame adopt: device model unsupported — skipping', {
              meta: { dreameDeviceId, integrationId, model: dev.model },
            })
            failures++
            continue
          }
          const name = perCandidate?.[dreameDeviceId]?.name ?? dev.name ?? dreameDeviceId
          const { deviceId, accessoryDeviceIds } = await adoptDevice({
            dreameDeviceId,
            integrationId,
            type: candidate.type,
            name,
            model: dev.model,
          })
          adopted.push({
            childNativeId: dreameDeviceId,
            parentDeviceId: deviceId,
            accessoryDeviceIds,
          })
        } catch (err: unknown) {
          logger.warn('dreame adopt: failed to adopt device', {
            meta: { dreameDeviceId, integrationId, error: errMsg(err) },
          })
          failures++
        }
      }

      if (adopted.length === 0 && failures > 0) {
        throw new Error(`dreame adopt: all ${failures} adopt(s) failed`)
      }
      return { adopted }
    },

    release: async ({ camDeviceId }) => {
      await removeDevice(camDeviceId)
    },

    resync: async ({ camDeviceId }) => {
      const cfg = await findDeviceConfig(camDeviceId)
      if (cfg === null) {
        throw new Error(`dreame resync: device ${camDeviceId} not found`)
      }
      if (cfg['system'] !== 'dreame') {
        throw new Error(`dreame resync: device ${camDeviceId} is not a Dreame device`)
      }
      // The Container derives its single accessory child LIVE from the facade on
      // each spawn; a structural drift reconcile is a follow-up. For now the
      // resync confirms the device is still present on its integration.
      const integrationId = String(cfg['brokerId'])
      const dreameDeviceId = String(cfg['dreameDeviceId'])
      if (!hasIntegration(integrationId)) {
        throw new Error(`dreame resync: integration ${integrationId} not connected`)
      }
      const facade = getFacade(integrationId)
      const present = facade?.devices.some((d) => d.deviceId === dreameDeviceId) ?? false
      if (!present) {
        throw new Error(
          `dreame resync: device ${dreameDeviceId} no longer present on integration ${integrationId}`,
        )
      }
      return { changed: false, rebuiltChildren: 0 }
    },
  }
}
