import { errMsg, type IScopedLogger } from '@camstack/types'
import type {
  AdoptionFilter,
  AdoptionStatus,
  DiscoveredChildDevice,
  IDeviceAdoptionProvider,
} from '@camstack/types'
import { buildPetkitCandidates, type PetkitDiscoverable } from './petkit-discovery.js'

/**
 * `device-adoption` cap provider for the PetKit addon (account mode).
 *
 * Broker-less: candidates + adoption resolve DIRECTLY by `integrationId` → the
 * per-integration feeder roster published on {@link petkitConnections}. An
 * adopted feeder stores its `integrationId` on its device config, which is how
 * the feeder device class resolves its live handle. One `PetFeeder` device per
 * cloud feeder — no container / children.
 */
export interface PetkitAdoptionProviderDeps {
  /** The discovered feeder roster for an integration (empty when disconnected). */
  readonly getInfos: (integrationId: string) => readonly PetkitDiscoverable[]
  /** True when a manager is registered for the integration. */
  readonly hasIntegration: (integrationId: string) => boolean
  /** The registered integration ids (one per account). */
  readonly listIntegrations: () => readonly string[]
  readonly listAdoptedPetkit: () => Promise<
    ReadonlyArray<{ readonly id: number; readonly config: Record<string, unknown> }>
  >
  readonly adoptDevice: (input: {
    readonly petkitDeviceId: string
    readonly integrationId: string
    readonly petkitDeviceType: string
    readonly name: string
    readonly model: string
  }) => Promise<{ readonly deviceId: number }>
  readonly removeDevice: (camDeviceId: number) => Promise<void>
  readonly findDeviceConfig: (camDeviceId: number) => Promise<Record<string, unknown> | null>
  readonly logger: IScopedLogger
}

/** The single granularity this provider advertises: whole-device adoption. */
const DEVICES_FILTER: AdoptionFilter = { id: 'devices', label: 'Devices', isDefault: true } as const

/** Build a `petkitDeviceId → CamStack deviceId` map for a single integration. */
async function adoptedMapForIntegration(
  integrationId: string,
  listAdoptedPetkit: PetkitAdoptionProviderDeps['listAdoptedPetkit'],
): Promise<ReadonlyMap<string, number>> {
  const all = await listAdoptedPetkit()
  const map = new Map<string, number>()
  for (const device of all) {
    if (device.config['system'] === 'petkit' && device.config['integrationId'] === integrationId) {
      const petkitId = device.config['petkitDeviceId']
      if (typeof petkitId === 'string') map.set(petkitId, device.id)
    }
  }
  return map
}

/**
 * Construct the `device-adoption` cap provider for the PetKit addon. Pure
 * builder: all side-effecting deps are injected. Single `devices` granularity
 * (one PetFeeder per cloud feeder); resolves each account by `integrationId`.
 */
export function buildPetkitAdoptionProvider(
  deps: PetkitAdoptionProviderDeps,
): IDeviceAdoptionProvider {
  const {
    getInfos,
    hasIntegration,
    listIntegrations,
    listAdoptedPetkit,
    adoptDevice,
    removeDevice,
    findDeviceConfig,
    logger,
  } = deps

  async function allCandidatesForIntegration(
    integrationId: string,
  ): Promise<DiscoveredChildDevice[]> {
    const devices = getInfos(integrationId)
    const adopted = await adoptedMapForIntegration(integrationId, listAdoptedPetkit)
    return buildPetkitCandidates({ devices, adopted })
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
        const allAdopted = await listAdoptedPetkit()
        const adoptedCount = allAdopted.filter((d) => d.config['system'] === 'petkit').length
        return {
          lastDiscoveryAt: Date.now(),
          candidateCount,
          adoptedCount,
          lastError: null,
        } satisfies AdoptionStatus
      } catch (err: unknown) {
        logger.warn('petkit adoption: getStatus failed', { meta: { error: errMsg(err) } })
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
      const adoptedCount = (await adoptedMapForIntegration(integrationId, listAdoptedPetkit)).size
      return {
        lastDiscoveryAt: Date.now(),
        candidateCount,
        adoptedCount,
        lastError: null,
      } satisfies AdoptionStatus
    },

    adopt: async ({ integrationId, childNativeIds, perCandidate }) => {
      if (!hasIntegration(integrationId)) {
        throw new Error(`petkit adopt: integration ${integrationId} not connected`)
      }
      const roster = getInfos(integrationId)

      const adopted: {
        readonly childNativeId: string
        readonly parentDeviceId: number
        readonly accessoryDeviceIds: readonly number[]
      }[] = []
      let failures = 0

      for (const petkitDeviceId of childNativeIds) {
        try {
          const info = roster.find((d) => d.id === petkitDeviceId)
          if (info === undefined) {
            logger.warn('petkit adopt: feeder not found on integration — skipping', {
              meta: { petkitDeviceId, integrationId },
            })
            failures++
            continue
          }
          const name = perCandidate?.[petkitDeviceId]?.name ?? info.name ?? petkitDeviceId
          const { deviceId } = await adoptDevice({
            petkitDeviceId,
            integrationId,
            petkitDeviceType: info.deviceType,
            name,
            model: info.model,
          })
          adopted.push({
            childNativeId: petkitDeviceId,
            parentDeviceId: deviceId,
            accessoryDeviceIds: [],
          })
        } catch (err: unknown) {
          logger.warn('petkit adopt: failed to adopt feeder', {
            meta: { petkitDeviceId, integrationId, error: errMsg(err) },
          })
          failures++
        }
      }

      if (adopted.length === 0 && failures > 0) {
        throw new Error(`petkit adopt: all ${failures} adopt(s) failed`)
      }
      return { adopted }
    },

    release: async ({ camDeviceId }) => {
      await removeDevice(camDeviceId)
    },

    resync: async ({ camDeviceId }) => {
      const cfg = await findDeviceConfig(camDeviceId)
      if (cfg === null) {
        throw new Error(`petkit resync: device ${camDeviceId} not found`)
      }
      if (cfg['system'] !== 'petkit') {
        throw new Error(`petkit resync: device ${camDeviceId} is not a PetKit device`)
      }
      const integrationId = String(cfg['integrationId'])
      const petkitDeviceId = String(cfg['petkitDeviceId'])
      if (!hasIntegration(integrationId)) {
        throw new Error(`petkit resync: integration ${integrationId} not connected`)
      }
      const present = getInfos(integrationId).some((d) => d.id === petkitDeviceId)
      if (!present) {
        throw new Error(
          `petkit resync: feeder ${petkitDeviceId} no longer present on integration ${integrationId}`,
        )
      }
      return { changed: false, rebuiltChildren: 0 }
    },
  }
}
