/**
 * `node-removal-hook` — the reliable way an addon learns a cluster node was
 * FORGOTTEN, so it can remove or re-point what it keeps for that node. The
 * node-scoped twin of `device-removal-hook` (D865); same shape, same rules.
 *
 * ## Why not "the node is absent"
 *
 * A node missing from topology is offline, restarting or not yet re-registered —
 * it is not forgotten. Deleting node-scoped data from absence destroys a live
 * node's configuration on any failed or partial read (D49). So the hook is
 * driven by a TOMBSTONE the hub records when the operator forgets a node
 * (`AgentRegistryService.forgetClusterNode`); nothing else produces one.
 *
 * ## The pieces
 *
 * 1. The hub records a tombstone `{ nodeId, removedAt, pending }` before it calls
 *    anyone. `pending` is the set of implementers that have not yet acknowledged.
 * 2. The hub calls `onNodeRemoved` on EVERY provider of this collection, one by
 *    one, with bounded retries, logged; an acknowledgement removes the
 *    implementer from `pending`.
 * 3. The hub re-drives still-pending tombstones at boot, so an implementer that
 *    was down at forget time is told when it is back.
 *
 * ## Contract for an implementer
 *
 * - **Idempotent.** Called again by a retry and by the boot re-drive. A node with
 *   nothing left answers zero counts.
 * - **One key per store** in `counts`, rows changed per store, so the log line
 *   can say where the data was.
 * - **Re-point or remove, never guess.** A row that merely MENTIONS the node as
 *   a preference is re-pointed to "unset"; a row that only means something on
 *   that node (a runtime bound to it) is removed.
 * - A provider that cannot tell is allowed to throw; the caller retries it.
 */

import { z } from 'zod'
import { method, type CapabilityDefinition, type InferProvider } from './capability-definition.js'

/** What a hook is told about the removal. */
export const NodeRemovedInputSchema = z.object({
  nodeId: z.string().min(1),
  /** Epoch ms the node was forgotten (the tombstone's `removedAt`). */
  removedAt: z.number(),
})

export type NodeRemovedInput = z.infer<typeof NodeRemovedInputSchema>

/** Rows changed (removed or re-pointed), per store this implementer owns. */
export const NodeRemovedResultSchema = z.object({
  counts: z.record(z.string(), z.number().int().nonnegative()),
})

export type NodeRemovedResult = z.infer<typeof NodeRemovedResultSchema>

export const nodeRemovalHookCapability = {
  name: 'node-removal-hook',
  scope: 'system',
  mode: 'collection',
  internal: true,
  methods: {
    /** Remove or re-point everything this addon keeps for the forgotten node. Idempotent. */
    onNodeRemoved: method(NodeRemovedInputSchema, NodeRemovedResultSchema, {
      kind: 'mutation',
      auth: 'admin',
    }),
  },
  /** In-process only — enumerated through `addons.listCapabilityProviders`. */
  mount: { kind: 'skip' },
} as const satisfies CapabilityDefinition

export type INodeRemovalHookProvider = InferProvider<typeof nodeRemovalHookCapability>
