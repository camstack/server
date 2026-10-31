/**
 * Model Studio's side of `node-removal-hook` (#265).
 *
 * The availability map says which model files each node holds (Library "On
 * nodes"). Those files lived on the forgotten node and are gone with it: its
 * entries are REMOVED — a ghost chip would claim a model is installed on a node
 * that no longer exists. A model left with no node is dropped from the map; the
 * Library registry row (the descriptor) is untouched, it is cluster-wide.
 *
 * Idempotent. The map is read through the durable handle; a failed read throws
 * so the hub retries (D49).
 */
import type { DurableState, INodeRemovalHookProvider, IScopedLogger } from '@camstack/types'
import type { z } from 'zod'
import type { ModelAvailabilityMapSchema } from './model-studio-actions.js'

type AvailabilityMap = z.infer<typeof ModelAvailabilityMapSchema>

/** `map` without `nodeId`'s entries, and how many (model, node) entries went. */
export function clearNodeAvailability(
  map: AvailabilityMap,
  nodeId: string,
): { next: AvailabilityMap; cleared: number } {
  const next: AvailabilityMap = {}
  let cleared = 0
  for (const [modelId, perNode] of Object.entries(map)) {
    if (!(nodeId in perNode)) {
      next[modelId] = perNode
      continue
    }
    cleared += 1
    const { [nodeId]: _gone, ...rest } = perNode
    if (Object.keys(rest).length > 0) next[modelId] = rest
  }
  return { next, cleared }
}

export interface NodeRemovalDeps {
  readonly availability: () => DurableState<AvailabilityMap>
  readonly logger: IScopedLogger
}

export function createNodeRemovalHook(deps: NodeRemovalDeps): INodeRemovalHookProvider {
  return {
    onNodeRemoved: async ({ nodeId }) => {
      let cleared = 0
      await deps.availability().update((prev) => {
        const result = clearNodeAvailability(prev, nodeId)
        cleared = result.cleared
        return cleared === 0 ? prev : result.next
      })
      deps.logger.info('cleared model availability of a forgotten node', {
        tags: { nodeId },
        meta: { cleared },
      })
      return { counts: { 'model-availability': cleared } }
    },
  }
}
