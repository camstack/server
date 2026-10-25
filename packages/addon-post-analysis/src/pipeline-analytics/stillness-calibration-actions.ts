/**
 * stillness-calibration-actions — "measure this camera's own stillness scale".
 *
 * ## Why an `addons.custom` action and not a cap method
 *
 * Same reason as `face.rescoreTrack` beside it: a cap method's wire schema
 * lives in `@camstack/types`, which travels inside the `@camstack/server`
 * closure, so a new one is not callable until a server train ships. Here the
 * schema lives in this addon's own dist and the hub forwards an opaque
 * envelope, so `camstack deploy` is the whole delivery.
 *
 * ## Why `apply` is explicit and not a fallback
 *
 * A calibration run READS recorded tracks and does arithmetic. Applying it
 * WRITES the camera's settings and changes what the tracker calls settled from
 * the next frame on. Those are different enough in consequence that a button
 * labelled "calibrate" must not choose between them on the operator's behalf —
 * the run reports, the operator applies. A REFUSED run never writes the bar
 * whatever `apply` says; it writes only the note, so the refusal and its reason
 * are visible in the form instead of being a toast that scrolls away.
 */
import { customAction, defineCustomActions } from '@camstack/types'
import { z } from 'zod'

/** Mirrors `StillnessCalibrationRefusal` — kept literal so the wire schema is
 *  self-describing and a new reason is a deliberate edit in both places. */
const StillnessRefusalSchema = z.enum([
  'no-tracks',
  'too-few-tracks',
  'too-few-samples',
  'no-motion-evidence',
])

const StillnessMeasurementSchema = z.object({
  /** Tracks that contributed at least one speed sample. */
  trackCount: z.number().int(),
  /** Tracks the pass actually read, after the cost bound. */
  tracksRead: z.number().int(),
  sampleCount: z.number().int(),
  /** Speed quantiles, subject-box-diagonals per second. `null` when there was
   *  nothing to measure — never 0, which would read as a measured stillness
   *  (D393). */
  p25: z.number().nullable(),
  p50: z.number().nullable(),
  p90: z.number().nullable(),
  /** Median gap between stored positions (s) — the camera's real cadence. */
  medianIntervalSec: z.number().nullable(),
  /** Median subject box diagonal (px) the speeds were normalised by. */
  medianSubjectDiagonalPx: z.number().nullable(),
})

const StillnessCalibrateInputSchema = z.object({
  deviceId: z.number().int(),
  /** How far back to read. Bounded: this pass parses ~10 kB of trajectory a
   *  row, so the window is a suggestion and `maxTracks` is the real bound. */
  sinceHours: z
    .number()
    .min(0.25)
    .max(24 * 30)
    .default(72),
  /** Hard cost bound on tracks read, newest first. */
  maxTracks: z.number().int().min(1).max(1_000).default(200),
  /**
   * Write the chosen bar onto the camera. Never implicit, and never done at
   * all for a refused run.
   */
  apply: z.boolean().default(false),
})

const StillnessCalibrateResultSchema = z.object({
  deviceId: z.number().int(),
  /** The window actually read (epoch ms). */
  since: z.number().int(),
  until: z.number().int(),
  accepted: z.boolean(),
  /** Why it refused. Absent on an accepted run. */
  reason: StillnessRefusalSchema.optional(),
  /** The chosen bar, subject-box-diagonals per second. Absent on a refusal —
   *  never 0, which the settings layer reads as "uncalibrated". */
  bar: z.number().optional(),
  /** The raw quantile before the rails, so the clamp is arguable. */
  rawBar: z.number().optional(),
  clampedBy: z.enum(['none', 'floor', 'ceiling', 'min', 'max']).optional(),
  measurement: StillnessMeasurementSchema,
  /** The bar this camera was on BEFORE the run — `null` = uncalibrated. Read
   *  before any write, so the operator sees both numbers. */
  previousBar: z.number().nullable(),
  /** Whether the camera's settings were actually written. */
  applied: z.boolean(),
  /** The one-line note stored on the camera (accepted or refused). */
  note: z.string(),
})

export const stillnessCalibrationActions = defineCustomActions({
  /**
   * `admin` because it WRITES a per-camera detection threshold when `apply` is
   * set, and because the report describes how the camera's subjects move,
   * which is not a viewer-level fact.
   */
  'stillness.calibrate': customAction(
    StillnessCalibrateInputSchema,
    StillnessCalibrateResultSchema,
    { kind: 'mutation', auth: 'admin' },
  ),
})

export type StillnessCalibrationActions = typeof stillnessCalibrationActions
export type StillnessCalibrateInput = z.infer<typeof StillnessCalibrateInputSchema>
export type StillnessCalibrateResult = z.infer<typeof StillnessCalibrateResultSchema>
