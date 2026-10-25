import type { FrameRef } from './frame-view.js'
import type { AudioClassifyOutcome } from '../capabilities/schemas/detection-shared.js'

export interface BoundingBox {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

export interface Landmark {
  readonly x: number
  readonly y: number
  readonly label?: string
}

/**
 * Canonical pixel/frame format identifier used throughout the streaming +
 * detection pipeline.
 *
 * - `jpeg`   — encoded JPEG bytes (decoder-side `sharp` encode)
 * - `rgb`    — packed RGB24 (3 bytes/pixel, planar order R,G,B)
 * - `bgr`    — packed BGR24 (3 bytes/pixel, planar order B,G,R)
 * - `yuv420` — planar YUV 4:2:0 (1.5 bytes/pixel)
 * - `gray`   — single-channel 8-bit luminance (1 byte/pixel)
 *
 * Single source of truth: matches `FrameFormatSchema` in
 * `capabilities/schemas/detection-shared.ts`.
 */
export type FrameFormat = 'jpeg' | 'rgb' | 'bgr' | 'yuv420' | 'gray'

/** Subset of `FrameFormat` accepted by the raw inference fast path. */
export type RawFrameFormat = Exclude<FrameFormat, 'jpeg' | 'yuv420'>

export interface FrameInput {
  readonly data: Uint8Array
  readonly format: FrameFormat
  readonly width: number
  readonly height: number
  readonly timestamp: number
  /** Local lazy source; `data` is empty until an inline fallback is selected. */
  readonly frameRef?: FrameRef
}

/**
 * Wire-safe audio chunk passed to the audio-analyzer and detection-pipeline
 * caps.  `data` holds the raw f32le bytes (4 bytes per sample, little-endian
 * IEEE 754 float).  Using `Uint8Array` rather than `Float32Array` is required
 * for correct UDS/MsgPack transport: `@msgpack/msgpack` serialises both as a
 * binary blob, but deserialises it as `Uint8Array`.  A `Float32Array` receiver
 * would silently read each individual byte (0–255) as a sample, producing
 * wildly wrong level measurements (~+43 dBFS instead of ≤ 0).
 *
 * To iterate samples as floats, reconstruct the view:
 *   `new Float32Array(chunk.data.buffer, chunk.data.byteOffset, chunk.data.byteLength / 4)`
 */
export interface AudioChunkInput {
  readonly [key: string]: unknown
  readonly data: Uint8Array<ArrayBuffer>
  readonly sampleRate: number
  readonly channels: number
  readonly timestamp: number
  readonly deviceId?: number
}

// ---------------------------------------------------------------------------
// Audio analysis result — returned by the audio pipeline addon
// ---------------------------------------------------------------------------

/**
 * Classification result for an audio chunk.
 * Mirrors `SpatialDetection` (class + originalClass): `className` is the
 * primary display class (macro or raw depending on how it was produced),
 * `originalClass` is the raw backend label that was actually emitted.
 * Both values are kept so downstream consumers — especially the UI — can
 * render and filter consistently regardless of the classMode.
 */
export interface AudioClassificationEntry {
  readonly className: string
  readonly originalClass?: string
  readonly score: number
}

/**
 * Complete result of audio analysis on a single chunk.
 * Produced by the addon, consumed by detection-wiring for EventBus emission.
 */
export interface AudioAnalysisResult {
  /** Audio level metrics — always present */
  readonly level: {
    readonly rms: number
    readonly dbfs: number
  }
  /** Classification results — present only if classifier is enabled and produced results */
  readonly classification?: {
    readonly labels: readonly AudioClassificationEntry[]
    readonly inferenceMs: number
  }
  /**
   * Whether the classifier RAN on this window (D660). `classification` absent
   * with `classified` = heard nothing above the floor; `not-classified` =
   * nobody listened, and the reason says why.
   */
  readonly classifyOutcome: AudioClassifyOutcome
  /** Chunk timestamp from the stream */
  readonly timestamp: number
}

/** Settings for audio analysis filtering (passed to the addon) */
export interface AudioAnalysisSettings {
  readonly minConfidence: number
  readonly allowedClasses: string[]
}
