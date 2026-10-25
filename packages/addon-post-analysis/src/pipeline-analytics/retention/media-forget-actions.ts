/**
 * The operator door for the NARROW media-row forget (`media-row-forget.ts`).
 *
 * It forgets `pipeline-analytics:media` rows stamped with ONE location whose
 * file is provably gone, and nothing else: no event, track, object-event,
 * face, plate or identity row is read for deletion, ever. Contrast
 * `storage.discardLocation`, which wipes the disk AND cascades owners.
 *
 * `dryRun` defaults to `true`: an unstated intent destroys nothing. Applying
 * also requires `expectAbsent` — the `absent` count a dry run just reported —
 * so the forget only ever deletes a population a human has already read.
 */

import { customAction, defineCustomActions } from '@camstack/types'
import { z } from 'zod'

/** Hard ceiling on rows one call examines — the call is synchronous. */
export const MEDIA_FORGET_MAX_ROWS = 50_000

export const MediaForgetInputSchema = z.object({
  locationId: z.string().min(1),
  /** Restrict to these cameras. Omitted = every row stamped with the location. */
  deviceIds: z.array(z.number().int()).min(1).optional(),
  dryRun: z.boolean().default(true),
  /**
   * Required when `dryRun` is false: the `totals.absent` of the dry run. A
   * different count at apply time refuses the whole call before any delete.
   */
  expectAbsent: z.number().int().nonnegative().optional(),
  /** Rows examined in this call. Default and max {@link MEDIA_FORGET_MAX_ROWS}. */
  maxRows: z.number().int().min(1).max(MEDIA_FORGET_MAX_ROWS).optional(),
  /** Detailed rows returned per verdict. Default 20. */
  sampleSize: z.number().int().min(0).max(500).optional(),
})

const VerdictCountsSchema = z.object({
  rows: z.number(),
  /** File answered ENOENT — the only verdict that may be forgotten. */
  absent: z.number(),
  /** File is there: relocation is incomplete. Never forgotten. */
  present: z.number(),
  /** The stat failed with any errno other than ENOENT. Never forgotten. */
  error: z.number(),
  /** No path, a path escaping the root, or a retention-exempt owner. Never forgotten. */
  kept: z.number(),
  /** Rows actually deleted (0 on a dry run). */
  deleted: z.number(),
})

const MediaForgetSampleSchema = z.object({
  mediaId: z.number(),
  deviceId: z.number(),
  kind: z.string(),
  ownerKind: z.string(),
  ownerId: z.string(),
  path: z.string(),
  /** The errno (error) or the reason (kept); absent otherwise. */
  reason: z.string().optional(),
})

const MediaForgetResultSchema = z.object({
  locationId: z.string(),
  dryRun: z.boolean(),
  root: z.string(),
  /** Rows of this location that were not examined because `maxRows` was hit. */
  truncated: z.boolean(),
  totals: VerdictCountsSchema,
  byDevice: z.array(VerdictCountsSchema.extend({ deviceId: z.number() })),
  byKind: z.array(VerdictCountsSchema.extend({ kind: z.string() })),
  /** Every id the call deletes (dry run: would delete). The exact list. */
  absentIds: z.array(z.number()),
  samples: z.object({
    absent: z.array(MediaForgetSampleSchema),
    present: z.array(MediaForgetSampleSchema),
    error: z.array(MediaForgetSampleSchema),
    kept: z.array(MediaForgetSampleSchema),
  }),
  /** Absent at classification, no longer ENOENT at delete time: kept. */
  changedBeforeDelete: z.number(),
})

export const mediaForgetActions = defineCustomActions({
  'storage.forgetMissingMedia': customAction(MediaForgetInputSchema, MediaForgetResultSchema, {
    kind: 'mutation',
    auth: 'admin',
  }),
})

export type MediaForgetInput = z.input<typeof MediaForgetInputSchema>
export type MediaForgetParsedInput = z.infer<typeof MediaForgetInputSchema>
export type MediaForgetResult = z.infer<typeof MediaForgetResultSchema>
export type MediaForgetSample = z.infer<typeof MediaForgetSampleSchema>
export type MediaForgetVerdictCounts = z.infer<typeof VerdictCountsSchema>
