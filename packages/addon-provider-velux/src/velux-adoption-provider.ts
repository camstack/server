import {
  type AdoptionFilter,
  type AdoptionStatus,
  type DiscoveredChildDevice,
  errMsg,
  type IDeviceAdoptionProvider,
  type IScopedLogger,
} from '@camstack/types'
import type { VeluxNode } from './velux-client-contract.js'
import { buildVeluxCandidates, type ResolvedNativeId, resolveNativeId } from './velux-discovery.js'

export interface VeluxAdoptionProviderDeps {
  readonly hasIntegration: (integrationId: string) => boolean
  readonly listIntegrations: () => readonly string[]
  readonly integrationName: (integrationId: string) => string
  readonly isOnline: (integrationId: string) => boolean
  readonly nodesOf: (integrationId: string) => readonly VeluxNode[]
  readonly listAdopted: () => Promise<
    ReadonlyArray<{ readonly id: number; readonly config: Record<string, unknown> }>
  >
  readonly adoptDevice: (input: {
    readonly integrationId: string
    readonly nativeId: string
    readonly resolved: ResolvedNativeId
    readonly name: string
  }) => Promise<{ readonly deviceId: number }>
  readonly removeDevice: (camDeviceId: number) => Promise<void>
  readonly findDeviceConfig: (camDeviceId: number) => Promise<Record<string, unknown> | null>
  readonly logger: IScopedLogger
}

const DEVICES_FILTER: AdoptionFilter = { id: 'devices', label: 'Devices', isDefault: true } as const

/** Native id → CamStack device id, for the top-level Velux devices of one integration. */
async function adoptedMapForIntegration(
  integrationId: string,
  listAdopted: VeluxAdoptionProviderDeps['listAdopted'],
): Promise<ReadonlyMap<string, number>> {
  const map = new Map<string, number>()
  for (const device of await listAdopted()) {
    const { config } = device
    if (config['system'] !== 'velux' || config['integrationId'] !== integrationId) continue
    const nativeId = config['nativeId']
    if (typeof nativeId === 'string') map.set(nativeId, device.id)
  }
  return map
}

export function buildVeluxAdoptionProvider(
  deps: VeluxAdoptionProviderDeps,
): IDeviceAdoptionProvider {
  const { listAdopted, logger } = deps

  async function candidatesFor(integrationId: string): Promise<readonly DiscoveredChildDevice[]> {
    return buildVeluxCandidates({
      integrationId,
      integrationName: deps.integrationName(integrationId),
      online: deps.isOnline(integrationId),
      nodes: deps.nodesOf(integrationId),
      adopted: await adoptedMapForIntegration(integrationId, listAdopted),
    })
  }

  return {
    listCandidateFilters: async () => ({ filters: [DEVICES_FILTER] }),

    listCandidates: async ({ integrationId, page, pageSize, filterText }) => {
      let filtered = [...(await candidatesFor(integrationId))]
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

    getCandidate: async ({ integrationId, childNativeId }) =>
      (await candidatesFor(integrationId)).find((c) => c.childNativeId === childNativeId) ?? null,

    getStatus: async () => {
      try {
        let candidateCount = 0
        let adoptedCount = 0
        for (const integrationId of deps.listIntegrations()) {
          candidateCount += (await candidatesFor(integrationId)).length
          adoptedCount += (await adoptedMapForIntegration(integrationId, listAdopted)).size
        }
        return {
          lastDiscoveryAt: Date.now(),
          candidateCount,
          adoptedCount,
          lastError: null,
        } satisfies AdoptionStatus
      } catch (err: unknown) {
        logger.warn('velux adoption: getStatus failed', { meta: { error: errMsg(err) } })
        return {
          lastDiscoveryAt: null,
          candidateCount: 0,
          adoptedCount: 0,
          lastError: errMsg(err),
        } satisfies AdoptionStatus
      }
    },

    refresh: async ({ integrationId }) => ({
      lastDiscoveryAt: Date.now(),
      candidateCount: (await candidatesFor(integrationId)).length,
      adoptedCount: (await adoptedMapForIntegration(integrationId, listAdopted)).size,
      lastError: null,
    }),

    adopt: async ({ integrationId, childNativeIds, perCandidate }) => {
      if (!deps.hasIntegration(integrationId)) {
        throw new Error(`velux adopt: integration ${integrationId} is not running`)
      }
      const nodes = deps.nodesOf(integrationId)
      const candidates = await candidatesFor(integrationId)
      const adoptedBefore = await adoptedMapForIntegration(integrationId, listAdopted)
      const adopted: {
        readonly childNativeId: string
        readonly parentDeviceId: number
        readonly accessoryDeviceIds: readonly number[]
      }[] = []
      let failures = 0

      for (const nativeId of childNativeIds) {
        try {
          const existing = adoptedBefore.get(nativeId)
          if (existing !== undefined) {
            adopted.push({
              childNativeId: nativeId,
              parentDeviceId: existing,
              accessoryDeviceIds: [],
            })
            continue
          }
          const resolved = resolveNativeId(integrationId, nodes, nativeId)
          if (resolved === null) {
            logger.warn('velux adopt: candidate is not adoptable', {
              meta: { integrationId, nativeId },
            })
            failures++
            continue
          }
          const fallbackName =
            candidates.find((c) => c.childNativeId === nativeId)?.name ?? nativeId
          const name = perCandidate?.[nativeId]?.name ?? fallbackName
          const { deviceId } = await deps.adoptDevice({ integrationId, nativeId, resolved, name })
          adopted.push({
            childNativeId: nativeId,
            parentDeviceId: deviceId,
            accessoryDeviceIds: [],
          })
        } catch (err: unknown) {
          logger.warn('velux adopt: failed', {
            meta: { integrationId, nativeId, error: errMsg(err) },
          })
          failures++
        }
      }

      if (adopted.length === 0 && failures > 0) {
        throw new Error(`velux adopt: all ${failures} adopt(s) failed`)
      }
      return { adopted }
    },

    release: async ({ camDeviceId }) => {
      await deps.removeDevice(camDeviceId)
    },

    resync: async ({ camDeviceId }) => {
      const cfg = await deps.findDeviceConfig(camDeviceId)
      if (cfg === null) throw new Error(`velux resync: device ${camDeviceId} not found`)
      if (cfg['system'] !== 'velux') {
        throw new Error(`velux resync: device ${camDeviceId} is not a Velux device`)
      }
      const integrationId = String(cfg['integrationId'])
      const nativeId = String(cfg['nativeId'])
      if (!deps.hasIntegration(integrationId)) {
        throw new Error(`velux resync: integration ${integrationId} is not running`)
      }
      if (resolveNativeId(integrationId, deps.nodesOf(integrationId), nativeId) === null) {
        throw new Error(`velux resync: ${nativeId} is no longer on the gateway`)
      }
      return { changed: false, rebuiltChildren: 0 }
    },
  }
}
