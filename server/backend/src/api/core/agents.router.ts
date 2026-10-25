/**
 * Agents router — fixed core API (not a capability).
 *
 * Thin binding over AgentRegistryService which now delegates to Moleculer
 * for node discovery and health. Only role-assignment management and
 * node listing remain; protocol endpoints (register, heartbeat, task
 * dispatch) are handled natively by the Moleculer service mesh.
 */
import { z } from 'zod'
import type { AgentRegistryService } from '../../core/agent/agent-registry.service.js'
import type { MoleculerService } from '../../core/moleculer/moleculer.service.js'
import { trpcRouter, adminProcedure } from '../trpc/trpc.middleware.js'

const AgentRoleSchema = z.enum(['decoder', 'transcoder', 'detector', 'recorder'])

export function createAgentsRouter(ar: AgentRegistryService, moleculer: MoleculerService) {
  return trpcRouter({
    // ── Node listing (replaces listAgents / listConnected) ────────────
    listNodes: adminProcedure.input(z.void()).query(async () => {
      const items = await ar.listNodes()
      // Spread to mutable copies: AgentListItem uses readonly arrays; Zod output schema uses mutable.
      return items.map((a) => ({
        ...a,
        info: {
          ...a.info,
          capabilities: [...a.info.capabilities],
        },
        status: {
          ...a.status,
          fps: { ...a.status.fps },
          errors: [...a.status.errors],
        },
        subProcesses: [...a.subProcesses],
      }))
    }),

    // ── Capability discovery (via Moleculer service list) ─────────────
    getAgentCapabilities: adminProcedure.input(z.void()).query(async () => {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access -- moleculer.broker.call typing chain unresolvable; runtime shape validated by the cast below
      const services = (await moleculer.broker.call('$node.services', {})) as Array<{
        name: string
      }>
      const capSet = new Set<string>()
      for (const svc of services) {
        if (svc.name.startsWith('$')) continue
        capSet.add(svc.name)
      }
      return [...capSet].toSorted()
    }),

    // ── Role assignments ──────────────────────────────────────────────
    getAssignments: adminProcedure
      .input(z.object({ cameraId: z.number().optional() }))
      .query(({ input }) => ar.getAssignments(input.cameraId)),

    setAssignment: adminProcedure
      .input(
        z.object({
          cameraId: z.number(),
          role: AgentRoleSchema,
          agentId: z.string(),
          priority: z.enum(['primary', 'backup', 'overflow']),
          rtspUrl: z.string().optional(),
        }),
      )
      .mutation(({ input }) => ar.setAssignment(input as never)),

    removeAssignment: adminProcedure
      .input(
        z.object({
          cameraId: z.number(),
          role: AgentRoleSchema,
        }),
      )
      .mutation(({ input }) => ar.removeAssignment(input.cameraId, input.role as never)),

    activateBackup: adminProcedure
      .input(
        z.object({
          cameraId: z.number(),
          role: AgentRoleSchema,
        }),
      )
      .mutation(({ input }) => ar.activateBackup(input.cameraId, input.role as never)),
  })
}
