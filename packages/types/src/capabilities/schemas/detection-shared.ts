/** Shared Zod schemas used across detection capabilities. */

import { z } from 'zod'

/**
 * Canonical frame-format enum mirrored on `FrameFormat` in
 * `packages/types/src/types/io.ts`. Kept inline (vs imported) so the
 * Zod runtime schema and TypeScript type stay in sync at the call site
 * — adding a new format requires changing both this enum and the
 * `FrameFormat` type alias together.
 */
export const FrameFormatSchema = z.enum(['jpeg', 'rgb', 'bgr', 'yuv420', 'gray'])

export const FrameInputSchema = z.object({
  data: z.custom<Uint8Array>(),
  format: FrameFormatSchema,
  width: z.number(),
  height: z.number(),
  timestamp: z.number(),
})

export const BoundingBoxSchema = z.object({
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
})

export const SpatialDetectionSchema = z.object({
  class: z.string(),
  originalClass: z.string(),
  score: z.number(),
  bbox: BoundingBoxSchema,
})

/**
 * `data` carries the raw f32le bytes of the PCM samples (4 bytes per
 * sample, little-endian IEEE 754).  `Uint8Array` is the wire-safe choice
 * because `@msgpack/msgpack` serialises it as a MsgPack `bin` type that
 * round-trips losslessly over the UDS transport.  `Float32Array` is NOT
 * preserved — the encoder serialises it as `bin` (its raw bytes) but
 * the decoder returns `Uint8Array`, so treating a `Float32Array` as the
 * wire type causes receivers to read bytes as sample values, producing
 * wildly wrong RMS/dBFS results (~+43 dBFS instead of ≤0).
 *
 * Callers that need float arithmetic reconstruct the view with:
 *   `new Float32Array(chunk.data.buffer, chunk.data.byteOffset, chunk.data.byteLength / 4)`
 */
export const AudioChunkInputSchema = z.object({
  data: z.instanceof(Uint8Array),
  sampleRate: z.number(),
  channels: z.number(),
  timestamp: z.number(),
  /** Originating device id — used by the classifier for per-camera concurrency tracking. */
  deviceId: z.number().optional(),
})

export const AudioLevelSchema = z.object({
  rms: z.number(),
  dbfs: z.number(),
})

export const AudioClassificationLabelSchema = z.object({
  /**
   * Primary display class. Depending on how the label was produced
   * this is either the macro category (e.g. `dog`) or the raw
   * backend label (e.g. `Dog bark`). Mirrors `class` on
   * `SpatialDetection`.
   */
  className: z.string(),
  /**
   * Raw backend-native label the classifier actually emitted (e.g.
   * `Dog bark` for YAMNet, `dog_bark` for Apple SoundAnalysis). For
   * macro-aggregated entries this is the top raw contributor. Mirrors
   * `originalClass` on `SpatialDetection`.
   */
  originalClass: z.string().optional(),
  score: z.number(),
})

/**
 * Why an audio window reached no classifier (D660). `superseded` is the ONLY
 * contention drop the analyzer makes: a camera's pending window replaced by
 * its own newer one while the single pipeline served other cameras. `error`
 * is an inference (or pipeline spawn) that failed, including a backend that
 * exited or was disposed mid-inference; `timeout` is an inference that did not
 * answer within the analyzer's bound (the backend is then killed and
 * respawned); `disposed` is a window still queued when the analyzer shut down.
 */
export const AUDIO_NOT_CLASSIFIED_REASONS = ['superseded', 'error', 'timeout', 'disposed'] as const

/**
 * Did the classifier RUN on this window? (D660)
 *
 * `classified` with no labels means the model heard nothing above the
 * camera's floor. `not-classified` means nobody listened — and until D660 the
 * two were the same shape (`classification` absent), so a window the global
 * busy gate threw away read downstream exactly like a quiet one (D393).
 */
export const AudioClassifyOutcomeSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('classified') }),
  z.object({
    state: z.literal('not-classified'),
    reason: z.enum(AUDIO_NOT_CLASSIFIED_REASONS),
  }),
])
export type AudioClassifyOutcome = z.infer<typeof AudioClassifyOutcomeSchema>
export type AudioNotClassifiedReason = (typeof AUDIO_NOT_CLASSIFIED_REASONS)[number]
