/**
 * The wire/storage shape of a whole-archive face rescore job (D866) — one Zod
 * schema for the action output, the persisted last report and the in-process
 * status, so the three cannot drift.
 */
import { z } from 'zod'

const FaceRescoreJobStateSchema = z.enum(['idle', 'running', 'completed', 'failed'])

export const FaceRescoreJobStatusSchema = z.object({
  /** `null` while nothing ever ran in this process. */
  jobId: z.string().nullable(),
  state: FaceRescoreJobStateSchema,
  /** Faces visited so far (rescored or deliberately skipped). */
  scanned: z.number().int(),
  /** Faces in the snapshot taken at the start; 0 until it is taken. */
  total: z.number().int(),
  /** newlySuggested + raised + lowered + cleared — rows actually written. */
  changed: z.number().int(),
  newlySuggested: z.number().int(),
  raised: z.number().int(),
  lowered: z.number().int(),
  cleared: z.number().int(),
  /** Faces in an old feature space: skipped, their suggestion untouched. */
  modelMismatch: z.number().int(),
  /** Faces with no vector in either home: skipped, counted. */
  noVector: z.number().int(),
  batches: z.number().int(),
  /** Slowest single batch's STORE time (read + transaction), ms. */
  maxBatchStoreMs: z.number(),
  durationMs: z.number(),
  galleryFingerprint: z.string(),
  /** Combined fingerprint taken at the start; what the scheduler persists. */
  fingerprint: z.string(),
  startedAt: z.number().nullable(),
  error: z.string().optional(),
})

export type FaceRescoreJobState = z.infer<typeof FaceRescoreJobStateSchema>
export type FaceRescoreJobStatus = z.infer<typeof FaceRescoreJobStatusSchema>
