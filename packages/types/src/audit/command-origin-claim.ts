import { z } from 'zod'

/** Where a command's origin claim comes from: an addon states WHY it called, never WHO it is. */
export const CommandOriginClaimSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('action'),
    actionId: z.string(),
    runId: z.string(),
    automationId: z.string().optional(),
  }),
  z.object({ kind: z.literal('scheduler'), schedulerId: z.string() }),
])
export type CommandOriginClaim = z.infer<typeof CommandOriginClaimSchema>
