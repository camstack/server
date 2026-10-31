import {
  errMsg,
  type AdoptionFilter,
  type AdoptionStatus,
  type DiscoveredChildDevice,
  type IDeviceAdoptionProvider,
  type IScopedLogger,
} from '@camstack/types'
import { UNRAID_SYSTEM } from './config.js'
import { buildUnraidCandidates, UNRAID_GATEWAY_ID, UNRAID_INSTANCE_ID } from './unraid-discovery.js'
import type { UnraidSnapshot } from './unraid-client-contract.js'

export interface UnraidAdoptionProviderDeps {
  readonly getSnapshot: (integrationId: string) => UnraidSnapshot | null
  readonly hasIntegration: (integrationId: string) => boolean
  readonly listIntegrations: () => readonly string[]
  /** The integration's display name, or null when it is unknown. */
  readonly integrationName: (integrationId: string) => string | null
  readonly listAdopted: () => Promise<
    ReadonlyArray<{
      readonly id: number
      readonly config: Record<string, unknown>
    }>
  >
  /** Create the top-level Gateway device of the server. */
  readonly adoptGateway: (input: {
    readonly integrationId: string
    readonly name: string
  }) => Promise<{ readonly deviceId: number }>
  /** Create the top-level instance Container; the kernel spawns its entity children. */
  readonly adoptInstance: (input: {
    readonly integrationId: string
    readonly name: string
  }) => Promise<{
    readonly deviceId: number
    readonly accessoryDeviceIds: readonly number[]
  }>
  /** The ids of a device's children (empty when it has none). */
  readonly childDeviceIds: (deviceId: number) => Promise<readonly number[]>
  readonly removeDevice: (deviceId: number) => Promise<void>
  readonly findDeviceConfig: (deviceId: number) => Promise<Record<string, unknown> | null>
  readonly logger: IScopedLogger
}

const DEVICES_FILTER: AdoptionFilter = {
  id: 'devices',
  label: 'Devices',
  isDefault: true,
}

/**
 * The Unraid `device-adoption` provider: the server's Gateway and its single instance
 * Container are candidates of the integration, adopted as top-level siblings.
 */
export function buildUnraidAdoptionProvider(
  deps: UnraidAdoptionProviderDeps,
): IDeviceAdoptionProvider {
  const { getSnapshot, hasIntegration, listIntegrations, listAdopted, logger } = deps
  const serverName = (integrationId: string): string =>
    deps.integrationName(integrationId) ?? 'Unraid'

  async function adoptedMap(integrationId: string): Promise<ReadonlyMap<string, number>> {
    const map = new Map<string, number>()
    for (const device of await listAdopted()) {
      const cfg = device.config
      if (cfg['system'] !== UNRAID_SYSTEM || cfg['integrationId'] !== integrationId) continue
      const nativeId = cfg['nativeId']
      if (typeof nativeId === 'string') map.set(nativeId, device.id)
    }
    return map
  }

  async function candidates(integrationId: string): Promise<readonly DiscoveredChildDevice[]> {
    return buildUnraidCandidates({
      server: {
        name: serverName(integrationId),
        online: getSnapshot(integrationId) !== null,
      },
      adopted: await adoptedMap(integrationId),
    })
  }

  async function status(integrationId: string): Promise<AdoptionStatus> {
    return {
      lastDiscoveryAt: Date.now(),
      candidateCount: (await candidates(integrationId)).length,
      adoptedCount: (await adoptedMap(integrationId)).size,
      lastError: null,
    }
  }

  return {
    listCandidateFilters: async () => ({ filters: [DEVICES_FILTER] }),

    listCandidates: async ({ integrationId, page, pageSize }) => {
      const all = await candidates(integrationId)
      const start = (page - 1) * pageSize
      return {
        candidates: all.slice(start, start + pageSize),
        totalCount: all.length,
        page,
        pageSize,
      }
    },

    getCandidate: async ({ integrationId, childNativeId }) => {
      const all = await candidates(integrationId)
      return all.find((c) => c.childNativeId === childNativeId) ?? null
    },

    getStatus: async () => {
      try {
        let candidateCount = 0
        let adoptedCount = 0
        for (const integrationId of listIntegrations()) {
          const s = await status(integrationId)
          candidateCount += s.candidateCount
          adoptedCount += s.adoptedCount
        }
        return { lastDiscoveryAt: Date.now(), candidateCount, adoptedCount, lastError: null }
      } catch (err: unknown) {
        return { lastDiscoveryAt: null, candidateCount: 0, adoptedCount: 0, lastError: errMsg(err) }
      }
    },

    refresh: async ({ integrationId }) => status(integrationId),

    adopt: async ({ integrationId, childNativeIds, perCandidate }) => {
      if (!hasIntegration(integrationId)) {
        throw new Error(`unraid adopt: integration ${integrationId} not found`)
      }
      const already = await adoptedMap(integrationId)
      const adopted: Array<{
        readonly childNativeId: string
        readonly parentDeviceId: number
        readonly accessoryDeviceIds: readonly number[]
      }> = []
      let failures = 0
      for (const nativeId of childNativeIds) {
        try {
          const name = perCandidate?.[nativeId]?.name ?? serverName(integrationId)
          const existingId = already.get(nativeId)
          if (existingId !== undefined) {
            // A retried adopt (the first reply was lost) is a no-op, never a duplicate.
            logger.info('unraid adopt: already adopted — skipping', {
              tags: { deviceId: existingId },
              meta: { nativeId, integrationId },
            })
            adopted.push({
              childNativeId: nativeId,
              parentDeviceId: existingId,
              accessoryDeviceIds: await deps.childDeviceIds(existingId),
            })
            continue
          }
          if (nativeId === UNRAID_GATEWAY_ID) {
            const { deviceId } = await deps.adoptGateway({ integrationId, name })
            adopted.push({
              childNativeId: nativeId,
              parentDeviceId: deviceId,
              accessoryDeviceIds: [],
            })
          } else if (nativeId === UNRAID_INSTANCE_ID) {
            const { deviceId, accessoryDeviceIds } = await deps.adoptInstance({
              integrationId,
              name,
            })
            adopted.push({ childNativeId: nativeId, parentDeviceId: deviceId, accessoryDeviceIds })
          } else {
            logger.warn('unraid adopt: not a candidate of this integration — skipping', {
              meta: { nativeId, integrationId },
            })
            failures++
          }
        } catch (err: unknown) {
          logger.warn('unraid adopt: failed to adopt candidate', {
            meta: { nativeId, integrationId, error: errMsg(err) },
          })
          failures++
        }
      }
      if (adopted.length === 0 && failures > 0) {
        throw new Error(`unraid adopt: all ${failures} adopt(s) failed`)
      }
      return { adopted }
    },

    release: async ({ camDeviceId }) => {
      await deps.removeDevice(camDeviceId)
    },

    resync: async ({ camDeviceId }) => {
      const cfg = await deps.findDeviceConfig(camDeviceId)
      if (cfg === null || cfg['system'] !== UNRAID_SYSTEM) {
        throw new Error(`unraid resync: device ${camDeviceId} is not an Unraid device`)
      }
      return { changed: false, rebuiltChildren: 0 }
    },
  }
}
