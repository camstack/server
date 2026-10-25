import type { z } from 'zod'
import type {
  AudioChunkInput,
  AudioAnalysisResult,
  AudioAnalysisSettings,
  AudioClassificationEntry,
} from '../types/io.js'
import type {
  AudioAttachDeviceInputSchema,
  AudioAttachDeviceResultSchema,
  AudioDetachDeviceResultSchema,
} from '../capabilities/audio-analyzer.cap.js'

/** `z.infer` off the cap's own schemas — never a second shape for one contract. */
export type AudioAttachDeviceInput = z.infer<typeof AudioAttachDeviceInputSchema>
export type AudioAttachDeviceResult = z.infer<typeof AudioAttachDeviceResultSchema>
export type AudioDetachDeviceResult = z.infer<typeof AudioDetachDeviceResultSchema>

// ---------------------------------------------------------------------------
// Audio Analyzer capability — singleton, provided by addon-audio-analysis
// ---------------------------------------------------------------------------

/**
 * Audio analyzer capability interface.
 *
 * Responsible for audio level metering (dBFS/RMS) on every chunk and
 * audio classification (in-process, no tRPC roundtrip). This is the
 * "always-on" audio service when audioEnabled is true.
 */
export interface IAudioAnalyzer {
  /**
   * Process a single audio chunk: compute levels + optionally classify.
   * Returns null if the analyzer is not initialized.
   */
  analyseChunk(input: {
    chunk: AudioChunkInput
    settings: AudioAnalysisSettings
  }): Promise<AudioAnalysisResult | null>

  /**
   * Resolve the effective per-device audio-analysis settings for the given
   * camera. Each addon owns its own settings schema (`getConfigSchema()`) and
   * is the only component allowed to read values out of its store — callers
   * like the orchestrator call this method and get a typed DTO with no
   * knowledge of the audio-analyzer's schema field names. Implementations
   * MUST use the 3-level resolver (schema defaults → global → device override).
   *
   * Returns `null` when the addon is not initialized yet.
   */
  resolveDeviceSettings(input: { deviceId: number }): Promise<AudioAnalysisSettings | null>

  /**
   * Start pulling this camera's audio from the broker, in the ANALYZER's
   * process (D461). The orchestrator relayed it until 2026-09-11: it drained
   * the broker's chunk plane, windowed the PCM and pushed it back through
   * `analyseChunk`, so every byte crossed hub-main twice for a process that
   * neither produced nor consumed the audio.
   *
   * Returns as soon as the attachment exists — the first
   * `subscribeAudioChunks` retries with backoff behind it, because the broker
   * for a camStream may not be registered yet. Idempotent BY REPLACEMENT: two
   * pollers on one camera would double the broker's fanout.
   */
  attachDevice(input: AudioAttachDeviceInput): Promise<AudioAttachDeviceResult>

  /**
   * Stop pulling this camera's audio and release the broker subscription.
   * Idempotent. A detach that never arrives is the failure this ownership
   * split adds, which is why `AudioChunkPlane` reaps a subscription nobody
   * drains rather than trusting this call to land (D461).
   */
  detachDevice(input: { deviceId: number }): Promise<AudioDetachDeviceResult>

  /** Check if the audio analyzer is initialized and ready */
  isReady(): boolean

  /** Dispose resources (called on shutdown) */
  dispose(): Promise<void>
}

// ---------------------------------------------------------------------------
// Audio classification result — used by the merged audio-analyzer cap
// ---------------------------------------------------------------------------

/** Result of audio classification on a single chunk */
export interface AudioClassificationResult {
  /** Macro-aggregated labels (25-class taxonomy from `AUDIO_MACRO_LABELS`). */
  readonly labels: readonly AudioClassificationEntry[]
  /**
   * Raw backend-native labels (e.g. YAMNet's 521 classes or Apple
   * SoundAnalysis's 303 classes), unaggregated. Always populated by the
   * analyzer provider so callers can choose between the macro-mapped
   * and the raw view (the benchmark UI uses this in `micro` mode).
   */
  readonly rawLabels?: readonly AudioClassificationEntry[]
  readonly inferenceMs: number
}
