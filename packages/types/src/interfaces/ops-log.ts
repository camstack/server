/**
 * Ops-log — the durable, append-only operations audit shared by the
 * recordings and events management surfaces.
 *
 * ONE row shape is reused for both domains so a single "Activity" view can
 * merge the recorder's DurableState ring (recordings ops-log) and the
 * pipeline-analytics SQLite collection (events ops-log). Each row records a
 * management operation, WHY it ran (reason), and its measurable effect
 * (itemsAffected + bytesReclaimed). Writes are best-effort — a failed log must
 * never fail the operation it records.
 */
import { z } from 'zod'

/** Which management domain the operation belongs to. */
export const OpsLogDomainSchema = z.enum(['recording', 'events'])
export type OpsLogDomain = z.infer<typeof OpsLogDomainSchema>

/** The kind of management operation performed. */
export const OpsLogOpSchema = z.enum([
  'prune',
  'manual-delete',
  'rescan',
  'retention-run',
  'relocate',
  /**
   * The ownership-keyed ORPHAN AUDIT (D61) — deliberately NOT `'prune'`.
   *
   * A prune selects by age and is the retention sweep. This selects by
   * ownership, has no cutoff, and in its default mode deletes nothing at all.
   * Sharing the op would make the two indistinguishable in the audit trail,
   * which is exactly what a reader needs to tell apart when asking "did
   * retention delete this, or did something else?".
   */
  'orphan-audit',
])
export type OpsLogOp = z.infer<typeof OpsLogOpSchema>

/** Why the operation ran. */
export const OpsLogReasonSchema = z.enum([
  'retention',
  'quota',
  'manual',
  'operator',
  /** A periodic consistency pass — not a retention policy taking effect. */
  'maintenance',
  /**
   * Disk pressure freed this, and it was chosen because the CAMERA IT BELONGS
   * TO NO LONGER EXISTS — not because it was the oldest thing on the disk.
   *
   * Deliberately distinct from `'quota'`, which is the same trigger picking
   * age-first. An operator reading the Activity table has exactly one question
   * after a disk fills — "did I lose footage of a camera I still have?" — and
   * one reason for both would make that unanswerable. Nothing SELECTS this
   * reason: it is only ever written, by the eviction that made the choice.
   */
  'orphaned-device',
])
export type OpsLogReason = z.infer<typeof OpsLogReasonSchema>

/** One audit row, shared verbatim by both domains. */
export const OpsLogEntrySchema = z.object({
  /** Unique row id. */
  id: z.string(),
  /** Epoch ms the operation completed. */
  at: z.number(),
  domain: OpsLogDomainSchema,
  op: OpsLogOpSchema,
  reason: OpsLogReasonSchema,
  /** The camera the op targeted; null for a cluster/global op. */
  deviceId: z.number().nullable(),
  /** Node that performed the op (the log carries nodeId — no cross-node aggregation). */
  nodeId: z.string(),
  /** Buckets / rows deleted (op-specific unit). */
  itemsAffected: z.number(),
  /** Bytes reclaimed by the op (0 when not measurable). */
  bytesReclaimed: z.number(),
  /** Free-text detail (e.g. "floor moved to <ts>"); null when none. */
  detail: z.string().nullable(),
  /** Who/what triggered the op. */
  actor: z.string(),
})
export type OpsLogEntry = z.infer<typeof OpsLogEntrySchema>

/** Shared query input for the per-domain `listOpsLog` cap methods. */
export const OpsLogQueryInputSchema = z.object({
  /** Restrict to a single camera; omit for every row. */
  deviceId: z.number().optional(),
  /** Max rows returned, newest-first. */
  limit: z.number().int().min(1).max(1000).optional(),
})
export type OpsLogQueryInput = z.infer<typeof OpsLogQueryInputSchema>

/**
 * Default cap on the recorder's DurableState ops-log ring — the newest N rows
 * survive; older ones are evicted on append.
 */
export const OPS_LOG_RING_DEFAULT_MAX = 500

/** Default page size for a `listOpsLog` query when the caller omits `limit`. */
export const OPS_LOG_DEFAULT_LIMIT = 200
