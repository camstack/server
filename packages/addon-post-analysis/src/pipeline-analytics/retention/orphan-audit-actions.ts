/**
 * The operator button for the orphan audit.
 *
 * The pass is tens of minutes on a standing backlog. The button STARTS it and
 * returns `{ started, alreadyRunning }` immediately — awaiting it is how this
 * door hit the 60 s UDS deadline. Progress is `retention.orphanAuditStatus`.
 *
 * Three properties this action does NOT leave to the caller's care:
 *
 *  1. **Dry run is the default.** `mode` omitted means `report`. `reclaim` is
 *     a word that has to be typed. The engine's own default is the same.
 *  2. **It is paced.** `pageSize` bounds one read, `maxRowsPerScope` bounds
 *     one pass, `maxReclaimPerScope` bounds the damage, and the engine yields
 *     the thread between pages.
 *  3. **It answers via status.** Poll `retention.orphanAuditStatus` for rows
 *     AND bytes; the start RPC is only an acknowledgement.
 */

import { customAction, defineCustomActions } from '@camstack/types'
import { z } from 'zod'

/**
 * `report` counts; `reclaim` deletes.
 *
 * `.default('report')` is load-bearing: the settings form sends `{}` for a
 * button with no fields, and the safe reading of an unstated intent is the one
 * that destroys nothing.
 */
const OrphanAuditActionModeSchema = z.enum(['report', 'reclaim']).default('report')

export const OrphanAuditActionInputSchema = z.object({
  mode: OrphanAuditActionModeSchema,
  /**
   * Start every scope from the top instead of resuming its persisted cursor.
   *
   * What draining a backlog wants, and never the default — the cursor exists
   * so a 6-hourly pass makes progress instead of re-walking the same head.
   */
  restart: z.boolean().optional(),
  /** Rows read per statement. Smaller = more yields = a gentler pass. */
  pageSize: z.number().int().min(50).max(5_000).optional(),
  /** Rows EXAMINED per collection in this pass — the pacing bound. */
  maxRowsPerScope: z.number().int().min(1).max(200_000).optional(),
  /** Rows DELETED per collection in this pass — the blast-radius bound. */
  maxReclaimPerScope: z.number().int().min(1).max(100_000).optional(),
  /**
   * Minutes of immunity for a recent row. Protective ONLY — raising it can
   * exclusively save rows, never select them.
   */
  graceMinutes: z.number().int().min(1).max(10_080).optional(),
})

const OrphanAuditStartedSchema = z.object({
  started: z.boolean(),
  alreadyRunning: z.boolean(),
})

const OrphanAuditStatusSchema = z.object({
  running: z.boolean(),
  mode: z.enum(['report', 'reclaim']).nullable(),
  complete: z.boolean().nullable(),
  totalOrphans: z.number(),
  totalReclaimed: z.number(),
  totalBytesReclaimed: z.number(),
  startedAtMs: z.number().nullable(),
  finishedAtMs: z.number().nullable(),
  error: z.string().nullable(),
})

export const orphanAuditActions = defineCustomActions({
  'retention.orphanAudit': customAction(OrphanAuditActionInputSchema, OrphanAuditStartedSchema, {
    auth: 'admin',
  }),
  'retention.orphanAuditStatus': customAction(z.object({}), OrphanAuditStatusSchema, {
    auth: 'admin',
  }),
})

export type OrphanAuditActions = typeof orphanAuditActions
export type OrphanAuditActionInput = z.infer<typeof OrphanAuditActionInputSchema>
export type OrphanAuditStartResult = z.infer<typeof OrphanAuditStartedSchema>
export type OrphanAuditStatus = z.infer<typeof OrphanAuditStatusSchema>

/** What one pass may override, resolved from {@link OrphanAuditActionInputSchema}. */
export interface OrphanAuditOverrides {
  readonly mode?: 'report' | 'reclaim'
  readonly restart?: boolean
  readonly pageSize?: number
  readonly maxRowsPerScope?: number
  readonly maxReclaimPerScope?: number
  readonly graceMinutes?: number
}
