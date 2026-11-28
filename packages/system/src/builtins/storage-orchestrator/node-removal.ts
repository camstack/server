/**
 * The storage orchestrator's side of `node-removal-hook` (#265).
 *
 * A storage location that lives on a forgotten node can no longer be reached,
 * but what it holds (recordings, the index over them) is the operator's data:
 * the location is DISABLED, never removed. The operator deletes the row by hand
 * when they decide the data is not wanted. Idempotent — a location already
 * disabled is skipped, so a retry or the boot re-drive answers zero.
 */
import { resolveLocationMode } from '@dominevo/types'
import type { INodeRemovalHookProvider, IScopedLogger, StorageLocation } from '@dominevo/types'
import type { StorageOrchestratorService } from './storage-orchestrator.service.js'

export interface NodeRemovalDeps {
  readonly service: Pick<
    StorageOrchestratorService,
    'listLocations' | 'disableLocationOfForgottenNode'
  >
  readonly logger: IScopedLogger
  /**
   * Called after each location is disabled and persisted: the owner announces the
   * change (`StorageLocationsChanged`) and re-evaluates writability, as every
   * other door does, so consumers and the no-writable-location alert see it.
   */
  readonly onChanged: (location: StorageLocation) => void
}

export function createNodeRemovalHook(deps: NodeRemovalDeps): INodeRemovalHookProvider {
  return {
    onNodeRemoved: async ({ nodeId }) => {
      let disabled = 0
      for (const location of deps.service.listLocations()) {
        if (location.nodeId !== nodeId) continue
        if (resolveLocationMode(location) === 'disabled') continue
        try {
          await deps.service.disableLocationOfForgottenNode(location.id)
        } catch (err) {
          deps.logger.error('could not disable a storage location on a forgotten node', {
            meta: {
              nodeId,
              locationId: location.id,
              error: err instanceof Error ? err.message : String(err),
            },
          })
          throw err
        }
        disabled += 1
        deps.onChanged(location)
        deps.logger.info('disabled a storage location on a forgotten node', {
          meta: { nodeId, locationId: location.id },
        })
      }
      return { counts: { 'storage-locations': disabled } }
    },
  }
}
