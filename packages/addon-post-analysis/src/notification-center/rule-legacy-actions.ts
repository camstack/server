/**
 * The READ projection of a stored rule whose `actions` block still has the shape
 * the notification centre wrote before rules ran existing Actions (planning#473):
 * hook bindings (`{ kind: 'sequence' | 'do', … }`) and buttons naming a
 * `sequenceId`.
 *
 * Zod would reject such a row as a whole and the rule would drop out of the
 * mirror — a rule that notified yesterday going silent. The projection drops
 * ONLY the `actions` block from the in-RAM candidate, so the rule still
 * notifies; its work waits for the boot migration
 * (`migrations/rule-actions-to-actions.ts`) that rewrites the stored row. The
 * store row is never touched here (D49: a read does not destroy).
 */
import { NcRuleActionsSchema } from '@camstack/types'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export interface NcLegacyActionsProjection {
  readonly candidate: unknown
  /** True when an `actions` block in the old shape was left out of the candidate. */
  readonly dropped: boolean
}

export function withoutLegacyActions(candidate: unknown): NcLegacyActionsProjection {
  if (!isRecord(candidate) || candidate['actions'] === undefined) {
    return { candidate, dropped: false }
  }
  if (NcRuleActionsSchema.safeParse(candidate['actions']).success) {
    return { candidate, dropped: false }
  }
  const { actions: _legacy, ...rest } = candidate
  return { candidate: rest, dropped: true }
}
