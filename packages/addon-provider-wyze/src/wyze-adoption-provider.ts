/**
 * `device-adoption` cap provider for the Wyze addon (account mode).
 *
 * Broker-less: candidates + adoption are resolved directly by
 * `integrationId` → the per-account {@link WyzeClientRegistry} client. Mirrors
 * `buildDreoAdoptionProvider`'s shape (listCandidateFilters / listCandidates /
 * getCandidate / getStatus / refresh / adopt / release / resync) with a single
 * `devices` granularity (one Camera per cloud device). Pure builder: every
 * side-effecting dependency is injected.
 */

import { errMsg, type IScopedLogger } from '@camstack/types'
import type {
  AdoptionFilter,
  AdoptionStatus,
  DiscoveredChildDevice,
  IDeviceAdoptionProvider,
} from '@camstack/types'
import type { WyzeCamera } from '@apocaliss92/wyze-bridge-js'
import { buildWyzeCandidates } from './candidates.js'

/** An adopted Wyze camera as the provider sees it: kernel id + persisted config. */
export interface AdoptedWyzeCamera {
  readonly id: number
  readonly config: Record<string, unknown>
}

/** All injected dependencies for {@link buildWyzeAdoptionProvider}. */
export interface WyzeAdoptionProviderDeps {
  /** Cloud camera list for one integration (cached + rate-safe). */
  readonly getCameraList: (integrationId: string, force?: boolean) => Promise<readonly WyzeCamera[]>
  /** True when a client is registered for the integration. */
  readonly hasIntegration: (integrationId: string) => boolean
  /** The registered integration ids (one per account). */
  readonly listIntegrations: () => readonly string[]
  /** All top-level adopted Wyze cameras (kernel id + config). */
  readonly listAdopted: () => Promise<readonly AdoptedWyzeCamera[]>
  /** Materialise a camera device for `mac` under `integrationId`. */
  readonly adoptCamera: (input: {
    readonly integrationId: string
    readonly mac: string
    readonly name: string
  }) => Promise<{ readonly deviceId: number }>
  readonly removeDevice: (camDeviceId: number) => Promise<void>
  readonly findDeviceConfig: (camDeviceId: number) => Promise<Record<string, unknown> | null>
  readonly logger: IScopedLogger
  /**
   * Return the last classified error from a silent `getCameraList` failure for
   * an integration, or null when the last fetch succeeded. Used by `getStatus`
   * to surface a non-null `lastError` even when the registry swallows the throw
   * (to avoid disrupting streaming / per-device callers).
   */
  readonly getLastFetchError?: (integrationId: string) => { kind: string; message: string } | null
}

/** The single granularity this provider advertises: whole-device adoption. */
const DEVICES_FILTER: AdoptionFilter = { id: 'devices', label: 'Cameras', isDefault: true } as const

/** Build a `MAC(uppercased) → CamStack deviceId` map for one integration. */
function adoptedMapForIntegration(
  integrationId: string,
  adopted: readonly AdoptedWyzeCamera[],
): ReadonlyMap<string, number> {
  const map = new Map<string, number>()
  for (const device of adopted) {
    if (device.config['integrationId'] !== integrationId) continue
    const mac = device.config['mac']
    if (typeof mac === 'string' && mac.length > 0) map.set(mac.toUpperCase(), device.id)
  }
  return map
}

export function buildWyzeAdoptionProvider(deps: WyzeAdoptionProviderDeps): IDeviceAdoptionProvider {
  const {
    getCameraList,
    hasIntegration,
    listIntegrations,
    listAdopted,
    adoptCamera,
    removeDevice,
    findDeviceConfig,
    logger,
  } = deps

  async function candidatesForIntegration(
    integrationId: string,
    force = false,
  ): Promise<DiscoveredChildDevice[]> {
    const cameras = await getCameraList(integrationId, force)
    const adopted = adoptedMapForIntegration(integrationId, await listAdopted())
    return buildWyzeCandidates({ cameras, adopted })
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
      const cands = await candidatesForIntegration(integrationId)
      const filtered = applyCandidateTextFilter(cands, filterText)
      const start = (page - 1) * pageSize
      const slice = filtered.slice(start, start + pageSize)
      return { candidates: slice, totalCount: filtered.length, page, pageSize }
    },

    getCandidate: async ({ integrationId, childNativeId }) => {
      const cands = await candidatesForIntegration(integrationId)
      return cands.find((c) => c.childNativeId === childNativeId) ?? null
    },

    getStatus: async () => {
      try {
        let candidateCount = 0
        for (const integrationId of listIntegrations()) {
          candidateCount += (await candidatesForIntegration(integrationId)).length
        }
        const adoptedCount = (await listAdopted()).length

        // Surface any silent getCameraList failures: the registry catches errors
        // and returns an empty cache so live cameras are not disrupted, but the
        // operator deserves a non-null lastError when the adoption panel is empty
        // because of a cloud fetch failure rather than a genuinely empty account.
        const fetchErrors: string[] = []
        if (deps.getLastFetchError) {
          for (const integrationId of listIntegrations()) {
            const err = deps.getLastFetchError(integrationId)
            if (err) fetchErrors.push(`[${integrationId}] ${err.message}`)
          }
        }

        return {
          lastDiscoveryAt: Date.now(),
          candidateCount,
          adoptedCount,
          lastError: fetchErrors.length > 0 ? fetchErrors.join('; ') : null,
        } satisfies AdoptionStatus
      } catch (err: unknown) {
        logger.warn('wyze adoption: getStatus failed', { meta: { error: errMsg(err) } })
        return {
          lastDiscoveryAt: null,
          candidateCount: 0,
          adoptedCount: 0,
          lastError: errMsg(err),
        } satisfies AdoptionStatus
      }
    },

    refresh: async ({ integrationId }) => {
      const candidateCount = (await candidatesForIntegration(integrationId, true)).length
      const adoptedCount = adoptedMapForIntegration(integrationId, await listAdopted()).size
      const fetchErr = deps.getLastFetchError?.(integrationId)
      return {
        lastDiscoveryAt: Date.now(),
        candidateCount,
        adoptedCount,
        lastError: fetchErr ? fetchErr.message : null,
      } satisfies AdoptionStatus
    },

    adopt: async ({ integrationId, childNativeIds, perCandidate }) => {
      if (!hasIntegration(integrationId)) {
        throw new Error(`wyze adopt: integration ${integrationId} not connected`)
      }
      const cameras = await getCameraList(integrationId, true)

      const adopted: {
        readonly childNativeId: string
        readonly parentDeviceId: number
        readonly accessoryDeviceIds: readonly number[]
      }[] = []
      let failures = 0

      for (const mac of childNativeIds) {
        try {
          const cam = cameras.find((c) => c.mac.toUpperCase() === mac.toUpperCase())
          if (cam === undefined) {
            logger.warn('wyze adopt: camera not found on account — skipping', {
              meta: { mac, integrationId },
            })
            failures++
            continue
          }
          const name = perCandidate?.[mac]?.name ?? cam.nickname ?? cam.productModel ?? mac
          const { deviceId } = await adoptCamera({ integrationId, mac: cam.mac, name })
          adopted.push({ childNativeId: mac, parentDeviceId: deviceId, accessoryDeviceIds: [] })
        } catch (err: unknown) {
          logger.warn('wyze adopt: failed to adopt camera', {
            meta: { mac, integrationId, error: errMsg(err) },
          })
          failures++
        }
      }

      if (adopted.length === 0 && failures > 0) {
        throw new Error(`wyze adopt: all ${failures} adopt(s) failed`)
      }
      return { adopted }
    },

    release: async ({ camDeviceId }) => {
      await removeDevice(camDeviceId)
    },

    resync: async ({ camDeviceId }) => {
      const cfg = await findDeviceConfig(camDeviceId)
      if (cfg === null) {
        throw new Error(`wyze resync: device ${camDeviceId} not found`)
      }
      const integrationId = typeof cfg['integrationId'] === 'string' ? cfg['integrationId'] : ''
      const mac = typeof cfg['mac'] === 'string' ? cfg['mac'] : ''
      if (mac.length === 0) {
        throw new Error(`wyze resync: device ${camDeviceId} has no MAC`)
      }
      if (integrationId.length > 0 && hasIntegration(integrationId)) {
        const cameras = await getCameraList(integrationId)
        const present = cameras.some((c) => c.mac.toUpperCase() === mac.toUpperCase())
        if (!present) {
          throw new Error(
            `wyze resync: camera ${mac} no longer present on integration ${integrationId}`,
          )
        }
      }
      return { changed: false, rebuiltChildren: 0 }
    },
  }
}
