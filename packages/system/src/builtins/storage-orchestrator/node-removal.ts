/**
 * The storage orchestrator's side of `node-removal-hook` (#265).
 *
 * A storage location that lives on a forgotten node can no longer be reached,
 * but what it holds (recordings, the index over them) is the operator's data:
 * the location is DISABLED, never removed. The operator deletes the row by hand
 * when they decide the data is not wanted. Idempotent — a location already
 * disabled is skipped, so a retry or the boot re-drive answers zero.
 */
import { resolveLocationMode } from '@camstack/types'
import type { INodeRemovalHookProvider, IScopedLogger } from '@camstack/types'
import type { StorageOrchestratorService } from './storage-orchestrator.service.js'

export interface NodeRemovalDeps {
  readonly service: Pick<
    StorageOrchestratorService,
    'listLocations' | 'disableLocationOfForgottenNode'
  >
  readonly logger: IScopedLogger
}

export function createNodeRemovalHook(deps: NodeRemovalDeps): INodeRemovalHookProvider {
  return {
    onNodeRemoved: async ({ nodeId }) => {
      let disabled = 0
      for (const location of deps.service.listLocations()) {
        if (location.nodeId !== nodeId) continue
        if (resolveLocationMode(location) === 'disabled') continue
        await deps.service.disableLocationOfForgottenNode(location.id)
        disabled += 1
        deps.logger.info('disabled a storage location on a forgotten node', {
          meta: { nodeId, locationId: location.id },
        })
      }
      return { counts: { 'storage-locations': disabled } }
    },
  }
}
