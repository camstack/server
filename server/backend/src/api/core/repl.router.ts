/**
 * REPL router — fixed core API (not a capability).
 *
 * The REPL engine is a single NestJS-backed service in the backend
 * (`ReplEngineService` extends `ReplEngine` from `@camstack/system`).
 * Only super_admin can execute code.
 */
import { z } from 'zod'
import type { ReplEngineService } from '../../core/repl/repl-engine.service.js'
import { trpcRouter, adminProcedure } from '../trpc/trpc.middleware.js'

const ReplScopeSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('system') }),
  z.object({ type: z.literal('device'), deviceId: z.number() }),
  z.object({ type: z.literal('provider'), providerId: z.string() }),
  z.object({ type: z.literal('addon'), addonId: z.string() }),
])

const ReplResultSchema = z.object({
  output: z.string(),
  error: z.string().optional(),
  duration: z.number().optional(),
})

export function createReplRouter(repl: ReplEngineService) {
  return trpcRouter({
    execute: adminProcedure
      .input(z.object({ code: z.string().max(10000), scope: ReplScopeSchema }))
      .output(ReplResultSchema)
      .mutation(({ input }) => repl.execute(input.code, { scope: input.scope, variables: {} })),

    completions: adminProcedure
      .input(z.object({ partial: z.string(), scope: ReplScopeSchema }))
      .output(z.array(z.string()).readonly())
      .query(({ input }) =>
        repl.getCompletions(input.partial, { scope: input.scope, variables: {} }),
      ),
  })
}
