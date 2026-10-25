import { z } from 'zod'
import { method, type CapabilityDefinition, type InferProvider } from './capability-definition.js'
import {
  AudioChunkInputSchema,
  AudioLevelSchema,
  AudioClassificationLabelSchema,
  AudioClassifyOutcomeSchema,
} from './schemas/detection-shared.js'

const AudioAnalysisResultSchema = z.object({
  level: AudioLevelSchema,
  /** Labels at or above the camera's floor. Absent = none — read `classifyOutcome` to know whether the model ran at all. */
  classification: z
    .object({
      labels: z.array(AudioClassificationLabelSchema).readonly(),
      inferenceMs: z.number(),
    })
    .optional(),
  /** Whether the classifier ran on this window (D660). */
  classifyOutcome: AudioClassifyOutcomeSchema,
  timestamp: z.number(),
})

const AudioAnalysisSettingsSchema = z.object({
  minConfidence: z.number().min(0).max(1).default(0.3),
  allowedClasses: z.array(z.string()).default([]),
})

/**
 * `attachDevice` — the analyzer PULLS a camera's audio from the broker (D461).
 *
 * Until D461 the orchestrator drained the broker's chunk plane, accumulated
 * ~1 s windows and pushed them back out as `analyseChunk`. It neither produced
 * nor consumed the audio: the PCM crossed hub-main twice for a process that
 * only buffered it. `attachDevice` inverts the direction — the analyzer opens
 * its own `subscribeAudioChunks` against the broker and the subscriber IS the
 * decoder, so the coded G.711 bytes D455 put on the plane stay coded all the
 * way to the one expansion that feeds the model.
 *
 * The orchestrator still owns the POLICY (the `audioMode` gate, the on-motion
 * window, the per-device node assignment, the settings read) and therefore
 * still owns the attach/detach pair. It no longer owns the bytes.
 */
const AudioAttachDeviceInputSchema = z.object({
  deviceId: z.number(),
  /** Broker id (`<deviceId>/<camStreamId>`) carrying this camera's audio. */
  brokerId: z.string(),
  /**
   * `clusterRoles.ingestNode` — the node whose broker owns the source dial.
   * Every `streamBroker` call the attachment makes is pinned to it, exactly as
   * the orchestrator's poller pinned them before the move.
   */
  ingestNodeId: z.string(),
  /**
   * Resolved once by the orchestrator at attach time, exactly as it was read
   * once per subscription before D461. The analyzer does NOT re-resolve per
   * window: a settings change re-attaches, which is what always happened.
   */
  settings: AudioAnalysisSettingsSchema,
})

const AudioAttachDeviceResultSchema = z.object({
  /** False only when the analyzer is shutting down and refused to attach. */
  attached: z.boolean(),
  /**
   * True when the attachment replaced a live one for the same device. An
   * attach is idempotent by REPLACEMENT — two pollers on one camera would
   * double the broker's fanout and neither would know about the other.
   */
  replaced: z.boolean(),
})

const AudioDetachDeviceResultSchema = z.object({
  /** False when no attachment existed — detach is idempotent. */
  detached: z.boolean(),
})

// Merged from audio-classifier.cap.ts — AudioAnalyzerAddon now owns the
// pipeline directly (no tRPC roundtrip to a separate classifier addon).
const AudioClassificationResultSchema = z.object({
  // Macro-aggregated labels (25-class taxonomy from `AUDIO_MACRO_LABELS`).
  // Primary surface — used by the live audio analyzer and notifications.
  labels: z.array(AudioClassificationLabelSchema).readonly(),
  // Raw backend-native labels (e.g. YAMNet's 521 classes or Apple
  // SoundAnalysis's 303 classes), unaggregated. Optional so existing
  // consumers continue to work; populated by the analyzer provider
  // for callers that want fine-grained output — the benchmark UI uses
  // this in `micro` mode.
  rawLabels: z.array(AudioClassificationLabelSchema).readonly().optional(),
  inferenceMs: z.number(),
})

/**
 * audio-analyzer — system-scoped compute cap.
 *
 * Owns the engine lifecycle (isReady / dispose), the stateless
 * `analyseChunk` call and the `classify` method. Per-device settings,
 * device-settings contribution and the `onAudioLevel` event live on the
 * paired `audio-analysis` cap (device-scoped, singleton, wrapper
 * defaultActive) so every camera gets its own bindings row and per-device
 * toggle. Pairing mirrors `stream-broker` (system) + `camera-streams`
 * (device) + `webrtc-session` (device) — single addon registers both.
 */
/**
 * Operator-facing audio-backend choice. 'auto' defers to the addon's
 * platform heuristic (Apple SoundAnalysis on macOS, YAMNet elsewhere).
 */
export const AUDIO_BACKEND_CHOICES = [
  { value: 'auto', label: 'Auto (platform default)' },
  { value: 'apple-soundanalysis', label: 'Apple SoundAnalysis (macOS 12+)' },
  { value: 'yamnet-onnx', label: 'YAMNet ONNX (cross-platform)' },
] as const

export type AudioBackendChoice = (typeof AUDIO_BACKEND_CHOICES)[number]['value']

/**
 * Shared shape of the audio-analyzer addon's global settings.
 * `audioBackend` = operator choice (wins); `probedBestAudioBackend`
 * = hint refreshed by `reprobeAudioEngine`.
 *
 * There is NO model id here. The backend IS the model: YAMNet ships one
 * ONNX graph and Apple SoundAnalysis is a built-in with nothing swappable,
 * so `createAudioPipeline` takes a backend and no model. A
 * `selectedAudioModel` select shipped here until 2026-08-28 (D272) and
 * reached inference on no path — it was a log field.
 *
 * NOTE — enable/disable is NOT stored here:
 *   - per-device: `audio-analysis` wrapper cap + `setWrapperActive`
 *     (binding system — the canonical gate).
 *   - cluster-wide: `addonDefaults['audio-classifier'].enabled` on
 *     the pipeline-orchestrator; drives whether the audio step
 *     appears in the resolved tree at all.
 */
export interface AudioAnalyzerGlobalConfig {
  readonly audioBackend: AudioBackendChoice
  readonly probedBestAudioBackend: string
}

export const DEFAULT_AUDIO_ANALYZER_CONFIG: AudioAnalyzerGlobalConfig = {
  audioBackend: 'auto',
  probedBestAudioBackend: '',
}

export const audioAnalyzerCapability = {
  name: 'audio-analyzer',
  scope: 'system',
  mode: 'singleton',
  methods: {
    analyseChunk: method(
      z.object({ chunk: AudioChunkInputSchema, settings: AudioAnalysisSettingsSchema }),
      AudioAnalysisResultSchema.nullable(),
      { kind: 'mutation' },
    ),
    // ONNX / Apple SoundAnalysis inference can exceed the broker's default
    // 5s requestTimeout on first load or under CPU pressure. 30s covers
    // even the worst-case cold-start without hanging indefinitely.
    classify: method(AudioChunkInputSchema, AudioClassificationResultSchema, { timeoutMs: 30_000 }),
    /**
     * Start pulling this camera's audio from the broker, in THIS process.
     * Returns as soon as the attachment exists — the first
     * `subscribeAudioChunks` retries with backoff behind it, because the
     * broker for a camStream may not be registered yet (that tolerance moved
     * with the poller, D461). Replaces any live attachment for the device.
     */
    attachDevice: method(AudioAttachDeviceInputSchema, AudioAttachDeviceResultSchema, {
      kind: 'mutation',
    }),

    /**
     * Stop pulling this camera's audio and release the broker subscription.
     * Idempotent. A detach that never arrives is the one failure mode this
     * split adds, which is why `AudioChunkPlane` reaps a subscription nobody
     * drains rather than trusting it (D461).
     */
    detachDevice: method(z.object({ deviceId: z.number() }), AudioDetachDeviceResultSchema, {
      kind: 'mutation',
    }),

    isReady: method(z.void(), z.boolean()),
    dispose: method(z.void(), z.void(), { kind: 'mutation' }),

    /**
     * Re-run the host platform-probe for the audio backend and persist
     * the detected value into `probedBestAudioBackend`. Replaces the
     * orchestrator's legacy `AgentPipelineSettings.audio.engine` —
     * audio-analyzer now owns the choice. Operator `audioBackend` is
     * not touched; only the probed-best hint.
     */
    reprobeAudioEngine: method(z.void(), z.object({ backend: z.string() }), {
      kind: 'mutation',
      auth: 'admin',
    }),
  },
} as const satisfies CapabilityDefinition

export type IAudioAnalyzerProvider = InferProvider<typeof audioAnalyzerCapability>

export {
  AudioAnalysisResultSchema,
  AudioAnalysisSettingsSchema,
  AudioClassificationResultSchema,
  AudioAttachDeviceInputSchema,
  AudioAttachDeviceResultSchema,
  AudioDetachDeviceResultSchema,
}
