import type { PipelineEngineChoice } from '../types/pipeline.js'
import type { PipelineExecutionPlane } from '../types/pipeline-step.js'
import type { PipelineSchema } from '../types/pipeline-schema.js'
import type { ModelFormat } from '../types/models.js'
import type { FrameInput } from '../types/io.js'
import type { FrameRef } from '../types/frame-view.js'
import type { FrameHandle } from './frame-handle.js'
import type { FrameResult } from '../types/detection.js'
import type { ConfigUISchema } from './config-ui.js'
import type { InferenceCapabilities } from './inference-capabilities.js'
import type { IAddonResolver } from './pipeline-runner.js'
import {
  PipelineStepInputSchema,
  type EngineProvisioning,
  type NativeCropRef,
  type PipelineValidationResult,
  type SuppliedRootOutput,
} from '../capabilities/pipeline-executor.cap.js'
import type { z } from 'zod'

// ---------------------------------------------------------------------------
// Pipeline run input (moved from pipeline-executor.ts)
// ---------------------------------------------------------------------------

/**
 * Step configuration for pipeline execution — no runtime/backend (comes
 * from engine). Phase 7 (settings redesign) removed the generic
 * `confidence: number` field; per-step thresholds live in `settings`
 * and the runtime executor falls back to
 * `StepDefinition.defaultConfidence` when unset.
 */
/** Wire shape for one pipeline step — same as {@link PipelineStepInputSchema}. */
export type PipelineStepInput = z.infer<typeof PipelineStepInputSchema>

/**
 * Input for pipeline execution. Exactly one image source must be provided:
 *  - `frame`: runtime dispatch (pipeline-runner — decoded broker frame)
 *  - `frameHandle` (CB5): a zero-pixel shm `FrameHandle` for the same
 *    decoded frame — the hub-local executor maps the segment and reads the
 *    pixels back zero-copy instead of paying the ~1.2MB UDS re-serialise.
 *  - `imageBase64`: one-shot benchmark (ImageTab "Run")
 *  - `referenceImage`: named file from the reference-image store
 *
 * `deviceId` is an optional contextual hint — the executor uses it for
 * per-device overrides and traces. There is no `engine` (D646): the pool is
 * the node's own engine, or the `deviceKey` pool when one is named.
 */
export interface PipelineRunInput {
  readonly steps: readonly PipelineStepInput[]
  readonly frame?: FrameInput
  /** Same-process lazy source; never forwarded over UDS/Moleculer. */
  readonly frameRef?: FrameRef
  /**
   * CB5 shm passthrough — names the ring slot the decoded pixels live in.
   * A null read (recycled slot / foreign handle) degrades to an empty
   * result; the runner ships `frame` as the fallback (queue-depth gated).
   */
  readonly frameHandle?: FrameHandle
  readonly referenceImage?: string
  readonly imageBase64?: string
  /**
   * Binary JPEG bytes — preferred over `imageBase64` on internal worker
   * hops (hub → forked worker via Moleculer MsgPack). Skips 33% base64
   * overhead + per-call decode. Exactly one of `frame`/`image`/
   * `imageBase64`/`referenceImage` is required.
   */
  readonly image?: Uint8Array
  readonly deviceId?: number
  /**
   * Inference-device selector (Phase 2 multi-device). `<backend>:<device>`
   * (e.g. `openvino:npu`, `openvino:gpu`, `edgetpu:usb`, `cpu`). Omitted ⇒ the
   * node's default engine pool. Routes the call to that device's own pool so a
   * node runs detection on NPU + iGPU + Coral concurrently.
   */
  readonly deviceKey?: string
  /**
   * Correlation id tagged on every `pipeline.progress` event emitted
   * by this run. When a UI-initiated one-shot (`runPipelineTest`)
   * generates its own id and passes it here, the UI can filter the
   * progress stream by `sessionId + nodeId` to ignore concurrent
   * runtime dispatches from live camera frames. Server-side runs
   * that omit this field get a generated id.
   */
  readonly sessionId?: string
  /**
   * Execution plane. 'full' (default) runs the whole tree — benchmark,
   * reference-image, and detail-subtree calls. 'frame' is the live
   * per-frame dispatch: ONLY root-plane steps run; crop children
   * (inputClasses ≠ null) are skipped and served per-track via
   * pipelineRunner.runDetailSubtree (two-plane design).
   */
  readonly plane?: PipelineExecutionPlane
  /**
   * Two-plane NATIVE child-crop reference (detail plane). Set by
   * `runDetailSubtree` ONLY when the parent crop was resolved from the frame's
   * retained native surface — lets the executor re-cut a leaf crop child's ROI
   * (plate-ocr, face-embedding, leaf classifiers) at native resolution instead
   * of the downscaled parent tile. Auxiliary to the image source, not one of the
   * mutually-exclusive image inputs. Absent ⇒ tile-crop children.
   */
  readonly nativeCropRef?: NativeCropRef
  /**
   * Root-supplied output for the tree's ROOT step (D730) — that step is not
   * inferred; see `pipelineExecutor.runPipeline.suppliedRoot`.
   */
  readonly suppliedRoot?: SuppliedRootOutput
  /**
   * Offline REPLAY of stored media for `deviceId` (D56, D646). The call runs
   * the camera's structure — its detection-stage zone gate and per-device
   * overrides, exactly as a live frame — over a recorded image, and it is
   * PINNED: every executing step runs the model it names on the `deviceKey`
   * pool it names, or the call refuses (`model-not-servable` /
   * `device-not-servable`) before any pool is touched. Nothing is emitted on
   * the camera's live trace stream. Absent ⇒ unchanged behaviour.
   */
  readonly replay?: true
}

// Note: `IVisionAddonRegistry` lived here as a legacy adapter injected
// into the pipeline-executor addon from the hub. It had zero runtime
// consumers after the detection-pipeline rewrite — addons resolve
// sibling capabilities via the kernel capability registry and enumerate
// installed addons dynamically, so the adapter and its interface were
// removed.

// BenchmarkHistoryEntry moved to `@camstack/addon-benchmark` — the
// canonical shape is now derived from `BenchmarkHistoryEntrySchema` in
// @camstack/types/capabilities/pipeline-executor.cap.ts (kept exported
// so the addon can import it without re-declaring). 2026-04-14.

// ---------------------------------------------------------------------------
// Pipeline Executor Provider — the capability interface
// ---------------------------------------------------------------------------

/**
 * Singleton capability provided by the pipeline-executor addon.
 * The server backend consumes this via the capability registry.
 */
export interface IPipelineExecutorProvider {
  // ── Schema & Configuration ──

  /** Build pipeline schema filtered by the selected (or provided) engine */
  getSchema(engine?: PipelineEngineChoice): Promise<PipelineSchema>
  /** Get all available engines probed on this agent */
  getAvailableEngines(): Promise<PipelineEngineChoice[]>

  // The node's computed default tree is not an interface surface (D927).

  /**
   * Gate B (pre-init config-correctness gate). PURE COMPUTE against this
   * node's `currentEngine.format` — resolves `steps` the same way the
   * runtime dispatch path would and reports what WOULD happen, WITHOUT
   * writing any node-global state (the node-default `modelSubstitutions`
   * map stays owned exclusively by the node-default tree resolver).
   * Called by the orchestrator at attach time, node-pinned to the target
   * node, so config problems surface before `pipelineRunner.attachCamera`
   * rather than at the first per-frame resolve. Never throws.
   */
  validatePipeline(input: {
    readonly steps: readonly PipelineStepInput[]
    /** Validate against this device pool's format; absent ⇒ the node default. */
    readonly deviceKey?: string
  }): Promise<PipelineValidationResult>

  // ── Engine Management ──
  //
  // `setEngine` removed in Phase 6c — engine is per-camera in the
  // stateless-pipeline model. `getSelectedEngine` kept for benchmark
  // and models-page read paths.

  /** Get the currently selected engine (bootstrap default on the node). */
  getSelectedEngine(): Promise<PipelineEngineChoice>

  // ── Engine runtime provisioning (Phase 2) ──

  /**
   * Per-node detection-engine provisioning snapshot (idle / installing /
   * verifying / ready / failed). Read by the cap and the inference gate.
   * The cap routes `{ nodeId }` for provider resolution only — each node
   * returns its own local machine state, so the provider takes no args.
   */
  getEngineProvisioning(): EngineProvisioning

  // ── Orchestrator config schema (consumed by hub-side dashboards) ──

  getOrchestratorConfigSchema(): Promise<ConfigUISchema>

  // ── Inference Capabilities ──

  /** Get full inference capabilities (addon models, runtimes, etc.) */
  getCapabilities(forceRefresh?: boolean): Promise<InferenceCapabilities>
  /** Get available models for a specific addon */
  getAddonModels(input: {
    addonId: string
  }): Promise<readonly import('./inference-capabilities.js').ModelAvailability[]>
  /** Download a specific model */
  downloadModel(input: {
    modelId: string
    format: ModelFormat
    addonId: string
  }): Promise<{ filePath: string; sizeMB: number; durationMs: number }>
  /** Delete a downloaded model from disk */
  deleteModel(input: {
    modelId: string
    format: ModelFormat
    addonId: string
  }): Promise<{ success: true }>

  // ── Pipeline Execution ──

  /** Execute the full pipeline on a reference/base64 image (for UI/benchmark) */
  runPipeline(input: PipelineRunInput, onProgress?: (message: string) => void): Promise<FrameResult>

  /**
   * Batched execution — N raw frames packed into one cap call. Routes
   * through `SharedInferencePool.inferBatch` (`MSG_INFER_BATCH = 0x03`)
   * so IPC + JSON envelope cost is amortised N:1 vs N concurrent
   * `runPipeline` calls. Constraints:
   *   - Single root step (no crop children) — multi-step trees fall
   *     back to sequential execution per-frame inside the provider.
   *   - Uniform model across the batch (Python pool resolves one model
   *     index per request).
   * Used by the batch benchmark — N frames in one call to
   * amortise per-call IPC overhead.
   */
  runPipelineBatch(input: {
    readonly steps: readonly PipelineStepInput[]
    readonly frames: readonly FrameInput[]
    readonly deviceId?: number
    readonly sessionId?: string
  }): Promise<{ readonly results: readonly FrameResult[] }>

  // Legacy single-addon `detect` removed — no real consumers (runtime
  // dispatch is the stateless `runPipeline`).
  // runFrame removed in Phase 4 (stateless-pipeline refactor). Runtime
  // dispatch now routes through `runPipeline({steps, frame, deviceId})`;
  // the runner hydrates `steps` from the orchestrator's
  // `pipelines[deviceId]` attach payload.

  // ── Reference Images ──

  listReferenceImages(): Promise<Array<{ id: string; filename: string; sizeKB: number }>>
  getReferenceImage(input: {
    filename: string
  }): Promise<{ base64: string; filename: string } | null>

  // ── Benchmarks ──
  // Moved to `@camstack/addon-benchmark` (2026-04-14) — the addon owns the
  // benchmark catalog as customActions and delegates execution back to this
  // cap's `runPipeline`. The 6 methods (runBenchmark/runPipelineTest/
  // list|save|delete|clearBenchmarkHistory) are no longer part of the
  // pipeline-executor contract.

  // ── Reference audio ──
  getReferenceAudioFiles(): Promise<readonly { filename: string; sizeKb: number }[]>
  getReferenceAudio(input: { filename: string }): Promise<{ base64: string }>
  getAudioCapabilities(): Promise<{
    activeBackend: string
    availableBackends: readonly {
      id: string
      name: string
      description: string
      available: boolean
    }[]
    sampleRate: number
    chunkDurationMs: number
  }>
  /**
   * Run the audio classifier on a reference WAV file (benchmark path).
   *
   * Returns an `AudioResult` wrapped in a `{success, error?, frame?}`
   * envelope so the UI can render a clean failure when the classifier
   * cap isn't available. Each class above the step's `minScore`
   * threshold becomes one `AudioDetection` entry; the full top-N ranked
   * list lives in `frame.debug.alternateLabels['audio-classifier']`.
   */
  runAudioTest(input: {
    addonId: string
    modelId: string
    filename?: string
    settings?: Record<string, unknown>
  }): Promise<{
    success: boolean
    error?: string
    frame?: import('../types/detection.js').AudioResult
  }>

  /** Get the detection pipeline addon's config schema (for detection-config UI). */
  getDetectionConfigSchema(): Promise<ConfigUISchema | null>

  // NOTE: orchestratorStatus / cameraDetectionStatus removed in the
  // pipeline page redesign. UI consumers now read runner metrics directly
  // via the new `perNodePipeline` tRPC router which forwards to the
  // pipeline-runner cap on the target node (`getLocalMetrics`,
  // `getCameraMetrics`).

  // ── Per-device pipeline step overrides ──
  //
  // Per-device pipeline step CRUD removed in Phase 4b. The orchestrator
  // owns per-camera pipeline content via
  // `pipelineOrchestratorCapability.{get,set}CameraPipeline` backed by
  // its `pipelines/<deviceId>` addon store. Consumers that previously
  // read executor device-steps now call the orchestrator instead; the
  // executor is stateless w.r.t. cameras.

  // ── Addon Resolver (for detection wiring) ──

  /** Get the addon resolver for runtime pipeline execution */
  getAddonResolver(): Promise<IAddonResolver>

  // ── Dependency injection (wiring layer) ──

  /** Set the in-process tRPC client for inter-capability calls. */
  setApi(api: unknown): Promise<void>
}
