import { z } from 'zod'

/**
 * What the vision model must answer before a package event is emitted
 * when a packages rule has "Confirm with the LLM" on.
 *
 * `package` is the verdict. `confidence` is 0..1. `reason` is the model's
 * one-line explanation, stored on the event so a drop is not silent.
 */
export const PackageLlmVerdictSchema = z.object({
  package: z.boolean(),
  confidence: z.number().min(0).max(1),
  reason: z.string().min(1),
})
export type PackageLlmVerdict = z.infer<typeof PackageLlmVerdictSchema>
