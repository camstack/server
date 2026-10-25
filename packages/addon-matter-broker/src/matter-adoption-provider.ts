import { errMsg, type IScopedLogger } from '@camstack/types'
import type {
  IDeviceAdoptionProvider,
  AdoptionStatus,
  AdoptionFilter,
  DiscoveredChildDevice,
} from '@camstack/types'
import type { MatterNodeSnapshot } from './matter-controller.js'
import { buildMatterNodeCandidate } from './matter-discovery.js'

/** Narrow registry surface consumed by the adoption provider. */
export interface MatterAdoptionRegistry {
  /** The live commissioned-node inventory for a broker (or [] when unknown). */
  getNodesForBroker(id: string): readonly MatterNodeSnapshot[]
  list(): readonly { readonly id: string; readonly name: string }[]
  has(id: string): boolean
}

export interface MatterAdoptionProviderDeps {
  readonly registry: MatterAdoptionRegistry
  readonly getBrokerIdForIntegration: (integrationId: string) => Promise<string>
  readonly listAdoptedMatter: () => Promise<
    ReadonlyArray<{ readonly id: number; readonly config: Record<string, unknown> }>
  >
  readonly adoptNode: (input: {
    readonly brokerId: string
    readonly nodeId: string
    readonly integrationId: string
    readonly name: string
  }) => Promise<{ readonly deviceId: number; readonly accessoryDeviceIds: readonly number[] }>
  readonly removeDevice: (camDeviceId: number) => Promise<void>
  readonly findDeviceConfig: (camDeviceId: number) => Promise<Record<string, unknown> | null>
  readonly logger: IScopedLogger
}

/** Single granularity: a whole Matter node adopts as one Container. */
const DEVICES_FILTER: AdoptionFilter = { id: 'devices', label: 'Devices', isDefault: true } as const

/** Resolve the adopted CamStack device id for a (broker, node), or null. */
async function adoptedNodeId(
  brokerId: string,
  nodeId: string,
  listAdoptedMatter: MatterAdoptionProviderDeps['listAdoptedMatter'],
): Promise<number | null> {
  for (const d of await listAdoptedMatter()) {
    if (
      d.config['system'] === 'matter' &&
      d.config['brokerId'] === brokerId &&
      d.config['nodeId'] === nodeId
    ) {
      return d.id
    }
  }
  return null
}

/**
 * Construct the `device-adoption` cap provider for the Matter addon. Pure
 * builder. One broker = one fabric; each commissioned node is a Container
 * candidate whose endpoints are preview accessory children. Mirrors the Ecowitt
 * adoption provider. Commissioning a NEW node is driven through the broker
 * `publish` action — once a node is commissioned it surfaces here as a candidate.
 */
export function buildMatterAdoptionProvider(
  deps: MatterAdoptionProviderDeps,
): IDeviceAdoptionProvider {
  const {
    registry,
    getBrokerIdForIntegration,
    listAdoptedMatter,
    adoptNode,
    removeDevice,
    findDeviceConfig,
    logger,
  } = deps

  async function candidatesForBroker(brokerId: string): Promise<DiscoveredChildDevice[]> {
    const nodes = registry.getNodesForBroker(brokerId)
    const out: DiscoveredChildDevice[] = []
    for (const node of nodes) {
      const adoptedDeviceId = await adoptedNodeId(brokerId, node.nodeId, listAdoptedMatter)
      out.push(buildMatterNodeCandidate({ node, adoptedDeviceId }))
    }
    return out
  }

  return {
    listCandidateFilters: async () => ({ filters: [DEVICES_FILTER] }),

    listCandidates: async ({ integrationId, page, pageSize }) => {
      const brokerId = await getBrokerIdForIntegration(integrationId)
      const candidates = await candidatesForBroker(brokerId)
      return { candidates, totalCount: candidates.length, page, pageSize }
    },

    getCandidate: async ({ integrationId, childNativeId }) => {
      const brokerId = await getBrokerIdForIntegration(integrationId)
      const candidates = await candidatesForBroker(brokerId)
      return candidates.find((c) => c.childNativeId === childNativeId) ?? null
    },

    getStatus: async () => {
      try {
        let candidateCount = 0
        for (const broker of registry.list()) {
          candidateCount += (await candidatesForBroker(broker.id)).length
        }
        const adopted = await listAdoptedMatter()
        const adoptedCount = adopted.filter((d) => d.config['system'] === 'matter').length
        return {
          lastDiscoveryAt: Date.now(),
          candidateCount,
          adoptedCount,
          lastError: null,
        } satisfies AdoptionStatus
      } catch (err: unknown) {
        logger.warn('matter adoption: getStatus failed', { meta: { error: errMsg(err) } })
        return {
          lastDiscoveryAt: null,
          candidateCount: 0,
          adoptedCount: 0,
          lastError: errMsg(err),
        } satisfies AdoptionStatus
      }
    },

    refresh: async ({ integrationId }) => {
      const brokerId = await getBrokerIdForIntegration(integrationId)
      const candidates = await candidatesForBroker(brokerId)
      const adopted = await listAdoptedMatter()
      const adoptedCount = adopted.filter(
        (d) => d.config['system'] === 'matter' && d.config['brokerId'] === brokerId,
      ).length
      return {
        lastDiscoveryAt: Date.now(),
        candidateCount: candidates.length,
        adoptedCount,
        lastError: null,
      } satisfies AdoptionStatus
    },

    adopt: async ({ integrationId, childNativeIds, perCandidate }) => {
      const brokerId = await getBrokerIdForIntegration(integrationId)
      if (!registry.has(brokerId)) {
        throw new Error(`matter adopt: broker ${brokerId} not connected`)
      }
      const nodes = registry.getNodesForBroker(brokerId)
      const adopted: {
        readonly childNativeId: string
        readonly parentDeviceId: number
        readonly accessoryDeviceIds: readonly number[]
      }[] = []
      let failures = 0

      for (const nativeId of childNativeIds) {
        const node = nodes.find((n) => n.nodeId === nativeId)
        if (node === undefined) {
          logger.warn('matter adopt: node not found in inventory — skipping', {
            meta: { nativeId, brokerId },
          })
          failures++
          continue
        }
        try {
          const name =
            perCandidate?.[nativeId]?.name ??
            (node.label.length > 0 ? node.label : `Matter node ${node.nodeId}`)
          const { deviceId, accessoryDeviceIds } = await adoptNode({
            brokerId,
            nodeId: node.nodeId,
            integrationId,
            name,
          })
          adopted.push({ childNativeId: nativeId, parentDeviceId: deviceId, accessoryDeviceIds })
        } catch (err: unknown) {
          logger.warn('matter adopt: failed to adopt node', {
            meta: { brokerId, nodeId: node.nodeId, error: errMsg(err) },
          })
          failures++
        }
      }

      if (adopted.length === 0 && failures > 0) {
        throw new Error(`matter adopt: all ${failures} adopt(s) failed`)
      }
      return { adopted }
    },

    release: async ({ camDeviceId }) => {
      await removeDevice(camDeviceId)
    },

    resync: async ({ camDeviceId }) => {
      const cfg = await findDeviceConfig(camDeviceId)
      if (cfg === null) throw new Error(`matter resync: device ${camDeviceId} not found`)
      if (cfg['system'] !== 'matter') {
        throw new Error(`matter resync: device ${camDeviceId} is not a Matter device`)
      }
      const brokerId = String(cfg['brokerId'])
      if (!registry.has(brokerId)) {
        throw new Error(`matter resync: broker ${brokerId} no longer connected`)
      }
      // The node Container re-derives its endpoint children LIVE; a full
      // structural drift report is a follow-up.
      return { changed: false, rebuiltChildren: 0 }
    },
  }
}
