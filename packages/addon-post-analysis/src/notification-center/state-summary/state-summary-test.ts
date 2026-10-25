/**
 * What TESTING a state-summary rule answers (D698, `nc.testRule`).
 *
 * A summary rule sends nothing per event (D647), so the per-event test the
 * other rules get — one synthetic event, injected — can never deliver for it.
 * Its test builds the summary NOW and enqueues it; this is the report: the
 * rows it enqueued (one, or one per section) and every section's read, so
 * "nothing to report" is an answer with its reason per section, never a
 * silence.
 */

import { NcStateSummarySectionIdSchema } from '@camstack/types'
import { z } from 'zod'

export const NcStateSummaryTestSchema = z.object({
  /** The test's record id — a per-section row appends `:<sectionId>`. */
  recordId: z.string(),
  split: z.enum(['rule', 'section']),
  /** Nothing open and every section read: nothing was enqueued. */
  nothingToReport: z.boolean(),
  sections: z.array(
    z.object({
      id: NcStateSummarySectionIdSchema,
      status: z.enum(['read', 'unavailable']),
      items: z.number().int().nonnegative(),
      reason: z.string().optional(),
    }),
  ),
  rows: z.array(
    z.object({
      recordId: z.string(),
      /** The section of a per-section row. */
      section: NcStateSummarySectionIdSchema.optional(),
      enqueued: z.number().int().nonnegative(),
      targetIds: z.array(z.string()),
    }),
  ),
})
export type NcStateSummaryTest = z.infer<typeof NcStateSummaryTestSchema>
