import type { AudioStreamPick } from '../capabilities/schemas/streaming-shared.js'
import type { PipelineStepInputOutput } from '../capabilities/pipeline-executor.cap.js'
import type { Zone } from '../capabilities/zones.cap.js'
import type { PipelinePhaseMode } from '../device/device-profile.js'
import type { CameraMetrics, OrchestratorMetrics } from './api-shared.js'

/**
 * Camera assignment payload sent by the pipeline-orchestrator to a runner
 * via `attachCamera`. Carries everything the runner needs to subscribe to
 * the local stream-broker and dispatch frames to motion / detection caps.
 *
 * Stateless-pipeline model: `steps` and `audio` travel with the payload so
 * the runner holds the content in RAM for the lifetime of the attach.
 * Re-sent on rebalance, edit, or restart. Engine is NOT carried: it is
 * node-local, resolved by the executing runner at dispatch time.
 */
export interface RunnerCameraConfig {
  readonly deviceId: number
  readonly motionCooldownMs: number
  readonly motionFps: number
  readonly detectionFps: number
  readonly motionStreamId: string
  readonly detectionStreamId: string
  /**
   * WHICH rung this camera's audio analysis listens on — `auto` (default) or an
   * explicit rung. NOT consumed by the runner: carried here, like
   * `audioMotionWindowMs`, because the orchestrator's own watchdog reads this
   * config to arm the audio stage and must resolve the SAME stream the
   * subscription did. Absent ⇒ `auto` (D537).
   */
  readonly audioStreamPick?: AudioStreamPick
  /** Motion sources that can activate the pipeline. At least one entry. */
  readonly motionSources: import('../capabilities/pipeline-runner.cap.js').MotionSources
  /**
   * Which root detectors run for this camera. Optional HERE and not on the Zod
   * schema, which defaults it: this interface is also what a runner older than
   * the field sees on the wire, and `planDetectionSources` reads an absent list
   * as `['pipeline']` — today's behaviour, unchanged.
   */
  readonly detectionSources?: import('../capabilities/pipeline-runner.cap.js').DetectionSources
  /**
   * What opened this attach — a SESSION attach only (`SessionTriggerSchema`,
   * D672 rule 11 as amended 2026-10-06). The runner names it on the phase
   * event and decides nothing on it. Absent ⇒ no source is named.
   */
  readonly sessionTrigger?: import('../capabilities/pipeline-runner.cap.js').SessionTrigger
  readonly pipelineEnabled: boolean
  // Engine is NOT carried on the attach payload — it is node-local: the
  // executing runner resolves its own format default at dispatch time.
  /**
   * Which of the node's inference accelerators this session runs on
   * (`<backend>:<device>`, e.g. `openvino:npu`, `edgetpu:usb`, `cpu`), chosen by
   * the orchestrator's per-device balancer (multi-device C4). Absent ⇒ the runner
   * uses its single default pool. Mirrors `RunnerCameraConfigSchema.deviceKey`.
   */
  readonly deviceKey?: string
  /**
   * Step-tree device-jump roster (phase 1) — the node's ENABLED inference
   * devices. Populated by the orchestrator ONLY when `deviceKey` is set and the
   * node has ≥2 enabled devices; the runner auto-jumps an enrichment step whose
   * model has no build for the elected device's format onto another enabled
   * device here. Mirrors `RunnerCameraConfigSchema.inferenceDevices`.
   */
  readonly inferenceDevices?: readonly import('../capabilities/pipeline-runner.cap.js').RunnerInferenceDevice[]
  /** Ordered tree of video steps — Phase 1 optional, runner ignores until Phase 3. */
  readonly steps?: readonly PipelineStepInputOutput[]
  /**
   * Audio classification branch — Phase 1 optional, runner ignores until
   * Phase 3. `modelId` absent = model selection is data only; the
   * executing node resolves its own format default at runtime
   * (mirrors `CameraPipelineConfig.audio`).
   */
  readonly audio?: {
    readonly modelId?: string
    readonly enabled: boolean
  } | null
  /**
   * Per-camera detection zones (user + onboard) snapshot taken at
   * dispatch time. Empty array → no zone filtering. Forwarded so
   * motion-wasm + pipeline-executor running on the runner can apply
   * include/exclude/monitor logic without an extra hub round-trip;
   * the orchestrator re-attaches the camera whenever the `zones`
   * device-state slice changes so the runner's copy stays in sync.
   */
  readonly zones?: readonly Zone[]
  /**
   * Operator-facing scheduling modes. The runner uses these to gate
   * its substream subscribers + phase machine:
   *
   *   - `'disabled'`   — runner skips the substream subscriber for
   *                      this phase entirely. Bindings stay bound;
   *                      this is the runtime-level off switch.
   *   - `'always-on'`  — phase starts in `'active'` and stays active.
   *   - `'on-motion'`  — phase starts in `'watching'`; transitions to
   *                      `'active'` when a motion source fires; falls
   *                      back after `motionCooldownMs`.
   *
   * `detectionMode` defaults to `'on-motion'` (battery profile keeps
   * this); `audioMode` defaults to `'always-on'` (battery profile
   * lowers to `'disabled'`).
   */
  readonly detectionMode: PipelinePhaseMode
  readonly audioMode: PipelinePhaseMode
  /**
   * When true (default) and `motionSources` contains only `'onboard'`, the
   * runner dynamically opens a WASM frame-diff subscription during active
   * motion windows and tears it down after `motionCooldownMs`. Set to false
   * to disable the dynamic analyzer for this camera.
   */
  readonly onboardMotionDrivesAnalyzer: boolean
  /**
   * Infer the session's PRE-ROLL — the retained history the restreamer replays
   * at session open — instead of decoding it and discarding it. Mirrors
   * `RunnerCameraConfigSchema.preRollInferenceEnabled` (default true; see the
   * schema for why the default is the argument).
   */
  readonly preRollInferenceEnabled: boolean
  /** Frames one pre-roll catch-up burst may send to inference. `0` disables it. */
  readonly preRollInferenceFrames: number
  /** Master toggle — when false the occupancy recheck never arms (default). */
  readonly occupancyRecheckEnabled: boolean
  /** Seconds between occupancy re-check bursts in watching phase. */
  readonly occupancyRecheckSec: number
  /** Frames to sample per occupancy re-check burst. */
  readonly occupancyRecheckFrames: number
  /**
   * Where this runner gets the camera's decoded frames (cross-node Phase 2,
   * P2c). Optional during the additive rollout: absent ≡
   * `{ kind: 'local-broker' }` (the schema default applied at router parse) —
   * today's co-located broker path. `remote-restream` makes the runner
   * acquire the owner's compressed restream and decode locally via a
   * satellite frame plane (P2d, dormant until `remoteSourcingNodes` is
   * populated).
   */
  readonly frameSource?: import('../capabilities/pipeline-runner.cap.js').RunnerFrameSource
}

/**
 * Hardware capability flags reported by a runner instance. Consumed by the
 * orchestrator's L3 hardware-aware load balancer to assign cameras to the
 * agent best suited for their detection workload (e.g. high-FPS cameras
 * onto GPU agents, motion-only onto CPU-only agents).
 */
export interface RunnerHardwareCapabilities {
  readonly hasGpu: boolean
  /** Inference backend identifier (e.g. 'coreml', 'openvino', 'cpu', 'cuda'). */
  readonly inferenceBackend?: string
  readonly cpuCores?: number
}

/**
 * Per-inference-device live load (multi-device C4). One entry per deviceKey a
 * runner currently has attached cameras on — feeds the orchestrator's second
 * `balance()` pass (over a node's devices, weighted on real per-pool session
 * counts). Mirrors the `devices` array in `RunnerLocalLoadSchema`.
 */
export interface RunnerDeviceLoad {
  readonly deviceKey: string
  readonly backend: string
  readonly attachedCameras: number
}

/**
 * Runtime load summary returned by `getLocalLoad`. The orchestrator's L2
 * capacity-based balancer uses this to compute a "least-loaded agent"
 * score when picking a target for new camera assignments.
 */
export interface RunnerLocalLoad {
  readonly nodeId: string
  readonly attachedCameras: number
  readonly activeCameras: number
  readonly avgInferenceFps: number
  readonly avgInferenceTimeMs: number
  readonly queueDepthTotal: number
  /** Per-inference-device live load (multi-device C4); empty on single-device
   *  / pre-multi-device runners. */
  readonly devices: readonly RunnerDeviceLoad[]
  readonly hardware: RunnerHardwareCapabilities
  /** D696: `'orchestrator'` = this runner never writes a camera's `motion` slice. Absent = an older runner, which does. */
  readonly motionSliceWriter?: 'orchestrator'
}

/**
 * Aggregate runtime metrics for a runner's whole local pool. Mirrors the
 * legacy `OrchestratorMetrics` shape so dashboards keep working unchanged
 * when they migrate from `pipeline-executor.orchestratorStatus` to the
 * new runner cap.
 */
export interface FrameLazyCounters {
  readonly framesDecoded: number
  readonly framesAdmitted: number
  readonly framesDroppedPixelFree: number
  readonly viewsMaterialized: number
  readonly viewsSkipped: number
  readonly workerToRunnerBytes: number
  readonly runnerToPoolRawBytes: number
  readonly runnerToPoolJpegBytes: number
  readonly onDemandFullFrameRequests: number
  readonly onDemandCropRequests: number
  readonly nativeHits: number
  readonly nativeMisses: number
  readonly tileHits: number
  readonly tileMisses: number
  readonly fallbackHits: number
  readonly fallbackMisses: number
  readonly retainedWritesAvoided: number
  readonly residentRefs: number
  readonly residentBytes: number
  readonly releases: number
  readonly evictions: number
  readonly staleMisses: number
}

export interface FrameLazyMetrics {
  readonly node: FrameLazyCounters
  readonly cameras: ReadonlyArray<{ readonly deviceId: number } & FrameLazyCounters>
}

export interface RunnerLocalMetrics extends OrchestratorMetrics {
  readonly nodeId: string
  readonly frameLazy?: FrameLazyMetrics
}

/**
 * Pipeline Runner provider interface — implemented by `addon-pipeline-runner`.
 *
 * One instance per node (singleton scope). Receives camera assignments from
 * the hub orchestrator, owns the per-camera frame queues + semaphore +
 * motion → detection phase machine, and emits typed events on the bus
 * (`detection.motion-analysis`, `pipeline.inference-result`, `pipeline.trace`).
 *
 * All methods exposed here mirror the cap definition exactly — there are no
 * "local-only" methods, no callbacks, no live object passing. Everything is
 * serializable so the runner is transparently routable across the cluster.
 */
export interface IPipelineRunnerProvider {
  /** Attach a camera to this runner. Subscribes to the local broker. */
  attachCamera(config: RunnerCameraConfig): Promise<{ success: true }>
  /** Detach a camera. Unsubscribes from the broker, clears queues. */
  detachCamera(input: { deviceId: number }): Promise<{ success: true }>
  /**
   * Report an external motion event for a camera. Drives the runner's
   * unified phase machine — every `detected:true` (analyzer or onboard)
   * rearms the cooldown timer; `detected:false` is a no-op. `regions`
   * is populated only by `source: 'analyzer'`.
   */
  reportMotion(
    input: import('../capabilities/pipeline-runner.cap.js').ReportMotionInput,
  ): Promise<{ success: true }>

  /** Return load summary used by the orchestrator's load balancer. */
  getLocalLoad(): Promise<RunnerLocalLoad>
  /** Return aggregate runtime metrics for this runner instance. */
  getLocalMetrics(): Promise<RunnerLocalMetrics>
  /** Per-camera metrics for cameras attached to this runner. */
  getCameraMetrics(input: { deviceId: number }): Promise<CameraMetrics | null>
  /** All per-camera metrics in one round-trip. */
  getAllCameraMetrics(): ReadonlyArray<{ deviceId: number } & CameraMetrics>
  /** List the deviceIds currently attached to this runner. */
  getLocalCameras(): readonly number[]

  /**
   * Two-plane design: run the DETAIL subtree (crop children — embedding,
   * classifier, refiner steps whose `inputClasses !== null`) for a single
   * tracked detection. See `pipelineRunnerCapability.runDetailSubtree`
   * (`capabilities/pipeline-runner.cap.ts`) for full semantics. Returns
   * `null` when neither `frameHandle` nor `cropJpeg` resolves to a crop.
   */
  runDetailSubtree(
    input: import('../capabilities/pipeline-runner.cap.js').RunDetailSubtreeInput,
  ): Promise<import('../capabilities/pipeline-runner.cap.js').RunDetailSubtreeResult | null>

  /**
   * Run ONE enrichment step against caller-supplied pixels with NO camera
   * session — no attach, no handle, no device affinity. See
   * `pipelineRunnerCapability.runStatelessStep`
   * (`capabilities/pipeline-runner.cap.ts`) for the full contract, including
   * why the model pin is refused rather than substituted.
   */
  runStatelessStep(
    input: import('../capabilities/pipeline-runner.cap.js').RunStatelessStepInput,
  ): Promise<import('../capabilities/pipeline-runner.cap.js').RunStatelessStepResult>

  /**
   * PARK a frame for a track at the instant the hub judged it relevant
   * (D422). See `pipelineRunnerCapability.parkTrackFrame`
   * (`capabilities/pipeline-runner.cap.ts`) for the contract; a refusal is
   * an answer, never a retry.
   */
  parkTrackFrame(input: {
    readonly deviceId: number
    readonly trackId: string
    readonly kind: import('../capabilities/pipeline-runner.cap.js').ParkedFrameKind
    readonly handle: import('./frame-handle.js').FrameHandle
    readonly bbox: import('../capabilities/pipeline-runner.cap.js').NativeCropBbox
    readonly maxWidth?: number
    readonly timestamp: number
  }): Promise<import('../capabilities/pipeline-runner.cap.js').ParkTrackFrameResult>

  /** A parked parcel by `(deviceId, trackId, kind)`; `null` = nothing parked here. */
  getParkedTrackFrame(input: {
    readonly deviceId: number
    readonly trackId: string
    readonly kind: import('../capabilities/pipeline-runner.cap.js').ParkedFrameKind
    /** The caller reads bytes: answer in `jpegBytes`, not base64 (D462). */
    readonly acceptJpegBytes?: boolean
  }): Promise<import('../capabilities/pipeline-runner.cap.js').ParkedTrackFrame | null>

  /** Drop every parcel of a closed track. Idempotent. */
  releaseParkedTrackFrames(input: {
    readonly deviceId: number
    readonly trackId: string
  }): Promise<{ released: number }>

  /**
   * Node benchmark measurement on THIS node (D791). See
   * `pipelineRunnerCapability.startNodeBench` for the contract.
   */
  startNodeBench(
    input: import('../pipeline/node-benchmark/schemas.js').NodeBenchRunnerInputRaw,
  ): Promise<{ accepted: true; runId: string }>
  /** The run's status; `null` when this runner does not know `runId`. */
  getNodeBenchStatus(input: {
    readonly runId: string
  }): Promise<import('../pipeline/node-benchmark/schemas.js').NodeBenchRunnerStatus | null>
  /** Stop the run; what it finished is kept. */
  abortNodeBench(input: { readonly runId: string }): Promise<{ aborted: boolean }>

  // NOTE: tuning fields (maxQueueDepth, maxConcurrentInferences,
  // targetLoadPercent, minThrottledFps) are exposed via the
  // global-level settings API (`getGlobalSettings / updateGlobalSettings`
  // on `ICamstackAddon`). The live runner instance is hot-reloaded via
  // `PipelineRunner.updateLimits()` from `PipelineRunnerAddon.updateGlobalSettings`.
  // The admin UI renders these under `NodeAddonsSettingsPanel`.
}
