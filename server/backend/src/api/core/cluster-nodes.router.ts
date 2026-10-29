/**
 * Cluster-nodes router — fixed core API (not a capability).
 *
 * Exposes the durable offline-node history's write-side cleanup so the admin
 * UI's inline "Forget node" action can purge a node the operator never expects
 * to see again. Hand-written (not a `*.cap.ts`) on purpose: it needs no
 * per-provider routing and adding a cap method would force a full codegen pass.
 *
 * The read side (`getClusterNodeHistory`) is consumed server-side by
 * `computeTopology` and is intentionally NOT exposed here — the admin UI reads
 * offline rows off the pushed `cluster.topology-snapshot`, never by polling.
 */
import { z } from 'zod'
import type { AgentRegistryService } from '../../core/agent/agent-registry.service.js'
import { trpcRouter, adminProcedure } from '../trpc/trpc.middleware.js'

const ForgetNodeInputSchema = z.object({ nodeId: z.string().min(1) })

/**
 * What forgetting a node ACTUALLY removed.
 *
 * This used to be `{ success: boolean }`, returned as a hardcoded `true` that
 * never looked at `forgetClusterNode` (which returned `void`). On 2026-09-01
 * the operator forgot `hub-test` repeatedly, got `{"success": true}` every
 * time, and watched it stay on the Cluster page — because only one of the two
 * sources of its topology row was being purged. An action that changed nothing
 * must not answer `success`.
 */
const ForgetNodeResultSchema = z.object({
  /** At least one source of the node's topology row was purged. */
  forgotten: z.boolean(),
  /** The durable history row existed and is gone. */
  historyRemoved: z.boolean(),
  /** The Moleculer node-catalog entry existed and is gone. */
  registryRemoved: z.boolean(),
  /** Read back AFTER the attempt: the node is still in the cluster registry. */
  stillListed: z.boolean(),
  /** What happened to the node's mesh certificates: `registry-unavailable` / `failed` = NOT revoked. */
  certificates: z.discriminatedUnion('outcome', [
    z.object({ outcome: z.literal('not-attempted') }),
    z.object({ outcome: z.literal('revoked'), serials: z.array(z.string()) }),
    z.object({ outcome: z.literal('registry-unavailable') }),
    z.object({ outcome: z.literal('failed'), error: z.string() }),
  ]),
  /** One operator-grade sentence naming what happened. */
  message: z.string(),
})
const RepairNodeAddonsInputSchema = z.object({ nodeId: z.string().min(1) })

export function createClusterNodesRouter(agentRegistry: AgentRegistryService) {
  return trpcRouter({
    /**
     * The explicit half of the addon back-fill's trigger set.
     *
     * Everything automatic is gated: a node only converges up when it
     * registers, when the hub boots, and when the hub is NOT mid-delivery to
     * it — because the roster a node reports while the hub is writing to it is
     * not evidence of anything. Those gates are deliberately conservative, so
     * there has to be a way for an operator to say "this node really is
     * missing addons, put them back" without waiting for a restart.
     *
     * It grants no extra powers: it runs the same reconcile, against the same
     * roster the node itself declared, with the same circuit breaker. Nothing
     * can be repaired by hand that the node could not have converged to.
     */
    repairNodeAddons: adminProcedure
      .input(RepairNodeAddonsInputSchema)
      .output(z.object({ success: z.boolean() }))
      .mutation(async ({ input }) => {
        await agentRegistry.repairNodeAddons(input.nodeId)
        return { success: true }
      }),
    // Forget a node, online or offline: revoke its certificates, cut it from routing, purge its
    // persisted history. Pairs with `pipelineOrchestrator.removeAgentSettings` on the frontend
    // (per-node pipeline assignments).
    forgetNode: adminProcedure
      .input(ForgetNodeInputSchema)
      .output(ForgetNodeResultSchema)
      // The service's own result IS the answer — this procedure adds nothing
      // and, above all, asserts nothing.
      .mutation(({ input }) => agentRegistry.forgetClusterNode(input.nodeId)),
  })
}
