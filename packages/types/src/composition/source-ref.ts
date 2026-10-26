/**
 * A composition source identity: `(addonId, stableId)`, never a numeric device
 * id. Split out so helper schemas can name it without a cycle through
 * `composition.ts` (D659).
 */
import { z } from 'zod'

export const CompositionSourceRefSchema: z.ZodObject<{
  addonId: z.ZodString
  stableId: z.ZodString
}> = z.object({
  /** The owning addon; `stableId` is unique only within it. */
  addonId: z.string().min(1),
  stableId: z.string().min(1),
})
export type CompositionSourceRef = z.infer<typeof CompositionSourceRefSchema>
