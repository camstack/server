/**
 * addon-ai's side of `node-removal-hook` (#265).
 *
 * A profile bound to a node (a `managed-local` runtime or an `apple-foundation`
 * row) only means something on that node: it cannot be re-pointed (the model
 * file and the platform are the node's), so a forgotten node's profiles are
 * REMOVED. Idempotent — a second call finds nothing and answers zero.
 */
import type { INodeRemovalHookProvider, IScopedLogger, LlmProfile } from '@camstack/types'
import { AppleConnectionSchema } from './kinds/provider-config.js'
import type { ProfileStore } from './profile-store.js'

export interface NodeRemovalDeps {
  readonly store: Pick<ProfileStore, 'list' | 'delete'>
  readonly logger: IScopedLogger
}

/** The node a profile is bound to; `null` = it runs wherever the endpoint is. */
function boundNodeOf(profile: LlmProfile): string | null {
  if (profile.kind !== 'managed-local' && profile.kind !== 'apple-foundation') return null
  // Only `nodeId` is read: a row whose runtime config is otherwise broken must
  // still go when its node is forgotten.
  const parsed = AppleConnectionSchema.safeParse(profile.providerConfig)
  return parsed.success ? parsed.data.nodeId : null
}

export function createNodeRemovalHook(deps: NodeRemovalDeps): INodeRemovalHookProvider {
  return {
    onNodeRemoved: async ({ nodeId }) => {
      let removed = 0
      for (const profile of await deps.store.list()) {
        if (boundNodeOf(profile) !== nodeId) continue
        await deps.store.delete(profile.id)
        removed += 1
        deps.logger.info('removed an LLM profile bound to a forgotten node', {
          meta: { nodeId, profileId: profile.id, kind: profile.kind },
        })
      }
      return { counts: { 'llm-profiles': removed } }
    },
  }
}
