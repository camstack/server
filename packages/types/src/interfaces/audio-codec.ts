/**
 * audio-codec capability — interface types.
 *
 * The audio-codec cap is a stateless I/O box: each consumer creates its
 * own session declaring source codec, source format, and target PCM
 * format. The provider runs decode + resample (or encode + resample)
 * inside the session — independent sessions so that a 16kHz mono ASA
 * subscriber and a 48kHz stereo WebRTC subscriber on the same source
 * stream don't share resamplers and don't force each other into a
 * common rate.
 *
 * Two session kinds:
 *   - `decode`: encoded-frame in → PCM out (audio-classifier, WebRTC
 *     out-leg, RTSP audio passthrough consumers).
 *   - `encode`: PCM in → encoded-frame out (intercom, server-to-camera
 *     audio playback).
 *
 * Lifecycle: `createDecodeSession` / `createEncodeSession` returns a
 * `sessionId` the caller pushes / pulls against. Sessions self-tear
 * after `idleMs` of inactivity (default 30s) — operators can also
 * close explicitly.
 */

/**
 * Canonical PCM sample format. `f32le` = Float32 little-endian
 * (typical for ML inference + WebRTC). `s16le` = Int16 little-endian
 * (typical for legacy audio pipelines + opus pre-encode).
 */
export type PcmSampleFormat = 'f32le' | 's16le'

/** Codec descriptor surfaced from the addon's runtime probe. */
export interface AudioCodecInfo {
  /** Canonical codec id, lowercase (e.g. `aac`, `pcm_mulaw`, `pcm_alaw`, `opus`). */
  readonly codec: string
  /** Whether the runtime can decode this codec on the local host. */
  readonly canDecode: boolean
  /** Whether the runtime can encode this codec on the local host. */
  readonly canEncode: boolean
  /** Free-form display label for UI — e.g. `'AAC (LC, HE-AAC v2)'`. */
  readonly label?: string
}

/** Inputs needed to open a per-consumer decode session. */
export interface AudioDecodeSessionConfig {
  /** Source codec — must satisfy `AudioCodecInfo.canDecode`. */
  readonly codec: string
  /** Source sample rate (Hz) as declared by SDP / container. */
  readonly sourceSampleRate: number
  /** Source channel count (1 = mono, 2 = stereo). */
  readonly sourceChannels: number
  /**
   * Codec-specific bootstrap blob (e.g. `AudioSpecificConfig` hex-decoded
   * for AAC, codec-private-data for OPUS in some containers). Optional —
   * pure RTP audio (PCMU/PCMA) needs no config.
   */
  readonly extraData?: Uint8Array
  /**
   * Target PCM sample rate (Hz). The session resamples internally with a
   * SwrContext so each consumer sees its preferred rate without forcing
   * a shared sampling on the source decode.
   */
  readonly targetSampleRate: number
  /** Target PCM channel count. */
  readonly targetChannels: number
  /** Target PCM sample format. Default: `f32le`. */
  readonly targetFormat?: PcmSampleFormat
  /**
   * Auto-close after this many ms with no `pushFrame` and no `pullPcm`.
   * Default 30000 — protects against leaked sessions when a consumer
   * crashes without calling `closeSession`.
   */
  readonly idleMs?: number
  /** Caller-identity tag for observability (e.g. `audio-classifier:5`). */
  readonly tag?: string
}

/** Inputs needed to open a per-consumer encode session (intercom, etc). */
export interface AudioEncodeSessionConfig {
  /** Target codec — must satisfy `AudioCodecInfo.canEncode`. */
  readonly codec: string
  /**
   * Source PCM sample rate of the buffers the caller will push. The
   * session resamples internally if it differs from the encoder's
   * native input rate.
   */
  readonly sourceSampleRate: number
  /** Source PCM channel count. */
  readonly sourceChannels: number
  /** Source PCM sample format. Default: `f32le`. */
  readonly sourceFormat?: PcmSampleFormat
  /** Encoder native sample rate (e.g. AAC 44100/48000, Opus 48000, PCMU/PCMA 8000). */
  readonly targetSampleRate: number
  /** Encoder native channel count. */
  readonly targetChannels: number
  /** Bitrate hint in kbps (lossy codecs only). */
  readonly bitrateKbps?: number
  /** Auto-close after this many idle ms. Default 30000. */
  readonly idleMs?: number
  /** Caller-identity tag for observability. */
  readonly tag?: string
}

/** A decoded PCM chunk pulled from a decode session. */
export interface AudioPcmChunk {
  /** Raw PCM bytes in `targetFormat`. */
  readonly data: Uint8Array<ArrayBuffer>
  /** Sample rate of `data` (== `targetSampleRate` from session config). */
  readonly sampleRate: number
  /** Channel count of `data` (== `targetChannels`). */
  readonly channels: number
  /** Sample format of `data` (== `targetFormat`). */
  readonly format: PcmSampleFormat
  /**
   * Presentation timestamp in milliseconds, monotonic per session.
   * Synthesised when source frames lack PTS.
   */
  readonly pts: number
}

/** An encoded chunk pulled from an encode session. */
export interface AudioEncodedChunk {
  readonly data: Uint8Array<ArrayBuffer>
  readonly codec: string
  readonly pts: number
  /** When `true`, this chunk completes a frame boundary the consumer can
   * forward as a single RTP packet. AAC always true; Opus always true. */
  readonly frameComplete: boolean
}
