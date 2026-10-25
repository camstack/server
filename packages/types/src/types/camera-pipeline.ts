/**
 * Per-camera pipeline configuration — the canonical shape carried by the
 * orchestrator's `pipelines/<deviceId>` store and pushed to the runner
 * inside every `attachCamera` payload.
 *
 * Model: a camera declares WHAT to execute (ordered tree of steps) and
 * WHERE to execute it (engine runtime+backend+format). The runner holds
 * this in RAM for the lifetime of the attach, swaps it atomically when
 * the orchestrator re-sends (hot reload on edit or rebalance).
 *
 * `PipelineStepInput` already exists in `pipeline-executor.cap.ts` and is
 * the stateless step shape accepted by `runPipeline`. Reusing it here
 * keeps the edit → persist → execute round-trip shape-identical with
 * zero conversion.
 */
import type { PipelineStepInputOutput } from '../capabilities/pipeline-executor.cap.js'
import type { PipelineEngineChoice } from './pipeline.js'

/**
 * A camera's end-to-end pipeline: which engine to run on, which video
 * steps (ordered tree), and optional audio classification. Null `audio`
 * or `audio.enabled === false` means audio classification is disabled
 * for this camera — metering (dB/RMS) stays orthogonal, it's part of
 * `audio-analyzer` not tied to this config.
 */
export interface CameraPipelineConfig {
  /**
   * Engine HINT ONLY — a vestigial explicit engine override older stored
   * configs may still carry. It is NEVER a live-dispatch field: the attach payload (`RunnerCameraConfig`) no longer carries an
   * engine, so this value cannot reach a node. Engine is node-local — the
   * executing runner resolves its own format default at dispatch time.
   */
  readonly engine?: PipelineEngineChoice
  readonly steps: readonly PipelineStepInputOutput[]
  readonly audio?: {
    /** Engine hint only — see `engine` above. Not dispatched. */
    readonly engine?: PipelineEngineChoice
    /**
     * Present ONLY when the operator explicitly chose an audio model;
     * absent = use this node's format default (resolved on-the-fly by
     * the provider). Model selection is data only (the engine-node-local
     * refactor).
     */
    readonly modelId?: string
    readonly enabled: boolean
    /**
     * Audio-classifier step settings (`enabledAudioClasses`,
     * `minConfidence`) sourced from the agent's
     * `addonDefaults['audio-classifier'].settings` and overlaid by any
     * per-device patch. The audio-analyzer reads these at runtime to
     * filter macro classes and gate by score.
     */
    readonly settings?: Readonly<Record<string, unknown>>
  } | null
}
