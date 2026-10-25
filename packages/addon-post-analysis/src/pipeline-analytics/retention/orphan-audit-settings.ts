/**
 * Operator knobs for the orphan audit.
 *
 * These are SETTINGS rather than constants because the right numbers depend on
 * the hub's load, and the hub's load is not something this code can know. The
 * main thread has been measured at 70–95% with 42 s of synchronous blocks in a
 * 120 s window, and `better-sqlite3` runs in that thread — so an operator who
 * sees the audit in a flame graph needs to be able to make it smaller without a
 * release.
 *
 * `mode` defaults to `'reclaim'` as of 2026-08-30 (D304). It defaulted to
 * `'report'` from the day the engine shipped, and that default was right for
 * exactly as long as its premise held — see {@link OrphanAuditModeSchema}.
 */
import { z } from 'zod'

export const ORPHAN_AUDIT_MODE_SETTING = 'orphanAuditMode'
export const ORPHAN_AUDIT_INTERVAL_SETTING = 'orphanAuditIntervalHours'
export const ORPHAN_AUDIT_PAGE_SIZE_SETTING = 'orphanAuditPageSize'

/**
 * `'reclaim'` is the default. Here is the argument, because reversing a
 * destructive default needs one on the record.
 *
 * The original default was `'report'`, and `orphan-audit.ts` states its reason
 * precisely: *"this engine's correctness rests entirely on an ownership model
 * that is being rewritten in the same change"*. Report mode existed to make
 * that model observable BEFORE it was load-bearing.
 *
 * That premise is spent. The model has run in production for weeks and has been
 * read: the `faces` scope reported 99 orphans among its oldest 300 rows and all
 * 99 were `assigned`, i.e. the exemption doing exactly what it claims; the
 * vector index reported 956 orphans per pass, of which the D58 re-derivability
 * check (a vector whose track is gone can neither be re-embedded nor returned)
 * accounts for all of them. What report mode had left to prove, it proved.
 *
 * What it did instead was nothing, forever. `reclaimed: 0` was logged every six
 * hours against a standing backlog, and a backstop that never acts is not a
 * backstop — it is a leftover that describes the right design, which this repo
 * has decided reads as verification and is worse than an absence.
 *
 * The blast radius is unchanged and bounded five ways (exempt owner kinds, the
 * grace window, probe-failure abandons the scope, an unresolvable row is kept,
 * and a per-scope reclaim ceiling that shows up in the report as `stoppedBy`).
 * An operator who wants observation-only sets `orphanAuditMode: 'report'` and
 * gets exactly the old behaviour; the knob did not move, only its default.
 *
 * NOTE what this does NOT change: an OPERATOR-triggered pass
 * (`retention.orphanAudit`) is still dry-run unless it names `mode` — it never
 * inherits this setting. Reclaiming on demand is still a word you have to type.
 */
export const OrphanAuditModeSchema = z.enum(['report', 'reclaim']).default('reclaim')

/** Hours between passes. Hours, not minutes — this walks whole collections. */
export const OrphanAuditIntervalHoursSchema = z.number().min(1).max(168).default(6)

export const OrphanAuditPageSizeSchema = z.number().int().min(50).max(5_000).default(500)

export const ORPHAN_AUDIT_DEFAULTS = {
  mode: OrphanAuditModeSchema.parse(undefined),
  intervalHours: OrphanAuditIntervalHoursSchema.parse(undefined),
  pageSize: OrphanAuditPageSizeSchema.parse(undefined),
} as const

export type OrphanAuditSettings = {
  readonly mode: z.infer<typeof OrphanAuditModeSchema>
  readonly intervalHours: z.infer<typeof OrphanAuditIntervalHoursSchema>
  readonly pageSize: z.infer<typeof OrphanAuditPageSizeSchema>
}
