/**
 * The operator button for the debug-media reclaim.
 *
 * The pass is tens of minutes. The button STARTS it and returns
 * `{ started, alreadyRunning }` immediately — the same shape as the CLIP
 * rebuild button. Progress is `retention.mediaReclaimStatus`. Awaiting the
 * walk is how this door hit the 60 s UDS deadline.
 *
 * `mode` omitted means `report`. `reclaim` is a word that has to be typed.
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
const MediaReclaimActionModeSchema = z.enum(['report', 'reclaim']).default('report')

const MediaReclaimScopeSchema = z.enum(['motion-still', 'track-filmstrip'])

export const MediaReclaimActionInputSchema = z.object({
  mode: MediaReclaimActionModeSchema,
  /** Which populations to walk. Omitted = both. */
  scopes: z.array(MediaReclaimScopeSchema).min(1).optional(),
  /** Restrict to these cameras. Omitted = every camera in retention scope. */
  deviceIds: z.array(z.number().int()).min(1).optional(),
  /** Start every device from the top instead of resuming its cursor. */
  restart: z.boolean().optional(),
  /** Rows read per statement. Smaller = more yields = a gentler pass. */
  pageSize: z.number().int().min(50).max(5_000).optional(),
  /** Rows EXAMINED per camera in this pass — the pacing bound. */
  maxRowsPerDevice: z.number().int().min(1).max(500_000).optional(),
  /** Rows DELETED per camera in this pass — the blast-radius bound. */
  maxReclaimPerDevice: z.number().int().min(1).max(500_000).optional(),
  /** Bytes released across the whole run — the disk-contention bound. */
  maxBytesPerRun: z.number().int().min(1).optional(),
  /** Wall-clock ceiling for the run. */
  budgetMinutes: z.number().int().min(1).max(720).optional(),
  /**
   * Bytes per second the pass may release. The recordings volume sustains
   * ~4 MB/s and the archive needs it more than this does; the default is half
   * of that.
   */
  throttleBytesPerSec: z
    .number()
    .int()
    .min(64 * 1024)
    .optional(),
  /**
   * Minutes of immunity for a recent row. Protective ONLY — raising it can
   * exclusively save rows, never select them.
   */
  graceMinutes: z.number().int().min(1).max(10_080).optional(),
})

const MediaReclaimStartedSchema = z.object({
  started: z.boolean(),
  alreadyRunning: z.boolean(),
})

const MediaReclaimStatusSchema = z.object({
  running: z.boolean(),
  mode: z.enum(['report', 'reclaim']).nullable(),
  totalExamined: z.number(),
  totalEligible: z.number(),
  totalReclaimed: z.number(),
  totalBytesReclaimed: z.number(),
  totalRefused: z.number(),
  devicesDone: z.number(),
  complete: z.boolean().nullable(),
  startedAtMs: z.number().nullable(),
  finishedAtMs: z.number().nullable(),
  error: z.string().nullable(),
})

export const mediaReclaimActions = defineCustomActions({
  'retention.mediaReclaim': customAction(MediaReclaimActionInputSchema, MediaReclaimStartedSchema, {
    auth: 'admin',
  }),
  'retention.mediaReclaimStatus': customAction(z.object({}), MediaReclaimStatusSchema, {
    auth: 'admin',
  }),
})

export type MediaReclaimActions = typeof mediaReclaimActions
export type MediaReclaimActionInput = z.infer<typeof MediaReclaimActionInputSchema>
export type MediaReclaimStarted = z.infer<typeof MediaReclaimStartedSchema>
