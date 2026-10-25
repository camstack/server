import { errMsg, type IScopedLogger } from '@camstack/types'
import type {
  AdoptionFilter,
  AdoptionStatus,
  DiscoveredChildDevice,
  IDeviceAdoptionProvider,
} from '@camstack/types'
import { buildTuyaCandidates } from './tuya-discovery.js'
import type { TuyaCatalogEntry } from './tuya-gateway.js'

/**
 * `device-adoption` cap provider for the Tuya addon (account mode). Broker-less:
 * candidates + adoption resolve DIRECTLY by `integrationId` → the per-integration
 * cloud CATALOG (published on the shared resolver). Each adopted cloud device
 * becomes one top-level CamStack device (a `switch` device, or a `container`
 * kettle that fans out its per-DP children). Mirrors `buildDreameAdoptionProvider`.
 */
export interface TuyaAdoptionProviderDeps {
  /** The cloud catalog for an integration (device list + localKeys). */
  readonly getCatalog: (integrationId: string) => readonly TuyaCatalogEntry[]
  readonly hasIntegration: (integrationId: string) => boolean
  readonly listIntegrations: () => readonly string[]
  readonly listAdoptedTuya: () => Promise<
    ReadonlyArray<{ readonly id: number; readonly config: Record<string, unknown> }>
  >
  readonly adoptDevice: (input: {
    readonly entry: TuyaCatalogEntry
    readonly integrationId: string
    readonly name: string
  }) => Promise<{ readonly deviceId: number; readonly accessoryDeviceIds: readonly number[] }>
  readonly removeDevice: (camDeviceId: number) => Promise<void>
  readonly findDeviceConfig: (camDeviceId: number) => Promise<Record<string, unknown> | null>
  readonly logger: IScopedLogger
}

const DEVICES_FILTER: AdoptionFilter = { id: 'devices', label: 'Devices', isDefault: true } as const

/** Build a `tuyaDeviceId → CamStack deviceId` map for a single integration. */
async function adoptedMapForIntegration(
  integrationId: string,
  listAdoptedTuya: TuyaAdoptionProviderDeps['listAdoptedTuya'],
): Promise<ReadonlyMap<string, number>> {
  const all = await listAdoptedTuya()
  const map = new Map<string, number>()
  for (const device of all) {
    if (device.config['system'] === 'tuya' && device.config['integrationId'] === integrationId) {
      const tuyaId = device.config['tuyaDeviceId']
      if (typeof tuyaId === 'string') map.set(tuyaId, device.id)
    }
  }
  return map
}

export function buildTuyaAdoptionProvider(deps: TuyaAdoptionProviderDeps): IDeviceAdoptionProvider {
  const {
    getCatalog,
    hasIntegration,
    listIntegrations,
    listAdoptedTuya,
    adoptDevice,
    removeDevice,
    findDeviceConfig,
    logger,
  } = deps

  async function allCandidatesForIntegration(
    integrationId: string,
  ): Promise<DiscoveredChildDevice[]> {
    const entries = getCatalog(integrationId)
    const adopted = await adoptedMapForIntegration(integrationId, listAdoptedTuya)
    return buildTuyaCandidates({ entries, adopted })
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
        const allAdopted = await listAdoptedTuya()
        const adoptedCount = allAdopted.filter((d) => d.config['system'] === 'tuya').length
        return {
          lastDiscoveryAt: Date.now(),
          candidateCount,
          adoptedCount,
          lastError: null,
        } satisfies AdoptionStatus
      } catch (err: unknown) {
        logger.warn('tuya adoption: getStatus failed', { meta: { error: errMsg(err) } })
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
      const adoptedCount = (await adoptedMapForIntegration(integrationId, listAdoptedTuya)).size
      return {
        lastDiscoveryAt: Date.now(),
        candidateCount,
        adoptedCount,
        lastError: null,
      } satisfies AdoptionStatus
    },

    adopt: async ({ integrationId, childNativeIds, perCandidate }) => {
      const entries = getCatalog(integrationId)
      if (entries.length === 0 && !hasIntegration(integrationId)) {
        throw new Error(`tuya adopt: integration ${integrationId} not connected`)
      }

      const adopted: {
        readonly childNativeId: string
        readonly parentDeviceId: number
        readonly accessoryDeviceIds: readonly number[]
      }[] = []
      let failures = 0

      for (const tuyaDeviceId of childNativeIds) {
        try {
          const entry = entries.find((e) => e.deviceId === tuyaDeviceId)
          if (entry === undefined) {
            logger.warn('tuya adopt: device not found in catalog — skipping', {
              meta: { tuyaDeviceId, integrationId },
            })
            failures++
            continue
          }
          const name = perCandidate?.[tuyaDeviceId]?.name ?? entry.name ?? tuyaDeviceId
          const { deviceId, accessoryDeviceIds } = await adoptDevice({
            entry,
            integrationId,
            name,
          })
          adopted.push({
            childNativeId: tuyaDeviceId,
            parentDeviceId: deviceId,
            accessoryDeviceIds,
          })
        } catch (err: unknown) {
          logger.warn('tuya adopt: failed to adopt device', {
            meta: { tuyaDeviceId, integrationId, error: errMsg(err) },
          })
          failures++
        }
      }

      if (adopted.length === 0 && failures > 0) {
        throw new Error(`tuya adopt: all ${failures} adopt(s) failed`)
      }
      return { adopted }
    },

    release: async ({ camDeviceId }) => {
      await removeDevice(camDeviceId)
    },

    resync: async ({ camDeviceId }) => {
      const cfg = await findDeviceConfig(camDeviceId)
      if (cfg === null) {
        throw new Error(`tuya resync: device ${camDeviceId} not found`)
      }
      if (cfg['system'] !== 'tuya') {
        throw new Error(`tuya resync: device ${camDeviceId} is not a Tuya device`)
      }
      const integrationId = String(cfg['integrationId'])
      const tuyaDeviceId = String(cfg['tuyaDeviceId'])
      if (!hasIntegration(integrationId)) {
        throw new Error(`tuya resync: integration ${integrationId} not connected`)
      }
      const present = getCatalog(integrationId).some((e) => e.deviceId === tuyaDeviceId)
      if (!present) {
        throw new Error(
          `tuya resync: device ${tuyaDeviceId} no longer present on integration ${integrationId}`,
        )
      }
      return { changed: false, rebuiltChildren: 0 }
    },
  }
}
