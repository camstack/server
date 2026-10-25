/**
 * addon-pipeline-runner — per-node detection scheduler.
 *
 * Lives on every "vision node" (hub if hub is one, every agent that runs
 * decoders/cameras). Receives camera assignments from the hub-side
 * `addon-pipeline-orchestrator` via cap calls, owns the per-camera frame
 * queues + semaphore + motion → detection phase machine, calls the local
 * `motion-detection` and `pipeline-executor` capabilities for the actual
 * work, and emits typed events on the bus
 * (`detection.motion-analysis`, `pipeline.inference-result`, `pipeline.trace`).
 *
 * Design notes:
 *
 *  - All cap inputs/outputs are serializable so the runner is transparently
 *    routable across the cluster: when the runner is co-located with the
 *    broker/decoder/motion/detection (the default and recommended deploy),
 *    capability lookups return live singletons and frame data never crosses
 *    a process boundary. When a deploy splits the runner from the executor
 *    (rare), the lookup returns null and the runner falls back to
 *    `this.ctx.api` (broker proxy) at the cost of serialization.
 *
 *  - The scheduler core (`PipelineRunner`) is callback-driven and framework
 *    agnostic. The addon class injects the inference + motion callbacks at
 *    construction time, capturing references to the relevant providers
 *    lazily on each invocation.
 *
 *  - Result post-processing (analysis pipeline, class filters, notifications)
 *    is intentionally NOT done by the runner. The runner emits the raw
 *    inference output as a `pipeline.inference-result` event on the bus;
 *    a hub-side subscriber consumes the event and runs the post-processing
 *    pipeline. This keeps the runner stateless w.r.t. detection-side
 *    business logic and makes it possible to deploy the post-processor
 *    independently from the inference workers.
 */

import * as os from 'node:os'
import type {
  OccupancyBurstRefusal,
  AddonApi,
  AddonInitResult,
  BirthEvidence,
  CameraMetrics,
  CameraNativeDetection,
  CameraPhase,
  DecodedFrame,
  DetectionSource,
  InferenceOccasion,
  DetailStepAnnounce,
  FrameHandle,
  FrameInput,
  FrameRef,
  FrameResult,
  FrameViewSpec,
  IPipelineRunnerProvider,
  NodeBenchRunnerInputRaw,
  NodeBenchRunnerStatus,
  IScopedLogger,
  KernelInferenceHardware,
  ModelFormat,
  MotionAnalysisPayload,
  MotionRegion,
  MotionSource,
  MotionZonesRawPayload,
  NativeCropRef,
  SuppliedRootOutput,
  ObjectDetection,
  ParkedFrameKind,
  ParkedTrackFrame,
  ParkTrackFrameResult,
  PhaseTransitionPayload,
  PipelineInferenceResultPayload,
  PipelineStepInputOutput,
  RunDetailSubtreeInput,
  RunDetailSubtreeResult,
  RunnerCameraConfig,
  RunnerFrameSource,
  RunnerLocalLoad,
  RunnerLocalMetrics,
  RunStatelessStepInput,
  RunStatelessStepResult,
  StepDefinition,
} from '@camstack/types'
import {
  APPEARANCE_RESOLVES_AMBIGUITY_DEFAULT,
  BackgroundRunRegistry,
  type BackgroundRunContext,
  BaseAddon,
  cameraOwnsMotionViaSensor,
  createEvent,
  EventCategory,
  errMsg,
  failureContributionCapability,
  loadContributionCapability,
  nodePin,
  pipelineRunnerCapability,
} from '@camstack/types'
import { ChildCostRegistry } from '@camstack/types/node'
import sharp from 'sharp'
// Same-package catalog lookup (NOT a cross-addon RPC bypass): pipeline-runner
// and detection-pipeline are two addon manifests bundled in this ONE npm
// package specifically so the runner can read the static step catalog
// in-process at attach time rather than round-tripping the executor's
// schema cap for every attach. `getStepDefinition` is pure data (models,
// inputClasses, cadence) — no addon context, no runtime state.
import { getStepDefinition } from '../detection-pipeline/registry/step-definitions.js'
import { forkDecodeWorker } from '../session-decode/fork-decode-worker.js'
import { RunnerDecodeWorkers } from '../session-decode/live-decode-workers.js'
import { resolveNativeLeaseKnobs } from '../session-decode/native-lease-config.js'
import type { WorkerLeaseKnobs } from '../session-decode/native-lease-knobs.js'
import {
  type SessionHwaccelOffer,
  SessionHwaccelSource,
} from '../session-decode/session-hwaccel.js'
import {
  type GuardedSlotWake,
  startGuardedSessionDecode,
} from '../session-decode/guarded-session-decode.js'
import type { LiveWorkerLease } from '../session-decode/live-worker-admission.js'
import {
  DEFAULT_MAX_LIVE_DECODE_WORKERS,
  DEFAULT_NODE_DECODE_BUDGET_MB,
  decodeWorkerFootprintMb,
  LiveDecodeWorkerAdmission,
  maxInflightPerCamera,
} from '../session-decode/live-worker-admission.js'
import { localFrameRegistry } from '../session-decode/local-frame-registry.js'
import { withRetainedReader } from './retained-reader-hold.js'
import { NATIVE_CROP_LEASE_MAX_AGE_MS } from '../session-decode/native-crop-lease-age.js'
import {
  DEFAULT_NATIVE_CROP_REGISTRY_CAP,
  NativeCropRegistry,
} from '../session-decode/native-crop-registry.js'
import {
  type NodeDecodeLimits,
  resolveNodeDecodeLimits,
} from '../session-decode/node-decode-budget.js'
import { createRetainedContentFallback } from '../session-decode/retained-content-fallback.js'
import {
  type ParkedFrameEviction,
  PartitionedParkedFrameStore,
} from '../session-decode/parked-frame-store.js'
import { RetainedFrameStore } from '../session-decode/retained-frame-store.js'
import type {
  ForkedChildLike,
  SessionDecodeTeardown,
} from '../session-decode/session-decode-coordinator.js'
import { isSessionDecodeReadGone } from '../session-decode/session-decode-read-gone.js'
import type { NativeCropRequester } from '../session-decode/session-decode-pump.js'
import { startSessionDecodePump } from '../session-decode/session-decode-pump.js'
import type { VideoFrameSource } from '../session-decode/video-frame-generator.js'
import { resolveHubHostname } from '../shared/hub-hostname.js'
import { getSharp } from '../shared/lazy-sharp.js'
import { planDetectionSources } from './detection-source-plan.js'
import { applyMaskFill, applyRootMasks } from './root-mask-supply.js'
import {
  applyPackageFill,
  applyRootSupplyAuthority,
  EMPTY_ROOT_SUPPLY_PLAN,
  newlySuppliedSteps,
  planRootSupplies,
  type RootSupplyPlan,
  suppliedSteps,
} from './root-supply.js'
import {
  DETECTION_PRE_ROLL_REQUEST_MS,
  preRollRequestOf,
  withDetectionIntent,
} from '../stream-broker/rtsp/restream-intent.js'
import {
  type CacheBenchFrameInput,
  type CacheBenchFrameResult,
  type PipelineRunnerBenchActions,
  pipelineRunnerBenchActions,
  type ReleaseBenchFrameInput,
  type ReleaseBenchFrameResult,
  type SyntheticBenchInput,
  type SyntheticBenchPool,
  type SyntheticBenchProgress,
  type SyntheticBenchResult,
  type SyntheticBenchStatus,
} from './bench-actions.js'
import {
  type BenchPoolTarget,
  buildBenchRunPipelineInput,
  buildBenchTuningQuery,
  canUseCachedFastPath,
  fastPathRefusalReason,
} from './bench-dispatch.js'
import {
  BIRTH_EVIDENCE_JPEG_QUALITY,
  BirthNoveltyMemory,
  type EvidencePlanEntry,
  planBirthEvidence,
} from './birth-evidence.js'
import { type AppearanceAttachCost, attachAppearanceIfEnabled } from './appearance-attach.js'
import {
  APPEARANCE_SCOPE,
  APPEARANCE_VIEW,
  type AppearanceCrop,
  overlapsSameClass,
  type RgbView,
} from './appearance-descriptor.js'
import {
  type CapacityDispatchOutcome,
  type CapacityRampStep,
  type CapacitySlo,
  DEFAULT_CAPACITY_SLO,
  executeCapacityRamp,
} from './capacity/capacity-runner.js'
import {
  type AbortCapacityRampInput,
  type AbortCapacityRampResult,
  type CapacityRampOverview,
  type CapacityRampProgress,
  type CapacityRampStatus,
  type CapacityRampStepResult,
  type GetCapacityRampStatusInput,
  type RunCapacityRampAccepted,
  type RunCapacityRampInput,
  type RunCapacityRampResult,
  toCapacityStepResult,
} from './capacity/capacity-schemas.js'
import { startStallSampler } from './capacity/stall-sampler.js'
import { CropConventionSource } from './crop-convention-source.js'
import {
  buildDetailHandleExpiredError,
  buildDetailNotAttachedError,
  DETAIL_PARK_GRACE_MS,
  isParkedDetailFresh,
  type ParkedDetailEntry,
  type ParkedDetailState,
} from './detail-park.js'
import {
  denormalizeRect,
  findMatchingDetailSteps,
  isDetailHandleExpiredRefusal,
  isDetailNotAttachedRefusal,
  type NativeCropFetch,
  type NormBbox,
  runDetailSubtree as runDetailSubtreeImpl,
} from './detail-subtree.js'
import {
  FACE_OUTSIDE_PARENT_LOG_INTERVAL_MS,
  FaceOutsideParentLog,
} from './face-parent-geometry.js'
import {
  type DetailStepPlacement,
  placeDetailStep,
  stepsForElectedPool,
  type ResolveStepDeviceResult,
} from './device-jump.js'
import { summarizeDeviceLoad } from './device-load.js'
import { CustomModelCatalog } from '../shared/custom-model-catalog.js'
import { RunnerFailureReport } from './failure-report.js'
import { FirstDetectionFrameTimer } from './first-detection-frame.js'
import { FrameCutterBinding } from './frame-cutter-binding.js'
import { OccupancyBurstLedger, type OccupancyBurstSummary } from './occupancy-burst-ledger.js'
import { FrameLazyTelemetry } from './frame-lazy-metrics.js'
import { selectExecutorFrameSource } from './frame-ref-transport.js'
import { summarizeRunnerHardware } from './hardware-capabilities.js'
import {
  applyCropClassFloors,
  planMotionCrops,
  type RecoveryRecipe,
  readRecoveryRecipeForSteps,
} from './motion-crop-plan.js'
import { MOTION_FRAME_VIEW, resolveMotionFrameView } from './motion-frame-view.js'
import {
  MotionSettleGovernor,
  PACKAGE_DETECTION_STEP_ID,
  withPackageLook,
} from './motion-settle-governor.js'
import {
  type NativeCropMissReason,
  type NativeCropPixels,
  type NativeCropTier,
  resolveNativeCropHitKind,
  resolveNativeCropSource,
} from './native-crop-tier.js'
import { NativeLeaseSettingsSource } from './native-lease-settings-source.js'
import { NodeDecodeLimitsSource } from './node-decode-limits-source.js'
import {
  encodeCrossNodeCrop,
  isContinuousRetainEnabled,
  OnDemandRetentionSession,
} from './on-demand-retention.js'
import {
  motionNearPackageZone,
  type NormalizedBox,
  packageZoneUnion,
} from './package-zone-proximity.js'
import { isRemoteRestream, profileForStreamId } from './remote-restream.js'
import { type PhaseTransitionMeta, PipelineRunner } from './runner.js'
import { Semaphore } from './semaphore.js'
import {
  countRecoverySkips,
  fuseRecoveredDetections,
  MotionRegionMirror,
  planRecoveryCrops,
  RECOVERY_MIN_INTERVAL_MS,
  RECOVERY_VIEW_PX,
  type RecoveryCrop,
  remapCropDetections,
  selectRecoveryStep,
} from './small-subject-recovery.js'
import { runStatelessStep as runStatelessStepImpl } from './stateless-step.js'
import type { NodeBenchHost } from './node-bench/node-bench-host.js'
import { createNodeBenchHost } from './node-bench/node-bench-wiring.js'
import { planTileCuts } from './tile-cut-plan.js'
import { readLocalResidentEngines } from './local-resident-engines.js'
import { buildRuntimeLabels, type ResidentEngine } from './runtime-labels.js'
import {
  parkTrackFrame as parkTrackFrameImpl,
  type ParkTrackFrameInput,
} from './track-frame-park.js'
import { rootObjectGate } from '../detection-pipeline/pipeline/macro-gate.js'

/**
 * The zero of the recovery skip counters — one frozen literal so a new reason
 * cannot be added to the map's shape and forgotten in one of the two places
 * that used to spell the zero out by hand.
 */
const EMPTY_RECOVERY_SKIPS = Object.freeze({
  rateLimited: 0,
  noMotion: 0,
  tooLarge: 0,
  covered: 0,
  unmagnifiable: 0,
})

/**
 * How often the small-subject recovery pass reports per camera. The pass runs
 * up to twice a second; one aggregated line every ten seconds says how often
 * it ran, what it cost and what it found — the numbers a "did the second
 * pass help on 101?" question is answered from.
 */
const RECOVERY_LOG_INTERVAL_MS = 10_000

/**
 * How often a device's package zone-union geometry is re-read. An operator
 * redrawing a package zone takes effect within one interval; the read is a
 * cross-addon cap call reached from the per-frame package gate, so it must be
 * throttled to something far slower than the frame rate.
 */
const PACKAGE_ZONE_UNION_TTL_MS = 60_000

/**
 * Bound on the frames whose cutter is bound but whose result has not come back.
 * A few per camera in flight; the ceiling only catches results that never
 * arrive (shed, inference timeout, detach mid-flight).
 */
const MAX_BOUND_FRAME_CUTTERS = 256

/** How often a camera reports its undispatched cuts. */
const TILE_CUT_DROP_LOG_INTERVAL_MS = 60_000
/**
 * How often the `pipeline stats` runtime labels are re-read (D463). Slow on
 * purpose: this answers "which engine is this node on", which changes when an
 * operator re-selects one or lazy provisioning completes — not per frame.
 */
const RUNTIME_INFO_REFRESH_MS = 300_000
/** Sentinel for "no context yet" so it is one transition, not a per-refresh line. */
const NO_CONTEXT_FAILURE = 'no addon context'

/** How often a camera reports parcels that left without a release (D422). */
const PARKED_EVICTION_LOG_INTERVAL_MS = 60_000

/**
 * How often a camera reports what carrying its birth evidence COST (D379).
 *
 * The cost of this change is the one thing that must be measured rather than
 * estimated, so the report is per camera, states encodes / bytes / encode-ms
 * over the window, and drains its counters — a camera that cut nothing says
 * nothing until it does.
 */
const BIRTH_EVIDENCE_REPORT_INTERVAL_MS = 600_000

/** What attaching descriptors cost one camera since the last report (D683). */
interface AppearanceCostTally {
  attached: number
  tooSmall: number
  failed: number
  skippedNoPixels: number
  /** First-level boxes a `'candidates'` scope left out (D683 Step 9's fallback). */
  skippedScope: number
  ms: number
}

export interface RunnerAddonConfig {
  readonly maxQueueDepth: number
  readonly maxConcurrentInferences: number
  readonly targetLoadPercent: number
  readonly minThrottledFps: number
  /**
   * SPAWN-CONCURRENCY GATE cap (P5 first pass).
   * Session-decode is now the ONLY decode path (the legacy shared shm
   * frame-handle poller was removed with @camstack/shm-ring on 2026-07-16), so
   * a synchronized multi-camera motion burst would otherwise fork N disposable
   * decode workers at once and stampede the shared iGPU. This is the MIN floor
   * of decode-worker forks allowed to spin up CONCURRENTLY on this node; forks
   * beyond the floor queue (FIFO) until an in-flight worker delivers its first
   * frame (GPU context established) or tears down. Sized `>=` typical camera
   * count → the gate never engages and behavior is unchanged; it only bounds a
   * burst. This IS the rate limit.
   *
   * TODO(adaptive): a FULL adaptive model — size this from a
   * measured-fps low-watermark of the running decode workers (start a new fork
   * only when running ones aren't struggling) and evict a struggling session
   * (kill-watermark). Deliberately NOT built in this first pass to keep it
   * bounded + safe; a static floor is the conservative subset.
   */
  readonly maxConcurrentDecodeSpawns: number
  /**
   * Hard ceiling on decode workers ALIVE at once on this node.
   *
   * Distinct from {@link RunnerAddonConfig.maxConcurrentDecodeSpawns}, which is a
   * RATE limit: the spawn gate's permit is released on the worker's FIRST FRAME,
   * not on session end, so it bounds cold-start stampedes and nothing else. This
   * is the concurrency bound, and it is an ADMISSION decision — a session that
   * does not fit is refused and retried on the guarded ladder, never queued.
   * See `LiveDecodeWorkerAdmission` for why, and how the default is sized.
   */
  readonly maxLiveDecodeWorkers: number
  /**
   * RAM live decode workers may commit on this node, in MB. Divided by one
   * worker's worst case it DERIVES the ceiling; `maxLiveDecodeWorkers` only
   * clamps the result. See `DEFAULT_NODE_DECODE_BUDGET_MB`.
   */
  readonly nodeDecodeBudgetMb: number
  /**
   * Per-node override of the decode RAM budget (MB). Absent ⇒ cluster /
   * derived (D365). Schema field is `perNode: true` on Engine & decoder.
   */
  readonly decodeBudgetMb?: number
  /**
   * Per-node override of the live-worker cap. Absent ⇒ cluster
   * `maxLiveDecodeWorkers`. Key differs so it does not collide with the
   * cluster field of the same conceptual name.
   */
  readonly decodeMaxLiveWorkers?: number
}

export const DEFAULT_CONFIG: RunnerAddonConfig = {
  maxQueueDepth: 30,
  // CoreML window accumulator coalesces concurrent calls into a single
  // model.predict([list]) — the more in-flight, the larger the batch and
  // the higher the per-frame throughput. With concurrency=2 the window
  // never fills past batch=2, capping the pool at ~50 fps single-node.
  // 16 matches the slider ceiling and lines up with bench numbers
  // (parallel=16 hits batch=7-8/8, sustaining ~140 fps full path).
  maxConcurrentInferences: 16,
  targetLoadPercent: 80,
  minThrottledFps: 1,
  // Min floor of concurrent decode-worker forks. 3 lets low-camera-count
  // setups never queue while still capping a synchronized burst.
  maxConcurrentDecodeSpawns: 3,
  // Upper CLAMP on live decode workers. It is no longer the RAM bound: a count
  // cannot express one while the per-worker cost is itself a knob (`budgetMb`).
  // See DECODE_WORKER_BASELINE_MB for the three contradicting figures this
  // replaced.
  maxLiveDecodeWorkers: DEFAULT_MAX_LIVE_DECODE_WORKERS,
  // The actual RAM bound. The ceiling in force is
  // `min(maxLiveDecodeWorkers, floor(nodeDecodeBudgetMb / workerFootprint))`.
  nodeDecodeBudgetMb: DEFAULT_NODE_DECODE_BUDGET_MB,
}

/** An acquired session-decode restream + its one-shot refcount release. */
/** What {@link getNativeCrop} is asked for. */
interface NativeCropRequestInput {
  handle: FrameHandle
  bbox: { x: number; y: number; w: number; h: number }
  maxWidth?: number
  encodeJpeg?: boolean
  acceptJpegBytes?: boolean
}

/** What {@link getNativeCrop} answers with; `null` is a miss. */
interface NativeCropRequestResult {
  bytes?: Uint8Array
  jpeg?: string
  jpegBytes?: Uint8Array
  width: number
  height: number
  tier?: 'native' | 'ram-fullframe'
}

interface SessionDecodeRestream {
  readonly source: VideoFrameSource
  /** Release the broker restream refcount. Idempotent; benign on hub restart. */
  readonly release: () => Promise<void>
}

/**
 * Camera attachment record kept by the runner addon. Holds the original
 * RunnerCameraConfig for introspection via `getLocalCameras` plus the
 * live broker subscription handles needed to tear down on detach.
 */
/**
 * Keep-warm grace after the motion gate closes before the per-session
 * detection decode worker is actually torn down. Motion re-firing inside
 * this window REUSES the warm worker instead of re-forking it — killing the
 * spawn/teardown churn (and its cold-start latency spike) that on-motion
 * cameras produced when every gate open/close forked and killed a worker.
 */
/** JPEG quality for the runner→executor detection-frame hop. q82 keeps
 *  detector-relevant detail (source is h264 anyway) at ~10-15× less payload
 *  than raw RGB — the hop transits the hub main process (UDS child↔child
 *  routing), which OOM'd under raw frames. */
const DETECTION_HOP_JPEG_QUALITY = 82
const SPLIT_DETECTION_VIEW: FrameViewSpec = {
  content: { width: 640, height: 640 },
  fit: 'contain',
  format: 'rgb',
}

function writeRetainedDetectionFrame(
  store: RetainedFrameStore | null,
  deviceId: number,
  frame: DecodedFrame,
  retention?: OnDemandRetentionSession | null,
): FrameHandle | undefined {
  if (retention) return retention.admitFrame(deviceId, frame)
  if (!store) return undefined
  if (!isContinuousRetainEnabled()) return store.allocateHandle(deviceId, frame) ?? undefined
  return (
    store.write(
      deviceId,
      frame,
      frame.frameRef
        ? createRetainedContentFallback(localFrameRegistry, frame.frameRef)
        : undefined,
    ) ?? undefined
  )
}

/**
 * Occupancy-burst safety timeout (both the dial path and the analyzer-tap
 * path — Task 10). Bounds worst-case burst latency when frames stop
 * arriving mid-burst — a dial that never gets a keyframe, or a tap whose
 * motion subscription closes before N frames arrive.
 */
const OCCUPANCY_BURST_SAFETY_TIMEOUT_MS = 8_000

/**
 * How long a burst whose collection has ended waits for the frames it admitted
 * to be INFERRED before it reports anyway (D652).
 *
 * A burst's verdict is read off its frames' results, so it completes when they
 * settle, not when they are enqueued. This bound is only for a frame that never
 * settles. Measured on the live hub 2026-09-26, the worst enqueue→emit of a
 * 10 s window was ≤1.5 s in 98.0% of 2 254 windows and ≤5 s in 98.9%; what lies
 * beyond is the inference-pool GPU hang, which the runner's own 20 s inference
 * timeout already ends. A timed-out burst counts its unsettled frames as lost
 * and says so on its `burst complete` line.
 */
const OCCUPANCY_BURST_SETTLE_BOUND_MS = 5_000

/**
 * Freshness window for `lastMotionFrameAt` (Task 10 hardening). A non-null
 * `attachment.motionUnsubscribe` only proves a subscription handle exists —
 * NOT that frames are actually flowing (guarded-session-decode can return
 * its teardown synchronously, and a failed `acquireSessionDecodeRestreamFrom`
 * acquire never retries, leaving the handle permanently non-null with zero
 * frames arriving). `runOccupancyBurst` additionally requires a motion frame
 * to have been teed within this window before it will route to the tap path.
 */
const MOTION_FRESHNESS_WINDOW_MS = 5_000

/** Delay before re-dialing a detection decode whose worker died unexpectedly. */
const DETECTION_REDIAL_DELAY_MS = 2_000
/**
 * Two unexpected decode deaths within this window → stop re-dialing and detach
 * (the orchestrator re-dispatches on the next motion signal). Bounds the loop
 * when the camera/source itself is broken.
 */
const DETECTION_REDIAL_GIVEUP_WINDOW_MS = 60_000

/**
 * In-flight state for a TAP-based occupancy burst (Task 10) — reusing an
 * already-live analyzer motion subscription instead of dialing a fresh
 * main-stream decode. Populated by `startOccupancyTap`, drained by
 * `teeOccupancyTapFrame` (called from `runMotionAnalysis` on every arriving
 * substream frame while `remaining > 0`).
 */
interface OccupancyTapState {
  remaining: number
  collected: number
  safetyTimer: ReturnType<typeof setTimeout>
  /** Settles the tap's admitted frames; the tap completes on it (D652). */
  readonly ledger: OccupancyBurstLedger
  /**
   * Resolves the promise `startOccupancyTap` returned to `runOccupancyBurst`
   * with the tap's {@link OccupancyBurstSummary} once every frame it admitted
   * has settled (D652). Keeping that promise pending until then is what makes
   * `occupancyActiveCount` (the global burst-concurrency gate) hold a slot for
   * the tap's full duration, exactly like the dial path. The caller uses
   * `frames` to decide between reporting the outcome and falling back to a
   * dial burst (Task 10 hardening #2 — see {@link MOTION_FRESHNESS_WINDOW_MS}).
   */
  resolve: (summary: OccupancyBurstSummary) => void
}

interface AttachedCamera {
  readonly config: RunnerCameraConfig
  /** Session-decode teardowns drain by default (D652); shutdown says `'immediate'`. */
  motionUnsubscribe: SessionDecodeTeardown | null
  detectionUnsubscribe: SessionDecodeTeardown | null
  /**
   * Detail-subtree announce for this camera's enabled child steps —
   * precomputed once at attach time (see {@link deriveDetailSteps}) and
   * spread onto every emitted `PipelineInferenceResultPayload` so a
   * track-level consumer can dispatch `pipelineRunner.runDetailSubtree`
   * on the right cadence without a separate round-trip.
   */
  readonly detailSteps: readonly DetailStepAnnounce[]
}

/**
 * ## There is no decode keep-warm any more — D453 removed it
 *
 * A `WarmDetachedDecode` used to hold a detection worker alive for 15 s across
 * a detach, hoping the next motion event would adopt it. It did not park: it
 * kept its broker restream lease and kept DECODING, because the child's loop is
 * `for await (... decoder.frames(demuxer.packets(...)))`, driven by the demuxer
 * and not by the parent's `pull` — `minIntervalMs` throttles only inside
 * `FrameSlot.publish`, after the decode. `framesDecoded` advanced in 122 of 122
 * park windows at full source rate, and a decode-worker child costs 40-80% of a
 * core.
 *
 * So the park cost about what running costs, and it bought a re-fork back in
 * 12% of cases: on this fleet, 272 of 440 park windows expired having adopted
 * nothing, while the two decode-worker children stood at 319% of the 522% of
 * CPU CamStack drew on the host. D282 put the arithmetic at ~25x net-negative
 * against the forks it avoided, and D453 made the fork itself ~150 ms and
 * ~100 MB cheaper, which only widens it.
 *
 * Do not reintroduce a keep-warm shaped like this one, and do not "fix" it with
 * a longer TTL: the measured p50 gap between two sessions of one camera is
 * 61 s, so a longer window scales the waste and not the hit rate. If a warm
 * process is wanted, it must be a process that holds NO stream and decodes
 * NOTHING — see D453 for what that costs and why it was not taken either.
 */

/**
 * The source fields a `DetectionPhaseTransition` carries, per cause. A motion
 * transition: its source and cooldown. A session attach: the motion that opened
 * it, as the orchestrator dispatched it — absent when it sent none. A detach:
 * nothing.
 */
export function phaseTransitionSourceFields(
  meta: PhaseTransitionMeta,
): PhaseTransitionSourceFields {
  if (meta.cause === 'motion') return { source: meta.source, cooldownMs: meta.cooldownMs }
  if (meta.cause === 'detach' || meta.trigger === undefined) return {}
  const { source, triggeredBy, sensorName } = meta.trigger
  return { source, triggeredBy, ...(sensorName !== undefined ? { sensorName } : {}) }
}

export type PhaseTransitionSourceFields = Pick<
  PhaseTransitionPayload,
  'source' | 'cooldownMs' | 'triggeredBy' | 'sensorName'
>

/**
 * Pure decision helper: returns `true` when a dynamic frame-diff analyzer
 * subscription should be opened for an onboard-motion camera.
 *
 * Conditions (all must hold):
 * - `onboardMotionDrivesAnalyzer` flag is enabled on the config.
 * - `motionSources` does NOT already include `'analyzer'` — if it does,
 *   the analyzer runs continuously and there is nothing to gate.
 *
 * Extracted as a pure function so the unit suite can exercise the decision
 * logic without instantiating the full addon.
 */
export function shouldStartOnboardAnalyzer(config: RunnerCameraConfig): boolean {
  if (!config.onboardMotionDrivesAnalyzer) return false
  if (config.motionSources.includes('analyzer')) return false
  return true
}

/**
 * D475: does this camera OWN its motion through a sensor (firmware `onboard`,
 * or the device's own `device-activity`) rather than the analyzer? On such a
 * camera the analyzer's `MotionOnMotionChanged` transitions never reach
 * `reportMotion`: "the pipeline must never overwrite what the sensors do". A
 * camera with `motionSources: ['analyzer']` only is unaffected. The rule lives
 * in `@camstack/types`, once, because the orchestrator's camera motion slice
 * (D696) applies the same rule to decide which motion events it counts.
 */
export { cameraOwnsMotionViaSensor }

/** Recursively collects the `addonId` of every ENABLED step in the tree. */
function collectEnabledStepIds(
  steps: readonly PipelineStepInputOutput[] | undefined,
  acc: Set<string>,
): void {
  if (!steps) return
  for (const step of steps) {
    if (!step.enabled) continue
    acc.add(step.addonId)
    collectEnabledStepIds(step.children, acc)
  }
}

/**
 * Looks up a catalog step definition, tolerating an unknown id. A stale
 * config entry (removed/custom addon) must degrade to "not announced"
 * rather than fail the attach — `getStepDefinition` throws on a miss.
 */
function tryGetStepDefinition(stepId: string): StepDefinition | null {
  try {
    return getStepDefinition(stepId)
  } catch {
    return null
  }
}

/**
 * A detail-plane step: its catalog definition consumes a parent class
 * (`inputClasses` non-null). Unknown/custom addonIds are root-plane — the
 * same reading as the executor's frame-plane skip and `deriveDetailSteps`.
 */
function isDetailPlaneStepId(stepId: string): boolean {
  const def = tryGetStepDefinition(stepId)
  return def !== null && def.inputClasses !== null
}

/**
 * Precomputes the `detailSteps` announce (two-plane design) for a camera's
 * configured step tree: every ENABLED step whose catalog definition is a
 * detail/child step (`inputClasses !== null` — a root step like
 * `object-detection` runs on every frame on the `'frame'` plane and has
 * nothing to announce) is surfaced as `{ stepId, inputClasses, cadence }`
 * so a track-level consumer knows what it can dispatch via
 * `pipelineRunner.runDetailSubtree` and on what cadence, without a
 * separate round-trip to the executor's schema/config caps.
 *
 * Unknown step ids (stale config referencing a removed/custom addon) are
 * skipped rather than thrown — the catalog is the single source of truth
 * for cadence and a stale entry must not fail the attach.
 *
 * Extracted as a pure function so the unit suite can exercise the
 * derivation without instantiating the full addon.
 */
export function deriveDetailSteps(
  steps: readonly PipelineStepInputOutput[] | undefined,
  plan: RootSupplyPlan = EMPTY_ROOT_SUPPLY_PLAN,
): readonly DetailStepAnnounce[] {
  const stepIds = new Set<string>()
  collectEnabledStepIds(steps, stepIds)
  // D730: a step whose supply is effective is still ANNOUNCED (the notification
  // centre reads the list as "what runs here"), carrying the model that
  // supplies it and how — the dispatcher never infers it.
  const supplied = suppliedSteps(plan)

  const announces: DetailStepAnnounce[] = []
  for (const stepId of stepIds) {
    const def = tryGetStepDefinition(stepId)
    if (!def || def.inputClasses === null) continue
    const by = supplied.get(def.id)
    announces.push({
      stepId: def.id,
      inputClasses: def.inputClasses,
      cadence: def.cadence ?? { trigger: 'once', maxPerTrack: 3 },
      ...(by !== undefined ? { filledBy: by.modelId, filledAs: by.kind } : {}),
    })
  }
  return announces
}

function toFrameInput(frame: DecodedFrame): FrameInput {
  return {
    data: frame.data,
    width: frame.width,
    height: frame.height,
    format: frame.format,
    timestamp: frame.timestamp,
  }
}

/**
 * Convert a packed RGB24 `DecodedFrame` into a packed GRAY8 one using the
 * BT.601 luma weighting (Y = 0.299R + 0.587G + 0.114B, integer-approximated as
 * 77/150/29 over 256).
 *
 * This is what lets **sensor-triggered (onboard) motion share the detection
 * decode**: the gray the motion analyzer needs is just the luma of the
 * already-decoded detection `rgb` frame, so no second decoder is spun up. Far
 * cheaper than a full second decode (a per-pixel weighted sum vs. an entire
 * H.264/H.265 decode). Persistent (analyzer-only) motion keeps its own gray
 * decode on the sub stream and never hits this path.
 */
export function rgbFrameToGrayFrame(frame: DecodedFrame): DecodedFrame {
  const rgb = frame.data
  const pixels = frame.width * frame.height
  const gray = Buffer.allocUnsafe(pixels)
  for (let i = 0, j = 0; i < pixels; i++, j += 3) {
    gray[i] = (rgb[j]! * 77 + rgb[j + 1]! * 150 + rgb[j + 2]! * 29) >> 8
  }
  return {
    data: gray,
    width: frame.width,
    height: frame.height,
    format: 'gray',
    timestamp: frame.timestamp,
    ...(frame.capturedAt !== undefined ? { capturedAt: frame.capturedAt } : {}),
  }
}

/** The stream + pixel format a motion subscription reads from. */
export interface MotionFrameSource {
  readonly streamId: string
  readonly format: 'gray' | 'rgb'
  /** True when riding the detection decode (rgb→gray) rather than a sub-stream gray decode. */
  readonly shared: boolean
}

/**
 * Decide where the motion analyzer reads frames from.
 *
 * - `sharedWithDetection` (onboard/sensor-triggered) AND detection actually
 *   runs (`detectionMode !== 'disabled'`) → ride the detection decode:
 *   `rgb` on the MAIN (`detectionStreamId`) stream, converted to gray. No
 *   second decoder — it rides detection's session-decode worker.
 * - Otherwise (persistent analyzer, or detection disabled) → a dedicated
 *   `gray` decode on the SUB (`motionStreamId`) stream, exactly as before.
 *
 * Pure so the decision is unit-testable without the addon/broker.
 */
export function resolveMotionFrameSource(
  config: Pick<RunnerCameraConfig, 'motionStreamId' | 'detectionStreamId' | 'detectionMode'>,
  sharedWithDetection: boolean,
): MotionFrameSource {
  const shared = sharedWithDetection && config.detectionMode !== 'disabled'
  return shared
    ? { streamId: config.detectionStreamId, format: 'rgb', shared: true }
    : { streamId: config.motionStreamId, format: 'gray', shared: false }
}

/**
 * The owner hostname a session-decode worker must dial to reach this camera's
 * compressed restream. `undefined` (→ the broker returns a `127.0.0.1` URL,
 * correct for a node-local co-located worker) unless the camera's source is a
 * cross-node remote-restream, in which case the owner host is resolved exactly
 * as `remoteSourceFor`/`RemoteSourcePlane` do. Pure so the decision is
 * unit-testable without the addon/broker.
 */
export function resolveSessionDecodeHostname(
  config: Pick<RunnerCameraConfig, 'frameSource'>,
  hubUrl: string | undefined,
): string | undefined {
  const frameSource = config.frameSource
  if (!isRemoteRestream(frameSource)) return undefined
  return resolveOwnerRestreamHost(frameSource, hubUrl)
}

/**
 * The camera-source OWNER node for a session-decode acquire, or `undefined`
 * when the source is node-local (co-located, pre-cross-node). Mirrors
 * `resolveSessionDecodeHostname`: only a `remote-restream` frame source names an
 * owner. Used to `nodePin` the broker calls at the actual owner.
 */
export function resolveSessionDecodeOwnerNodeId(
  config: Pick<RunnerCameraConfig, 'frameSource'>,
): string | undefined {
  const frameSource = config.frameSource
  if (!isRemoteRestream(frameSource)) return undefined
  return frameSource.ownerNodeId
}

/**
 * The host a cross-node consumer dials for the owner's compressed restream.
 * Precedence: the orchestrator-resolved `ownerReachableHost` (the per-node
 * Cluster-UI override) → the operator `hubHostnameOverride` escape hatch →
 * the `CAMSTACK_HUB_URL`-derived host (the auto-detected Moleculer address).
 * `undefined` only when none resolve (the acquire then fails loudly rather
 * than silently dialing `127.0.0.1` on a remote node).
 */
function resolveOwnerRestreamHost(
  frameSource: Extract<RunnerFrameSource, { kind: 'remote-restream' }>,
  hubUrl: string | undefined,
): string | undefined {
  const reachable = frameSource.ownerReachableHost?.trim()
  if (reachable !== undefined && reachable.length > 0) return reachable
  return resolveHubHostname(frameSource.hubHostnameOverride, hubUrl)
}

export interface AcquireSessionDecodeRestreamParams {
  readonly deviceId: number
  readonly streamId: string
  readonly tag: string
  readonly hostname?: string
  readonly ownerNodeId?: string
  /**
   * Declare this dial as a DETECTION decode, so the restreamer exempts it from
   * the live-edge join withhold and hands it the current-GOP burst instead of
   * leaving it blind until the camera's next IDR (see `restream-intent.ts`).
   *
   * Set ONLY by the detection session-decode call site. The motion (gray,
   * sub-stream) decode and every other muted consumer keep today's behaviour.
   */
  readonly detectionIntent?: boolean
}

/**
 * Acquire the broker's COMPRESSED passthrough restream for one camStream and
 * wrap it as a {@link VideoFrameSource} the decode worker can dial. Mirrors
 * {@link RemoteSourcePlane}'s acquire: resolve the profile the camStream
 * feeds, then `getStreamWithCodec({ video: 'copy' })` (refcounted — rides the
 * broker's single source pull, never a second camera dial). No `hostname`:
 * the P1 flagged camera is HUB-LOCAL, so the returned `127.0.0.1` URL is
 * dialable from this hub-resident runner. Returns `null` (loudly logged) when
 * no profile is bound yet — the caller opens no subscription.
 *
 * Extracted as a standalone exported function (rather than a private method)
 * so the owner-node pin threading through the three `streamBroker` calls
 * (`listAllProfileSlots`, `getStreamWithCodec`, `releaseStreamWithCodec`) is
 * directly unit-testable without instantiating the addon class. The private
 * `acquireSessionDecodeRestream` method on {@link PipelineRunnerAddon} is a
 * thin delegator to this function — its two call sites are unchanged.
 */
export async function acquireSessionDecodeRestreamFrom(
  api: AddonApi,
  logger: IScopedLogger,
  params: AcquireSessionDecodeRestreamParams,
): Promise<SessionDecodeRestream | null> {
  const { deviceId, streamId, tag, hostname, ownerNodeId, detectionIntent } = params
  const pin = ownerNodeId !== undefined ? nodePin(ownerNodeId) : undefined
  const slots = await api.streamBroker.listAllProfileSlots.query(undefined, pin)
  const profile = profileForStreamId(slots, deviceId, streamId)
  if (profile === null) {
    logger.error('session-decode: no broker profile feeds camStream — cannot acquire restream', {
      tags: { deviceId },
      meta: { streamId },
    })
    return null
  }
  // Cross-node (point 3): when the camera's source is on a REMOTE node, pass
  // the owner `hostname` so the broker returns a LAN-dialable restream URL —
  // mirrors `RemoteSourcePlane`/`remoteSourceFor`. A node-local source passes
  // no hostname → the broker returns `127.0.0.1` (correct for the co-located
  // worker), preserving the P1 behavior.
  const rtpSource = await api.streamBroker.getStreamWithCodec.mutate(
    {
      deviceId,
      video: 'copy',
      audio: 'none',
      profile,
      tag,
      ...(hostname !== undefined ? { hostname } : {}),
    },
    pin,
  )
  const codec = rtpSource.videoCodec === 'H265' ? 'h265' : 'h264'
  // The broker returns the video-only (`/muted`) restream for `audio: 'none'`.
  // A detection dial rewrites that to the detection-intent variant so the
  // restreamer serves it the join burst — the dial URL is the only channel the
  // RTSP path has, and the broker cap input carries no purpose field.
  // The dial states BOTH halves (D382): the intent, which is what lifts the
  // live-edge withhold, and the amount of retained history this consumer asks
  // for. They used to be one: declaring the intent was enough to be handed the
  // whole prebuffer, so detection received a recording-sized backlog because
  // nothing in the path said otherwise — not because anybody had decided it
  // needed one. `DETECTION_PRE_ROLL_REQUEST_MS` is that decision, made once,
  // in the open, at a value that keeps today's behaviour until the measurement
  // says what it should be.
  const restreamUrl = detectionIntent
    ? withDetectionIntent(rtpSource.url, DETECTION_PRE_ROLL_REQUEST_MS)
    : rtpSource.url
  const source: VideoFrameSource = { restreamUrl, deviceId, codec }
  const pipelineKey = rtpSource.pipelineKey
  let released = false
  const release = async (): Promise<void> => {
    if (released) return
    released = true
    await api.streamBroker.releaseStreamWithCodec
      .mutate({ pipelineKey }, pin)
      .catch((err: unknown) => {
        logger.debug('session-decode: releaseStreamWithCodec failed (benign on hub restart)', {
          tags: { deviceId },
          meta: { pipelineKey, error: errMsg(err) },
        })
      })
  }
  return { source, release }
}

/**
 * Interval for periodic metric snapshot emission. ~1 Hz strikes the
 * balance between UI freshness (overlay phase / fps numbers feel live)
 * and bus traffic (one snapshot per attached camera + one per node
 * load is well under 100 events/s even at 50 cameras).
 */
const METRICS_SNAPSHOT_INTERVAL_MS = 1_000
/**
 * Force a metrics-snapshot emit at least every 30s even when the
 * payload hasn't changed — gives the UI's "agent reachable" chip a
 * heartbeat without the per-tick spam an unconditional emit
 * produces. Picked so a 5-minute idle window emits ~10 events
 * instead of ~300.
 */
const METRICS_HEARTBEAT_MS = 30_000

export default class PipelineRunnerAddon
  extends BaseAddon<RunnerAddonConfig>
  implements IPipelineRunnerProvider
{
  private runner: PipelineRunner | null = null
  /**
   * The decode-worker children this addon forked, claimed at the fork and
   * released at their exit. One registry per PROCESS; it dies with the
   * process, which is correct — those workers were this process's children.
   */
  private readonly costRegistry = new ChildCostRegistry()
  /**
   * Every decode worker this process forked, from ANY spawn site (live
   * sessions, occupancy bursts), until its exit. The first thing `onShutdown`
   * does is kill them, a fork after that is killed at once, and any process
   * exit kills what is left (D666). The logger is only unready before
   * `initialize()`, when no worker can have been forked.
   */
  private readonly decodeWorkers = new RunnerDecodeWorkers({
    fork: forkDecodeWorker,
    costRegistry: this.costRegistry,
    logger: {
      info: (message, extras) => this.ctxIfReady?.logger.info(message, extras),
      warn: (message, extras) => this.ctxIfReady?.logger.warn(message, extras),
    },
    process,
  })
  /**
   * Per-camera inference-deadline counters reported through
   * `failure-contribution`. Bounded, cumulative, and read (never drained) by
   * the provider. Constructed eagerly: created on the first timeout it would
   * have no denominator for everything that already succeeded.
   */
  private readonly failureReport = new RunnerFailureReport()
  /**
   * Per-runner (per-node) decode-worker SPAWN-CONCURRENCY GATE (P5). A single
   * counting semaphore every session-decode fork (detection + motion, all
   * cameras on this node) passes through, sized to
   * `config.maxConcurrentDecodeSpawns`. Bounds a synchronized multi-camera
   * motion burst to N concurrent forks instead of stampeding the shared iGPU.
   * `resize()`d live in `onConfigChanged`. Null until `onInitialize`.
   */
  private spawnGate: Semaphore | null = null
  /**
   * Per-node ceiling on decode workers ALIVE at once, sized to
   * `config.maxLiveDecodeWorkers`. The spawn gate above bounds how fast workers
   * START; this bounds how many EXIST — measured live at 1 -> 8 workers and a
   * ~4 GiB move in 8 seconds, with nothing stopping the 9th. `resize()`d live in
   * `onConfigChanged`. Null until `onInitialize`.
   */
  private liveWorkers: LiveDecodeWorkerAdmission | null = null
  /**
   * Node-level map from a retention-ring `FrameHandle` to the decode worker
   * still holding that frame's NATIVE surface — backs the `getNativeCrop` cap
   * so post-analysis can cut native-res crops (best-effort; a miss falls back
   * to the detection-frame crop). See {@link NativeCropRegistry}.
   */
  private readonly nativeCropRegistry = new NativeCropRegistry()
  /**
   * Per-frame cutter bindings — the requester that can cut a frame's subject
   * tiles and end its hold, ended by its result, by a drop, or by the bound.
   * See `frame-cutter-binding.ts` for why this is not `nativeCropRegistry`.
   */
  private readonly frameCutters = new FrameCutterBinding(MAX_BOUND_FRAME_CUTTERS)
  /** Per-camera tally of cuts that could not be dispatched, and why. */
  private readonly tileCutDrops = new Map<
    number,
    { handleless: number; unbound: number; threw: number }
  >()
  private readonly tileCutDropLoggedAt = new Map<number, number>()
  /**
   * Per-camera memory of the boxes recently on screen — what decides whether a
   * detection is worth cutting its own evidence for (D379). Per CAMERA, never
   * global: one camera's traffic must never decide another's cuts.
   */
  private readonly birthNovelty = new BirthNoveltyMemory()
  /** Per-camera cost of the carried evidence, drained by its report line. */
  private readonly birthEvidenceCost = new Map<
    number,
    { cut: number; failed: number; skippedNoPixels: number; bytes: number; encodeMs: number }
  >()
  private readonly birthEvidenceReportedAt = new Map<number, number>()
  /** Per-camera descriptor cost since the last report (D683). */
  private readonly appearanceCost = new Map<number, AppearanceCostTally>()
  private readonly appearanceReportedAt = new Map<number, number>()
  /**
   * Node-level RAM store of retained rgb detection frames, keyed by the
   * `FrameHandle` that rides the inference-result event (shm-ring removal
   * 2026-07-16 — replaces the `csr.` shm retention ring). Backs the
   * FULL-FRAME branch of `getNativeCrop` so hub-side post-analysis resolves a
   * frame's pixels over tRPC (routed by `handle.nodeId`) with no `/dev/shm`.
   * Initialised in {@link onInitialize} once `nodeId` is known.
   */
  private retainedFrames: RetainedFrameStore | null = null
  /**
   * Per-track PARCELS (D422): one JPEG per `(deviceId, trackId, kind)`, cut
   * from the native surface at the instant the hub judged the frame relevant,
   * retrieved later by that key — never by handle, never by age. Bounded per
   * device and per node in `parked-frame-store.ts`, where the numbers are
   * stated. Initialised in {@link onInitialize} beside the retained store.
   */
  private parkedFrames: PartitionedParkedFrameStore | null = null
  /** Per-camera tally of parcels that left WITHOUT a release, by cause. */
  private readonly parkedEvictions = new Map<
    number,
    { deviceBound: number; nodeBudget: number; age: number }
  >()
  private readonly parkedEvictionLoggedAt = new Map<number, number>()
  private readonly frameLazy = new FrameLazyTelemetry()
  private retention: OnDemandRetentionSession | null = null
  private readonly attached = new Map<number, AttachedCamera>()
  /**
   * Detail step state parked across a SOFT detach, keyed by deviceId — see
   * `detail-park.ts` for the fault this closes. Bounded by construction: at
   * most one entry per camera, each self-expiring after
   * {@link DETAIL_PARK_GRACE_MS}, dropped early on re-attach / hard detach /
   * shutdown.
   */
  private readonly parkedDetail = new Map<number, ParkedDetailEntry>()
  private nodeId = 'unknown'
  private metricsSnapshotTimer: ReturnType<typeof setInterval> | null = null
  private runtimeInfoTimer: ReturnType<typeof setInterval> | null = null
  /** Last runtime-label failure, so only a CHANGE is logged (D463). */
  private lastRuntimeInfoFailure: string | null = null
  private unsubMotionEvents: (() => void) | null = null
  private unsubNativeDetections: (() => void) | null = null
  /** Devices we have positively observed reporting `battery.sleeping: true`.
   *  Absent = unknown or awake; both mean "do not gate" (D49). Fed only by
   *  `BatteryOnStatusChanged`, so consulting it costs nothing and can never
   *  wake the camera it protects. See `enqueueOccupancyBurst`. */
  private readonly sleepingBatteryDevices = new Set<number>()
  private unsubBatteryEvents: (() => void) | null = null
  /** Last analyzer-detected state per device — gates the
   *  `MotionOnMotionChanged` emit in `runMotionAnalysis` to transitions
   *  only (otherwise we'd emit on every analyzer frame). */
  private readonly lastAnalyzerDetected = new Map<number, boolean>()
  /**
   * The analyzer's last motion regions per camera — what the small-subject
   * recovery pass judges a full-frame result against. Written on the motion
   * path, read on the detection path (`small-subject-recovery.ts`).
   */
  private readonly motionRegions = new MotionRegionMirror()
  /** Wall clock of the last recovery pass per camera (`RECOVERY_MIN_INTERVAL_MS`). */
  private readonly lastRecoveryAt = new Map<number, number>()
  /** Per-camera counters since the last recovery report line. */
  private readonly recoveryStats = new Map<
    number,
    {
      passes: number
      crops: number
      recovered: number
      floored: number
      ms: number
      reportedAt: number
    }
  >()
  /**
   * Per-camera counters for the frames on which the pass did NOT run, since the
   * last report line (D378). "The second pass stops running when a person is
   * beside the dog" was a live hypothesis on camera 101 and the logs could not
   * answer it: a report that counts only the passes that ran cannot say why the
   * others did not. `rateLimited` is the cadence cap, `noMotion` an empty or
   * stale motion mirror, `tooLarge` / `covered` the shipped rule's two region
   * gates, and `unmagnifiable` the measured recipe's only non-run — a frame
   * whose short side is below the magnification floor (D396).
   *
   * Together with `passes` these count EVERY frame the pass was offered, which
   * is what turns `crops` into the detector invocations per frame the cost of
   * this feature is judged on.
   */
  private readonly recoverySkips = new Map<
    number,
    {
      rateLimited: number
      noMotion: number
      tooLarge: number
      covered: number
      unmagnifiable: number
    }
  >()
  /**
   * Gates the root-plane `package-detection` step to motion-settle edges +
   * a low-cadence safety poll instead of every frame (packages are
   * stationary — per-frame parcel inference is wasted cost). Consulted in
   * `runInference` only when the step is enabled; state dropped on detach.
   */
  private readonly packageGovernor = new MotionSettleGovernor()
  /**
   * Frames on which the governor DROPPED `package-detection` since that
   * device last ran it. The drop is the single most consequential silent
   * branch in the package chain — it decides the cadence that the whole
   * downstream promotion criterion has to be satisfiable at — and it logged
   * nothing at all, so "the parcel was never detected" and "the step never
   * ran" were indistinguishable in the logs. Counted here and reported on the
   * transition (first skip) and on every run, never per frame.
   */
  private readonly packageGateSkips = new Map<number, number>()
  /**
   * Per-device package zone-union box (normalised), the target the motion
   * proximity test measures against.
   *
   * A device MISSING from this map is "unknown", not "no zones" — and unknown
   * FAILS OPEN in `motionNearPackageZone`, degrading to the whole-frame motion
   * signal. Resolved off the frame path (on attach, and refreshed on the
   * package-step gate's own cadence), never inside `runMotionAnalysis`.
   */
  private readonly packageZoneUnionByDevice = new Map<number, NormalizedBox | undefined>()
  /** In-flight/last zone-union resolution time per device, so the refresh does
   *  not stampede the zone caps from the motion path. */
  private readonly packageZoneUnionAt = new Map<number, number>()
  /**
   * Whether the last analyzer frame saw motion NEAR the device's package
   * zones — the boolean the settle-burst governor consumes. Distinct from
   * `lastAnalyzerDetected` (whole-frame), which is what the phase machine
   * uses and which must not change meaning.
   */
  private readonly lastMotionNearPackageZone = new Map<number, boolean>()
  /**
   * Last positive motion timestamp per device — preserved across the
   * OFF transition so the motion runtime-state slice keeps a stable
   * `lastDetectedAt` after the cooldown closes the phase. Cleared on
   * detach.
   */
  private readonly lastMotionAt = new Map<number, number>()

  /**
   * Dynamic analyzer subscriptions opened on `MotionOnMotionChanged
   * source:'onboard'` when `onboardMotionDrivesAnalyzer === true`. Each
   * entry is the unsubscribe handle returned by `subscribeMotionFrames`.
   * Cleared on teardown timer fire, detach, and shutdown.
   */
  private readonly onboardAnalyzerSubs = new Map<number, () => void>()
  /**
   * Teardown timers that close the dynamic analyzer subscription after
   * `motionCooldownMs` without a new motion event. Re-armed on every
   * `MotionOnMotionChanged source:'onboard'` call so the sub stays open
   * while motion persists.
   */
  private readonly onboardAnalyzerTeardownTimers = new Map<number, ReturnType<typeof setTimeout>>()

  /**
   * REMOTE-SOURCE legs (cross-node Phase 2, P2d) — one per attached camera
   * whose `frameSource.kind === 'remote-restream'`: the owner's compressed
   * restream + a local satellite frame plane. DORMANT with today's default
   * payloads (`local-broker` / absent) — the map stays empty and every code
   * path is identical to pre-Phase-2. Torn down on detach / shutdown.
   */
  /**
   * Devices whose motion currently rides the detection session-decode worker
   * (P4 co-active sharing) instead of a dedicated motion worker. Membership →
   * the detection pump also enqueues a derived gray motion frame per decoded
   * rgb (see `enqueueSharedDetectionFrame`). A pure flag-set: `enqueueMotionFrame`
   * is device-scoped, so no per-device callback object is needed.
   */
  private readonly sharedMotionSinks = new Map<
    number,
    { minIntervalMs: number; lastMotionEnqueueTs: number }
  >()
  /** Wall clock for the shared-sink motionFps throttle — injectable in tests. */
  private sharedSinkNow: () => number = Date.now

  /**
   * Snapshot-equality cache for metrics-snapshot defer. The runner
   * fires per-camera metrics every `METRICS_SNAPSHOT_INTERVAL_MS`;
   * for an idle camera (no inference, queue empty, fps=0) every tick
   * carries an identical payload. We skip the bus emit when the
   * payload deep-equals the previous one so the events tab + remote
   * subscribers stop seeing 60 metrics-snapshots/min/camera that
   * convey nothing. A periodic heartbeat re-emits every
   * METRICS_HEARTBEAT_MS so consumers know the runner is still
   * alive.
   */
  private readonly lastEmittedCameraMetrics = new Map<number, { json: string; emittedAt: number }>()
  private lastEmittedRunnerLoad: { json: string; emittedAt: number } | null = null

  /**
   * In-memory bench-frame cache (decoded JPEG bytes). Populated by the
   * `cacheBenchFrame` custom action. Fed into the synthetic-bench loop
   * via the `frame: FrameInput` shape that mirrors what stream-broker
   * delivers to this very addon during real camera detection.
   */
  private readonly benchFrameCache = new Map<
    string,
    {
      readonly data: Uint8Array
      readonly width: number
      readonly height: number
      readonly format: 'rgb'
      readonly expiresAt: number
    }
  >()
  private benchFrameSweeper: ReturnType<typeof setInterval> | null = null

  /**
   * Synthetic benches, start-then-poll (D646). One at a time on this runner —
   * the measurement owns the pool — and the last few finished ones kept for a
   * late poll. In RAM: a bench belongs to this process.
   */
  private readonly syntheticBenches = new BackgroundRunRegistry<
    SyntheticBenchProgress,
    SyntheticBenchResult
  >({
    maxConcurrent: 1,
    keepFinished: 5,
    onSettled: (status) => {
      const line = {
        meta: {
          sessionId: status.runId,
          state: status.state,
          error: status.error,
          runs: status.result?.runs ?? null,
          fps: status.result?.fps ?? null,
        },
      }
      if (status.state === 'failed') this.ctx.logger.warn('synthetic bench failed', line)
      else this.ctx.logger.info('synthetic bench finished', line)
    },
  })

  /**
   * In-flight + recent capacity-ramp runs, keyed by sessionId. The ramp is
   * fire-and-poll (a full run outlives the UDS addon-call 60s timeout), so
   * completed results are kept here for `getCapacityRampStatus` to collect;
   * bounded by {@link PipelineRunnerAddon.MAX_CAPACITY_RUN_HISTORY}.
   * Entries are replaced wholesale, never mutated in place.
   */
  private readonly capacityRuns = new Map<
    string,
    { readonly abortFlag: { aborted: boolean }; readonly status: CapacityRampStatus }
  >()
  private static readonly MAX_CAPACITY_RUN_HISTORY = 8
  /** Per-camera single-flight: a camera never runs two occupancy bursts at once. */
  private readonly occupancyBurstInFlight = new Set<number>()
  /**
   * Devices whose in-flight occupancy burst has seen at least one inference
   * result with detections>0 (set from the `onResult` handler above, cleared
   * per-burst in `runOccupancyBurst`). Read at burst cleanup and reported to
   * `PipelineRunner.reportOccupancyBurstOutcome` — Task 9's arm/disarm signal.
   */
  private readonly occupancyBurstFound = new Set<number>()
  /**
   * GLOBAL occupancy admission queue. Each occupancy burst SUBSCRIBES a detection
   * stream (rgb) which, during the `watching` phase, has no existing consumer and
   * therefore makes the broker DIAL a fresh decoder. Without a global cap, N
   * cameras rechecking on the same interval would spawn N parallel decoder dials
   * (thundering herd → re-dial churn → latency). This bounds concurrent bursts to
   * OCCUPANCY_MAX_CONCURRENT; the rest wait in the queue and drain as slots free.
   * (A burst on an already-`active` camera reuses the live decoder — the broker's
   * demand-gate shares one session across subscribers — so only watching-phase
   * spawns pay the dial cost.)
   */
  private readonly occupancyQueue: number[] = []
  private readonly occupancyQueued = new Set<number>()
  private readonly occupancyFrames = new Map<number, number>()
  private occupancyActiveCount = 0
  /** Max concurrent occupancy bursts (decoder dials) across all cameras. */
  private readonly occupancyMaxConcurrent = 3
  /**
   * TAP-based occupancy bursts in flight, keyed by deviceId (Task 10). See
   * {@link OccupancyTapState}. A device has an entry here XOR is dialing a
   * session-decode burst in `runOccupancyBurst` — never both; the choice
   * is made once at burst start based on `attachment.motionUnsubscribe`.
   */
  private readonly occupancyTaps = new Map<number, OccupancyTapState>()
  /**
   * Timestamp (`Date.now()`) of the last motion frame teed for each device
   * — set in `runMotionAnalysis` at the same call site as
   * `teeOccupancyTapFrame` (Task 10 hardening). This is the TRUTHFUL "is
   * the analyzer subscription actually delivering frames" signal;
   * `attachment.motionUnsubscribe !== null` alone only proves a
   * subscription handle was assigned, not that it's live. See
   * {@link MOTION_FRESHNESS_WINDOW_MS}.
   */
  private readonly lastMotionFrameAt = new Map<number, number>()
  /** Cached local accelerator probe — see {@link resolveLocalHardware}. */
  private localHardware: KernelInferenceHardware | null = null

  constructor() {
    super({ ...DEFAULT_CONFIG })
  }

  protected async onInitialize(): Promise<AddonInitResult<PipelineRunnerBenchActions>> {
    // Use the cluster node id (hub, dev-agent-0, etc.) for dispatch routing,
    // not the addon id (pipeline-runner). The orchestrator uses this to track
    // which cluster node a camera is assigned to.
    // When the runner lives in a group-runner subprocess the broker
    // nodeID is hierarchical (`hub/pipeline`); strip the suffix so
    // emitted events / cap calls refer to the cluster-visible parent
    // node. In-process boot leaves the value untouched.
    const raw = this.ctx.kernel.localNodeId ?? this.ctx.id
    this.nodeId = raw.includes('/') ? raw.split('/')[0]! : raw
    // This node's own decode limits (D365) — read on the lease-knob cadence.
    this.nodeLimits = new NodeDecodeLimitsSource({
      logger: {
        info: (message, extras) => this.ctxIfReady?.logger.info(message, extras),
        warn: (message, extras) => this.ctxIfReady?.logger.warn(message, extras),
      },
      nodeId: this.nodeId,
    })

    // Retained-frame store lives in RAM keyed by this node's id (shm-ring
    // removal 2026-07-16) — no `/dev/shm` segments to reclaim, so there is no
    // orphan-purge step. Frames age out latest-wins under the byte budget.
    this.retainedFrames = new RetainedFrameStore({
      nodeId: this.nodeId,
      logger: this.ctx.logger.child('retained-frames'),
      onEvict: (deviceId) => this.frameLazy.noteEviction(deviceId),
    })
    this.retention = new OnDemandRetentionSession({
      store: this.retainedFrames,
      registry: localFrameRegistry,
      telemetry: this.frameLazy,
      nodeId: this.nodeId,
      continuousRetain: isContinuousRetainEnabled(),
    })
    // D644: face source parcels live in their own budget and can never evict
    // a track's keyFrame/thumbnail parcel.
    const onEvict = (eviction: ParkedFrameEviction): void =>
      this.noteParkedEviction(eviction.deviceId, eviction.cause)
    this.parkedFrames = new PartitionedParkedFrameStore({
      track: { onEvict },
      faceSource: { onEvict },
    })

    this.runner = new PipelineRunner({
      maxQueueDepth: this.config.maxQueueDepth,
      maxConcurrentInferences: this.config.maxConcurrentInferences,
      // One camera never has more lazy refs in inference than its worker
      // holds — the hold evicts oldest-first, so the cap IS the hold minus one.
      maxInflightPerCamera: maxInflightPerCamera(this.nativeLease.current()),
      targetLoadPercent: this.config.targetLoadPercent,
      minThrottledFps: this.config.minThrottledFps,
      processFrame: (deviceId, frame, handle) => this.runInference(deviceId, frame, handle),
      analyzeMotion: (deviceId, frame, handle) => this.runMotionAnalysis(deviceId, frame, handle),
      releaseFrameRef: (ref, reason) => localFrameRegistry.release(ref, reason),
      releaseRetention: (handle, reason) => {
        this.retention?.release(handle, reason)
        // A frame the runner let go — superseded in the queue, an error, a
        // timeout — ends its worker hold NOW. A no-op after the result path
        // consumed the binding, so a success cannot release twice.
        this.frameCutters.drop(handle)
      },
      hydrateRetainedFrame: (handle) =>
        this.retainedFrames?.ensureContent(handle) ?? Promise.resolve(null),
      // The onboard root's counterpart to the `markInferred()` the ML enqueue
      // sends. Same fact, reached from the handle instead of from the crop
      // requester, because the runner holds the handle and not the requester.
      markFrameAskable: (handle) => {
        const found = this.nativeCropRegistry.lookup(handle)
        if (found.kind === 'live') found.request.markInferred?.()
      },
      onPhaseChanged: (deviceId, phase, meta) => this.handlePhaseChanged(deviceId, phase, meta),
      logger: this.ctx.logger,
      onOccupancyRecheck: (deviceId, frames) => {
        this.enqueueOccupancyBurst(deviceId, frames)
      },
      // Per-camera inference deadline counter, with the frames that came back
      // in time as its denominator (`failure-contribution`, family `inference`).
      noteInferenceOutcome: (deviceId, reason) =>
        this.failureReport.noteInference(deviceId, reason),
    })

    // Size the decode-worker spawn gate (P5). >=1 enforced so a misconfigured
    // 0 can never wedge every fork.
    this.spawnGate = new Semaphore(Math.max(1, this.config.maxConcurrentDecodeSpawns))
    const decodeLimits = this.resolvedNodeDecodeLimits()
    this.lastAppliedDecodeLimits = decodeLimits
    // Said once at boot too: the source in force is the first thing asked
    // when a node admits fewer (or more) workers than its neighbour.
    this.ctx.logger.info('node decode limits in force', {
      meta: {
        reason: 'boot',
        budgetMb: decodeLimits.budgetMb,
        budgetSource: decodeLimits.budgetSource,
        maxWorkers: decodeLimits.maxWorkers,
        maxWorkersSource: decodeLimits.maxWorkersSource,
        totalMemMb: Math.round(os.totalmem() / 1_048_576),
      },
    })
    this.liveWorkers = new LiveDecodeWorkerAdmission({
      limit: decodeLimits.maxWorkers,
      logger: this.ctx.logger,
      nodeBudgetMb: decodeLimits.budgetMb,
      // The knobs the operator has set right now. Refreshed on every lease
      // settings refresh below, so raising `budgetMb` immediately lowers how
      // many workers this node admits instead of silently authorising more RAM.
      workerFootprintMb: decodeWorkerFootprintMb(this.nativeLease.current()),
    })

    this.runner.timingSampler.setLogger(this.ctx.logger.child('timing'))
    // Each camera's ELECTED device on its own stats line: `pipelineRuntime`
    // names every pool on the node, and only this says which one served the
    // camera (null = the node's default pool).
    this.runner.timingSampler.setElectedDeviceKeyResolver(
      (deviceId) => this.attached.get(deviceId)?.config?.deviceKey ?? null,
    )
    // `pipelineRuntime` / `pipelineModels` on every `pipeline stats` line had
    // been null since the field existed: `TimingSampler.runtimeInfo` was
    // initialised to `{}` and NOTHING in the repo ever assigned it (D463). A
    // reader could not tell "this node runs on CPU" from "nobody said", which
    // is the question those lines exist to answer.
    //
    // Refreshed on a slow timer rather than read once: the engine is
    // provisioned lazily and can be re-selected by the operator, so a
    // boot-time read would pin whatever was true before provisioning
    // finished — a stale label is worse than the null it replaces.
    void this.refreshRuntimeInfo()
    this.runtimeInfoTimer = setInterval(
      () => void this.refreshRuntimeInfo(),
      RUNTIME_INFO_REFRESH_MS,
    )
    this.runtimeInfoTimer.unref?.()

    // Hook the per-camera detection-stream subscribe/unsubscribe lifecycle
    // into the local broker. The runner's phase machine triggers this
    // handler when a camera transitions WATCHING ↔ ACTIVE.
    this.runner.onDetectionStreamChange((deviceId, action) => {
      this.handleDetectionStreamChange(deviceId, action)
    })

    // Emit raw inference results to the bus. Hub-side post-processors
    // (analysis pipeline, class filters, notifications) consume these
    // and emit the post-processed `detection.result` event. The
    // `handle` is the shm-ring `FrameHandle` the runner read pixels
    // from — forwarded onto the emitted event so post-analysis
    // consumers (Task 8) can resolve the same frame zero-copy.
    this.runner.onResult(async (deviceId, frame, result, _streamType, handle, source, occasion) => {
      this.retention?.noteInferenceResult(deviceId, handle, result)
      // R2 — the subject tiles. This callback is the ONE moment at which the
      // frame's native pixels still exist AND its detections are known, so it
      // is where the frame is turned into a handful of compressed subject
      // crops and then freed. It runs BEFORE the emit: the emit is what sets
      // post-analysis off toward the crop request that the tiles will serve.
      this.cutSubjectTiles(deviceId, result, handle)
      // D379 — the candidate births carry their own pixels. Cut HERE, from the
      // frame this callback already holds, because asking for them afterwards
      // by handle was measured to miss 7 452 times in three hours (99.9%
      // `worker-lease-gone`, misses at `handleAgeMs=254`) and 63% of gate
      // verdicts never saw a pixel. Awaited before the emit: the crop must ride
      // the result, and a store the crop had to be fetched from later is the
      // exact thing this replaces.
      // The birth-novelty plan is computed ONCE per frame (it advances the
      // novelty memory); the appearance scope reuses its indices.
      const { result: carried, novel } = await this.attachBirthEvidence(deviceId, frame, result)
      const described = await this.attachAppearance(deviceId, frame, carried, novel)
      this.emitInferenceResult(deviceId, frame, described, handle, source, occasion)
      const detectionCount = result.detections?.length ?? 0
      this.runner?.noteDetectionResult(deviceId, detectionCount)
      // While an occupancy burst is in flight for this device, its frames
      // are the ONLY detection-queue traffic (the camera is `watching`, so
      // `enqueueDetectionFrame` drops everything but occupancy-burst
      // frames) — a positive result here is unambiguously "occupancy
      // found something", surfaced to `runOccupancyBurst`'s cleanup below.
      if (detectionCount > 0 && this.occupancyBurstInFlight.has(deviceId)) {
        this.occupancyBurstFound.add(deviceId)
      }
    })

    this.runner.start()
    this.ctx.logger.info('Pipeline runner started', {
      tags: { nodeId: this.nodeId },
      meta: {
        maxConcurrent: this.config.maxConcurrentInferences,
        queueDepth: this.config.maxQueueDepth,
      },
    })

    // Unified motion event subscription. Sources (Reolink firmware push
    // events emitting `source: 'onboard'`, this runner's own analyzer
    // path emitting `source: 'analyzer'` from `runMotionAnalysis`) all
    // funnel through `MotionOnMotionChanged`. The phase machine reacts
    // via `reportMotion` regardless of source — `motionSources`
    // selector at the runner-config level still gates which sources
    // trigger detection downstream.
    if (this.ctx.eventBus) {
      this.unsubMotionEvents = this.ctx.eventBus.subscribe(
        { category: EventCategory.MotionOnMotionChanged },
        (event) => {
          const data = event.data
          const deviceId = data.deviceId
          const attachment = this.attached.get(deviceId)
          if (!attachment) return
          const source = data.source
          // Dynamic analyzer gate: when the camera uses onboard-only
          // motion, open/close the frame-diff subscription on demand so
          // `runMotionAnalysis` runs (and emits MotionZonesRaw) during
          // active-motion windows without holding the substream open
          // continuously. Runs regardless of the `motionSources` gate
          // below — the dynamic sub is a side-channel that does NOT feed
          // the phase machine (onboard remains the sole driver).
          if (source === 'onboard') {
            void this.handleOnboardMotionAnalyzer(deviceId, data.detected)
          }
          if (!attachment.config.motionSources.includes(source)) return
          // D475: a sensor-owned camera (firmware `onboard`, or a device
          // reporting its own `device-activity`) is never re-described by the
          // analyzer's phase transitions, even when `motionSources` lists
          // both — see `cameraOwnsMotionViaSensor`. The analyzer may still be
          // RUNNING on such a camera (shared detection decode); it just
          // never reaches the phase machine.
          if (source === 'analyzer' && cameraOwnsMotionViaSensor(attachment.config.motionSources)) {
            return
          }
          this.runner?.reportMotion(
            deviceId,
            data.detected,
            source,
            data.regions ? [...data.regions] : undefined,
          )
        },
      )
    }

    // Sleeping-battery mirror (D173). Refreshed off the cap's own change
    // event — never a poll, never a read on the decision path: the whole
    // point is to avoid touching a camera, so the gate must not touch one
    // either. An unknown device is absent from the set and therefore NOT
    // gated (unknown excludes nothing — D49); only a device we have
    // positively seen report `sleeping: true` stops paying for a recheck.
    if (this.ctx.eventBus) {
      // The CAMERA's detector, admitted here and nowhere else.
      //
      // Symmetric with the motion subscription above and for the same reason:
      // a provider EMITS what its firmware said, and the system decides whether
      // this camera uses it. The gate is `detectionSources`, on the same attach
      // config that carries `motionSources` — never a flag inside a vendor
      // addon, which is what this replaces (the Reolink cap owned the policy,
      // no other addon could even see it, and the operator had no way to reach
      // it).
      this.unsubNativeDetections = this.ctx.eventBus.subscribe(
        { category: EventCategory.DetectionCameraNative },
        (event) => {
          const data = event.data as {
            cameraId?: number
            detections?: readonly CameraNativeDetection[]
            frameWidth?: number
            frameHeight?: number
          }
          const deviceId = data.cameraId
          if (typeof deviceId !== 'number') return
          const attachment = this.attached.get(deviceId)
          if (!attachment) return
          if (!planDetectionSources(attachment.config.detectionSources).runsOnboard) return
          const detections = data.detections
          if (!detections || detections.length === 0) return
          this.runner?.reportNativeDetection(
            deviceId,
            detections,
            data.frameWidth,
            data.frameHeight,
          )
        },
      )

      this.unsubBatteryEvents = this.ctx.eventBus.subscribe(
        { category: EventCategory.BatteryOnStatusChanged },
        (event) => {
          const data = event.data
          const deviceId = data.deviceId
          if (typeof deviceId !== 'number') return
          if (data.status?.sleeping === true) this.sleepingBatteryDevices.add(deviceId)
          else this.sleepingBatteryDevices.delete(deviceId)
        },
      )
    }

    // Periodic metric-snapshot emission: one runner-load event +
    // one per-camera metrics event per attached camera per tick.
    // UI dashboards subscribe to these instead of polling the cap.
    this.metricsSnapshotTimer = setInterval(
      () => this.emitMetricsSnapshot(),
      METRICS_SNAPSHOT_INTERVAL_MS,
    )

    return {
      providers: [
        { capability: pipelineRunnerCapability, provider: this },
        // This addon's own cost, already attributed: one forked decode worker
        // per decode session, and a session never spans two cameras. Computed
        // live from `costRegistry` when asked — no timer, no history.
        {
          capability: loadContributionCapability,
          provider: { list: () => this.costRegistry.contributions() },
        },
        // This addon's own LOSSES, per camera, with their denominator. Same
        // enumeration and same transport as the cost entries above; read from
        // bounded in-RAM counters, no timer and no persistence.
        {
          capability: failureContributionCapability,
          provider: { list: () => this.failureReport.list() },
        },
      ],
      customActions: pipelineRunnerBenchActions,
      actionHandlers: {
        cacheBenchFrame: async (input) => this.cacheBenchFrame(input),
        releaseBenchFrame: async (input) => this.releaseBenchFrame(input),
        startSyntheticBench: async (input) => this.startSyntheticBench(input),
        getSyntheticBenchStatus: async (input) => this.getSyntheticBenchStatus(input.sessionId),
        abortSyntheticBench: async (input) => ({
          aborted: this.syntheticBenches.abort(input.sessionId),
        }),
        runCapacityRamp: async (input) => this.runCapacityRampAction(input),
        getCapacityRampStatus: async (input) => this.getCapacityRampStatusAction(input),
        listCapacityRamps: async () => this.listCapacityRampsAction(),
        abortCapacityRamp: async (input) => this.abortCapacityRampAction(input),
      },
    }
  }

  protected async onShutdown(): Promise<void> {
    // FIRST, before anything below can throw: every decode worker dies here,
    // synchronously, and a fork after this is killed at once (D666). The
    // addon runner calls `process.exit(0)` right after this method, and a
    // worker it did not kill was orphaned — 17 of them on the Mac agent, at
    // 641 % CPU, still pulling RTSP. One line per camera.
    this.decodeWorkers.shutdown()
    if (this.runtimeInfoTimer !== null) {
      clearInterval(this.runtimeInfoTimer)
      this.runtimeInfoTimer = null
    }
    if (this.metricsSnapshotTimer) {
      clearInterval(this.metricsSnapshotTimer)
      this.metricsSnapshotTimer = null
    }
    if (this.benchFrameSweeper) {
      clearInterval(this.benchFrameSweeper)
      this.benchFrameSweeper = null
    }
    this.benchFrameCache.clear()
    this.syntheticBenches.abortAll()
    // Signal any in-flight capacity ramp to drain on its next tick.
    for (const entry of this.capacityRuns.values()) entry.abortFlag.aborted = true
    this.capacityRuns.clear()
    if (this.unsubMotionEvents) {
      this.unsubMotionEvents()
      this.unsubMotionEvents = null
    }
    if (this.unsubNativeDetections) {
      this.unsubNativeDetections()
      this.unsubNativeDetections = null
    }
    if (this.unsubBatteryEvents) {
      this.unsubBatteryEvents()
      this.unsubBatteryEvents = null
    }
    this.sleepingBatteryDevices.clear()
    this.lastAnalyzerDetected.clear()
    this.packageGovernor.reset()
    this.packageGateSkips.clear()
    this.packageZoneUnionByDevice.clear()
    this.packageZoneUnionAt.clear()
    this.lastMotionNearPackageZone.clear()

    // Clear all dynamic onboard-analyzer subscriptions before stopping
    // the runner — `clearOnboardAnalyzer` cancels the timer then calls
    // the unsubscribe handle so no stray callbacks fire after shutdown.
    for (const deviceId of [
      ...this.onboardAnalyzerTeardownTimers.keys(),
      ...this.onboardAnalyzerSubs.keys(),
    ]) {
      this.clearOnboardAnalyzer(deviceId)
    }

    if (this.runner) {
      this.runner.stop()
      this.runner = null
    }

    // IMMEDIATE, not drained (D652): the runner stopped dispatching above, so
    // nothing is left to read the frames a drain would wait for.
    for (const attachment of this.attached.values()) {
      attachment.motionUnsubscribe?.('immediate')
      attachment.detectionUnsubscribe?.('immediate')
    }
    // Parked detail state holds only a config slice, but its expiry timers and
    // entries must not outlive the addon either.
    for (const deviceId of [...this.parkedDetail.keys()]) {
      this.dropParkedDetail(deviceId)
    }
    this.attached.clear()
    this.lastMotionFrameAt.clear()
    this.nativeCropRegistry.clear()
    this.retainedFrames?.clear()
    this.retainedFrames = null
    this.parkedFrames?.clear()
    this.parkedFrames = null
    this.retention = null
  }

  // ── Synthetic bench (production-equivalent measurement) ───────────────

  private async cacheBenchFrame(input: CacheBenchFrameInput): Promise<CacheBenchFrameResult> {
    // Decode JPEG → raw RGB ONCE. The runner then feeds this raw buffer
    // to api.pipelineExecutor.runPipeline via the `frame` field — same
    // shape that stream-broker hands the runner during real camera
    // detection. In-process call; no Moleculer serialisation cost.
    const sharp = await getSharp()
    const jpeg = Buffer.from(input.imageBase64, 'base64')
    const { data, info } = await sharp(jpeg).raw().toBuffer({ resolveWithObject: true })
    if (info.channels !== 3) {
      throw new Error(`cacheBenchFrame: expected 3 channels (rgb), got ${info.channels}`)
    }
    const rgb = new Uint8Array(data)
    const ttlMs = Math.max(60_000, (input.ttlSeconds ?? 600) * 1000)
    const frameId = `runner-bench-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
    const expiresAt = Date.now() + ttlMs
    this.benchFrameCache.set(frameId, {
      data: rgb,
      width: info.width,
      height: info.height,
      format: 'rgb',
      expiresAt,
    })
    if (!this.benchFrameSweeper) {
      this.benchFrameSweeper = setInterval(() => this.sweepBenchFrameCache(), 60_000)
      this.benchFrameSweeper.unref?.()
    }
    this.ctx.logger.info('cached bench frame', {
      meta: { frameId, width: info.width, height: info.height, bytes: rgb.length, ttlMs },
    })
    return { frameId, width: info.width, height: info.height, expiresAt }
  }

  private async releaseBenchFrame(input: ReleaseBenchFrameInput): Promise<ReleaseBenchFrameResult> {
    return { released: this.benchFrameCache.delete(input.frameId) }
  }

  private sweepBenchFrameCache(): void {
    const now = Date.now()
    for (const [id, entry] of this.benchFrameCache) {
      if (entry.expiresAt < now) this.benchFrameCache.delete(id)
    }
  }

  /**
   * Validate the cheap preconditions synchronously (so a bad frame id is a
   * refusal the caller sees at once), then run the bench in the background
   * and answer with the receipt (D646).
   */
  private startSyntheticBench(input: SyntheticBenchInput): { accepted: true; sessionId: string } {
    if (!this.ctx.api) throw new Error('startSyntheticBench: ctx.api unavailable')
    if (!this.benchFrameCache.has(input.frameId)) {
      throw new Error(
        `startSyntheticBench: frameId ${input.frameId} not cached (call cacheBenchFrame first)`,
      )
    }
    this.syntheticBenches.start(input.sessionId, (run) => this.runSyntheticBench(input, run))
    return { accepted: true, sessionId: input.sessionId }
  }

  private getSyntheticBenchStatus(sessionId: string): SyntheticBenchStatus | null {
    const status = this.syntheticBenches.status(sessionId)
    if (status === null) return null
    return {
      sessionId: status.runId,
      state: status.state,
      startedAtMs: status.startedAtMs,
      finishedAtMs: status.finishedAtMs,
      progress: status.progress,
      result: status.result,
      error: status.error,
    }
  }

  private async runSyntheticBench(
    input: SyntheticBenchInput,
    run: BackgroundRunContext<SyntheticBenchProgress>,
  ): Promise<SyntheticBenchResult> {
    const ctx = this.ctx
    const api = ctx.api
    if (!api) throw new Error('runSyntheticBench: ctx.api unavailable')
    // Pin every inference to ONE node's detection-pipeline for the whole run.
    // Without this the cap call resolves to the default provider and can fail
    // over to another node mid-run (e.g. after an NPU crash), which both
    // poisons the measurement and silently moves work off the node under test.
    // Defaults to this runner's own node — the bench stays co-located.
    const benchNode = input.nodeId ?? this.nodeId
    const pin = nodePin(benchNode)
    ctx.logger.info('runSyntheticBench input', {
      meta: {
        frameId: input.frameId,
        parallel: input.parallel,
        iterations: input.iterations,
        node: benchNode,
      },
    })

    const cached = this.benchFrameCache.get(input.frameId)
    if (!cached) {
      throw new Error(
        `runSyntheticBench: frameId ${input.frameId} not cached (call cacheBenchFrame first)`,
      )
    }

    const stepsToRun = input.steps.map((s) => ({
      addonId: s.addonId,
      modelId: s.modelId,
      enabled: s.enabled,
      children: s.children ?? [],
    }))

    // Determine if we can use the fast cache path:
    // Single root step, no enabled children, simulatePipeline not requested,
    // and NO device/plane selector → bypass runPipeline entirely, cache
    // frame in Python pool once, then send only 5-byte references.
    // `bench-dispatch.ts` owns the rule and explains why a deviceKey has to
    // veto it (inferCached has no device selector).
    const enabledSteps = stepsToRun.filter((s) => s.enabled)
    const isSingleStep =
      enabledSteps.length === 1 &&
      (!enabledSteps[0]!.children ||
        enabledSteps[0]!.children.filter((c) => c.enabled).length === 0)
    const useFastPath = canUseCachedFastPath(isSingleStep, input)
    const rootStep = enabledSteps[0]

    // A branch that drops the operator's request logs it — silence reads as
    // "never happened", and "why is my Coral number identical to CPU" is
    // exactly the question this line answers.
    const fastPathRefusal = isSingleStep ? fastPathRefusalReason(input) : null
    if (fastPathRefusal) {
      ctx.logger.info('synthetic bench: cached fast path declined', {
        meta: { reason: fastPathRefusal, node: benchNode },
      })
    }

    // Ensure engine + model are loaded (same as runPipeline does)
    // Run one warmup call through the FULL path to trigger model load
    const sharedFrame: FrameInput = {
      data: cached.data,
      format: cached.format,
      width: cached.width,
      height: cached.height,
      timestamp: Date.now(),
    }

    let poolFrameId: number | null = null

    if (useFastPath && rootStep) {
      // ── Fast path: cache frame in Python, infer via 5-byte reference ──
      ctx.logger.info('synthetic bench: using Python cache path', {
        meta: { step: rootStep.addonId, model: rootStep.modelId },
      })

      // Cache the raw frame in the Python pool
      const cacheResult = await api.pipelineExecutor.cacheFrameInPool.mutate(
        {
          data: new Uint8Array(cached.data.slice().buffer),
          width: cached.width,
          height: cached.height,
          format: cached.format,
        },
        pin,
      )
      poolFrameId = cacheResult.frameId

      // Warmup through full runPipeline path to ensure model is loaded on
      // the node-default pool — the same pool `inferCached` then times. Its
      // `rootModelId` is the model resolution actually RAN (a requested model
      // may be substituted for the format): that, and nothing else, is what the
      // cached calls time (D658).
      const warm = await api.pipelineExecutor.runPipeline.mutate(
        // No deviceKey / plane here BY CONSTRUCTION: this branch only runs
        // when `canUseCachedFastPath` said neither was requested.
        // Spread into a fresh literal: the generated router input carries a
        // `.loose()` index signature a named interface does not satisfy.
        {
          ...buildBenchRunPipelineInput({
            steps: stepsToRun,
            frame: sharedFrame,
          }),
        },
        pin,
      )
      const benchModelId = warm.rootModelId
      if (benchModelId === undefined || benchModelId === '') {
        throw new Error(
          `synthetic bench: the warmup of "${rootStep.addonId}" named no model — refusing to time an unnamed variant`,
        )
      }
      // Additional warmup via cached path
      const warmupCount = input.warmup ?? 1
      for (let w = 0; w < warmupCount; w++) {
        await api.pipelineExecutor.inferCached.mutate(
          {
            stepId: rootStep.addonId,
            frameId: poolFrameId,
            modelId: benchModelId,
          },
          pin,
        )
      }

      // Timed run — each call sends only 5 bytes through the pipe
      const wallTimings: number[] = []
      const inferTimings: number[] = []
      const preprocessTimings: number[] = []
      const predictTimings: number[] = []
      const batchSizes: number[] = []
      const detCounts: number[] = []
      let _n = 0
      const sessionId = input.sessionId
      const totalRuns = input.parallel * input.iterations

      const wallStart = performance.now()
      const worker = async (): Promise<void> => {
        for (let i = 0; i < input.iterations; i++) {
          if (run.signal.aborted) break
          const t0 = performance.now()
          const result = await api.pipelineExecutor.inferCached.mutate(
            {
              stepId: rootStep.addonId,
              frameId: poolFrameId!,
              modelId: benchModelId,
            },
            pin,
          )
          const wallMs = performance.now() - t0
          const r = result as Record<string, unknown>
          const inferMs =
            typeof r['inferenceMs'] === 'number' ? (r['inferenceMs'] as number) : wallMs
          const preMs = typeof r['preprocessMs'] === 'number' ? (r['preprocessMs'] as number) : 0
          const predMs = typeof r['predictMs'] === 'number' ? (r['predictMs'] as number) : 0
          const bs = typeof r['batchSize'] === 'number' ? (r['batchSize'] as number) : 1
          const dets = Array.isArray(r['detections']) ? (r['detections'] as unknown[]).length : 0
          wallTimings.push(wallMs)
          inferTimings.push(inferMs)
          preprocessTimings.push(preMs)
          predictTimings.push(predMs)
          batchSizes.push(bs)
          detCounts.push(dets)
          const n = ++_n
          run.report({ runs: n, totalRuns })
          if (n <= 20) {
            ctx.logger.info('bench call trace (cached)', {
              meta: {
                n,
                wallMs: Math.round(wallMs),
                inferMs: Math.round(inferMs),
                preMs: Math.round(preMs * 10) / 10,
                predMs: Math.round(predMs * 10) / 10,
                bs,
              },
            })
          }
          // Emit live progress every `parallel` completions
          if (n % Math.max(1, input.parallel) === 0) {
            const elapsed = (performance.now() - wallStart) / 1000
            const fps = elapsed > 0 ? n / elapsed : 0
            const meanCallMs = wallTimings.reduce((s, v) => s + v, 0) / wallTimings.length
            const sorted = [...wallTimings].toSorted((a, b) => a - b)
            const p95 = sorted[Math.min(sorted.length - 1, Math.floor(0.95 * sorted.length))] ?? 0
            const totalDet = detCounts.reduce((s, v) => s + v, 0)
            const avgDet = detCounts.length > 0 ? totalDet / detCounts.length : 0
            const bsMean = batchSizes.reduce((s, v) => s + v, 0) / batchSizes.length
            const msg = `runs ${n}/${totalRuns} \u00b7 ${fps.toFixed(1)} fps \u00b7 call ${meanCallMs.toFixed(1)}ms \u00b7 batch ${bsMean.toFixed(1)}`
            if (ctx.eventBus) {
              // Emit directly (bypassing createEvent's strict typing) so we
              // can attach structured bench stats as extra fields. The UI's
              // pipeline.progress subscription reads them from event.data.
              ctx.eventBus.emit({
                id: `bench-${n}`,
                timestamp: new Date(),
                source: { type: 'pipeline' as const, id: 'synthetic-bench' },
                category: EventCategory.PipelineProgress,
                data: {
                  nodeId: benchNode,
                  sessionId,
                  step: 'synthetic-bench',
                  message: msg,
                  benchProgress: true,
                  runs: n,
                  totalRuns,
                  fps: Math.round(fps * 100) / 100,
                  meanMs: Math.round(meanCallMs * 100) / 100,
                  p95Ms: Math.round(p95 * 100) / 100,
                  inferMeanMs:
                    Math.round(
                      (inferTimings.reduce((s, v) => s + v, 0) / inferTimings.length) * 100,
                    ) / 100,
                  preprocessMeanMs:
                    Math.round(
                      (preprocessTimings.reduce((s, v) => s + v, 0) / preprocessTimings.length) *
                        100,
                    ) / 100,
                  predictMeanMs:
                    Math.round(
                      (predictTimings.reduce((s, v) => s + v, 0) / predictTimings.length) * 100,
                    ) / 100,
                  batchSizeMean: Math.round(bsMean * 100) / 100,
                  detPerSec: elapsed > 0 ? Math.round((totalDet / elapsed) * 100) / 100 : 0,
                  avgDetections: Math.round(avgDet * 100) / 100,
                },
              })
            } else {
              ctx.logger.warn('emitProgress: NO eventBus')
            }
          }
        }
      }

      await Promise.all(Array.from({ length: input.parallel }, () => worker()))
      const wallSec = (performance.now() - wallStart) / 1000

      // Cleanup
      await api.pipelineExecutor.uncacheFrame.mutate({ frameId: poolFrameId }, pin).catch(() => {})

      return this.buildBenchResult(
        wallTimings,
        inferTimings,
        preprocessTimings,
        predictTimings,
        batchSizes,
        detCounts,
        wallSec,
        'cached',
        { nodeId: benchNode },
      )
    }

    // ── Slow path: full runPipeline per call (multi-step trees) ──
    ctx.logger.info('synthetic bench: using full runPipeline path', {
      meta: {
        steps: enabledSteps.length,
        simulatePipeline: !!input.simulatePipeline,
        deviceKey: input.deviceKey ?? null,
        plane: input.plane ?? null,
      },
    })

    let _callCount = 0
    const callOnce = async (): Promise<{ wallMs: number; result: FrameResult }> => {
      const t0 = performance.now()
      const result = await api.pipelineExecutor.runPipeline.mutate(
        {
          ...buildBenchRunPipelineInput({
            steps: stepsToRun,
            frame: sharedFrame,
            ...(input.deviceKey ? { deviceKey: input.deviceKey } : {}),
            ...(input.plane ? { plane: input.plane } : {}),
          }),
        },
        pin,
      )
      const wallMs = performance.now() - t0
      const n = ++_callCount
      if (n <= 20) {
        ctx.logger.info('bench call trace', {
          meta: {
            n,
            wallMs: Math.round(wallMs),
            totalInferenceMs: Math.round(result.debug?.totalInferenceMs ?? 0),
            predictMs: Math.round((result.debug?.predictMs ?? 0) * 10) / 10,
            preprocessMs: Math.round((result.debug?.preprocessMs ?? 0) * 10) / 10,
            batchSize: result.debug?.batchSize ?? 1,
          },
        })
      }
      return { wallMs, result }
    }

    // Warmup — sequential to ensure engine is hot before timing.
    const warmupCount = input.warmup ?? 1
    for (let i = 0; i < warmupCount; i++) {
      await callOnce()
    }

    const wallTimings: number[] = []
    const serverWallTimings: number[] = []
    const inferTimings: number[] = []
    const preprocessTimings: number[] = []
    const predictTimings: number[] = []
    const batchSizes: number[] = []
    const detCounts: number[] = []
    const sessionId = input.sessionId
    const totalRuns = input.parallel * input.iterations

    const wallStart = performance.now()
    const worker = async (): Promise<void> => {
      for (let i = 0; i < input.iterations; i++) {
        if (run.signal.aborted) break
        const { wallMs, result } = await callOnce()
        wallTimings.push(wallMs)
        serverWallTimings.push(result.debug?.wallMs ?? 0)
        inferTimings.push(result.debug?.totalInferenceMs ?? 0)
        preprocessTimings.push(result.debug?.preprocessMs ?? 0)
        predictTimings.push(result.debug?.predictMs ?? 0)
        batchSizes.push(result.debug?.batchSize ?? 1)
        detCounts.push(result.detections?.length ?? 0)
        const n = wallTimings.length
        run.report({ runs: n, totalRuns })
        if (n % Math.max(1, input.parallel) === 0 && ctx.eventBus) {
          const elapsed = (performance.now() - wallStart) / 1000
          const fps = elapsed > 0 ? n / elapsed : 0
          const meanMs = wallTimings.reduce((s, v) => s + v, 0) / n
          const sorted = [...wallTimings].toSorted((a, b) => a - b)
          const p95 = sorted[Math.min(sorted.length - 1, Math.floor(0.95 * sorted.length))] ?? 0
          const totalDet = detCounts.reduce((s, v) => s + v, 0)
          const bsMean = batchSizes.reduce((s, v) => s + v, 0) / n
          ctx.eventBus.emit({
            id: `bench-${n}`,
            timestamp: new Date(),
            source: { type: 'pipeline' as const, id: 'synthetic-bench' },
            category: EventCategory.PipelineProgress,
            data: {
              nodeId: benchNode,
              sessionId,
              step: 'synthetic-bench',
              message: `runs ${n}/${totalRuns} \u00b7 ${fps.toFixed(1)} fps \u00b7 call ${meanMs.toFixed(1)}ms \u00b7 batch ${bsMean.toFixed(1)}`,
              benchProgress: true,
              runs: n,
              totalRuns,
              fps: Math.round(fps * 100) / 100,
              meanMs: Math.round(meanMs * 100) / 100,
              p95Ms: Math.round(p95 * 100) / 100,
              inferMeanMs: Math.round((inferTimings.reduce((s, v) => s + v, 0) / n) * 100) / 100,
              preprocessMeanMs:
                Math.round((preprocessTimings.reduce((s, v) => s + v, 0) / n) * 100) / 100,
              predictMeanMs:
                Math.round((predictTimings.reduce((s, v) => s + v, 0) / n) * 100) / 100,
              batchSizeMean: Math.round(bsMean * 100) / 100,
              detPerSec: elapsed > 0 ? Math.round((totalDet / elapsed) * 100) / 100 : 0,
              avgDetections: n > 0 ? Math.round((totalDet / n) * 100) / 100 : 0,
            },
          })
        }
      }
    }

    await Promise.all(Array.from({ length: input.parallel }, () => worker()))
    const wallSec = (performance.now() - wallStart) / 1000

    return this.buildBenchResult(
      wallTimings,
      inferTimings,
      preprocessTimings,
      predictTimings,
      batchSizes,
      detCounts,
      wallSec,
      'pipeline',
      { nodeId: benchNode, ...(input.deviceKey ? { deviceKey: input.deviceKey } : {}) },
    )
  }

  private async buildBenchResult(
    wallTimings: number[],
    inferTimings: number[],
    preprocessTimings: number[],
    predictTimings: number[],
    batchSizes: number[],
    detCounts: number[],
    wallSec: number,
    path: string,
    target: BenchPoolTarget,
  ): Promise<SyntheticBenchResult> {
    const meanOfArr = (xs: readonly number[]): number =>
      xs.length > 0 ? xs.reduce((s, v) => s + v, 0) / xs.length : 0
    this.ctx.logger.info('synthetic bench summary', {
      meta: {
        runs: wallTimings.length,
        wallSec: Math.round(wallSec * 100) / 100,
        fps: Math.round((wallTimings.length / wallSec) * 100) / 100,
        callMeanMs: Math.round(meanOfArr(wallTimings)),
        inferMeanMs: Math.round(meanOfArr(inferTimings)),
        preprocessMeanMs: Math.round(meanOfArr(preprocessTimings)),
        predictMeanMs: Math.round(meanOfArr(predictTimings)),
        batchSizeMean: Math.round(meanOfArr(batchSizes) * 100) / 100,
        batchSizeMax: batchSizes.length > 0 ? Math.max(...batchSizes) : 0,
      },
    })

    const sorted = [...wallTimings].toSorted((a, b) => a - b)
    const pick = (q: number): number =>
      sorted.length > 0 ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]! : 0
    const meanOf = (xs: readonly number[]): number =>
      xs.length > 0 ? xs.reduce((s, v) => s + v, 0) / xs.length : 0

    const totalRuns = wallTimings.length
    const totalDet = detCounts.reduce((s, v) => s + v, 0)

    return {
      runs: totalRuns,
      wallSec: Math.round(wallSec * 1000) / 1000,
      fps: wallSec > 0 ? Math.round((totalRuns / wallSec) * 100) / 100 : 0,
      detectionsPerSec: wallSec > 0 ? Math.round((totalDet / wallSec) * 100) / 100 : 0,
      avgDetections: totalRuns > 0 ? Math.round((totalDet / totalRuns) * 100) / 100 : 0,
      callMs: {
        mean: Math.round(meanOf(wallTimings) * 100) / 100,
        p50: Math.round(pick(0.5) * 100) / 100,
        p95: Math.round(pick(0.95) * 100) / 100,
        p99: Math.round(pick(0.99) * 100) / 100,
      },
      inferMs: Math.round(meanOf(inferTimings) * 100) / 100,
      preprocessMs: Math.round(meanOf(preprocessTimings) * 100) / 100,
      predictMs: Math.round(meanOf(predictTimings) * 100) / 100,
      batchSizeMean: Math.round(meanOf(batchSizes) * 100) / 100,
      batchSizeMax: batchSizes.length > 0 ? Math.max(...batchSizes) : 0,
      path,
      pool: await this.readBenchPool(target),
    }
  }

  /**
   * The pool a bench measured, and its provisioning — asked of the node it
   * was pinned to, for the device pool it named (D646). It used to ask the
   * node DEFAULT of whichever node answered, so an NPU bench was recorded
   * beside the onnx pool's tuning. A failed read is `null` fields and a line,
   * never a default (D393).
   */
  private async readBenchPool(target: BenchPoolTarget): Promise<SyntheticBenchPool> {
    const unknown: SyntheticBenchPool = {
      nodeId: target.nodeId,
      deviceKey: target.deviceKey ?? null,
      runtime: null,
      numWorkers: null,
      concurrency: null,
      batchMode: null,
      maxBatchSize: null,
    }
    const api = this.ctx.api
    if (!api) return unknown
    const query = buildBenchTuningQuery(target)
    try {
      const tuning = await api.pipelineExecutor.getEffectiveTuning.query(
        { ...query.input },
        nodePin(query.nodeId),
      )
      return {
        nodeId: target.nodeId,
        deviceKey: tuning.deviceKey,
        runtime: tuning.runtime,
        numWorkers: tuning.numWorkers,
        concurrency: tuning.concurrency,
        batchMode: tuning.batchMode,
        maxBatchSize: tuning.maxBatchSize,
      }
    } catch (err: unknown) {
      this.ctx.logger.warn('synthetic bench: pool tuning read failed — reported as unknown', {
        meta: { nodeId: target.nodeId, deviceKey: target.deviceKey ?? null, error: errMsg(err) },
      })
      return unknown
    }
  }

  // ── Capacity ramp (open-loop, spec 2026-08-02-capacity-test-design §4) ──

  /**
   * Validate + START an open-loop capacity ramp, returning immediately.
   *
   * WHY here and not addon-benchmark: the benchmark addon lives in the `ml`
   * group — a separate process — and a child↔child cap call transits the
   * hub parent router, so raw-RGB frames at ramp rate (up to 32×10fps ×
   * 1.2MB) through that relay is exactly the D9 failure that OOM'd
   * hub-main; shipping JPEG instead would skip the executor's per-frame
   * `getSharp()` encode, i.e. the very path the measurement exists to
   * exercise. This runner is co-located with detection-pipeline (the
   * `detection` group), so `runPipeline` resolves in-process and the
   * dispatch is byte-for-byte the live camera shape — same reasoning as
   * `runSyntheticBench` above. It also puts the stall sampler on the SAME
   * event loop the executor blocks.
   *
   * WHY fire-and-poll: a full ramp (steps × (settle+measure)) outlives the
   * UDS addon-call plane's 60s request timeout. `getCapacityRampStatus`
   * collects progress + the final result; `abortCapacityRamp` stops early.
   */
  private async runCapacityRampAction(
    input: RunCapacityRampInput,
  ): Promise<RunCapacityRampAccepted> {
    const ctx = this.ctx
    if (!ctx.api) throw new Error('runCapacityRamp: ctx.api unavailable')

    const existing = this.capacityRuns.get(input.sessionId)
    if (existing?.status.state === 'running') {
      throw new Error(`runCapacityRamp: session '${input.sessionId}' is already running`)
    }
    for (const [id, entry] of this.capacityRuns) {
      if (entry.status.state === 'running') {
        throw new Error(
          `runCapacityRamp: ramp '${id}' is already running on this node — one at a time, the measurement owns the node`,
        )
      }
    }

    // Node-locality gate: the driver runs where this runner runs. A nodeId
    // naming another node would ship a raw frame across the cluster per
    // call — that measures the transport, not the node (and can OOM the
    // relay). Cross-node capacity needs the ramp STARTED on that node's
    // runner; addons.custom currently reaches only the hub's.
    if (input.nodeId !== undefined && input.nodeId !== this.nodeId) {
      throw new Error(
        `runCapacityRamp: driver is node-local — this runner is '${this.nodeId}', refusing nodeId '${input.nodeId}'. Frames must not cross a node boundary per call.`,
      )
    }

    // Quiet-node gate: live cameras still in watching/active phase share the
    // pools and the event loop with the ramp — the number would be neither
    // "capacity" nor "current load". The pause procedure
    // (scripts/capacity/pause-restore.mjs) drives every camera to 'idle'.
    const nonIdle = (this.runner?.getAllCameraMetrics() ?? []).filter((m) => m.phase !== 'idle')
    const contaminated = nonIdle.length > 0
    if (contaminated && input.allowActiveCameras !== true) {
      throw new Error(
        `runCapacityRamp: node not quiet — ${nonIdle.length} camera(s) not idle (deviceIds ${nonIdle
          .map((m) => m.deviceId)
          .join(
            ', ',
          )}). Pause detection first (scripts/capacity/pause-restore.mjs) or pass allowActiveCameras: true to run a knowingly contaminated measurement.`,
      )
    }

    const cached = this.benchFrameCache.get(input.frameId)
    if (!cached) {
      throw new Error(
        `runCapacityRamp: frameId ${input.frameId} not cached (call cacheBenchFrame first)`,
      )
    }

    const abortFlag = { aborted: false }
    this.capacityRuns.set(input.sessionId, {
      abortFlag,
      status: { sessionId: input.sessionId, state: 'running' },
    })
    this.pruneCapacityRuns()

    void this.executeCapacityRampInBackground(input, cached, abortFlag, contaminated)
      .then((result) => {
        this.setCapacityStatus(input.sessionId, {
          sessionId: input.sessionId,
          state: 'done',
          result,
        })
      })
      .catch((err: unknown) => {
        const error = errMsg(err)
        ctx.logger.error('capacity ramp failed', {
          meta: { sessionId: input.sessionId, error },
        })
        this.setCapacityStatus(input.sessionId, {
          sessionId: input.sessionId,
          state: 'failed',
          error,
        })
      })

    return { accepted: true, sessionId: input.sessionId }
  }

  private async executeCapacityRampInBackground(
    input: RunCapacityRampInput,
    cached: { readonly data: Uint8Array; readonly width: number; readonly height: number },
    abortFlag: { aborted: boolean },
    contaminatedByActiveCameras: boolean,
  ): Promise<RunCapacityRampResult> {
    const ctx = this.ctx
    const api = ctx.api
    if (!api) throw new Error('runCapacityRamp: ctx.api unavailable')
    const startedAt = new Date().toISOString()
    const rampStart = Date.now()
    const pin = nodePin(this.nodeId)
    const sessionId = input.sessionId
    const targetSize = input.targetSize ?? 640
    const fpsPerCamera = input.fpsPerCamera ?? 10
    const settleSec = input.settleSec ?? 30
    const measureSec = input.measureSec ?? 120
    const ramp = input.ramp ?? [2, 4, 8, 12, 16, 20, 24, 28, 32]
    const warmupCalls = Math.max(1, input.warmupCalls ?? 3)
    const drainTimeoutMs = (input.drainTimeoutSec ?? 30) * 1000
    const slo: CapacitySlo = {
      dropRatioMax: input.slo?.dropRatioMax ?? DEFAULT_CAPACITY_SLO.dropRatioMax,
      e2eP95MsMax: input.slo?.e2eP95MsMax ?? DEFAULT_CAPACITY_SLO.e2eP95MsMax,
      stallsMax: input.slo?.stallsMax ?? DEFAULT_CAPACITY_SLO.stallsMax,
    }

    // Resize the pinned raw-RGB frame ONCE to the spec's square size — the
    // per-call path pays the sharp ENCODE (in the executor), never a resize.
    let frameData: Uint8Array
    if (cached.width === targetSize && cached.height === targetSize) {
      frameData = cached.data
    } else {
      const sharpFn = await getSharp()
      const resized = await sharpFn(
        Buffer.from(cached.data.buffer, cached.data.byteOffset, cached.data.byteLength),
        { raw: { width: cached.width, height: cached.height, channels: 3 } },
      )
        .resize({ width: targetSize, height: targetSize, fit: 'fill' })
        .raw()
        .toBuffer()
      frameData = new Uint8Array(resized.buffer, resized.byteOffset, resized.byteLength)
    }

    const stepsToRun = input.steps.map((s) => ({
      addonId: s.addonId,
      modelId: s.modelId,
      enabled: s.enabled,
      children: s.children ?? [],
    }))

    ctx.logger.info('capacity ramp start', {
      meta: {
        sessionId,
        ramp: [...ramp],
        fpsPerCamera,
        targetSize,
        settleSec,
        measureSec,
        deviceKey: input.deviceKey ?? null,
        contaminatedByActiveCameras,
        steps: stepsToRun.map((s) => `${s.addonId}/${s.modelId}${s.enabled ? '' : '[off]'}`),
      },
    })

    let engineLabel = 'unknown'
    const dispatchOnce = async (): Promise<CapacityDispatchOutcome> => {
      // The production dispatch shape, byte for byte: raw-RGB `frame`,
      // `plane: 'frame'` (root-plane only, crop children skipped by the
      // executor — two-plane design), optional per-camera deviceKey. NO
      // pool-side frameId pin: preprocess + the sharp encode must run per
      // call or the test is not camera-shaped (spec §4).
      const result = await api.pipelineExecutor.runPipeline.mutate(
        {
          steps: stepsToRun,
          frame: {
            data: frameData,
            format: 'rgb' as const,
            width: targetSize,
            height: targetSize,
            timestamp: Date.now(),
          },
          plane: 'frame',
          sessionId,
          ...(input.deviceKey ? { deviceKey: input.deviceKey } : {}),
        },
        pin,
      )
      if (result.debug?.engine !== undefined) engineLabel = result.debug.engine
      if (result.shed === true) return { kind: 'shed', shedSignal: 'first-class' }
      const detections = result.detections.length
      if (detections === 0) {
        // Pre-marker executor fallback: the pinned frame always carries ≥1
        // detection (enforced in warmup below), so an empty frame ⇒ shed.
        return { kind: 'shed', shedSignal: 'zero-detections-fallback' }
      }
      return {
        kind: 'ok',
        inferMs: result.debug?.totalInferenceMs ?? 0,
        predictMs: result.debug?.predictMs ?? 0,
        detections,
      }
    }

    // Warmup: first dispatch pays ensureModelsForSteps (model load) — it
    // must never pollute step 1. Doubles as the pinned-frame guard: shed
    // accounting reads "0 detections ⇒ shed" on a pre-marker executor, so a
    // frame that genuinely yields 0 detections would corrupt every count.
    this.setCapacityProgress(sessionId, {
      stepIndex: 0,
      totalSteps: ramp.length,
      cameras: ramp[0] ?? 1,
      phase: 'warmup',
    })
    let warmupDetections = 0
    for (let i = 0; i < warmupCalls; i++) {
      const out = await dispatchOnce()
      if (out.kind === 'ok') warmupDetections = Math.max(warmupDetections, out.detections ?? 0)
    }
    if (warmupDetections === 0) {
      throw new Error(
        'runCapacityRamp: the pinned frame produced 0 detections in warmup — pick a reference frame with ≥1 detection (spec §4: shed accounting needs "empty ⇒ shed" to hold)',
      )
    }

    // The stall sampler shares THIS process's event loop with the executor's
    // per-frame Node-side work — the same loop the lazy-sharp fix unblocks.
    const sampler = startStallSampler()
    const sleepUntil = (t: number): Promise<void> =>
      new Promise((resolve) => {
        const timer = setTimeout(resolve, Math.max(0, t - Date.now()))
        timer.unref?.()
      })

    try {
      const outcome = await executeCapacityRamp({
        ramp,
        fpsPerCamera,
        settleMs: settleSec * 1000,
        measureMs: measureSec * 1000,
        drainTimeoutMs,
        slo,
        stopOnFirstFail: input.stopOnFirstFail ?? true,
        dispatch: dispatchOnce,
        now: Date.now,
        sleepUntil,
        shouldStop: () => abortFlag.aborted,
        stallSnapshot: () => sampler.snapshot(),
        rssMb: () => Math.round(process.memoryUsage().rss / 1e6),
        onStep: (info) => this.onCapacityRampStep(sessionId, ramp.length, info),
      })

      const perStep: CapacityRampStepResult[] = outcome.steps.map((s) => toCapacityStepResult(s))
      const result: RunCapacityRampResult = {
        perStep,
        nMax: outcome.nMax,
        failedStep: outcome.failedStep,
        engineLabel,
        shedSignal: outcome.shedSignal,
        frame: {
          width: targetSize,
          height: targetSize,
          payloadBytes: frameData.byteLength,
          format: 'rgb',
        },
        slo,
        fpsPerCamera,
        settleSec,
        measureSec,
        nodeId: this.nodeId,
        deviceKey: input.deviceKey ?? null,
        contaminatedByActiveCameras,
        startedAt,
        wallMs: Date.now() - rampStart,
        aborted: outcome.aborted,
      }
      ctx.logger.info('capacity ramp done', {
        meta: {
          sessionId,
          nMax: result.nMax,
          failedStep: result.failedStep,
          engineLabel,
          shedSignal: result.shedSignal,
          aborted: result.aborted,
          wallMs: result.wallMs,
          steps: perStep.map(
            (s) =>
              `${s.cameras}cam: drop ${(s.dropRatio * 100).toFixed(2)}% p95 ${Math.round(s.e2eMs.p95)}ms stalls ${s.stallCount} ${s.pass ? 'PASS' : 'FAIL'}`,
          ),
        },
      })
      return result
    } finally {
      sampler.stop()
    }
  }

  /** Per-step progress: status map + log line + benchProgress event. */
  private onCapacityRampStep(
    sessionId: string,
    totalSteps: number,
    info: {
      readonly stepIndex: number
      readonly cameras: number
      readonly phase: 'settle' | 'measure' | 'done'
      readonly step?: CapacityRampStep
    },
  ): void {
    if (info.phase !== 'done') {
      this.setCapacityProgress(sessionId, {
        stepIndex: info.stepIndex,
        totalSteps,
        cameras: info.cameras,
        phase: info.phase,
      })
      return
    }
    const step = info.step
    if (!step) return
    const summary = {
      cameras: step.cameras,
      offered: step.raw.offered,
      completed: step.raw.completed,
      droppedByDriver: step.raw.droppedByDriver,
      shed: step.raw.shed,
      errors: step.raw.errors,
      dropRatioPct: Math.round(step.verdict.dropRatio * 10000) / 100,
      e2eP95Ms: Math.round(step.verdict.e2eMs.p95),
      inferP95Ms: Math.round(step.verdict.inferMs.p95 * 100) / 100,
      stallCount: step.stall.count,
      stallSyncCount: step.stall.syncCount,
      stallMaxMs: step.stall.maxMs,
      rssDeltaMb: step.rssEndMb - step.rssStartMb,
      pass: step.verdict.pass,
      failReasons: step.verdict.failReasons,
    }
    this.ctx.logger.info('capacity ramp step done', { meta: { sessionId, ...summary } })
    this.ctx.eventBus?.emit({
      id: `capacity-${sessionId}-${step.cameras}`,
      timestamp: new Date(),
      source: { type: 'pipeline' as const, id: 'capacity-ramp' },
      category: EventCategory.PipelineProgress,
      data: {
        nodeId: this.nodeId,
        sessionId,
        step: 'capacity-ramp',
        benchProgress: true,
        message: `capacity ${step.cameras} cam: drop ${summary.dropRatioPct}% · e2e p95 ${summary.e2eP95Ms}ms · stalls ${summary.stallCount} · ${summary.pass ? 'PASS' : 'FAIL'}`,
        ...summary,
      },
    })
  }

  private async getCapacityRampStatusAction(
    input: GetCapacityRampStatusInput,
  ): Promise<CapacityRampStatus> {
    const entry = this.capacityRuns.get(input.sessionId)
    if (!entry) {
      throw new Error(
        `getCapacityRampStatus: unknown sessionId '${input.sessionId}' (only the last ${PipelineRunnerAddon.MAX_CAPACITY_RUN_HISTORY} runs are kept)`,
      )
    }
    return entry.status
  }

  /**
   * The node, its quiet state and every ramp this runner still remembers.
   *
   * A caller holding a sessionId uses `getCapacityRampStatus`; a caller that
   * has just been opened (a page reloaded mid-ramp, a fresh shell) has no id
   * at all, and the ramp it needs to watch or stop may have another 40
   * minutes to run. Without this the only recovery path is parsing the
   * "already running" rejection for the id it names.
   *
   * `nodeId` is this runner answering about itself — the ramp is node-local
   * and `addons.custom` reaches exactly one runner, so a caller that wanted
   * another node can refuse instead of attributing this one's number to it.
   */
  private async listCapacityRampsAction(): Promise<CapacityRampOverview> {
    const busy = (this.runner?.getAllCameraMetrics() ?? []).filter((m) => m.phase !== 'idle')
    return {
      nodeId: this.nodeId,
      maxHistory: PipelineRunnerAddon.MAX_CAPACITY_RUN_HISTORY,
      quiet: busy.length === 0,
      busyCameras: busy.map((m) => m.deviceId),
      runs: [...this.capacityRuns.values()].map((entry) => entry.status),
    }
  }

  private async abortCapacityRampAction(
    input: AbortCapacityRampInput,
  ): Promise<AbortCapacityRampResult> {
    const entry = this.capacityRuns.get(input.sessionId)
    if (!entry || entry.status.state !== 'running') return { aborted: false }
    entry.abortFlag.aborted = true
    return { aborted: true }
  }

  /** Replace a session's status wholesale (entries are never mutated). */
  private setCapacityStatus(sessionId: string, status: CapacityRampStatus): void {
    const entry = this.capacityRuns.get(sessionId)
    if (!entry) return
    this.capacityRuns.set(sessionId, { abortFlag: entry.abortFlag, status })
  }

  private setCapacityProgress(sessionId: string, progress: CapacityRampProgress): void {
    const entry = this.capacityRuns.get(sessionId)
    if (!entry || entry.status.state !== 'running') return
    this.capacityRuns.set(sessionId, {
      abortFlag: entry.abortFlag,
      status: { ...entry.status, progress },
    })
  }

  /** Drop the oldest finished runs past the history bound (insertion order). */
  private pruneCapacityRuns(): void {
    while (this.capacityRuns.size > PipelineRunnerAddon.MAX_CAPACITY_RUN_HISTORY) {
      let dropped = false
      for (const [id, entry] of this.capacityRuns) {
        if (entry.status.state !== 'running') {
          this.capacityRuns.delete(id)
          dropped = true
          break
        }
      }
      if (!dropped) break
    }
  }

  // ── IPipelineRunnerProvider implementation ────────────────────────────

  async attachCamera(config: RunnerCameraConfig): Promise<{ success: true }> {
    const runner = this.runner
    const ctx = this.ctx
    if (!runner || !ctx) {
      throw new Error('PipelineRunnerAddon: attachCamera called before initialize completed')
    }

    // Diagnostic: log the incoming config to understand why
    // subscribeMotionFrames isn't being called.
    this.ctx.logger.info('attachCamera received config', {
      tags: { deviceId: config.deviceId },
      meta: {
        motionSources: config.motionSources,
        motionSourcesType: Array.isArray(config.motionSources)
          ? `array(${config.motionSources.length})`
          : typeof config.motionSources,
        motionStreamId: config.motionStreamId,
        detectionStreamId: config.detectionStreamId,
        keys: Reflect.ownKeys(config).filter((k): k is string => typeof k === 'string'),
      },
    })

    if (this.attached.has(config.deviceId)) {
      // Idempotent: re-attach with new config replaces the existing one.
      this.detachInternal(config.deviceId)
    }

    // Register the attachment BEFORE `registerCamera`. An always-on camera
    // starts in the ACTIVE phase, so `registerCamera` fires a SYNCHRONOUS
    // `detectionStreamHandler('subscribe')` → `handleDetectionStreamChange`,
    // which early-returns when `this.attached` has no entry yet. Setting the
    // attachment first ensures that synchronous subscribe opens the detection
    // frame subscription; otherwise an always-on camera never decodes (its
    // detection stays at 0 fps). On-motion cameras subscribe later (on a motion
    // transition) so they were unaffected by the previous ordering.
    const attachment: AttachedCamera = {
      config,
      motionUnsubscribe: null,
      detectionUnsubscribe: null,
      detailSteps: deriveDetailSteps(config.steps),
    }
    this.attached.set(config.deviceId, attachment)
    // The live attachment supersedes any detail state parked by a previous
    // soft detach — `resolveDetailChildSteps` must answer from THIS config now.
    this.dropParkedDetail(config.deviceId)

    runner.registerCamera(config.deviceId, {
      detectionMode: config.detectionMode,
      // WITHOUT this the whole mode is inert: the setting resolves, it rides
      // the attach payload, the bus subscription admits the camera's boxes —
      // and the runner registers a camera that never heard of them, so
      // `planDetectionSources(undefined)` reads `['pipeline']` and the ML root
      // step runs anyway. Measured live on camera 106 with `['onboard']`
      // stored: every track still came back `source=pipeline`.
      ...(config.detectionSources !== undefined
        ? { detectionSources: config.detectionSources }
        : {}),
      // What opened this session — named on the attach phase event, never
      // decided on (D672 rule 11 as amended 2026-10-06).
      ...(config.sessionTrigger !== undefined ? { sessionTrigger: config.sessionTrigger } : {}),
      // The root step's settings ARE the operator's gate. The executor reads
      // them for the ML root; the onboard root has no executor, so they travel
      // here instead of being unenforced (D62: one authority, asked twice).
      ...(rootObjectGate(config.steps) !== undefined
        ? { objectGate: rootObjectGate(config.steps) }
        : {}),
      fps: config.detectionFps,
      motionCooldownMs: config.motionCooldownMs,
      occupancyRecheckEnabled: config.occupancyRecheckEnabled,
      occupancyRecheckSec: config.occupancyRecheckSec,
      occupancyRecheckFrames: config.occupancyRecheckFrames,
    })

    // Subscribe to the local motion stream broker only when 'analyzer'
    // is among the active motion sources — that's the source that
    // needs decoded frames flowing through the motion-detection cap.
    // 'onboard' alone arrives via the bus (the provider's ProviderMotion →
    // the orchestrator's camera-sensors bridge → MotionOnMotionChanged →
    // reportMotion, D673) without needing broker frames.
    if (config.motionSources.includes('analyzer')) {
      attachment.motionUnsubscribe = await this.subscribeMotionFrames(config)
    }

    // Note: detection stream subscription is wired LAZILY by the
    // runner's phase machine via `handleDetectionStreamChange`, which
    // fires when the camera transitions to ACTIVE. Always-on cameras
    // transition immediately on registerCamera, so the subscribe call
    // already happened by the time we get here.

    const stepsCount = config.steps?.length ?? 0
    const dispatch =
      stepsCount > 0
        ? `runPipeline(${stepsCount}step${stepsCount === 1 ? '' : 's'})`
        : config.steps !== undefined
          ? 'skip(0steps)'
          : 'runFrame(legacy)'
    // Engine is node-local now (the detection-pipeline provider resolves
    // its own node's engine) — the runner no longer carries or knows the
    // per-camera engine, so the log label is a static marker rather than
    // a value derived from `config.engine`.
    const engineLabel = 'node-local'
    this.firstDetectionFrame.markAttached(config.deviceId, Date.now())
    this.ctx.logger.info('attachCamera', {
      tags: { deviceId: config.deviceId },
      meta: {
        detectionMode: config.detectionMode,
        audioMode: config.audioMode,
        motionFps: config.motionFps,
        detectionFps: config.detectionFps,
        motionSources: config.motionSources,
        dispatch,
        engine: engineLabel,
      },
    })

    return { success: true }
  }

  async detachCamera(input: { deviceId: number }): Promise<{ success: true }> {
    // SOFT: the orchestrator's motion-cooldown teardown lands here, and the
    // next motion event for this camera is usually seconds away. Killing the
    // decode worker made every such event pay a full cold start — the keep-warm
    // written for the phase gate could never apply to an on-motion camera
    // because the phase gate is not what closes its session.
    this.detachInternal(input.deviceId, true)
    return { success: true }
  }

  async reportMotion(input: {
    deviceId: number
    detected: boolean
    source?: MotionSource
    regions?: ReadonlyArray<MotionRegion>
  }): Promise<{ success: true }> {
    this.runner?.reportMotion(input.deviceId, input.detected, input.source, input.regions)
    return { success: true }
  }

  /**
   * Native-resolution crop for a retention-ring frame (native-crop feature).
   * Looks the handle up in {@link nativeCropRegistry}; the worker downloads ONLY
   * the ROI — a full native frame never travels the wire.
   *
   * Tier decision ({@link resolveNativeCropSource}): a native-lease HIT always
   * wins. On a MISS (never registered, or the worker's tiny native ring already
   * evicted the frame), an ROI (subject-crop) request returns `null` so the
   * caller reports the miss and RETRIES — it is NEVER handed the ≤640 detection
   * raster masquerading as a native crop (Task S1). A full-frame request keeps
   * the ≤640 RAM `RetainedFrameStore` fallback (blank-frame guard / 640-snapshot
   * resolve legitimately want the lower-RES honest frame).
   */
  async getNativeCrop(input: NativeCropRequestInput): Promise<NativeCropRequestResult | null> {
    // Both rungs run with the parked frame held as a READER (D656): a native
    // miss settles the worker's last request in the same turn the fallback's
    // read is not yet sent, and a draining worker must not die in that gap.
    return withRetainedReader(this.retainedFrames, input.handle, () =>
      this.resolveNativeCropBothRungs(input),
    )
  }

  /** {@link getNativeCrop}'s two rungs, run under its reader hold. */
  private async resolveNativeCropBothRungs(
    input: NativeCropRequestInput,
  ): Promise<NativeCropRequestResult | null> {
    const deviceId = this.nativeCropRegistry.deviceIdFor(input.handle) ?? 0
    const isFullFrame =
      input.bbox.x <= 0.001 &&
      input.bbox.y <= 0.001 &&
      input.bbox.w >= 0.999 &&
      input.bbox.h >= 0.999
    this.frameLazy.noteOnDemandRequest({
      deviceId,
      kind: isFullFrame && input.maxWidth === undefined ? 'full-frame' : 'crop',
    })
    const resolved = await this.resolveNativeCropPixels(input)
    if (resolved.tier === 'native' && resolved.pixels !== null) {
      this.frameLazy.noteHit(resolveNativeCropHitKind(resolved.pixels.source), deviceId)
      return this.encodeNativeCropResult(
        resolved.pixels,
        resolved.tier,
        input.encodeJpeg,
        input.acceptJpegBytes,
      )
    }
    this.frameLazy.noteMiss('native', deviceId)
    // 2) RAM retained-frame path (shm-ring removal 2026-07-16). ONLY legitimate
    //    for a FULL-FRAME resolve (post-analysis `resolveFrame` → bbox {0,0,1,1}:
    //    blank-frame guard / 640-snapshot fallback) — a lower-RES honest frame.
    //    An ROI (subject crop) that missed the native lease MUST report the miss
    //    so the caller retries; it is never served the ≤640 detection raster
    //    masquerading as a native crop (Task S1 — removes the RC-2 floor's reason
    //    to exist).
    if (resolved.tier !== 'ram-fullframe') return null
    const crop = await this.retainedFrames?.cropAsync(input.handle, input.bbox, input.maxWidth)
    if (!crop) {
      this.frameLazy.noteMiss('fallback', deviceId)
      // THE LAST RUNG. A full-frame request that gets here has already missed
      // the native lease, so the retained store is the only thing left; a `null`
      // from it is the difference between "the handle missed but a lower rung
      // covered" (no recognition loss) and "the dispatch produced nothing at
      // all" (recognition loss). Until 2026-08-09 this returned silently and the
      // two were indistinguishable in the logs — the whole `native crop miss`
      // rate read as one number, and the only signal for total failure was the
      // dispatcher's warn, throttled to one line per device per minute.
      this.ctx?.logger.warn(
        'native full-frame miss — the retained store no longer holds this frame',
        {
          tags: {
            deviceId: this.nativeCropRegistry.deviceIdFor(input.handle) ?? -1,
          },
          meta: {
            handle: `${input.handle.shmId}#${input.handle.slot}#${input.handle.seq}`,
            handleNodeId: input.handle.nodeId,
            // The native rung's own verdict, so one line carries both failures.
            nativeMissReason: resolved.missReason,
            nativeHandleAgeMs: resolved.handleAgeMs,
            ...(resolved.workerReason !== undefined
              ? { nativeWorkerReason: resolved.workerReason }
              : {}),
            maxWidth: input.maxWidth ?? null,
            hint: 'both the native lease and the retained-frame window have closed for this frame — the detail dispatch that asked for it produces NO crop',
          },
        },
      )
      return null
    }
    this.frameLazy.noteHit('fallback', deviceId)
    return this.encodeNativeCropResult(
      { bytes: crop.bytes, width: crop.width, height: crop.height },
      resolved.tier,
      input.encodeJpeg,
      input.acceptJpegBytes,
    )
  }

  /**
   * PARK a frame for a track (D422) — the hub judged it relevant, and this node
   * still holds its pixels. Same native-lease resolve `getNativeCrop` uses,
   * same single encoder; the parcel lives in {@link parkedFrames} under
   * `(deviceId, trackId, kind)`. A refusal is an answer and a `deviceId`-tagged
   * log line, never a retry.
   */
  async parkTrackFrame(input: ParkTrackFrameInput): Promise<ParkTrackFrameResult> {
    const store = this.parkedFrames
    if (store === null) {
      return {
        parked: false,
        nodeId: this.nodeId,
        reason: 'handle-gone',
        handleAgeMs: null,
        detail: 'runner not initialised',
      }
    }
    return parkTrackFrameImpl(
      {
        nodeId: this.nodeId,
        store,
        resolvePixels: (request) => this.resolveNativeCropPixels(request),
        encodeJpeg: async (pixels) => {
          // In-process: the parcel is stored as bytes and shipped as bytes.
          // Asking for base64 here encoded and decoded the same JPEG for a
          // round trip that never left this process (D462).
          const encoded = await this.encodeNativeCropResult(pixels, 'native', true, true)
          return encoded?.jpegBytes !== undefined ? Buffer.from(encoded.jpegBytes) : null
        },
        logger: this.ctx.logger,
      },
      input,
    )
  }

  /** A parcel by `(deviceId, trackId, kind)`; `null` = nothing parked here. */
  async getParkedTrackFrame(input: {
    deviceId: number
    trackId: string
    kind: ParkedFrameKind
    acceptJpegBytes?: boolean
  }): Promise<ParkedTrackFrame | null> {
    const parcel = this.parkedFrames?.get(input.deviceId, input.trackId, input.kind) ?? null
    if (parcel === null) {
      // The consumer logs the loss with its own context; this side says what
      // it holds for the camera so "never parked" and "already gone" can be
      // told apart from the two lines together.
      this.ctxIfReady?.logger.debug('parked frame miss — nothing under this key', {
        tags: { deviceId: input.deviceId },
        meta: {
          trackId: input.trackId,
          kind: input.kind,
          ...(this.parkedFrames?.statsByDevice(input.deviceId) ?? { parcels: 0, bytes: 0 }),
        },
      })
      return null
    }
    return {
      // `new Uint8Array(buf)` is a native memcpy — NOT `Uint8Array.from()`,
      // which walks 2.5 MB element by element. The park store is typed
      // `Buffer` end to end, and a `Buffer<ArrayBufferLike>` is not assignable
      // to the schema's `Uint8Array<ArrayBuffer>`; retyping that chain is a
      // separate change, and a cast is not allowed here. One memcpy still
      // costs a fraction of the base64 encode plus the 3.3 MB string it built.
      ...(input.acceptJpegBytes === true
        ? { jpegBytes: new Uint8Array(parcel.jpeg) }
        : { jpeg: parcel.jpeg.toString('base64') }),
      width: parcel.width,
      height: parcel.height,
      timestamp: parcel.timestamp,
      parkedAt: parcel.parkedAt,
    }
  }

  /** The hub closed a track: drop its parcels. Idempotent. */
  async releaseParkedTrackFrames(input: {
    deviceId: number
    trackId: string
  }): Promise<{ released: number }> {
    return { released: this.parkedFrames?.release(input.deviceId, input.trackId) ?? 0 }
  }

  /**
   * A parcel left without a release. Counted per camera by cause and reported
   * one line per camera per minute: a camera whose parcels keep leaving under
   * the device bound is a crowd, under the node budget is a neighbour's
   * traffic, and under the age ceiling is a hub that stopped releasing.
   */
  private noteParkedEviction(
    deviceId: number,
    cause: 'device-bound' | 'node-budget' | 'age',
  ): void {
    const tally = this.parkedEvictions.get(deviceId) ?? { deviceBound: 0, nodeBudget: 0, age: 0 }
    if (cause === 'device-bound') tally.deviceBound += 1
    else if (cause === 'node-budget') tally.nodeBudget += 1
    else tally.age += 1
    this.parkedEvictions.set(deviceId, tally)
    const now = Date.now()
    const lastAt = this.parkedEvictionLoggedAt.get(deviceId) ?? 0
    if (now - lastAt < PARKED_EVICTION_LOG_INTERVAL_MS) return
    this.parkedEvictionLoggedAt.set(deviceId, now)
    this.ctxIfReady?.logger.info('parked frames evicted without a release', {
      tags: { deviceId },
      meta: {
        ...tally,
        lastCause: cause,
        parcelsHeld: this.parkedFrames?.size ?? 0,
        bytesHeld: this.parkedFrames?.bytes ?? 0,
      },
    })
    this.parkedEvictions.set(deviceId, { deviceBound: 0, nodeBudget: 0, age: 0 })
  }

  /**
   * Turn a finished frame into subject TILES and end its hold — the runner half
   * of R2 (`docs/design/2026-08-13-native-lease-two-tier-redesign.md`).
   *
   * Called from the result callback, which is the last instant at which the
   * frame's native pixels exist and its detections are known at the same time.
   * Every path through here ends the hold, including the one where there is
   * nothing to cut: a frame that detected nothing is the majority of frames and
   * releasing it promptly is most of the RAM this redesign gives back.
   *
   * Deliberately synchronous and unawaited. The worker replies to nothing, so
   * there is nothing to wait for, and a detection result must never be delayed
   * by an encode.
   */
  private cutSubjectTiles(
    deviceId: number,
    result: FrameResult,
    handle: FrameHandle | undefined,
  ): void {
    const outcome = this.dispatchSubjectTiles(result, handle)
    if ((result.detections?.length ?? 0) > 0) {
      if (outcome === 'sent') this.frameLazy.noteHit('tile', deviceId)
      else this.frameLazy.noteMiss('tile', deviceId)
    }
    if (outcome === 'sent') return
    // Every non-send is counted and reported per camera, throttled. The first
    // version of this method returned silently on a missing handle and on a
    // missing registry entry, which is how it reached production cutting ZERO
    // tiles on every camera while its own metrics line said `tilesCut:0` with
    // no explanation anywhere. A branch that drops work logs it.
    const tally = this.tileCutDrops.get(deviceId) ?? { handleless: 0, unbound: 0, threw: 0 }
    tally[outcome] += 1
    this.tileCutDrops.set(deviceId, tally)
    const now = Date.now()
    const lastAt = this.tileCutDropLoggedAt.get(deviceId) ?? 0
    if (now - lastAt < TILE_CUT_DROP_LOG_INTERVAL_MS) return
    this.tileCutDropLoggedAt.set(deviceId, now)
    this.ctx.logger.warn('subject tile cut NOT dispatched — the frame hold will not be released', {
      tags: { deviceId },
      meta: { ...tally, lastReason: outcome, boundFrames: this.frameCutters.size },
    })
  }

  /**
   * Send the cut for one finished frame. Returns what happened, so the caller
   * can account for it.
   *
   * The cutter is looked up in {@link frameCutters} — the addon's OWN per-frame
   * binding — and NOT in `nativeCropRegistry`. That distinction is the bug this
   * method exists to not have again: the registry is a node-wide LRU capped at
   * 256 entries, shared by every camera, and it exists to serve LATE
   * cross-process crops. Measured on the live hub during the incident it sits
   * PINNED at `registrySize=256 registryCap=256`, so an entry's lifetime is a
   * function of how many other cameras are busy. Ending a frame's hold is a
   * per-frame lifecycle event and must never be subject to another camera's
   * eviction pressure.
   */
  private dispatchSubjectTiles(
    result: FrameResult,
    handle: FrameHandle | undefined,
  ): 'sent' | 'handleless' | 'unbound' | 'threw' {
    if (!handle) return 'handleless'
    // Consume it either way: this frame's result has arrived exactly once, and
    // a binding left behind would leak one entry per frame.
    const cutter = this.frameCutters.take(handle)
    if (!cutter) return 'unbound'
    const boxes = planTileCuts(result.detections ?? [], {
      width: result.width,
      height: result.height,
    })
    try {
      cutter.cutTiles(boxes)
      return 'sent'
    } catch {
      return 'threw'
    }
  }

  /**
   * Bind a frame's cutter at DELIVERY, so its result can end its hold.
   *
   * Bounded by {@link MAX_BOUND_FRAME_CUTTERS}: a frame whose result never
   * comes back (a shed, a timed-out inference, a camera detaching mid-flight)
   * would otherwise leave its binding forever. The oldest is dropped and its
   * hold released directly — the worker's own frame bound would have reclaimed
   * it anyway, but releasing here is what keeps `holdOverflow` meaning "the
   * runner stopped answering" rather than "the runner forgot".
   */
  private bindFrameCutter(handle: FrameHandle, cutter: NativeCropRequester): void {
    this.frameCutters.bind(handle, cutter)
  }

  /**
   * The native-lease half of {@link getNativeCrop}, extracted so the DETAIL path
   * can keep the miss REASON the cap's `null` return has no room for. Both
   * callers share this one decision — a second copy of the tier arithmetic is
   * how a quality tier starts differing by caller.
   *
   * Logging level follows the CONSEQUENCE, not the event: a native miss that the
   * RAM tier is allowed to serve (a full-frame resolve) cost nobody anything and
   * stays at debug; a miss the caller is handed as `null` is lost work and is a
   * warn, carrying the numbers that decide the fix.
   */
  /**
   * Cut each candidate birth's own pixels from the frame that produced it, and
   * return a result carrying them (D379).
   *
   * Returns the SAME result object when there is nothing to cut, which is the
   * overwhelming majority of frames: a subject already on screen is not a
   * birth, so it costs a novelty lookup and no encode. A new result object is
   * built when there is — never a mutation of the one the executor produced.
   *
   * Every drop is counted and reported per camera. A branch that silently
   * dropped the evidence would be indistinguishable from a camera with no
   * births at all, which is the shape of failure this whole change exists to
   * remove.
   *
   * Also returns `novel`: the set of `plan[].index` this pass planned as
   * birth candidates — reused by `attachAppearance` so the 'candidates'
   * appearance scope (D683) does not recompute the same novelty question.
   */
  private async attachBirthEvidence(
    deviceId: number,
    frame: DecodedFrame,
    result: FrameResult,
  ): Promise<{ result: FrameResult; novel: ReadonlySet<number> }> {
    const detections = result.detections
    if (detections.length === 0) return { result, novel: new Set() }
    const plan = planBirthEvidence(
      deviceId,
      detections.map((d) => ({ bbox: d.bbox, score: d.score, macroClass: d.macroClass })),
      { width: result.width, height: result.height },
      this.birthNovelty,
      Date.now(),
    )
    if (plan.length === 0) return { result, novel: new Set() }
    const novel = new Set(plan.map((entry) => entry.index))
    const cost = this.birthEvidenceCost.get(deviceId) ?? {
      cut: 0,
      failed: 0,
      skippedNoPixels: 0,
      bytes: 0,
      encodeMs: 0,
    }
    this.birthEvidenceCost.set(deviceId, cost)
    // Two rasters can serve this, both in THIS process and both already paid
    // for. Neither is a fetch, and that is the whole point.
    const byIndex = new Map<number, BirthEvidence>()
    // Told apart because they have different fixes: no raster at all means the
    // frame reached here without pixels (a delivery-path question), while an
    // encode failure means the pixels were there and the cut did not work.
    const hasRaster =
      frame.frameRef !== undefined ||
      (frame.format === 'rgb' && frame.data.byteLength >= result.width * result.height * 3)
    if (!hasRaster) {
      cost.skippedNoPixels += plan.length
      this.reportBirthEvidenceCost(deviceId)
      return { result, novel }
    }
    for (const entry of plan) {
      const startedAt = Date.now()
      const jpeg = await this.encodeEvidenceCrop(frame, result, entry)
      if (jpeg === null) {
        cost.failed += 1
        continue
      }
      cost.cut += 1
      cost.bytes += jpeg.byteLength
      cost.encodeMs += Date.now() - startedAt
      byIndex.set(entry.index, {
        jpegBase64: jpeg.toString('base64'),
        rect: entry.rect,
        tier: 'analysis',
      })
    }
    this.reportBirthEvidenceCost(deviceId)
    if (byIndex.size === 0) return { result, novel }
    return {
      result: {
        ...result,
        detections: detections.map((d, i) => {
          const evidence = byIndex.get(i)
          return evidence === undefined ? d : { ...d, birthEvidence: evidence }
        }),
      },
      novel,
    }
  }

  /**
   * One evidence crop, or `null` when neither raster can serve it.
   *
   * The process-local frame LEASE is tried first. On the co-located path
   * `DecodedFrame.data` is deliberately empty and the pixels live only behind
   * `frameRef` — reading `data` there produced `skippedNoPixels` on roughly half
   * the cluster's cameras in the first minutes after this shipped, which is
   * exactly the silent gap this whole change exists to close. It is also the
   * same lease the recovery pass resolves its views from, so it costs no new
   * mechanism and no new copy of the frame.
   *
   * The raw buffer is the fallback for a frame delivered inline. `format` is
   * checked rather than assumed: a planar frame read as RGB would produce a crop
   * of noise that re-detects as nothing — a false SUPPRESSION, the one error
   * this path must never make.
   */
  private async encodeEvidenceCrop(
    frame: DecodedFrame,
    result: FrameResult,
    entry: EvidencePlanEntry,
  ): Promise<Buffer | null> {
    const fromLease = frame.frameRef
      ? await this.encodeEvidenceFromLease(frame.frameRef, entry)
      : null
    if (fromLease !== null) return fromLease
    const expectedBytes = result.width * result.height * 3
    if (frame.format !== 'rgb' || frame.data.byteLength < expectedBytes) return null
    try {
      const sharp = await getSharp()
      let pipeline = sharp(frame.data, {
        raw: { width: result.width, height: result.height, channels: 3 },
      }).extract({
        left: entry.rect.x,
        top: entry.rect.y,
        width: entry.rect.width,
        height: entry.rect.height,
      })
      if (entry.target.width !== entry.rect.width) {
        pipeline = pipeline.resize(entry.target.width, entry.target.height, { fit: 'fill' })
      }
      return await pipeline.jpeg({ quality: BIRTH_EVIDENCE_JPEG_QUALITY }).toBuffer()
    } catch {
      return null
    }
  }

  /** The evidence crop from the process-local lease, JPEG-encoded by the view. */
  private async encodeEvidenceFromLease(
    ref: FrameRef,
    entry: EvidencePlanEntry,
  ): Promise<Buffer | null> {
    const lease = localFrameRegistry.acquire(ref)
    if (!lease) return null
    let reason: 'success' | 'error' | 'drop' = 'error'
    try {
      const view = await lease.resolve({
        crop: {
          left: entry.rect.x,
          top: entry.rect.y,
          width: entry.rect.width,
          height: entry.rect.height,
        },
        // `stretch` is exact, not a distortion: `target` is derived from `rect`
        // by one scale factor, so the aspect is already the crop's own.
        content: { width: entry.target.width, height: entry.target.height },
        fit: 'stretch',
        format: 'jpeg',
      })
      if (view.kind !== 'view') {
        reason = 'drop'
        return null
      }
      reason = 'success'
      return Buffer.from(view.data)
    } catch {
      return null
    } finally {
      lease.release(reason)
    }
  }

  /**
   * State, per camera, what carrying the evidence cost over the window — and
   * drain it. The operator's acceptance condition for D379 is that the runner's
   * memory and the frame path do not grow beyond a declared budget, and a
   * budget nobody measures is an estimate.
   */
  private reportBirthEvidenceCost(deviceId: number): void {
    const cost = this.birthEvidenceCost.get(deviceId)
    if (!cost) return
    const now = Date.now()
    const lastAt = this.birthEvidenceReportedAt.get(deviceId) ?? 0
    if (lastAt !== 0 && now - lastAt < BIRTH_EVIDENCE_REPORT_INTERVAL_MS) return
    const windowMs = lastAt === 0 ? BIRTH_EVIDENCE_REPORT_INTERVAL_MS : now - lastAt
    this.birthEvidenceReportedAt.set(deviceId, now)
    this.ctx.logger.info('birth evidence carried', {
      tags: { deviceId },
      meta: {
        cut: cost.cut,
        failed: cost.failed,
        skippedNoPixels: cost.skippedNoPixels,
        kb: Math.round(cost.bytes / 1024),
        encodeMs: cost.encodeMs,
        meanKb: cost.cut > 0 ? Math.round(cost.bytes / cost.cut / 1024) : 0,
        meanEncodeMs: cost.cut > 0 ? Math.round(cost.encodeMs / cost.cut) : 0,
        windowMs,
      },
    })
    cost.cut = 0
    cost.failed = 0
    cost.skippedNoPixels = 0
    cost.bytes = 0
    cost.encodeMs = 0
  }

  /**
   * The v2 tracker's appearance descriptor (D683 §8.1), cut from the same
   * raster the birth evidence uses (lease first, inline RGB second). A frame
   * with no raster attaches nothing and is counted as `skippedNoPixels`.
   *
   * OFF by default (fix round 1, coordinator ruling 2026-09-30): appearance
   * is unproven cost until Task 23 calibrates it, so a disabled camera must
   * add NOTHING to the frame path — no crop, no resample, no descriptor.
   * `APPEARANCE_RESOLVES_AMBIGUITY_DEFAULT` is the SAME authority the v2
   * tracker's own default reads (`@camstack/types`, never a second flag that
   * could disagree with it — CLAUDE.md D62). Checked here, before any
   * per-camera bookkeeping, AND inside {@link attachAppearanceIfEnabled} —
   * one symbol, checked defensively in two frames, not two settings.
   */
  private async attachAppearance(
    deviceId: number,
    frame: DecodedFrame,
    result: FrameResult,
    novel: ReadonlySet<number>,
  ): Promise<FrameResult> {
    if (!APPEARANCE_RESOLVES_AMBIGUITY_DEFAULT) return result
    if (result.detections.length === 0) return result
    const cost = this.appearanceCost.get(deviceId) ?? {
      attached: 0,
      tooSmall: 0,
      failed: 0,
      skippedNoPixels: 0,
      skippedScope: 0,
      ms: 0,
    }
    this.appearanceCost.set(deviceId, cost)
    const inline =
      frame.format === 'rgb' && frame.data.byteLength >= result.width * result.height * 3
    if (frame.frameRef === undefined && !inline) {
      cost.skippedNoPixels += result.detections.filter((d) => d.kind === 'first-level').length
      this.reportAppearanceCost(deviceId)
      return result
    }
    const outcome = await attachAppearanceIfEnabled(
      APPEARANCE_RESOLVES_AMBIGUITY_DEFAULT,
      result,
      (crop) => this.readAppearanceView(frame, result, crop),
      {
        scope: APPEARANCE_SCOPE,
        isCandidate: (i) => novel.has(i) || overlapsSameClass(result.detections, i),
      },
      () => Date.now(),
    )
    this.foldAppearanceCost(cost, outcome.cost)
    this.reportAppearanceCost(deviceId)
    return outcome.result
  }

  private foldAppearanceCost(into: AppearanceCostTally, add: AppearanceAttachCost): void {
    into.attached += add.attached
    into.tooSmall += add.tooSmall
    into.failed += add.failed
    into.skippedScope += add.skippedScope
    into.ms += add.ms
  }

  /** A 16×32 RGB view of `crop`: the lease when there is one, else the inline buffer. */
  private async readAppearanceView(
    frame: DecodedFrame,
    result: FrameResult,
    crop: AppearanceCrop,
  ): Promise<RgbView | null> {
    if (frame.frameRef !== undefined) {
      const lease = localFrameRegistry.acquire(frame.frameRef)
      if (lease) {
        let reason: 'success' | 'error' | 'drop' = 'error'
        try {
          const view = await lease.resolve({
            crop,
            content: { width: APPEARANCE_VIEW.width, height: APPEARANCE_VIEW.height },
            fit: 'stretch',
            format: 'rgb',
          })
          if (view.kind !== 'view') {
            reason = 'drop'
            return null
          }
          if (view.data.byteLength !== APPEARANCE_VIEW.width * APPEARANCE_VIEW.height * 3) {
            reason = 'error'
            return null
          }
          reason = 'success'
          return {
            data: new Uint8Array(view.data),
            width: APPEARANCE_VIEW.width,
            height: APPEARANCE_VIEW.height,
          }
        } catch {
          return null
        } finally {
          lease.release(reason)
        }
      }
    }
    if (frame.format !== 'rgb' || frame.data.byteLength < result.width * result.height * 3)
      return null
    try {
      const sharp = await getSharp()
      const data = await sharp(frame.data, {
        raw: { width: result.width, height: result.height, channels: 3 },
      })
        .extract(crop)
        .resize(APPEARANCE_VIEW.width, APPEARANCE_VIEW.height, { fit: 'fill' })
        .raw()
        .toBuffer()
      return {
        data: new Uint8Array(data),
        width: APPEARANCE_VIEW.width,
        height: APPEARANCE_VIEW.height,
      }
    } catch {
      return null
    }
  }

  /**
   * State, per camera, what attaching the descriptor cost over the window —
   * and drain it (D683, mirrors {@link reportBirthEvidenceCost}). The cost
   * gate (Step 9) is measured offline; this line is what proves the shipped
   * runner matches the bench.
   */
  private reportAppearanceCost(deviceId: number): void {
    const cost = this.appearanceCost.get(deviceId)
    if (!cost) return
    const now = Date.now()
    const lastAt = this.appearanceReportedAt.get(deviceId) ?? 0
    if (lastAt !== 0 && now - lastAt < BIRTH_EVIDENCE_REPORT_INTERVAL_MS) return
    const windowMs = lastAt === 0 ? BIRTH_EVIDENCE_REPORT_INTERVAL_MS : now - lastAt
    this.appearanceReportedAt.set(deviceId, now)
    this.ctx.logger.info('appearance descriptors attached', {
      tags: { deviceId },
      meta: {
        attached: cost.attached,
        tooSmall: cost.tooSmall,
        failed: cost.failed,
        skippedNoPixels: cost.skippedNoPixels,
        skippedScope: cost.skippedScope,
        meanMs: cost.attached > 0 ? Number((cost.ms / cost.attached).toFixed(2)) : 0,
        scope: APPEARANCE_SCOPE,
        windowMs,
      },
    })
    cost.attached = 0
    cost.tooSmall = 0
    cost.failed = 0
    cost.skippedNoPixels = 0
    cost.skippedScope = 0
    cost.ms = 0
  }

  private async resolveNativeCropPixels(input: {
    handle: FrameHandle
    bbox: { x: number; y: number; w: number; h: number }
    maxWidth?: number
  }): Promise<{
    pixels: NativeCropPixels | null
    tier: NativeCropTier
    missReason: NativeCropMissReason | null
    /** The worker's own sentence for the miss; diagnostic only. */
    workerReason: string | undefined
    handleAgeMs: number | null
  }> {
    const b = input.bbox
    const isFullFrame = b.x <= 0.001 && b.y <= 0.001 && b.w >= 0.999 && b.h >= 0.999
    // A full-frame request with NO width cap is the post-analysis full-frame
    // RESOLVE (firstFrame / lastFrame / snapshot → `resolveFrame` bbox {0,0,1,1}):
    // serving it from the native surface would download the whole native frame
    // (4K…) only to hand back the detection raster, so it goes straight to the
    // RAM store below. A full-frame request WITH a `maxWidth` cap is the Design-B
    // native `keyFrame` (maxWidth 1920) — it MUST route through the native
    // surface, where the worker downloads ONLY a bounded ≤maxWidth crop (never
    // the raw native frame). Skipping it here is exactly what pinned every stored
    // `keyFrame` at the ≤640 detection raster (native-crop quality regression).
    const isUnboundedFullFrame = isFullFrame && input.maxWidth === undefined
    // 1) Native-resolution crop from the decode worker's retained native surface
    //    — the quality path. Serves a tracked-object ROI AND the bounded
    //    full-frame native `keyFrame`; skipped only for the unbounded full-frame
    //    resolve above.
    let nativeResult: NativeCropPixels | null = null
    // WHY this miss happened — the caller can only see `null`, but there are
    // three different failures behind it with three different fixes (registry
    // LRU evicted the entry / the worker's own lease is gone / the ROI came
    // back empty). Instrumented 2026-07-30: the subject-crop miss rate was
    // 22% steady-state with no way to tell them apart.
    let missReason: NativeCropMissReason | null = null
    let handleAgeMs: number | null = null
    /** The camera the lookup attributed the handle to, live or expired. */
    let deviceIdForMiss: number | null = null
    // The WORKER's own account of the miss. `worker-lease-gone` is one wire
    // word over four different failures — nothing retained for the frame, a
    // rectangle no tile contains, retention switched off, a cut that outran its
    // encode — and until 2026-09-07 the only place that distinction survived
    // was an untagged `debug` line, so a per-camera query returned misses and
    // no reasons. Diagnostic only: nothing branches on this text.
    let workerReason: string | undefined
    if (!isUnboundedFullFrame) {
      // The registry applies the AGE bound before anything crosses a process
      // boundary (ADR-0419): an `expired` handle is refused here, so the
      // doomed worker round trip that produced 332 `worker-lease-gone` lines
      // in 54 minutes does not happen at all.
      const found = this.nativeCropRegistry.lookup(input.handle)
      handleAgeMs = found.kind === 'unknown' ? null : found.ageMs
      deviceIdForMiss = found.kind === 'unknown' ? null : found.deviceId
      if (found.kind === 'live') {
        const attempt = await found.request(input.bbox, input.maxWidth)
        if (attempt.kind === 'crop') {
          nativeResult = {
            bytes: attempt.crop.bytes,
            width: attempt.crop.width,
            height: attempt.crop.height,
            ...(attempt.crop.source ? { source: attempt.crop.source } : {}),
          }
        } else {
          missReason = 'worker-lease-gone'
          workerReason = attempt.workerReason
        }
      } else if (found.kind === 'expired') {
        missReason = 'handle-expired'
      } else {
        missReason = 'no-registry-entry'
      }
      if (missReason !== null) {
        const tierOnMiss = resolveNativeCropSource(isFullFrame, false)
        const fields = {
          tags: {
            deviceId: deviceIdForMiss ?? this.nativeCropRegistry.deviceIdFor(input.handle) ?? -1,
          },
          meta: {
            reason: missReason,
            // What the CALLER actually gets: `miss` means it is handed nothing
            // and the work is lost; `ram-fullframe` means the honest lower-res
            // tier covered for it and only the quality dropped.
            servedTier: tierOnMiss,
            handle: `${input.handle.shmId}#${input.handle.slot}#${input.handle.seq}`,
            handleNodeId: input.handle.nodeId,
            // The two numbers that decide the fix: how long the handle had
            // been alive when the crop was asked for, and how full the
            // node-wide registry is at that instant.
            // Age since the handle was REGISTERED (same process, same clock —
            // `FrameHandle.pts` is process-local and must never be correlated).
            // This is the number that says whether the window is too small or
            // the request is simply too late.
            handleAgeMs,
            registrySize: this.nativeCropRegistry.size,
            registryCap: DEFAULT_NATIVE_CROP_REGISTRY_CAP,
            // The worker's OWN sentence, on the `deviceId`-tagged line rather
            // than on an untagged debug one. This is what turns "hall missed
            // 1 102 times" into "hall missed 1 102 times, and here is which
            // of the four failures each was".
            ...(workerReason !== undefined ? { workerReason } : {}),
          },
        }
        // A REFUSAL and a MISS are different events and must not share a
        // message (ADR-0419). A miss says the frame was gone when we asked; a
        // refusal says we declined to ask, because the handle is past the
        // lease age bound and the answer could only have been a miss. Sharing
        // one word is how 332 lines in 54 minutes read as one number and the
        // next person re-measured it: `handle-expired` is a request that
        // arrived too late, and no cap size can ever change that.
        const message =
          missReason === 'handle-expired'
            ? 'native crop refused — the handle is past the lease age bound'
            : 'native crop miss'
        const withBound =
          missReason === 'handle-expired'
            ? {
                ...fields,
                meta: { ...fields.meta, leaseMaxAgeMs: NATIVE_CROP_LEASE_MAX_AGE_MS },
              }
            : fields
        // The caller's half of this pair (`native subject crop miss`, carrying
        // the round-trip) has always been a warn. Leaving this half at debug is
        // why the designed diagnostic pair was never once visible together in
        // production — a `null` was attributable to nothing.
        if (tierOnMiss === 'miss') this.ctx.logger.warn(message, withBound)
        else this.ctx.logger.debug(message, withBound)
      }
    }
    // Tag the served result with the resolved tier so a quality-sensitive
    // consumer (native keyFrame) can reject the ≤640 RAM fallback (S1).
    return {
      pixels: nativeResult,
      tier: resolveNativeCropSource(isFullFrame, nativeResult !== null),
      missReason,
      handleAgeMs,
      workerReason,
    }
  }

  /**
   * Shape a resolved RGB crop into a `getNativeCrop` result. Raw path (default):
   * return the zero-copy `bytes` — same-node callers encode locally. Compressed
   * path (`encodeJpeg`, the CROSS-NODE case): encode to JPEG in-process, on the
   * OWNING node, and return `jpeg` (base64) with NO `bytes` — the payload then
   * fits Moleculer's `maxPacketSize` and no raw pixels cross the process
   * boundary (CLAUDE.md invariant #21). On an encode failure the crop is a miss
   * (`null`) — the caller retries — never a silent raw-RGB cross-node fallback.
   */
  private async encodeNativeCropResult(
    crop: NativeCropPixels,
    tier: 'native' | 'ram-fullframe',
    encodeJpeg: boolean | undefined,
    acceptJpegBytes?: boolean,
  ): Promise<{
    bytes?: Uint8Array
    jpeg?: string
    jpegBytes?: Uint8Array
    width: number
    height: number
    tier: 'native' | 'ram-fullframe'
  } | null> {
    const alreadyJpeg =
      crop.bytes.byteLength >= 2 && crop.bytes[0] === 0xff && crop.bytes[1] === 0xd8
    if (alreadyJpeg) {
      const encoded = encodeCrossNodeCrop({ jpeg: crop.bytes, acceptBytes: acceptJpegBytes })
      if (!encoded) return null
      return { ...encoded, width: crop.width, height: crop.height, tier }
    }
    if (encodeJpeg !== true) {
      return { bytes: crop.bytes, width: crop.width, height: crop.height, tier }
    }
    try {
      const sharp = await getSharp()
      const jpeg = await sharp(Buffer.from(crop.bytes), {
        raw: { width: crop.width, height: crop.height, channels: 3 },
      })
        .jpeg({ quality: 90 })
        .toBuffer()
      const encoded = encodeCrossNodeCrop({
        jpeg,
        bytes: crop.bytes,
        acceptBytes: acceptJpegBytes,
      })
      if (!encoded) return null
      return { ...encoded, width: crop.width, height: crop.height, tier }
    } catch (err) {
      this.ctx.logger.warn('getNativeCrop: cross-node JPEG encode failed', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
      return null
    }
  }

  /**
   * Two-plane design: run the DETAIL subtree (crop children) for a single
   * tracked detection. Delegates the algorithm to the deps-injected pure
   * function in {@link runDetailSubtreeImpl} — this method only wires the
   * real deps: the attach config's step tree (+ the catalog, for the
   * `inputClasses` match), the SAME internal native-crop lease path
   * `getNativeCrop` uses above (no `ctx.api` round-trip — we're already in
   * the frame's owning process), and the node-local `pipelineExecutor`.
   */
  async runDetailSubtree(input: RunDetailSubtreeInput): Promise<RunDetailSubtreeResult | null> {
    // Refresh the cluster crop convention BEFORE the derivation runs (TTL-
    // cached, so this is a no-op on all but one call a minute). `current()` is
    // then synchronous for the whole dispatch — one convention per dispatch,
    // never two halves of one crop cut to different values.
    const convention = await this.cropConvention.refresh(this.ctxIfReady?.api)
    await this.customModels.refresh(this.ctxIfReady?.api)
    const outcome = await runDetailSubtreeImpl(
      {
        resolveChildSteps: (deviceId, parentClassName, filter) =>
          this.resolveDetailChildSteps(deviceId, parentClassName, filter),
        getNativeCrop: (deviceId, handle, paddedBbox) =>
          this.getNativeCropForDetail(deviceId, handle, paddedBbox),
        runPipeline: (steps, imageJpeg, deviceId, deviceKey, nativeCropRef, suppliedRoot) =>
          this.runDetailPipeline(
            steps,
            imageJpeg,
            deviceId,
            deviceKey,
            nativeCropRef,
            suppliedRoot,
          ),
        placeStep: (deviceId, step) => this.placeDetailStepForCamera(deviceId, step),
        resolveCropConvention: () => convention,
        logger: this.detailSubtreeLogger(),
        recordFaceOutsideParent: (drop) => this.faceOutsideParentLog.record(drop),
      },
      input,
    )
    // The not-attached refusal crosses the wire as a MARKER ERROR, not a result
    // field: the cap output schema (`z.object({ details }).nullable()`) is
    // parsed on the hub route and Zod strips unknown keys, so a new field
    // cannot survive without a `@camstack/types` + codegen + server-train
    // change. The dispatcher recognises the marker and stops its crop ladder
    // instead of burning the two doomed fallback RPCs. See detail-park.ts.
    if (outcome !== null && isDetailNotAttachedRefusal(outcome)) {
      throw buildDetailNotAttachedError(input.deviceId)
    }
    // Same wire shape for the handle refusal: final for the handle, so the
    // dispatcher must retire it rather than re-ask each tick (D688).
    if (outcome !== null && isDetailHandleExpiredRefusal(outcome)) {
      throw buildDetailHandleExpiredError(input.deviceId, outcome.handleAgeMs)
    }
    return outcome
  }

  /**
   * Stateless single-step execution — no attach, no handle, no device
   * affinity. Delegates the decision table (catalog lookup, MODEL PIN
   * servability, crop, dispatch) to the deps-injected pure function in
   * {@link runStatelessStepImpl}; this method only wires the real deps.
   *
   * Note what is NOT wired, deliberately: no `resolveChildSteps` (the step
   * comes from the catalog, not from an attachment) and no `deviceKey` /
   * device jump (the jump roster is part of the attach config). The step runs
   * on the node's default engine, which is exactly the engine
   * `executionFormat` reports — so the servability check and the dispatch
   * cannot disagree about which format was verified.
   */
  // ── Node benchmark measurement (D791) ─────────────────────────────

  private nodeBenchHost: NodeBenchHost | null = null

  private nodeBench(): NodeBenchHost {
    this.nodeBenchHost ??= createNodeBenchHost({
      nodeId: this.nodeId,
      ctx: () => this.ctx,
      activeCameraIds: () =>
        (this.runner?.getAllCameraMetrics() ?? [])
          .filter((m) => m.phase !== 'idle')
          .map((m) => m.deviceId),
      pipelineVersion: null,
    })
    return this.nodeBenchHost
  }

  async startNodeBench(input: NodeBenchRunnerInputRaw): Promise<{ accepted: true; runId: string }> {
    return this.nodeBench().start(input)
  }

  async getNodeBenchStatus(input: { runId: string }): Promise<NodeBenchRunnerStatus | null> {
    return this.nodeBench().status(input.runId)
  }

  async abortNodeBench(input: { runId: string }): Promise<{ aborted: boolean }> {
    return this.nodeBench().abort(input.runId)
  }

  async runStatelessStep(input: RunStatelessStepInput): Promise<RunStatelessStepResult> {
    // Same as the detail plane: refresh the cluster convention BEFORE the
    // derivation, then hold it synchronous for the whole call.
    const convention = await this.cropConvention.refresh(this.ctxIfReady?.api)
    return runStatelessStepImpl(
      {
        nodeId: this.nodeId,
        lookupStep: (stepId) => tryGetStepDefinition(stepId),
        executionFormat: () => this.resolveNodeExecutionFormat(),
        resolveCropConvention: () => convention,
        runPipeline: (steps, imageJpeg, sourceDeviceId) =>
          this.runStatelessPipeline(steps, imageJpeg, sourceDeviceId),
        logger: this.detailSubtreeLogger(),
      },
      input,
    )
  }

  /**
   * Re-read the labels the `pipeline stats` lines carry (D463).
   *
   * Each half is read INDEPENDENTLY and a failure omits only its own field:
   * an engine that will not answer must not also erase the model list. Both
   * reads are best-effort by design — this is a label on a telemetry line, and
   * it must never be able to take the runner down or to log a storm. A failure
   * is logged once per refresh at `debug`, deliberately: the ABSENCE of the
   * field in the line is the signal, and the hub writes `info`.
   */
  private async refreshRuntimeInfo(): Promise<void> {
    const ctx = this.ctxIfReady
    const sampler = this.runner?.timingSampler
    if (!ctx || sampler === undefined || sampler === null) {
      this.noteRuntimeInfoFailure(NO_CONTEXT_FAILURE)
      return
    }
    // What is RESIDENT, not what was configured (`runtime-labels.ts`), and
    // in THIS node's executor — the co-tenant provider of the `detection`
    // process, never the cluster-active singleton: unpinned, that was the hub,
    // and every agent printed the hub's pools (`local-resident-engines.ts`).
    // biome-ignore lint/plugin: LOCAL on purpose — the question is "this process's executor"; ctx.api routes the singleton to the hub (pinned, it answered an empty list)
    const read = await readLocalResidentEngines(ctx.capabilities)
    const engines: readonly ResidentEngine[] | null = read.kind === 'read' ? read.engines : null
    const failure: string | null = read.kind === 'failed' ? read.error : null
    this.noteRuntimeInfoFailure(failure)
    sampler.runtimeInfo = { ...sampler.runtimeInfo, ...buildRuntimeLabels(engines) }
  }

  /**
   * Log a runtime-label failure at its TRANSITION, and at `warn`.
   *
   * This branch first shipped at `debug`, on the argument that the absent field
   * in the line was signal enough. It was not: within the hour `agent-a`
   * was the one node still logging `pipelineRuntime=null` and there was no way
   * to tell "this node has no engine" from "the read threw", because the hub
   * writes `info` and the agent forwards to it. That is D438's blind
   * instrument for the third time. Logging the transition rather than every
   * refresh is what keeps it from becoming a storm.
   */
  private noteRuntimeInfoFailure(failure: string | null): void {
    if (failure === this.lastRuntimeInfoFailure) return
    if (failure === null) this.ctxIfReady?.logger.info('runtime labels: readable again')
    else {
      this.ctxIfReady?.logger.warn(
        'runtime labels unreadable — this node cannot name its engines',
        {
          meta: { error: failure },
        },
      )
    }
    this.lastRuntimeInfoFailure = failure
  }

  /**
   * The model format this node dispatches on when no `deviceKey` is given —
   * its selected engine's format. `null` on any failure, which the caller
   * turns into a refusal rather than a guess: a model pin that cannot be
   * checked is a substitution waiting to happen.
   */
  private async resolveNodeExecutionFormat(): Promise<ModelFormat | null> {
    const api = this.ctxIfReady?.api
    if (!api) return null
    try {
      const engine = await api.pipelineExecutor.getSelectedEngine.query()
      return engine.format
    } catch (err: unknown) {
      this.ctxIfReady?.logger.warn(
        'runStatelessStep: could not read this node selected engine — refusing rather than guessing a format',
        { meta: { error: errMsg(err) } },
      )
      return null
    }
  }

  /**
   * Real `runPipeline` dep for the stateless path: node-local
   * `pipelineExecutor.runPipeline` on the `'full'` plane with NO `deviceKey`.
   *
   * `deviceId` is passed so the executor's own gate/substitution lines are
   * tagged with the source camera. It is a routing hint on other transports,
   * but not here: the executor is co-located in the `detection` group, so
   * `localProviderLink` answers in-process before any router sees it — the
   * call cannot leave the node this one was pinned to.
   */
  private async runStatelessPipeline(
    steps: readonly PipelineStepInputOutput[],
    imageJpeg: Buffer,
    sourceDeviceId: number,
  ): Promise<FrameResult | null> {
    const api = this.ctxIfReady?.api
    if (!api) return null
    return api.pipelineExecutor.runPipeline.mutate({
      steps: [...steps],
      image: new Uint8Array(imageJpeg),
      deviceId: sourceDeviceId,
      plane: 'full',
    })
  }

  /**
   * The cluster-wide detail-crop convention — read from the orchestrator's
   * global settings, NOT from the attach config. See `crop-convention-source.ts`
   * for why eleven attach builders make the attach config the wrong carrier.
   */
  /**
   * The custom-model registry, merged into the catalog the device jump judges
   * (D657): a custom model with a tflite build, pinned on a Coral, runs there.
   * Refreshed on the async boundaries (`runInference`, `runDetailSubtree`),
   * read synchronously by the placement.
   */
  private readonly customModels = new CustomModelCatalog({
    warn: (message, extras) => this.ctxIfReady?.logger.warn(message, extras),
  })

  /**
   * Per camera, the root-supply plan (D730) and the announce derived from it,
   * keyed on the two inputs it reads: the attach tree and the custom-model
   * snapshot (a plus catalog root is a custom model), plus the elected device
   * whose default an unpinned root runs. Recomputed when any changes — at
   * most once per catalog refresh.
   */
  private readonly rootSupplyCache = new Map<
    number,
    {
      readonly steps: readonly PipelineStepInputOutput[]
      readonly deviceKey: string | undefined
      readonly byStep: ReturnType<CustomModelCatalog['current']>
      readonly plan: RootSupplyPlan
      readonly announces: readonly DetailStepAnnounce[]
    }
  >()

  /**
   * The camera's root-supply plan. One INFO per (camera, step) when a step
   * BECOMES supplied by the root — a COCO root now stops dispatching the
   * animal and vehicle classifiers by default, and that must be readable per
   * camera rather than inferred from a missing dispatch (D391).
   */
  private rootSupplyPlanFor(
    deviceId: number,
    steps: readonly PipelineStepInputOutput[],
    deviceKey: string | undefined,
  ): RootSupplyPlan {
    const byStep = this.customModels.current()
    const cached = this.rootSupplyCache.get(deviceId)
    if (
      cached !== undefined &&
      cached.steps === steps &&
      cached.deviceKey === deviceKey &&
      cached.byStep === byStep
    ) {
      return cached.plan
    }
    const plan = planRootSupplies(
      steps,
      (stepId, modelId) =>
        this.customModels.stepDefinition(stepId)?.models.find((m) => m.id === modelId),
      deviceKey,
    )
    const announces = deriveDetailSteps(steps, plan)
    this.rootSupplyCache.set(deviceId, { steps, deviceKey, byStep, plan, announces })
    for (const stepId of newlySuppliedSteps(cached?.plan, plan)) {
      const state = plan.states.get(stepId)
      this.ctxIfReady?.logger.info(
        'root model supplies a pipeline step — the step is not dispatched',
        {
          tags: { deviceId },
          meta: {
            stepId,
            rootModelId: plan.rootModelId ?? null,
            kind: state?.supply?.kind ?? null,
            uncovered: state?.supply?.kind === 'label' ? state.supply.uncovered : [],
          },
        },
      )
    }
    return plan
  }

  private readonly cropConvention = new CropConventionSource({
    logger: {
      info: (message, extras) => this.ctxIfReady?.logger.info(message, extras),
      warn: (message, extras) => this.ctxIfReady?.logger.warn(message, extras),
    },
  })

  /**
   * The cluster-wide native-frame LEASE knobs (TTL / RAM ceiling / demand
   * window) — read from the orchestrator's global settings for the same reason
   * as the crop convention above, and injected into each decode worker at fork
   * time. See `native-lease-settings-source.ts`.
   */
  private readonly nativeLease = new NativeLeaseSettingsSource({
    logger: {
      info: (message, extras) => this.ctxIfReady?.logger.info(message, extras),
      warn: (message, extras) => this.ctxIfReady?.logger.warn(message, extras),
    },
  })

  /**
   * Fork a decode worker. Used in place of a bare `forkDecodeWorker` reference
   * at every session-decode spawn site so the cost registry is never forgotten.
   *
   * The fork carries NO configuration: since D453 the lease knobs travel on the
   * `start` message ({@link resolveSessionLeaseKnobs}), not in the child's
   * environment. A worker is therefore forkable before anyone knows which
   * camera it will serve.
   */
  private readonly forkDecodeWorkerWithLease = (source: VideoFrameSource): ForkedChildLike =>
    this.decodeWorkers.fork(source)

  /**
   * The lease knobs for the session that is about to start — `setting > env >
   * default`, resolved HERE because this process is the one that carries the
   * Zod schemas (the child no longer does; D453).
   *
   * Read per session, so a changed operator setting reaches NEW sessions and
   * leaves running ones alone (a live session would have to be re-dialled).
   */
  private readonly resolveSessionLeaseKnobs = (): WorkerLeaseKnobs =>
    resolveNativeLeaseKnobs(process.env, this.nativeLease.current())

  /**
   * The decode hwaccel backends this node's kernel resolver offers (D926),
   * refreshed on the acquire leg with the lease knobs and read when `start` is
   * sent. A node whose libva cannot initialise the driver offers no vaapi/qsv,
   * so its session workers never try them.
   */
  private readonly sessionHwaccel = new SessionHwaccelSource()
  private readonly resolveSessionHwaccel = (): SessionHwaccelOffer => this.sessionHwaccel.current()

  /**
   * Refresh the lease knobs before a decode worker is spawned. Awaited on the
   * `acquire` leg of `startGuardedSessionDecode` (which always completes before
   * `startPump` forks), so the spawn sees a value at most one TTL stale rather
   * than whatever a background refresh happened to have landed.
   * `NativeLeaseSettingsSource.refresh` swallows its own failures, so this can
   * never break a dial.
   */
  private async refreshNativeLeaseSettings(): Promise<void> {
    await this.nativeLease.refresh(this.ctxIfReady?.api)
    // The admission ceiling is DERIVED from these knobs, so it has to move with
    // them. Same lifetime rule as `resize`: running sessions are untouched, the
    // next admission is measured against the new footprint.
    this.liveWorkers?.resizeFootprint(decodeWorkerFootprintMb(this.nativeLease.current()))
    this.runner?.setMaxInflightPerCamera(maxInflightPerCamera(this.nativeLease.current()))
    await this.nodeLimits?.refresh(this.ctxIfReady?.api)
    this.applyNodeDecodeLimits('lease-refresh')
  }

  private nodeLimits: NodeDecodeLimitsSource | null = null
  private lastAppliedDecodeLimits: NodeDecodeLimits | null = null

  /**
   * The budget and worker cap THIS node runs under (D365): its own agent
   * setting, else the cluster value the operator moved, else a share of its
   * RAM. One resolver for construction, the lease refresh and a settings
   * change — computing it in two places is how the count and the budget
   * drifted apart before.
   */
  private resolvedNodeDecodeLimits(): NodeDecodeLimits {
    // Prefer this addon's per-node schema fields (Engine tab); fall back to
    // orchestrator agent-settings while older overrides migrate (D365).
    const fromSchema = {
      ...(typeof this.config.decodeBudgetMb === 'number'
        ? { decodeBudgetMb: this.config.decodeBudgetMb }
        : {}),
      ...(typeof this.config.decodeMaxLiveWorkers === 'number'
        ? { maxLiveDecodeWorkers: this.config.decodeMaxLiveWorkers }
        : {}),
    }
    const fromAgent = this.nodeLimits?.current() ?? {}
    return resolveNodeDecodeLimits({
      clusterBudgetMb: this.config.nodeDecodeBudgetMb,
      clusterMaxWorkers: this.config.maxLiveDecodeWorkers,
      defaultBudgetMb: DEFAULT_CONFIG.nodeDecodeBudgetMb,
      defaultMaxWorkers: DEFAULT_CONFIG.maxLiveDecodeWorkers,
      node: {
        decodeBudgetMb: fromSchema.decodeBudgetMb ?? fromAgent.decodeBudgetMb,
        maxLiveDecodeWorkers: fromSchema.maxLiveDecodeWorkers ?? fromAgent.maxLiveDecodeWorkers,
      },
      totalMemMb: Math.round(os.totalmem() / 1_048_576),
    })
  }

  /** Resize the admission to the resolved limits; one info line per change. */
  private applyNodeDecodeLimits(reason: 'lease-refresh' | 'settings'): void {
    const limits = this.resolvedNodeDecodeLimits()
    const last = this.lastAppliedDecodeLimits
    this.liveWorkers?.resize(limits.maxWorkers)
    this.liveWorkers?.resizeBudget(limits.budgetMb)
    if (
      last !== null &&
      last.budgetMb === limits.budgetMb &&
      last.maxWorkers === limits.maxWorkers &&
      last.budgetSource === limits.budgetSource
    )
      return
    this.lastAppliedDecodeLimits = limits
    this.ctxIfReady?.logger.info('node decode limits in force', {
      meta: {
        reason,
        budgetMb: limits.budgetMb,
        budgetSource: limits.budgetSource,
        maxWorkers: limits.maxWorkers,
        maxWorkersSource: limits.maxWorkersSource,
        totalMemMb: Math.round(os.totalmem() / 1_048_576),
        decodeCeilingInForce: this.liveWorkers?.ceiling,
      },
    })
  }

  /** D662: faces the detail plane's geometry guard dropped, one line per camera per minute. */
  private readonly faceOutsideParentLog = new FaceOutsideParentLog({
    info: (message, extras) => this.ctxIfReady?.logger.info(message, extras),
    now: () => Date.now(),
    intervalMs: FACE_OUTSIDE_PARENT_LOG_INTERVAL_MS,
    schedule: (flush, delayMs) => {
      setTimeout(flush, delayMs).unref()
    },
  })

  /** A warn sink that survives a not-yet-ready ctx (boot-order dispatches). */
  private detailSubtreeLogger(): { warn: IScopedLogger['warn'] } {
    return { warn: (message, extras) => this.ctxIfReady?.logger.warn(message, extras) }
  }

  /**
   * Step-tree device jump — place one enrichment subtree on a same-node
   * inference device ({@link placeDetailStep}). AUTO-jumps only when the
   * camera's elected device cannot run the subtree (its format has no build);
   * an operator `step.jumpDeviceKey` overrides. A jumped subtree runs with the
   * TARGET device's provisioning carried on the roster (D650), never the
   * elected device's. `deviceKey: undefined` ⇒ the runner's per-camera default
   * pool (no elected device).
   *
   * Logs the jump ONCE per (camera, step, target), and — when NO enabled device
   * on the node can run the subtree — a LOUD warn once per (camera, step).
   */
  private placeDetailStepForCamera(
    deviceId: number,
    step: PipelineStepInputOutput,
  ): DetailStepPlacement {
    const config = this.attached.get(deviceId)?.config
    const placement = this.placementOf(config, step, this.perDeviceAttachedCounts())
    const decision = placement.decision
    if (decision?.kind === 'no-candidate') {
      this.warnStepHasNoRunnableDevice(deviceId, step.addonId, decision.deviceKey)
    } else if (decision?.kind === 'jumped' && config?.deviceKey) {
      this.logStepJumped(deviceId, config.deviceKey, decision, placement)
    }
    return placement
  }

  /**
   * Where one detail subtree of this camera runs — the ONE decision both the
   * detail plane (which dispatches it) and the frame plane (which decides what
   * the elected pool pre-warms, D657) read. Pure: nothing is logged here.
   */
  private placementOf(
    config: RunnerCameraConfig | undefined,
    step: PipelineStepInputOutput,
    attachedByKey: ReadonlyMap<string, number>,
  ): DetailStepPlacement {
    return placeDetailStep({
      step,
      effectiveDeviceKey: config?.deviceKey,
      roster: config?.inferenceDevices,
      attachedByKey,
      // The static catalog MERGED with the operator's custom models — the
      // catalog the orchestrator and the executor judge too (D657).
      getStepDef: this.customModels.stepDefinition,
    })
  }

  /**
   * The tree this camera's frame-plane dispatch carries (D657): a detail
   * subtree the placement sends to another device (or to none) is left out,
   * so its model is never loaded on the elected pool — it loads on its
   * target, with the target's provisioning, when the detail plane dispatches
   * it there. Said once per (camera, elected device, set left out).
   */
  private stepsForElectedPoolOf(
    deviceId: number,
    steps: readonly PipelineStepInputOutput[],
  ): readonly PipelineStepInputOutput[] {
    const config = this.attached.get(deviceId)?.config
    // Nothing to place between: no elected device, or a roster of one. Skip
    // the per-frame count of attached cameras and the placement walk.
    if (config?.deviceKey === undefined || (config.inferenceDevices?.length ?? 0) < 2) {
      this.noteElectedPoolDelegation(deviceId, undefined, [])
      return steps
    }
    const attachedByKey = this.perDeviceAttachedCounts()
    const result = stepsForElectedPool(steps, isDetailPlaneStepId, (step) =>
      this.placementOf(config, step, attachedByKey),
    )
    this.noteElectedPoolDelegation(deviceId, config.deviceKey, result.delegated)
    return result.delegated.length === 0 ? steps : result.steps
  }

  /**
   * Say once per STATE CHANGE which detail steps a camera's elected pool no
   * longer loads: a camera moving A → B → A says so again on A.
   */
  private noteElectedPoolDelegation(
    deviceId: number,
    electedDeviceKey: string | undefined,
    delegated: readonly string[],
  ): void {
    const state = `${electedDeviceKey ?? ''}|${delegated.join(',')}`
    if (this.electedPoolDelegationState.get(deviceId) === state) return
    this.electedPoolDelegationState.set(deviceId, state)
    if (delegated.length === 0) return
    this.ctx?.logger.info('detail steps not loaded on the elected pool — they run elsewhere', {
      tags: { deviceId },
      meta: { electedDeviceKey: electedDeviceKey ?? null, steps: [...delegated] },
    })
  }

  /** Per camera, the last (elected device, steps left out) state that was logged. */
  private readonly electedPoolDelegationState = new Map<number, string>()

  /** `${deviceId}:${addonId}:${target}` triples whose jump has been logged. */
  private readonly loggedStepJumps = new Set<string>()

  private logStepJumped(
    deviceId: number,
    electedDeviceKey: string,
    decision: Extract<ResolveStepDeviceResult, { kind: 'jumped' }>,
    placement: DetailStepPlacement,
  ): void {
    const step = placement.step
    const key = `${deviceId}:${step.addonId}:${decision.deviceKey}`
    if (this.loggedStepJumps.has(key)) return
    this.loggedStepJumps.add(key)
    this.ctx?.logger.info('enrichment step runs on another device of this node', {
      tags: { deviceId },
      meta: {
        step: step.addonId,
        electedDeviceKey,
        targetDeviceKey: decision.deviceKey,
        reason: decision.reason,
        // true: re-provisioned from the target's roster entry (D650), and
        // `modelId` is what the target runs (null = its format default).
        // false: the roster carried no provisioning — the step runs as sent,
        // with the ELECTED device's model and settings.
        provisioned: placement.provisioned,
        modelId: step.modelId ?? null,
      },
    })
  }

  /** Live attached-camera count per inference `deviceKey` on this runner. */
  private perDeviceAttachedCounts(): Map<string, number> {
    const counts = new Map<string, number>()
    for (const cam of this.attached.values()) {
      const key = cam.config.deviceKey
      if (key === undefined) continue
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    return counts
  }

  /** `${deviceId}:${addonId}` pairs already warned about a no-runnable-device step. */
  private readonly warnedNoJumpDevice = new Set<string>()

  private warnStepHasNoRunnableDevice(
    deviceId: number,
    addonId: string,
    effectiveDeviceKey: string,
  ): void {
    const key = `${deviceId}:${addonId}`
    if (this.warnedNoJumpDevice.has(key)) return
    this.warnedNoJumpDevice.add(key)
    this.ctx?.logger.warn(
      'enrichment step has no runnable inference device on this node — producing NO results for it',
      {
        tags: { deviceId },
        meta: {
          step: addonId,
          electedDeviceKey: effectiveDeviceKey,
          hint: 'the elected device format has no build of this step, and no enabled same-node device can run it — enable a compatible accelerator or add a jumpDeviceKey',
        },
      },
    )
  }

  /**
   * Real `resolveChildSteps` dep: `null` when the camera isn't attached
   * (matches the cap doc — "camera not attached" is a distinct case from
   * "attached but no matching child steps", which returns an empty array
   * and short-circuits inside {@link runDetailSubtreeImpl} the same way).
   */
  private resolveDetailChildSteps(
    deviceId: number,
    parentClassName: string,
    filter?: readonly string[],
  ): readonly PipelineStepInputOutput[] | null {
    const attachment = this.attached.get(deviceId)
    if (!attachment) {
      // A camera SOFT-detached within DETAIL_PARK_GRACE_MS answers from its
      // PARKED step tree: the post-analysis dispatcher keeps asking for up to
      // 30 s after the session closed (the durable-track TTL), and refusing
      // those asks left end-of-session person tracks permanently unembedded.
      const parked = this.freshParkedDetail(deviceId)
      if (!parked) return null
      if (!parked.steps) return []
      return findMatchingDetailSteps(parked.steps, parentClassName, tryGetStepDefinition, filter)
    }
    const steps = attachment.config.steps
    if (!steps) return []
    return findMatchingDetailSteps(steps, parentClassName, tryGetStepDefinition, filter)
  }

  /**
   * Real `getNativeCrop` dep: reuses the node-local {@link nativeCropRegistry}
   * lease (same path the `getNativeCrop` cap method above uses), encodes the
   * raw RGB crop to JPEG, and denormalizes `paddedBbox` back to frame-space
   * pixels for the `frameSpace` the caller maps result bboxes against.
   *
   * Returns the MISS REASON rather than a bare `null`. This is the only caller
   * that can carry it anywhere useful — the cap's return shape has no room for
   * it, and the detail plane's drop line is where an operator reads why an
   * enrichment dispatch produced nothing.
   */
  private async getNativeCropForDetail(
    _deviceId: number,
    handle: FrameHandle,
    paddedBbox: NormBbox,
  ): Promise<NativeCropFetch> {
    const resolved = await this.resolveNativeCropPixels({ handle, bbox: paddedBbox })
    if (resolved.pixels === null || resolved.tier !== 'native') {
      return {
        miss: resolved.missReason ?? 'worker-lease-gone',
        handleAgeMs: resolved.handleAgeMs,
        ...(resolved.workerReason !== undefined ? { workerReason: resolved.workerReason } : {}),
      }
    }
    // Same-process detail crop: encode to JPEG here (the runner encodes in one
    // place) — the crop never leaves this process, so this is just the
    // in-process encode the caller used to do by hand.
    const encoded = await this.encodeNativeCropResult(resolved.pixels, 'native', true, true)
    if (!encoded?.jpegBytes)
      return { miss: 'jpeg-encode-failed', handleAgeMs: resolved.handleAgeMs }
    return {
      jpeg: Buffer.from(encoded.jpegBytes),
      width: encoded.width,
      height: encoded.height,
      frameSpace: denormalizeRect(paddedBbox, handle.width, handle.height),
    }
  }

  /** Real `runPipeline` dep: node-local `pipelineExecutor.runPipeline` on the `'full'` plane. */
  private async runDetailPipeline(
    steps: readonly PipelineStepInputOutput[],
    imageJpeg: Buffer,
    deviceId: number,
    stepDeviceKey?: string,
    nativeCropRef?: NativeCropRef,
    suppliedRoot?: SuppliedRootOutput,
  ): Promise<FrameResult | null> {
    const api = this.ctxIfReady?.api
    if (!api) return null
    // Step-tree device jump (phase 1): the per-step resolved device wins; when
    // the resolver returned nothing, fall back to the camera's elected device
    // (T5 — a session otherwise stays pinned to one accelerator end-to-end).
    // A soft-detached camera keeps its elected device through the PARK: the
    // jump roster is gone with the attachment, but the elected key is not.
    const detailDeviceKey =
      stepDeviceKey ??
      this.attached.get(deviceId)?.config?.deviceKey ??
      this.freshParkedDetail(deviceId)?.deviceKey
    try {
      return await api.pipelineExecutor.runPipeline.mutate({
        steps: [...steps],
        image: new Uint8Array(imageJpeg),
        deviceId,
        ...(detailDeviceKey ? { deviceKey: detailDeviceKey } : {}),
        plane: 'full',
        // NATIVE child-crop path: forwarded ONLY when the parent crop came from
        // the frame's native surface — lets the executor re-cut leaf child ROIs
        // (plate-ocr, face-embedding) at native resolution (the plate-OCR fix).
        ...(nativeCropRef ? { nativeCropRef } : {}),
        ...(suppliedRoot ? { suppliedRoot } : {}),
      })
    } catch (err: unknown) {
      this.ctxIfReady?.logger.warn('runDetailSubtree: runPipeline failed', {
        tags: { deviceId },
        meta: { error: errMsg(err) },
      })
      return null
    }
  }

  /** Last unexpected detection-decode end per device — bounds the re-dial. */
  private readonly lastDecodeUnexpectedEndAt = new Map<number, number>()

  /**
   * The detection decode pump ended WITHOUT a teardown (worker death /
   * generator error) while the camera may still be attached. Previously this
   * zombied the session — phase stayed `active`, frames stopped, and nothing
   * re-dialed (the pre-fix Channel-closed runner crash used to mask it by
   * respawning the whole runner). Recovery, bounded:
   *  - first death: clean up the dead subscription and re-dial once (2s);
   *  - second death within 60s: give up re-dialing and DETACH — the
   *    orchestrator re-dispatches cleanly on the next motion/occupancy signal
   *    (the same recovery path validated manually on device 107).
   */
  private handleDetectionDecodeEnded(deviceId: number): void {
    const attachment = this.attached.get(deviceId)
    // Detached: nothing survives a detach any more (D453), so a worker that
    // died after one has already taken its resources with it.
    if (!attachment) return
    const log = this.ctx.logger.withTags({ deviceId })

    // Release the dead pump's resources (restream refcount, retention sink).
    attachment.detectionUnsubscribe?.()
    attachment.detectionUnsubscribe = null

    const now = Date.now()
    const last = this.lastDecodeUnexpectedEndAt.get(deviceId) ?? 0
    this.lastDecodeUnexpectedEndAt.set(deviceId, now)
    if (now - last < DETECTION_REDIAL_GIVEUP_WINDOW_MS) {
      log.warn(
        'detection decode died twice within the re-dial window — detaching for orchestrator re-dispatch',
      )
      this.detachInternal(deviceId)
      return
    }

    log.warn('detection decode ended unexpectedly while attached — re-dialing once')
    const redial = setTimeout(() => {
      const still = this.attached.get(deviceId)
      if (!still || still.detectionUnsubscribe !== null) return
      void this.subscribeDetectionFrames(still.config).then((unsub) => {
        if (!this.attached.has(deviceId)) {
          unsub?.()
          return
        }
        still.detectionUnsubscribe = unsub
      })
    }, DETECTION_REDIAL_DELAY_MS)
    redial.unref?.()
  }

  /**
   * Tear a camera down.
   *
   * `softDetach` is the {@link detachCamera} cap entry point (the
   * orchestrator's motion-cooldown teardown). It keeps the DETAIL step tree
   * parked — a config slice, no process, no CPU — so a track outliving this
   * session can still resolve its enrichment steps. It does NOT keep the decode
   * worker: since D453 every detach releases it, because a held worker went on
   * decoding at full rate for the whole window (see the note above
   * {@link AttachedCamera}). Every internal detach — an attach replacing a
   * stale config, a decode that died twice, shutdown — is hard on both counts.
   */
  /**
   * Park the detaching camera's detail-relevant config slice for the grace
   * window, replacing any previous park (older state would resolve a stale
   * step tree). The expiry timer mirrors {@link parkWarmDetectionDecode};
   * {@link freshParkedDetail} also expires lazily so a fired-late timer can
   * never extend the window.
   */
  private parkDetailState(deviceId: number, config: RunnerCameraConfig): void {
    this.dropParkedDetail(deviceId)
    const state: ParkedDetailState = {
      steps: config.steps,
      deviceKey: config.deviceKey,
      parkedAt: Date.now(),
    }
    const timer = setTimeout(() => {
      this.parkedDetail.delete(deviceId)
    }, DETAIL_PARK_GRACE_MS)
    timer.unref?.()
    this.parkedDetail.set(deviceId, { state, timer })
  }

  /** Drop a park now (hard detach, re-attach, shutdown) — timer included. */
  private dropParkedDetail(deviceId: number): void {
    const parked = this.parkedDetail.get(deviceId)
    if (!parked) return
    clearTimeout(parked.timer)
    this.parkedDetail.delete(deviceId)
  }

  /**
   * The parked detail state for `deviceId`, or `null` once the grace has
   * lapsed. Expiry is enforced HERE, not only by the timer: the window must be
   * bounded by the clock, never by timer-delivery luck — an unbounded park
   * would be the lease-TTL inflation D73 rejected, by another name.
   */
  private freshParkedDetail(deviceId: number): ParkedDetailState | null {
    const parked = this.parkedDetail.get(deviceId)
    if (!parked) return null
    if (!isParkedDetailFresh(parked.state, Date.now())) {
      this.dropParkedDetail(deviceId)
      return null
    }
    return parked.state
  }

  private detachInternal(deviceId: number, softDetach = false): void {
    const attachment = this.attached.get(deviceId)
    if (!attachment) return

    // Tear down any dynamic onboard-analyzer subscription + its timer
    // before clearing the attachment — order matters so the timer can't
    // fire and look up a no-longer-present attachment entry.
    this.clearOnboardAnalyzer(deviceId)

    attachment.motionUnsubscribe?.()
    attachment.detectionUnsubscribe?.()
    // SOFT detach: park the detail step tree so a track outliving this session
    // (post-analysis holds tracks 30 s past `lastSeen`) can still resolve its
    // enrichment steps and cut from whatever pixels remain. HARD detach: the
    // config is wrong or the process is going away — purge. See detail-park.ts.
    if (softDetach) {
      this.parkDetailState(deviceId, attachment.config)
    } else {
      this.dropParkedDetail(deviceId)
    }
    this.lastMotionFrameAt.delete(deviceId)
    this.lastDecodeUnexpectedEndAt.delete(deviceId)
    this.packageGovernor.forget(deviceId)
    this.packageGateSkips.delete(deviceId)
    this.rootSupplyCache.delete(deviceId)
    this.packageZoneUnionByDevice.delete(deviceId)
    this.packageZoneUnionAt.delete(deviceId)
    this.lastMotionNearPackageZone.delete(deviceId)
    this.motionRegions.forget(deviceId)
    this.lastRecoveryAt.delete(deviceId)
    this.recoveryStats.delete(deviceId)
    this.recoverySkips.delete(deviceId)
    // Reset the device-jump no-runnable-device warn de-dup for this camera so a
    // re-attach (config may have changed) can warn afresh.
    const warnPrefix = `${deviceId}:`
    for (const key of this.warnedNoJumpDevice) {
      if (key.startsWith(warnPrefix)) this.warnedNoJumpDevice.delete(key)
    }
    this.attached.delete(deviceId)
    this.electedPoolDelegationState.delete(deviceId)
    this.lastMotionAt.delete(deviceId)
    this.lastEmittedCameraMetrics.delete(deviceId)
    this.retention?.forgetDevice(deviceId)
    // The novelty memory and its cost tally are per camera, so a detach must
    // take them with it — otherwise a re-attached camera inherits boxes from a
    // scene it no longer sees and its first real births are read as "seen".
    this.birthNovelty.clearDevice(deviceId)
    this.birthEvidenceCost.delete(deviceId)
    this.birthEvidenceReportedAt.delete(deviceId)
    this.appearanceCost.delete(deviceId)
    this.appearanceReportedAt.delete(deviceId)

    this.runner?.unregisterCamera(deviceId)
    this.ctx?.logger.info('detachCamera', {
      tags: { deviceId },
      meta: { detailParked: this.parkedDetail.has(deviceId) },
    })
  }

  /**
   * Synchronously cancel the teardown timer and call the unsubscribe
   * handle for the dynamic onboard analyzer, if one is open. Safe to
   * call when no subscription exists.
   */
  private clearOnboardAnalyzer(deviceId: number): void {
    const timer = this.onboardAnalyzerTeardownTimers.get(deviceId)
    if (timer !== undefined) {
      clearTimeout(timer)
      this.onboardAnalyzerTeardownTimers.delete(deviceId)
    }
    const unsub = this.onboardAnalyzerSubs.get(deviceId)
    if (unsub !== undefined) {
      try {
        unsub()
      } catch {
        /* swallow — broker may already be gone */
      }
      this.onboardAnalyzerSubs.delete(deviceId)
    }
  }

  /**
   * Dynamic analyzer gate for onboard-motion cameras.
   *
   * Called from the `MotionOnMotionChanged` subscriber whenever
   * `source === 'onboard'`. Opens a `subscribeMotionFrames` subscription
   * the first time motion is detected (idempotent — a second `detected:true`
   * while the sub is already open is a no-op). Always re-arms the teardown
   * timer so the subscription stays open as long as motion events keep
   * arriving and tears down `motionCooldownMs` after the last event.
   *
   * No-op when:
   * - The camera is not currently attached.
   * - `shouldStartOnboardAnalyzer(config)` returns false (flag off or
   *   `motionSources` already includes `'analyzer'`).
   */
  private async handleOnboardMotionAnalyzer(deviceId: number, detected: boolean): Promise<void> {
    const attachment = this.attached.get(deviceId)
    if (!attachment) return

    const config = attachment.config
    if (!shouldStartOnboardAnalyzer(config)) return

    const log = this.ctx.logger.withTags({ deviceId })

    // Open the subscription on the first `detected:true` if not already open.
    if (detected && !this.onboardAnalyzerSubs.has(deviceId)) {
      // Sensor-triggered motion rides the detection decode (main stream) rather
      // than spinning a dedicated sub-stream gray decode — the sensor already
      // drove the camera ACTIVE, so a detection `rgb` decode is (about to be)
      // running; the analyzer derives its gray from it. See `subscribeMotionFrames`.
      const unsub = await this.subscribeMotionFrames(config, { sharedWithDetection: true })
      if (unsub) {
        this.onboardAnalyzerSubs.set(deviceId, unsub)
        log.debug('onboard-analyzer: opened motion-frame subscription (shared detection decode)')
      }
      // ⚠️ GATE (Epic C P2, found in Phase-1 final review): session-decode is
      // the only decode path, so subscribeMotionFrames → startMotionSessionDecode
      // returns a SYNCHRONOUS, always-non-null teardown (I3's guarded start
      // absorbs an async acquire failure in the background). So `unsub` is
      // truthy even if the restream never actually
      // acquired → this stored entry blocks re-subscribe, and a failed
      // acquire self-heals only after `motionCooldownMs` idles. Applies to
      // EVERY camera on this node whose `motionSources` includes `'onboard'`
      // whenever the runner-level setting is on (the default) — the shm
      // poller path retries internally; this one does not. MUST be closed
      // (guard reports acquire-failure so this can clear+retry, or acquire
      // retries with backoff) before this gate can be considered fully safe.
    }

    // (Re-)arm the teardown timer on every event — both true and false.
    // Onboard cameras may emit only `detected:true`; the cooldown timer
    // is the single closure path (matching the phase machine's design).
    const existing = this.onboardAnalyzerTeardownTimers.get(deviceId)
    if (existing !== undefined) clearTimeout(existing)

    const cooldownMs = config.motionCooldownMs
    const timer = setTimeout(() => {
      this.onboardAnalyzerTeardownTimers.delete(deviceId)
      const unsub = this.onboardAnalyzerSubs.get(deviceId)
      if (!unsub) return
      try {
        unsub()
      } catch {
        /* swallow */
      }
      this.onboardAnalyzerSubs.delete(deviceId)
      log.debug('onboard-analyzer: closed after motion cooldown', { meta: { cooldownMs } })
    }, cooldownMs)
    this.onboardAnalyzerTeardownTimers.set(deviceId, timer)
  }

  async getLocalLoad(): Promise<RunnerLocalLoad> {
    const metrics = this.runner?.getMetrics() ?? {
      activeCameras: 0,
      throttledCameras: 0,
      avgInferenceTimeMs: 0,
      queueDepth: 0,
    }
    const allCameraMetrics = this.runner?.getAllCameraMetrics() ?? []

    let activeCameras = 0
    let totalActualFps = 0
    for (const cm of allCameraMetrics) {
      if (cm.phase === 'active') activeCameras++
      totalActualFps += cm.actualFps
    }

    // Phase 4: hardware probe moved off the runner.
    //
    // In the stateless-pipeline model each camera declares its own
    // engine. L3 hardware-aware balancing now lives on the orchestrator,
    // which knows `pipelines[deviceId].engine` and can match against
    // `nodes.topology.availableEngines` directly (spec Phase 3 extends
    // topology; consumed by the balancer once Phase 8 lands). The runner
    // no longer calls `pipelineExecutor.getSelectedEngine` — that cap is
    // being removed and its legacy "one engine per node" assumption
    // doesn't fit multi-engine nodes.
    // Per-device live load (multi-device C4): the orchestrator's second
    // `balance()` pass — over a node's inference devices — weights on these
    // real per-pool session counts instead of guessing from its own ephemeral
    // session registry (audit F6).
    const devices = summarizeDeviceLoad(
      Array.from(this.attached.values(), (cam) => cam.config.deviceKey),
    )

    return {
      nodeId: this.nodeId,
      attachedCameras: this.attached.size,
      activeCameras,
      avgInferenceFps: totalActualFps,
      avgInferenceTimeMs: metrics.avgInferenceTimeMs,
      queueDepthTotal: metrics.queueDepth,
      devices,
      hardware: summarizeRunnerHardware(await this.resolveLocalHardware()),
      // D696: this runner never writes a camera's `motion` slice. The
      // orchestrator writes it only once every runner node says this.
      motionSliceWriter: 'orchestrator',
    }
  }

  /**
   * THIS node's accelerators, probed once from the local kernel resolver and
   * cached (the probe is deterministic per host, and `getLocalLoad` is polled).
   * A throwing/absent resolver caches nothing and reports "could not tell" so a
   * later poll retries.
   */
  private async resolveLocalHardware(): Promise<KernelInferenceHardware | null> {
    if (this.localHardware) return this.localHardware
    try {
      const hw = await this.ctx.kernel?.inferenceEngine?.resolveHardware()
      this.localHardware = hw ?? null
      return this.localHardware
    } catch (err) {
      this.ctx.logger.warn('local hardware probe failed — reporting no accelerator', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
      return null
    }
  }

  async getLocalMetrics(): Promise<RunnerLocalMetrics> {
    const m = this.runner?.getMetrics() ?? {
      activeCameras: 0,
      throttledCameras: 0,
      avgInferenceTimeMs: 0,
      queueDepth: 0,
    }
    this.retention?.syncResident()
    return {
      nodeId: this.nodeId,
      ...m,
      frameLazy: this.frameLazy.snapshot(this.getLocalCameras()),
    }
  }

  async getCameraMetrics(input: { deviceId: number }): Promise<CameraMetrics | null> {
    return this.runner?.getCameraMetrics(input.deviceId) ?? null
  }

  getAllCameraMetrics(): ReadonlyArray<{ deviceId: number } & CameraMetrics> {
    return this.runner?.getAllCameraMetrics() ?? []
  }

  getLocalCameras(): readonly number[] {
    return [...this.attached.keys()]
  }

  /**
   * Look at one camera NOW, out of band — see the cap docblock for why the
   * periodic recheck cannot serve a question that was just asked.
   *
   * Every refusal is NAMED. The battery gate is the one that matters most: a
   * sleeping camera must not be woken by a burst (D173), and a caller told only
   * "no" cannot tell that protection from a bug.
   */
  requestOccupancyBurst(input: { deviceId: number; frames?: number; reason: string }): {
    started: boolean
    refusedBecause?: OccupancyBurstRefusal
  } {
    const { deviceId } = input
    const log = this.ctx.logger.child('occupancy-burst')
    if (!this.attached.has(deviceId)) {
      log.debug('out-of-band burst refused — camera not attached here', {
        tags: { deviceId },
        meta: { reason: input.reason },
      })
      return { started: false, refusedBecause: 'not-attached' }
    }
    // D173. The recheck tick has the same gate for the same reason: re-dialling
    // a camera that went to sleep because the event ended is exactly the
    // self-initiated activation the contract forbids.
    if (this.sleepingBatteryDevices.has(deviceId)) {
      log.debug('out-of-band burst refused — battery camera is sleeping', {
        tags: { deviceId },
        meta: { reason: input.reason },
      })
      return { started: false, refusedBecause: 'battery-asleep' }
    }
    const phase = this.runner?.getPhase(deviceId)
    if (phase !== 'watching') {
      // An ACTIVE session is already decoding and inferring this camera at full
      // rate — a burst would add nothing and cost a second dial.
      log.debug('out-of-band burst refused — the camera is not watching', {
        tags: { deviceId },
        meta: { reason: input.reason, phase },
      })
      return { started: false, refusedBecause: 'not-watching' }
    }
    if (this.occupancyBurstInFlight.has(deviceId) || this.occupancyQueued.has(deviceId)) {
      return { started: false, refusedBecause: 'already-bursting' }
    }
    const frames = Math.max(1, Math.min(input.frames ?? 4, 10))
    log.info('out-of-band occupancy burst', {
      tags: { deviceId },
      meta: { reason: input.reason, frames },
    })
    this.enqueueOccupancyBurst(deviceId, frames)
    return { started: true }
  }

  // ── Internal: broker subscription wiring ─────────────────────────────

  /**
   * Thin delegator to the module-level {@link acquireSessionDecodeRestreamFrom}
   * (see its doc for the acquire behavior) — supplies this addon's `ctx.logger`.
   * Kept as a method so the two call sites need no change.
   */
  private async acquireSessionDecodeRestream(
    api: AddonApi,
    deviceId: number,
    streamId: string,
    tag: string,
    hostname?: string,
    ownerNodeId?: string,
    detectionIntent?: boolean,
  ): Promise<SessionDecodeRestream | null> {
    // Every session-decode spawn passes through here, and it is the ACQUIRE leg
    // of `startGuardedSessionDecode` — which always settles before `startPump`
    // forks the worker. Refreshing the lease knobs here is therefore the one
    // place that guarantees a fork sees a current value, without threading it
    // through each of the three spawn sites (the same "one carrier, not N
    // builders" argument as `native-lease-settings-source.ts`'s docblock).
    // TTL-cached and failure-swallowing, so it costs nothing and cannot break a
    // dial.
    await this.refreshNativeLeaseSettings()
    await this.sessionHwaccel.refresh(this.ctxIfReady?.kernel.hwaccel)
    return acquireSessionDecodeRestreamFrom(api, this.ctx.logger, {
      deviceId,
      streamId,
      tag,
      hostname,
      ownerNodeId,
      ...(detectionIntent === true ? { detectionIntent: true } : {}),
    })
  }

  /**
   * Register this device's motion to ride the detection session-decode worker
   * (P4 co-active sharing) instead of forking a dedicated motion worker. While
   * registered, the detection pump enqueues a derived gray motion frame per
   * decoded rgb. Returns an idempotent teardown that unregisters it; forks
   * nothing and holds no restream (the detection subscription owns the worker).
   */
  private registerSharedMotionSink(deviceId: number, motionFps: number): () => void {
    // Throttle to the camera's motionFps (mirrors the shm path's `maxFps`).
    // Without it the analyzer diffs consecutive full-rate (~22fps) detection
    // frames whose inter-frame deltas sit below the wasm thresholds, so it
    // never emits regions — the missing-motion-boxes bug on onboard-driven
    // cameras (P4 regression, 3feb30b5).
    const fps = motionFps > 0 ? motionFps : 4
    this.sharedMotionSinks.set(deviceId, {
      minIntervalMs: 1000 / fps,
      // -Infinity: the FIRST decoded frame always reaches the analyzer.
      lastMotionEnqueueTs: Number.NEGATIVE_INFINITY,
    })
    this.ctxIfReady?.logger.info(
      'session-decode: motion rides the detection worker (shared — no 2nd fork)',
      { tags: { deviceId }, meta: { motionFps: fps } },
    )
    let released = false
    return () => {
      if (released) return
      released = true
      this.sharedMotionSinks.delete(deviceId)
    }
  }

  /**
   * Fan a decoded detection rgb frame out to the detection queue, and — when
   * this device's motion is riding the detection worker (P4 sharing) — also to
   * the motion queue as a derived gray frame (`rgbFrameToGrayFrame`, luma only:
   * no second dial, no second decode, no GPU). Mirrors the shm shared-motion
   * seam (`subscribeMotionFrames` `shared` branch).
   */
  /** Attach → first decoded detection frame, one line per attach. See
   *  {@link FirstDetectionFrameTimer}. */
  private readonly firstDetectionFrame = new FirstDetectionFrameTimer()

  /**
   * Frames this camera's pre-roll catch-up burst may send to inference.
   *
   * The switch and the budget are ONE number here on purpose: `false` and
   * `0` mean the same thing to every layer below (no burst is constructed, the
   * history is decoded to reach a GOP and then discarded exactly as it was
   * before D411), and two independent ways to say it is two ways to disagree.
   */
  private preRollBudgetFor(config: RunnerCameraConfig): number {
    if (!config.preRollInferenceEnabled) return 0
    const frames = config.preRollInferenceFrames
    return Number.isFinite(frames) && frames > 0 ? frames : 0
  }

  private enqueueSharedDetectionFrame(
    deviceId: number,
    frame: DecodedFrame,
    handle?: FrameHandle,
    reservation?: { readonly detection: boolean; readonly motion: boolean },
  ): boolean {
    const runner = this.runner
    if (!runner) return false
    // The detection frame carries the retention-ring `FrameHandle` (Shape-2
    // Slice 1) so it rides the emitted inference-result event and post-analysis
    // can cut crop media from the exact frame. Motion fan-out below stays
    // handle-less: motion analyses a derived gray frame that is never retained.
    // History rides the bounded FIFO lane, never the latest-only live queue —
    // pushing a burst through that queue leaves exactly one frame of it, which
    // is the second of the three gates this change removes.
    const admitted =
      frame.preRoll === true
        ? runner.enqueuePreRollFrame(deviceId, frame, handle)
        : reservation
          ? reservation.detection && runner.enqueueReservedDetectionFrame(deviceId, frame, handle)
          : runner.enqueueDetectionFrame(deviceId, frame, handle)
    if (admitted) {
      // The leg nothing measured: the orchestrator's `session motion → attach
      // latency` ends at the attach, and `frame processed` is emitted only
      // when a frame produces something notable. Between them an operator's
      // "detection starts late" had no number at all.
      const latencyMs = this.firstDetectionFrame.takeLatency(deviceId, Date.now())
      if (latencyMs !== null) {
        this.ctx?.logger.info('session-decode: first detection frame after attach', {
          tags: { deviceId },
          meta: { latencyMs },
        })
      }
    }
    if (reservation?.motion) {
      runner.enqueueMotionFrame(deviceId, rgbFrameToGrayFrame(frame), undefined)
    } else if (!reservation) {
      const sink = this.sharedMotionSinks.get(deviceId)
      if (sink) {
        const now = this.sharedSinkNow()
        if (now - sink.lastMotionEnqueueTs >= sink.minIntervalMs) {
          sink.lastMotionEnqueueTs = now
          runner.enqueueMotionFrame(deviceId, rgbFrameToGrayFrame(frame), undefined)
        }
      }
    }
    return admitted
  }

  /**
   * Reserve all consumers of one lazy RGB frame before materializing pixels.
   * Detection follows the adaptive governor; shared motion keeps its independent
   * cadence so throttling inference cannot starve the analyzer.
   */
  private reserveSharedDetectionFrame(deviceId: number): {
    readonly detection: boolean
    readonly motion: boolean
  } {
    const detection = this.runner?.reserveDetectionFrame(deviceId) ?? false
    const sink = this.sharedMotionSinks.get(deviceId)
    if (!sink) return { detection, motion: false }
    const now = this.sharedSinkNow()
    const motion = now - sink.lastMotionEnqueueTs >= sink.minIntervalMs
    if (motion) sink.lastMotionEnqueueTs = now
    return { detection, motion }
  }

  /**
   * Epic C P1 detection path for a flagged camera: decode `rgb` in a
   * per-session forked worker and feed the runner's detection queue INLINE (no
   * `FrameHandle`), exactly like the shared shm path. Teardown stops the pump
   * (→ worker `stop` + `kill` + SIGKILL fallback → reclaim) and releases the
   * restream refcount.
   *
   * Returns the teardown SYNCHRONOUSLY (Epic C P2 I3): the restream acquire +
   * pump-start run in the background via {@link startGuardedSessionDecode},
   * so a detach that lands while the acquire is still in flight releases the
   * restream immediately and never forks the decode worker — no orphan
   * worker, no leaked refcount.
   */
  /**
   * Build the spawn-gate acquire the pump calls before forking a decode
   * worker (P5). Logs DEFERRAL (gate saturated → this fork queues) and the
   * subsequent proceed — no silent capping. Returns a no-op acquire when the
   * gate is not yet initialised (pre-`onInitialize`), so the pump is never
   * blocked by a missing gate. `label` distinguishes detect vs motion forks in
   * the logs; the device id is already tagged on `log`.
   */
  /**
   * The node's live-decode-worker admission, bound to one camera.
   *
   * `undefined` when the ceiling is not configured (pre-`onInitialize`), which
   * `startGuardedSessionDecode` reads as "no ceiling" — the historical
   * behaviour. Never a queue: see {@link LiveDecodeWorkerAdmission}.
   */
  private buildLiveWorkerAdmit(
    deviceId: number,
    label: string,
  ): (() => LiveWorkerLease | null) | undefined {
    const admission = this.liveWorkers
    if (!admission) return undefined
    return () => admission.admit(deviceId, label)
  }

  /**
   * The start's place in the node's queue of refused starts (D652) — taken by
   * the guarded start on its first refusal, kept until it is over. Spread into
   * `startGuardedSessionDecode`'s deps; empty when this node runs no ceiling.
   */
  private liveWorkerSlotWaiter(deviceId: number): GuardedSlotWake {
    const admission = this.liveWorkers
    if (!admission) return {}
    return { slotWaiter: () => admission.slotWaiter(deviceId) }
  }

  private buildDecodeSpawnAcquire(log: IScopedLogger, label: string): () => Promise<() => void> {
    return async (): Promise<() => void> => {
      const gate = this.spawnGate
      if (!gate) return () => {}
      const wasDeferred = gate.available <= 0
      if (wasDeferred) {
        log.info('session-decode: decode-worker spawn DEFERRED — spawn gate saturated, queuing', {
          meta: { label, cap: gate.concurrency, inFlight: gate.concurrency - gate.available },
        })
      }
      const release = await gate.acquire()
      if (wasDeferred) {
        log.info('session-decode: deferred decode-worker spawn now proceeding', { meta: { label } })
      } else {
        log.debug('session-decode: decode-worker spawn slot acquired', {
          meta: { label, remaining: gate.available },
        })
      }
      return release
    }
  }

  private startDetectionSessionDecode(
    config: RunnerCameraConfig,
    api: AddonApi,
  ): SessionDecodeTeardown {
    const runner = this.runner
    const log = this.ctx.logger.withTags({ deviceId: config.deviceId })
    if (!runner) return () => {}
    // Retain every decoded rgb detection frame in the node-level RAM store; the
    // returned handle rides the inference-result event so hub-side post-analysis
    // resolves the frame over tRPC (`getNativeCrop`, routed by `handle.nodeId`)
    // and cuts crop media from it — no `/dev/shm` (shm-ring removal 2026-07-16).
    const retainedFrames = this.retainedFrames
    // Origin for the first-frame line below: when this session was ASKED for.
    // Everything the operator waits through — broker acquire, spawn queue, fork,
    // RTSP dial, the wait for a decodable GOP — is measured from here.
    const requestedAt = Date.now()
    const teardown = startGuardedSessionDecode({
      logger: log,
      admitWorker: this.buildLiveWorkerAdmit(config.deviceId, 'detect'),
      ...this.liveWorkerSlotWaiter(config.deviceId),
      acquire: () =>
        this.acquireSessionDecodeRestream(
          api,
          config.deviceId,
          config.detectionStreamId,
          `session-decode:detect:${config.deviceId}`,
          resolveSessionDecodeHostname(config, process.env['CAMSTACK_HUB_URL']),
          resolveSessionDecodeOwnerNodeId(config),
          // Detection decodes at source rate and publishes throttled by the
          // FrameSlot, so it drains a catch-up burst instead of accumulating it
          // — the one consumer for which the restreamer's live-edge withhold
          // costs a blind start and buys nothing. See `restream-intent.ts`.
          //
          // "Drains" used to mean FREES: the FrameSlot throttle compares wall
          // clocks, and ~4 s of replayed history arrives inside a few hundred
          // ms of wall clock, so the window was decoded in full and discarded
          // bar a frame or two. It is now SPENT — a bounded, media-paced
          // catch-up burst that reaches inference through the runner's pre-roll
          // lane (D411).
          true,
        ),
      startPump: (source, hooks) => {
        const dialMs = Date.now() - requestedAt
        const useLocalFrameRef = this.executorCoLocated()
        log.info('session-decode: detection routed through per-session decode worker (rgb)', {
          meta: {
            streamId: config.detectionStreamId,
            codec: source.codec,
            transport: useLocalFrameRef ? 'local-frame-ref' : 'inline-compat',
          },
        })
        let reservation: { readonly detection: boolean; readonly motion: boolean } | null = null
        return startSessionDecodePump({
          fork: this.forkDecodeWorkerWithLease,
          lease: this.resolveSessionLeaseKnobs,
          hwaccel: this.resolveSessionHwaccel,
          // The live-worker slot returns at the worker's real exit (D652).
          onWorkerGone: hooks.onWorkerGone,
          logger: log,
          source,
          opts: {
            fps: config.detectionFps,
            format: 'rgb',
            // What this dial asked the broker for. It anchors the worker's
            // media clock and is the window the catch-up burst plans over —
            // the worker can see neither the url's intent nor the camera's
            // settings, so both have to arrive here.
            preRollMs: preRollRequestOf(source.restreamUrl),
            preRollMaxFrames: this.preRollBudgetFor(config),
          },
          shouldMaterializeFrame: (preRoll) => {
            if (preRoll) {
              // History never asks the LIVE gate. `reserveDetectionFrame` paces
              // on wall clock and a catch-up burst delivers seconds of media
              // inside milliseconds of it, so the live gate refuses the whole
              // burst. Its budget was already spent in the worker, in media
              // time; all that is left to ask is whether the lane has room.
              const accepting = runner.preRollLaneAccepting(config.deviceId)
              reservation = { detection: accepting, motion: false }
              return accepting
            }
            reservation = this.reserveSharedDetectionFrame(config.deviceId)
            const materialize = reservation.detection || reservation.motion
            this.retention?.noteFrame({
              deviceId: config.deviceId,
              decoded: true,
              admitted: reservation.detection,
              droppedPixelFree: !materialize,
            })
            if (!materialize) {
              this.frameLazy.noteView({
                deviceId: config.deviceId,
                materialized: false,
                workerToRunnerBytes: 0,
              })
            }
            return materialize
          },
          ...(useLocalFrameRef
            ? {
                frameRegistry: localFrameRegistry,
                // Under backpressure the pixels are copied while the frame is
                // still reserved (see `inlineWhen` in the pump) — the same rule
                // the shm passthrough applies, asked per frame.
                inlineWhen: () => runner.detectionBackpressure(config.deviceId),
                inlineViewSpec: SPLIT_DETECTION_VIEW,
                onFrameRef: async (
                  frame: DecodedFrame,
                  nativeCrop?: NativeCropRequester,
                ): Promise<boolean> => {
                  const current = reservation
                  reservation = null
                  if (!current || !frame.frameRef) return false
                  const handle = current.detection
                    ? writeRetainedDetectionFrame(
                        retainedFrames,
                        config.deviceId,
                        frame,
                        this.retention,
                      )
                    : undefined
                  if (handle && nativeCrop) {
                    this.nativeCropRegistry.register(handle, nativeCrop, config.deviceId)
                    this.bindFrameCutter(handle, nativeCrop)
                  }
                  this.frameLazy.noteView({
                    deviceId: config.deviceId,
                    materialized: false,
                    workerToRunnerBytes: 0,
                  })
                  const admitted =
                    current.detection &&
                    (frame.preRoll === true
                      ? runner.enqueuePreRollFrame(config.deviceId, frame, handle)
                      : runner.enqueueReservedDetectionFrame(config.deviceId, frame, handle))
                  // The mark goes out from THIS synchronous turn, before the
                  // motion view's await below. The worker keeps a native copy
                  // of a superseded frame only if the mark has already arrived
                  // when the next pull supersedes it; sent after the await, the
                  // mark reached the worker two pulls late, the frame had been
                  // declined and freed, and every crop on it was a `released`
                  // miss that nobody had released (59 in 20 min, 2026-09-06).
                  if (admitted) nativeCrop?.markInferred()
                  if (current.motion) {
                    const motion = await resolveMotionFrameView(localFrameRegistry, frame.frameRef)
                    if (motion.kind === 'view') {
                      runner.enqueueMotionFrame(
                        config.deviceId,
                        {
                          data: Buffer.from(motion.data),
                          width: motion.width,
                          height: motion.height,
                          format: 'gray',
                          timestamp: frame.timestamp,
                          capturedAt: frame.capturedAt,
                        },
                        undefined,
                      )
                    }
                  }
                  return admitted
                },
              }
            : { inlineViewSpec: SPLIT_DETECTION_VIEW }),
          acquireSpawnSlot: this.buildDecodeSpawnAcquire(log, 'detect'),
          // THE pre-roll line. One per detection session that asked for
          // history, never per frame, and emitted from the branch that DROPS —
          // a burst that inferred 3 of 47 offered frames and one that inferred
          // 12 of 12 are different situations, and until this line they read
          // identically (i.e. as nothing at all). Reconstructing the miss this
          // fixes needed a frame-by-frame re-run of the stored recording
          // because no line existed that could have answered it.
          onPreRollReport: (report) => {
            log.info('session-decode: pre-roll catch-up burst', {
              tags: { deviceId: config.deviceId },
              meta: {
                streamId: config.detectionStreamId,
                // What the dial asked the broker for vs what the burst covered.
                requestedMs: preRollRequestOf(source.restreamUrl),
                spanMs: report.spanMs,
                // Frames the worker OFFERED the burst (the decoded history),
                // how many reached inference, and how many did not.
                offered: report.offered,
                inferred: report.inferred,
                dropped: report.dropped,
                // Why each dropped frame dropped: `stride` (subsampled to fit
                // the budget), `budget-frames`, `budget-wall-ms`, `live-edge`.
                droppedByReason: report.droppedByReason,
                // The media-time gap the window was sampled at, and whether it
                // had to be widened past the session's detection cadence.
                strideMs: report.strideMs,
                subsampled: report.subsampled,
                // …and the SECOND place a frame can still be lost: the runner's
                // lane was full when the burst handed it one. A non-zero here
                // and a non-zero `budget-frames` are different faults with
                // different fixes.
                // `null` when the camera was already detached: unread, not 0.
                laneRefused: runner.preRollRefusedCount(config.deviceId),
                budgetFrames: this.preRollBudgetFor(config),
                // What the burst was ALLOWED after the hold cap (D652).
                effectiveBudgetFrames: report.budgetFrames,
              },
            })
          },
          // …and the THIRD place: a history frame the runner admitted and
          // inference never read — the hold evicted it, a re-dial cleared it,
          // its download failed, or the read found it gone. A separate, later
          // line because it can only be known once those frames settle (D652).
          // Capping the burst at `holdFrames - 1` does not make it 0: live
          // frames share the hold and outrank the lane.
          onPreRollSettled: (summary) => {
            const lost =
              summary.lostByReason.evicted +
              summary.lostByReason.cleared +
              summary.lostByReason['download-failed'] +
              summary.lostByReason.miss
            const meta = { streamId: config.detectionStreamId, ...summary, lost }
            if (lost > 0 || summary.unsettled > 0) {
              log.info('session-decode: pre-roll frames settled', {
                tags: { deviceId: config.deviceId },
                meta,
              })
              return
            }
            log.debug('session-decode: pre-roll frames settled', {
              tags: { deviceId: config.deviceId },
              meta,
            })
          },
          // THE success-path latency line. One per detection decode session,
          // never per frame. Before this, a fast start and a start that spent 8
          // seconds blind waiting for the camera's next IDR produced identical
          // logs (i.e. none) — only the FAILURE was ever reported — so the ramp
          // between motion and the first inferenced frame, which is where
          // camera 101's missed notifications happened, could not be measured
          // at all. It is the before/after proof for the join-burst exemption
          // and the decode keep-warm.
          //
          // `primeSpanMs` is deliberately absent: the join burst is a decision
          // made inside the RESTREAMER (possibly on another node), which
          // reports it on its own `restream attach live-edge` line — one line
          // per session, naming what it asked for and what it was served.
          // Correlate by deviceId plus the per-attach `consumer` tag
          // (`decode/<deviceId>/<dial>`, set by the worker's `user_agent`)
          // rather than inventing a field this seam cannot see.
          //
          // `preRollRequestMs` IS here, because it is not the broker's: it is
          // what THIS dial asked for, read back off the url it actually dialed.
          // Without it "101 was slow" and "101 asked for 15 s of history" are
          // two facts in two processes with nothing joining them, which is the
          // state that made the D381 side effect unmeasurable.
          onFirstFrame: (timing) => {
            const phaseActiveAt = this.lastMotionAt.get(config.deviceId)
            log.info('session-decode: detection first frame', {
              tags: { deviceId: config.deviceId },
              meta: {
                streamId: config.detectionStreamId,
                codec: source.codec,
                // Broker acquire (profile lookup + getStreamWithCodec).
                dialMs,
                // Queued behind this node's decode-worker spawn gate.
                spawnWaitMs: timing.spawnWaitMs,
                // Fork → first decoded frame: RTSP setup, hwaccel context, and
                // the wait for a decodable GOP. The join withhold lives here.
                forkToFrameMs: timing.forkToFrameMs,
                // …and WHERE inside it. `forkToFrameMs` was measured at 4 689 ms
                // (p50, n=2 501) with nothing to attribute it to: four serial
                // steps inside the child, behind one number, none of them
                // visible from this process. These four are the worker's own
                // report; they do NOT sum to `forkToFrameMs` — the residual is
                // module load (~0.2 s measured), the IPC hop and the one-shot
                // GPU-filter probe, and leaving it a residual is what keeps the
                // split honest. `streamInfoProbed` says whether the redundant
                // `avformat_find_stream_info` ran, which is the difference
                // between two readings of `demuxerOpenMs` that are not the same
                // measurement (see `session-decode/pull-demuxer-open.ts`).
                ...(timing.dial
                  ? {
                      hwContextMs: timing.dial.hwContextMs,
                      demuxerOpenMs: timing.dial.demuxerOpenMs,
                      decoderCreateMs: timing.dial.decoderCreateMs,
                      firstDecodeMs: timing.dial.firstDecodeMs,
                      streamInfoProbed: timing.dial.streamInfoProbed,
                    }
                  : {}),
                // What this attach ASKED the broker for (ms of history), off
                // the dialed url. `0` = it asked for none.
                preRollRequestMs: preRollRequestOf(source.restreamUrl),
                // What the operator experiences: session asked for → first frame.
                firstFrameMs: Date.now() - requestedAt,
                // Since this runner's phase machine went ACTIVE for the camera.
                // Deliberately NOT called `sinceMotionMs`: the runner does not
                // see the motion event that caused an on-motion session (the
                // orchestrator attaches it as `always-on`, so this clock starts
                // at registerCamera). The true motion origin is on the
                // orchestrator's `detection session: dispatched on motion`
                // line — correlate by deviceId.
                ...(phaseActiveAt !== undefined
                  ? { sincePhaseActiveMs: Date.now() - phaseActiveAt }
                  : {}),
              },
            })
          },
          // A worker death used to zombie the session (the runner kept the
          // attachment, frames just stopped — previously masked by the
          // Channel-closed runner crash whose respawn re-attached everything).
          onEnded: () => this.handleDetectionDecodeEnded(config.deviceId),
          onDecodedFrame: (frame, nativeCrop) => {
            const current = reservation
            reservation = null
            if (!current) return
            this.frameLazy.noteView({
              deviceId: config.deviceId,
              materialized: frame.data.byteLength > 0,
              workerToRunnerBytes: frame.data.byteLength,
            })
            const handle = current.detection
              ? writeRetainedDetectionFrame(retainedFrames, config.deviceId, frame, this.retention)
              : undefined
            // Correlate the retention handle with the worker still holding this
            // frame's native surface, so `getNativeCrop` can cut a native-res
            // crop for it (best-effort; evicts with the worker's tiny ring).
            if (handle && nativeCrop) {
              this.nativeCropRegistry.register(handle, nativeCrop, config.deviceId)
              // Bind the cutter to THIS frame so its result can end its hold
              // without a second lookup in the shared LRU above.
              this.bindFrameCutter(handle, nativeCrop)
            }
            // Lease admission (Option B): a native crop can only ever name a
            // frameId that rode an INFERENCE RESULT, and the runner knows that
            // set right here. Marking it lets the worker retain a native copy
            // of only those frames instead of all ~25/s it delivers. The mark
            // MUST be sent from this synchronous turn — the pull that follows
            // is what decides this frame's retention.
            if (this.enqueueSharedDetectionFrame(config.deviceId, frame, handle, current)) {
              nativeCrop?.markInferred()
            }
          },
        })
      },
    })
    // The retained-frame store is node-level and latest-wins under a byte
    // budget, so a per-session teardown does NOT clear it — in-flight
    // post-analysis for this camera's last frames must still resolve; they age
    // out naturally. Only the session decode is torn down here.
    return (mode) => {
      teardown(mode)
    }
  }

  /**
   * Epic C P1 motion path for a flagged camera: a dedicated `gray` decode of
   * the SUB stream in its OWN per-session forked worker (independent of the
   * detection worker — two workers per flagged camera in P1; sharing one is a
   * P2 follow-up). Feeds the motion queue INLINE (no handle). Teardown stops
   * the pump and releases the restream refcount.
   *
   * Returns the teardown SYNCHRONOUSLY (Epic C P2 I3) — same
   * {@link startGuardedSessionDecode} guard as detection: a detach during the
   * in-flight acquire releases immediately and skips the pump/worker fork.
   */
  private startMotionSessionDecode(
    config: RunnerCameraConfig,
    api: AddonApi,
  ): SessionDecodeTeardown {
    const runner = this.runner
    const log = this.ctx.logger.withTags({ deviceId: config.deviceId })
    if (!runner) return () => {}
    return startGuardedSessionDecode({
      logger: log,
      admitWorker: this.buildLiveWorkerAdmit(config.deviceId, 'motion'),
      ...this.liveWorkerSlotWaiter(config.deviceId),
      acquire: () =>
        this.acquireSessionDecodeRestream(
          api,
          config.deviceId,
          config.motionStreamId,
          `session-decode:motion:${config.deviceId}`,
          resolveSessionDecodeHostname(config, process.env['CAMSTACK_HUB_URL']),
          resolveSessionDecodeOwnerNodeId(config),
        ),
      startPump: (source, hooks) => {
        log.info('session-decode: motion routed through per-session decode worker (gray)', {
          meta: { streamId: config.motionStreamId, codec: source.codec },
        })
        return startSessionDecodePump({
          fork: this.forkDecodeWorkerWithLease,
          lease: this.resolveSessionLeaseKnobs,
          hwaccel: this.resolveSessionHwaccel,
          // The live-worker slot returns at the worker's real exit (D652).
          onWorkerGone: hooks.onWorkerGone,
          logger: log,
          source,
          opts: { fps: config.motionFps, format: 'gray' },
          inlineViewSpec: MOTION_FRAME_VIEW,
          acquireSpawnSlot: this.buildDecodeSpawnAcquire(log, 'motion'),
          onDecodedFrame: (frame) => {
            runner.enqueueMotionFrame(config.deviceId, frame, undefined)
          },
        })
      },
    })
  }

  /**
   * Subscribe the motion analyzer to decoded frames.
   *
   * Two modes:
   * - **Persistent (default)** — a dedicated `gray` decode of the camera's
   *   `motionStreamId` (the sub stream). Cheap, always-on; used when the SW
   *   analyzer is the motion source (`motionSources` includes `'analyzer'`).
   * - **Shared with detection** (`opts.sharedWithDetection`) — subscribes
   *   `rgb` on `detectionStreamId` (the MAIN stream) so it rides the SAME
   *   session-decode worker detection already uses, then derives the
   *   analyzer's `gray` from that rgb frame's luma. No second decoder. Used for
   *   onboard/sensor-triggered motion, where a decode is already active.
   */
  private async subscribeMotionFrames(
    config: RunnerCameraConfig,
    opts?: { readonly sharedWithDetection?: boolean },
  ): Promise<SessionDecodeTeardown | null> {
    const ctx = this.ctx
    const runner = this.runner
    if (!ctx || !runner) return null

    const log = this.ctx.logger.withTags({ deviceId: config.deviceId })
    const api = this.ctx.api
    if (!api) {
      log.warn('subscribeMotionFrames: this.ctx.api not available')
      return null
    }

    // Session-decode is the ONLY decode path (the shared shm frame-handle
    // poller was removed with @camstack/shm-ring on 2026-07-16): every attached
    // camera decodes in a per-session worker. P4: when motion is co-active with
    // detection on the main stream (`sharedWithDetection`), RIDE the detection
    // worker and derive gray — no second fork. Otherwise (persistent analyzer,
    // or detection disabled) spawn the dedicated sub-stream gray worker.
    if (resolveMotionFrameSource(config, opts?.sharedWithDetection === true).shared) {
      return this.registerSharedMotionSink(config.deviceId, config.motionFps)
    }
    return this.startMotionSessionDecode(config, api)
  }

  private handleDetectionStreamChange(deviceId: number, action: 'subscribe' | 'unsubscribe'): void {
    const attachment = this.attached.get(deviceId)
    if (!attachment) return

    if (action === 'subscribe') {
      // Already subscribed → nothing to spawn.
      if (attachment.detectionUnsubscribe !== null) return
      void this.subscribeDetectionFrames(attachment.config).then((unsub) => {
        // A detach/teardown may have raced in while the async subscribe was
        // in flight — honour it by disposing the just-opened subscription.
        if (!this.attached.has(deviceId)) {
          unsub?.()
          return
        }
        attachment.detectionUnsubscribe = unsub
      })
    } else {
      // Gate closed: release the worker NOW. It was held for 15 s until D453,
      // and a held worker does not idle — it decodes the whole window at the
      // source rate for a 12% chance of being reused.
      if (attachment.detectionUnsubscribe === null) return
      attachment.detectionUnsubscribe()
      attachment.detectionUnsubscribe = null
    }
  }

  /**
   * Publish a runner phase transition as `DetectionPhaseTransition` (WATCHING
   * ↔ ACTIVE, after the cooldown debounce), for the UI events panel, analytics
   * and the alert center.
   *
   * The phase is NOT the camera's motion and writes no `motion` runtime slice
   * (D696). Every on-motion detection session attaches `always-on`, so the
   * phase reads `active` for a whole session, and an always-on camera is
   * `active` for as long as it is attached (`cause: 'attach'`), and returns to
   * `watching` on detach (`cause: 'detach'`) — neither names a motion source.
   * The slice it used to write was therefore "a session is attached", and was
   * left `detected: true` after every session (the detach close of the EVENT
   * did not exist either until 2026-10-06). The orchestrator is the only
   * writer of that slice, with the EFFECTIVE motion, and this runner says so
   * on `getLocalLoad().motionSliceWriter` so that it never writes the slice
   * while a runner older than D696 still does.
   */
  private handlePhaseChanged(
    deviceId: number,
    phase: CameraPhase,
    meta: PhaseTransitionMeta,
  ): void {
    const detected = phase === 'active'
    if (detected) this.lastMotionAt.set(deviceId, meta.timestamp)
    // `MotionOnMotionChanged` carries the motion signal (the bridge's
    // effective onboard motion, the analyzer, device activity); this event
    // carries the post-phase-machine truth (after cooldown debouncing).
    // Different consumers, different cadences.
    if (this.ctx.eventBus) {
      const from: 'watching' | 'active' = detected ? 'watching' : 'active'
      const to: 'watching' | 'active' = detected ? 'active' : 'watching'
      const reason: 'motion_detected' | 'cooldown_expired' = detected
        ? 'motion_detected'
        : 'cooldown_expired'
      // A motion transition names its source and cooldown; a session attach
      // names the motion the orchestrator dispatched it on (never a guess —
      // it used to claim `analyzer` on cameras that do not list it); a
      // detach names none.
      const payload: PhaseTransitionPayload = {
        deviceId,
        from,
        to,
        reason,
        cause: meta.cause,
        ...phaseTransitionSourceFields(meta),
        timestamp: meta.timestamp,
      }
      this.ctx.eventBus.emit(
        createEvent(
          EventCategory.DetectionPhaseTransition,
          { type: 'device', id: deviceId, addonId: this.ctx.id, deviceId, nodeId: this.nodeId },
          payload,
        ),
      )
    }
  }

  private async subscribeDetectionFrames(
    config: RunnerCameraConfig,
  ): Promise<SessionDecodeTeardown | null> {
    const ctx = this.ctx
    const runner = this.runner
    if (!ctx || !runner) return null

    const log = this.ctx.logger.withTags({ deviceId: config.deviceId })
    const api = this.ctx.api
    if (!api) {
      log.warn('subscribeDetectionFrames: this.ctx.api not available')
      return null
    }

    // Session-decode is the ONLY decode path (the shared shm frame-handle
    // poller was removed with @camstack/shm-ring on 2026-07-16): every attached
    // camera decodes rgb in a per-session forked worker over the broker's copy
    // restream — no shm ring, no poller.
    return this.startDetectionSessionDecode(config, api)
  }

  // ── Internal: inference + motion callbacks ───────────────────────────

  private async runInference(
    deviceId: number,
    frame: FrameInput,
    // The retention handle rides the emitted inference-result event (via the
    // runner's `onResult` callback), not this per-frame dispatch — the CB5 shm
    // passthrough that used it here is gone (shm-ring removal 2026-07-16).
    _handle: FrameHandle | undefined,
  ): Promise<FrameResult | null> {
    const ctx = this.ctx
    if (!ctx) return null

    const log = this.ctx.logger.withTags({ deviceId })
    const api = this.ctx.api
    if (!api) {
      log.error('runInference: this.ctx.api not available')
      return null
    }

    const attachment = this.attached.get(deviceId)
    const camConfig = attachment?.config
    const steps = camConfig?.steps
    // TTL-cached: a no-op on all but one frame in five seconds (D657).
    await this.customModels.refresh(api)

    // Stateless-pipeline dispatch (Phase 4): the orchestrator hydrates
    // every attach with `steps` (from `pipelines[deviceId]` or the
    // cluster default). Absent steps means the camera was attached
    // before the orchestrator migrated — skip the frame rather than
    // falling back to the removed legacy `runFrame` path.
    if (!steps) {
      log.warn('runInference: no steps in attach config — skipping frame (legacy attach?)')
      return null
    }
    if (steps.length === 0) {
      return null
    }

    // D730: the root model may supply pipeline steps. When its `package`
    // supply is effective, the package root is not dispatched at all — the
    // camera root's own `package` boxes are the package result, on every frame
    // it runs (so the governor below has nothing to gate).
    const rootSupplyPlan = this.rootSupplyPlanFor(deviceId, steps, camConfig?.deviceKey)
    const packageFill = applyPackageFill(steps, rootSupplyPlan)
    // D737: a seg root's masks ARE the `segmentation` step's result when that
    // supply is effective — the step is not dispatched on this frame.
    const maskFill = applyMaskFill(packageFill.steps, rootSupplyPlan)

    // Motion-settle governor: the `package-detection` root runs on
    // motion-settle edges + a low-cadence safety poll, NOT every frame
    // (a delivered package is stationary — see MotionSettleGovernor). When
    // the governor says "not this frame", drop the step from the dispatched
    // tree; every other root still runs unchanged. Gated behind the step
    // actually being enabled for this camera.
    let dispatchSteps: readonly PipelineStepInputOutput[] = maskFill.steps
    const packageStepEnabled = dispatchSteps.some(
      (s) => s.addonId === PACKAGE_DETECTION_STEP_ID && s.enabled !== false,
    )
    if (packageStepEnabled) {
      // Refresh the zone geometry off the decision path (never awaited here).
      this.refreshPackageZoneUnion(deviceId)
      // Motion NEAR the package zone opens the burst. Falls back to the
      // whole-frame signal until the first analyzer frame has been measured —
      // an unmeasured camera must not be quieter than it was before.
      const motionInZone =
        this.lastMotionNearPackageZone.get(deviceId) ??
        this.lastAnalyzerDetected.get(deviceId) ??
        false
      const decision = this.packageGovernor.evaluate({
        deviceId,
        motionInZone,
        now: Date.now(),
      })
      const skipped = this.packageGateSkips.get(deviceId) ?? 0
      if (!decision.run) {
        dispatchSteps = dispatchSteps.filter((s) => s.addonId !== PACKAGE_DETECTION_STEP_ID)
        // Transition only: the first frame of a gated-off stretch says so, the
        // rest are counted and reported by the `run` line that ends the
        // stretch. Per-frame logging here would be frame-rate volume.
        if (skipped === 0) {
          log.info('package-detection gated off by the motion-settle governor', {
            tags: { deviceId },
            meta: { motionInZone: this.lastAnalyzerDetected.get(deviceId) ?? false },
          })
        }
        this.packageGateSkips.set(deviceId, skipped + 1)
        // All configured steps were package-detection and it's gated off:
        // nothing to run this frame.
        if (dispatchSteps.length === 0) return null
      } else {
        this.packageGateSkips.set(deviceId, 0)
        log.info('package-detection dispatched by the motion-settle governor', {
          tags: { deviceId },
          meta: { reason: decision.reason, framesSkippedSinceLastRun: skipped },
        })
      }
    }

    // D657: the elected pool loads only what runs on it. A detail subtree the
    // placement sends elsewhere never rides this dispatch — it would be loaded
    // here, resolved for a format it has no build in, and fail the root's load.
    dispatchSteps = this.stepsForElectedPoolOf(deviceId, dispatchSteps)

    // Frame transport to the executor, by topology:
    //  - CO-LOCATED (the `detection` execution.group — the executor's provider
    //    is registered in THIS process' local registry): send raw `frame`. The
    //    SDK link chain resolves the call in-process, so the pixels never cross
    //    a process boundary — a JPEG round-trip here would be pure CPU waste
    //    (live-observed pinning a 4-core N100 the moment a camera attached).
    //  - SPLIT processes (pre-group kernels, version skew): BINARY JPEG
    //    (`image`) — the hub-local UDS hop routes THROUGH the hub parent, and
    //    raw RGB (~0.7MB/frame × fps × cameras) OOM'd the hub main at its
    //    1536MB ceiling. q82 JPEG is ~10-15× smaller; raw `frame` remains the
    //    encode-failure fallback (never skip a detection frame for it).
    // `handle` still rides the emitted inference-result event for post-analysis
    // media (resolved via `getNativeCrop`, routed by `handle.nodeId`).
    // `Uint8Array<ArrayBuffer>` (not the `ArrayBufferLike` default) is what the
    // cap's `z.instanceof(Uint8Array)` input infers — a SharedArrayBuffer-backed
    // view is not transferable over the cap boundary. sharp's `toBuffer()`
    // returns exactly that.
    let image: Uint8Array<ArrayBuffer> | undefined
    const executorCoLocated = this.executorCoLocated()
    if (!executorCoLocated) {
      if (frame.format === 'rgb') {
        try {
          const encoded = await sharp(frame.data, {
            raw: { width: frame.width, height: frame.height, channels: 3 },
          })
            .jpeg({ quality: DETECTION_HOP_JPEG_QUALITY })
            .toBuffer()
          // `Buffer` is declared over `ArrayBufferLike`; the cap input is a
          // plain `Uint8Array<ArrayBuffer>` view. Same wrap the two
          // `image: new Uint8Array(imageJpeg)` call sites above use.
          image = new Uint8Array(encoded)
        } catch (err: unknown) {
          log.debug('runInference: frame JPEG encode failed — falling back to raw pixels', {
            meta: { error: errMsg(err) },
          })
        }
      }
    }
    if (image !== undefined) {
      this.frameLazy.notePoolBytes({ deviceId, raw: 0, jpeg: image.byteLength })
    } else if (executorCoLocated && frame.frameRef) {
      this.frameLazy.notePoolBytes({ deviceId, raw: 0, jpeg: 0 })
    } else {
      this.frameLazy.notePoolBytes({ deviceId, raw: frame.data.byteLength, jpeg: 0 })
    }
    let result: FrameResult | null
    try {
      result = await api.pipelineExecutor.runPipeline.mutate({
        // tRPC input is a mutable array; the attach payload holds it
        // as readonly. One spread copy at the cap boundary is cheap
        // (pipeline step trees are tiny) and keeps the type surface
        // clean without casting.
        steps: [...dispatchSteps],
        ...(image !== undefined
          ? { image }
          : selectExecutorFrameSource(executorCoLocated, frame.frameRef, frame)),
        deviceId,
        // T5: forward the per-camera inference-device selector so this
        // session's frames run on the chosen device pool (NPU / iGPU /
        // Coral) of THIS node. Omitted ⇒ the node's default device pool.
        // Engine selection stays node-local; deviceKey only picks WHICH
        // device pool of that node runs the session.
        ...(camConfig?.deviceKey ? { deviceKey: camConfig.deviceKey } : {}),
        // Live dispatch never forwards an engine: engine selection is
        // node-local (the detection-pipeline provider resolves the
        // node's own engine), and since D646 no caller can send one.
        //
        // Two-plane design: live per-frame dispatch only ever runs the
        // ROOT-plane steps (inputClasses === null). Crop children (face
        // detection/embedding, plate, classifiers, …) are announced on
        // the emitted result (`detailSteps`) and dispatched on-demand
        // per-track via `pipelineRunner.runDetailSubtree` instead.
        //
        // The BENCHMARK caller is NOT pinned to `'full'`: it forwards
        // `input.plane` when the request carries one (and the cached fast
        // path refuses that request precisely because it has no plane
        // selector), falling back to the cap's `'full'` default only when
        // the request omits it. So a bench CAN be asked to measure this
        // same root-plane dispatch — which is the point of the knob.
        plane: 'frame',
      })
    } catch (err: unknown) {
      // A real dispatch fault. Overload sheds no longer surface here — they
      // are a first-class `EngineOutput.dropped` outcome the executor skips
      // (before 2026-08-01 every deliberate shed landed on this line as
      // "unexpected kind: undefined", ~4/s across all nodes). Everything a
      // post-mortem needs rides the line: the camera (tags), the node, and
      // the step tree that was dispatched.
      const msg = errMsg(err)
      // D656: a named session-decode refusal / local frameRef miss is the
      // session ending under a frame still in flight — not a pool fault.
      if (isSessionDecodeReadGone(err)) {
        log.warn('runInference skipped — session decode frame gone', {
          meta: {
            error: msg,
            nodeId: this.nodeId,
            steps: dispatchSteps.map((s) => s.addonId).join(','),
            deviceKey: camConfig?.deviceKey ?? null,
          },
        })
        return null
      }
      log.error('runInference failed', {
        meta: {
          error: msg,
          nodeId: this.nodeId,
          steps: dispatchSteps.map((s) => s.addonId).join(','),
          // ALWAYS present, so the line can be grouped by inference device.
          // `null` is the truth for a session with no elected selector (a
          // single-eligible-device node) — the executor used the node's
          // DEFAULT pool, whose identity rides the error message itself
          // (`… on <runtime>:<device> …`, stamped by the pool's rejection).
          deviceKey: camConfig?.deviceKey ?? null,
        },
      })
      return null
    }
    if (result === null) return null
    // Whether the package step LOOKED at this frame — only the governor's
    // decision above knows, and post-analysis needs it to tell an empty
    // doormat from a frame nobody asked about (D687).
    const looked = withPackageLook(
      applyRootMasks(applyRootSupplyAuthority(result, rootSupplyPlan), maskFill),
      dispatchSteps,
      packageFill.filledByRoot,
    )
    return this.recoverSmallSubjects(deviceId, frame, looked, dispatchSteps, camConfig?.deviceKey)
  }

  /**
   * The second detector pass at native resolution — `small-subject-recovery.ts`
   * for the why and the geometry. This method owns only what is not pure: the
   * per-camera rate limit, the `frameRef` lease that yields the crop view, the
   * executor call and the report line.
   *
   * Runs on the frame the full pass just ran on, in this process, through the
   * same process-local lease. Anything that makes the pass impossible (no
   * local frame, no detector in the tree, a stale or empty motion mirror, a
   * lease miss, an executor error) leaves the full-frame result EXACTLY as it
   * was: the pass only ever adds.
   *
   * The crop is dispatched WITHOUT `deviceId` on purpose. The executor's
   * provider applies the detection-stage zone gate to whatever result it
   * builds, in that result's own coordinates — for a crop those are crop
   * coordinates, and a zone polygon evaluated against them gates the wrong
   * pixels. The recovered boxes are re-projected into frame space here, and
   * the tracker on the analytics side applies the same detection rules in
   * frame space (`frame-processor.ts`, zone filter), so nothing is gated
   * twice and nothing is gated wrong. The cost is that the crop pass runs on
   * the node's default thresholds rather than a per-device override.
   */
  private async recoverSmallSubjects(
    deviceId: number,
    frame: FrameInput,
    result: FrameResult,
    steps: readonly PipelineStepInputOutput[],
    deviceKey: string | undefined,
  ): Promise<FrameResult> {
    const api = this.ctx?.api
    if (!api || !frame.frameRef) return result
    const now = Date.now()
    if (now - (this.lastRecoveryAt.get(deviceId) ?? 0) < RECOVERY_MIN_INTERVAL_MS) {
      this.addRecoverySkips(deviceId, { rateLimited: 1 })
      return result
    }
    const regions = this.motionRegions.fresh(deviceId, now)
    if (regions.length === 0) {
      this.addRecoverySkips(deviceId, { noMotion: 1 })
      return result
    }
    const step = selectRecoveryStep(steps)
    if (step === null) return result
    if (result.width <= 0 || result.height <= 0) return result

    const native = { width: frame.frameRef.width, height: frame.frameRef.height }
    const planInput = {
      regions,
      detections: result.detections
        .filter((d) => d.kind === 'first-level')
        .map((d) => ({
          x: d.bbox.x / result.width,
          y: d.bbox.y / result.height,
          w: d.bbox.width / result.width,
          h: d.bbox.height / result.height,
        })),
      native,
    }
    // WHICH region rule this camera runs (D396). Per camera, default the
    // shipped one, so a deploy changes nothing until an operator moves a
    // camera — the same opt-in shape the motion area bar uses (D394).
    const recipe = readRecoveryRecipeForSteps(steps)
    const crops =
      recipe === 'motion-crop' ? planMotionCrops(planInput) : planRecoveryCrops(planInput)
    if (crops.length === 0) {
      // The gates cost this frame a pass. WHICH gate is the whole question when
      // a subject the pass is meant to recover is walking beside a person the
      // full-frame pass boxes (D378). The measured recipe has no region gates
      // at all, so a frame with motion that plans no crop there is a frame too
      // small to magnify — counted separately rather than blamed on a gate
      // that did not run.
      if (recipe === 'motion-crop') this.addRecoverySkips(deviceId, { unmagnifiable: 1 })
      else {
        const skipped = countRecoverySkips(planInput)
        this.addRecoverySkips(deviceId, { tooLarge: skipped.tooLarge, covered: skipped.covered })
      }
      return result
    }
    this.lastRecoveryAt.set(deviceId, now)

    const log = this.ctx.logger.withTags({ deviceId })
    const started = Date.now()
    const recovered: ObjectDetection[] = []
    let cropsRun = 0
    for (const crop of crops) {
      const view = await this.resolveRecoveryCropView(frame.frameRef, crop)
      if (view === null) continue
      cropsRun += 1
      try {
        const cropResult = await api.pipelineExecutor.runPipeline.mutate({
          steps: [step],
          image: view.jpeg,
          // The camera, so a failed load is tagged with it and the pass runs
          // with the camera's own detector overrides, like its full frame (D657).
          deviceId,
          plane: 'frame',
          ...(deviceKey ? { deviceKey } : {}),
        })
        if (!cropResult) continue
        recovered.push(
          ...remapCropDetections(
            cropResult.detections,
            crop,
            { width: view.width, height: view.height },
            { width: result.width, height: result.height },
            native,
          ),
        )
      } catch (err: unknown) {
        // The full-frame result stands. Named, not swallowed: a crop pass that
        // fails every time is a pool problem and must not read as "no small
        // subjects here".
        log.warn('small-subject recovery: crop pass failed — full-frame result kept', {
          meta: { error: errMsg(err), crop, nodeId: this.nodeId },
        })
      }
    }
    // The crop-only class floor (D396). Both real false positives the crop arm
    // produced on quiet footage were night-IR corners upscaled into a 320
    // model — `vehicle 0.749`, `person 0.701` — and `animal`, the class this
    // pass exists to recover, produced none at any gate. Applied to the CROP
    // boxes only; a full-frame box is never touched by it.
    const floor = applyCropClassFloors(recovered)
    if (floor.dropped.length > 0) {
      // A branch that drops work says so. Without this line a camera whose
      // recoveries are all being floored is indistinguishable from a camera
      // with nothing to recover.
      log.info('small-subject recovery: crop boxes below the crop-only class floor', {
        meta: { recipe, dropped: floor.dropped, nodeId: this.nodeId },
      })
    }
    const fused = fuseRecoveredDetections(result.detections, floor.kept)
    const added = fused.length - result.detections.length
    this.reportRecovery(deviceId, {
      crops: cropsRun,
      recovered: added,
      floored: floor.dropped.length,
      recipe,
      ms: Date.now() - started,
      now,
      // The class AND the score. A recovery line that says only `["animal"]`
      // cannot answer the one question the downstream spawn floors raise
      // ("was it above 0.45? above 0.6?"), and that is exactly the question
      // that had to be answered by deploying instrumentation on 2026-09-07.
      classes: fused
        .slice(result.detections.length)
        .map((d) => `${d.macroClass}:${d.score.toFixed(3)}`),
      // WHERE it was. Without this the line cannot answer "was the subject in
      // the watched zone at the time?" — the question the 2026-09-10 cat
      // raised, and the one that had to be answered from the operator's video
      // recording because nothing here recorded a box (D430). Zones cannot be
      // resolved in this process (they live in post-analysis), so the box is
      // the honest thing to ship: it is what a zone is tested against.
      boxes: fused.slice(result.detections.length).map((d) => ({
        x: Math.round(d.bbox.x),
        y: Math.round(d.bbox.y),
        w: Math.round(d.bbox.width),
        h: Math.round(d.bbox.height),
      })),
    })
    return added > 0 ? { ...result, detections: fused } : result
  }

  /**
   * One compressed ≤{@link RECOVERY_VIEW_PX} px view of a native square, from
   * the same process-local lease the full pass resolved its view from. `null`
   * on a miss — the frame is gone, and the full-frame result stands.
   */
  private async resolveRecoveryCropView(
    ref: FrameRef,
    crop: RecoveryCrop,
  ): Promise<{ jpeg: Uint8Array<ArrayBuffer>; width: number; height: number } | null> {
    const lease = localFrameRegistry.acquire(ref)
    if (!lease) return null
    let reason: 'success' | 'error' | 'drop' = 'error'
    try {
      const view = await lease.resolve({
        crop: { left: crop.left, top: crop.top, width: crop.side, height: crop.side },
        content: { width: RECOVERY_VIEW_PX, height: RECOVERY_VIEW_PX },
        fit: 'contain',
        format: 'jpeg',
      })
      if (view.kind !== 'view') {
        reason = 'drop'
        return null
      }
      reason = 'success'
      // A plain `Uint8Array<ArrayBuffer>` view is what the cap's
      // `z.instanceof(Uint8Array)` input infers (same wrap as the split-hop
      // JPEG in `runInference`); the copy is one ≤640 px JPEG.
      const jpeg = new Uint8Array(new ArrayBuffer(view.data.byteLength))
      jpeg.set(view.data)
      return { jpeg, width: view.width, height: view.height }
    } catch {
      return null
    } finally {
      lease.release(reason)
    }
  }

  /**
   * Fold a frame's non-run into the per-camera skip counters, drained by the
   * next report line (D378). Counters, never lines: a skip happens several
   * times a second per camera and a line per skip would be the noisiest thing
   * in the log.
   */
  private addRecoverySkips(
    deviceId: number,
    delta: Partial<{
      rateLimited: number
      noMotion: number
      tooLarge: number
      covered: number
      unmagnifiable: number
    }>,
  ): void {
    const current = this.recoverySkips.get(deviceId) ?? EMPTY_RECOVERY_SKIPS
    this.recoverySkips.set(deviceId, {
      rateLimited: current.rateLimited + (delta.rateLimited ?? 0),
      noMotion: current.noMotion + (delta.noMotion ?? 0),
      tooLarge: current.tooLarge + (delta.tooLarge ?? 0),
      covered: current.covered + (delta.covered ?? 0),
      unmagnifiable: current.unmagnifiable + (delta.unmagnifiable ?? 0),
    })
  }

  /** Aggregate the pass per camera and report once per {@link RECOVERY_LOG_INTERVAL_MS}. */
  private reportRecovery(
    deviceId: number,
    sample: {
      crops: number
      recovered: number
      floored: number
      recipe: RecoveryRecipe
      ms: number
      now: number
      classes: readonly string[]
      boxes: readonly { x: number; y: number; w: number; h: number }[]
    },
  ): void {
    const stats = this.recoveryStats.get(deviceId) ?? {
      passes: 0,
      crops: 0,
      recovered: 0,
      floored: 0,
      ms: 0,
      reportedAt: sample.now,
    }
    const next = {
      passes: stats.passes + 1,
      crops: stats.crops + sample.crops,
      recovered: stats.recovered + sample.recovered,
      floored: stats.floored + sample.floored,
      ms: stats.ms + sample.ms,
      reportedAt: stats.reportedAt,
    }
    // A recovery is the whole point of the pass: say so on the frame it
    // happened, bounded by the pass rate (≤ 2/s per camera), with the classes
    // that were missing from the full-frame result.
    if (sample.recovered > 0) {
      this.ctx.logger.info(
        'small-subject recovery: the native crop pass found what the full frame missed',
        {
          tags: { deviceId },
          meta: {
            recipe: sample.recipe,
            crops: sample.crops,
            recovered: sample.recovered,
            classes: sample.classes,
            boxes: sample.boxes,
            ms: sample.ms,
          },
        },
      )
    }
    if (sample.now - stats.reportedAt >= RECOVERY_LOG_INTERVAL_MS) {
      const skips = this.recoverySkips.get(deviceId) ?? EMPTY_RECOVERY_SKIPS
      // Frames the pass was OFFERED in this window: the ones it ran on plus
      // every reason it did not. This is the denominator of the one number the
      // crop dispatch is judged on — extra detector invocations per frame —
      // and it is computed here rather than estimated from an fps, which would
      // silently disagree with the governor's real admission rate.
      const framesOffered =
        next.passes +
        skips.rateLimited +
        skips.noMotion +
        skips.tooLarge +
        skips.covered +
        skips.unmagnifiable
      this.ctx.logger.info('small-subject recovery: pass report', {
        tags: { deviceId },
        meta: {
          recipe: sample.recipe,
          passes: next.passes,
          crops: next.crops,
          recovered: next.recovered,
          // Boxes the crop-only class floor removed (D396). A number that
          // climbs while `recovered` stays flat is the floor doing too much.
          floored: next.floored,
          framesOffered,
          cropsPerFrame: framesOffered > 0 ? +(next.crops / framesOffered).toFixed(3) : 0,
          avgMsPerPass: next.passes > 0 ? Math.round(next.ms / next.passes) : 0,
          windowMs: sample.now - stats.reportedAt,
          // Why the other frames did not run one (D378). `skipRateLimited` is
          // the cadence cap doing its job; `skipTooLarge` / `skipCovered` are
          // the two region gates, and a passage where the dog is never
          // recovered while these climb is the gates, not the cadence.
          skipRateLimited: skips.rateLimited,
          skipNoMotion: skips.noMotion,
          skipTooLarge: skips.tooLarge,
          skipCovered: skips.covered,
          skipUnmagnifiable: skips.unmagnifiable,
        },
      })
      this.recoverySkips.delete(deviceId)
      this.recoveryStats.set(deviceId, {
        passes: 0,
        crops: 0,
        recovered: 0,
        floored: 0,
        ms: 0,
        reportedAt: sample.now,
      })
      return
    }
    this.recoveryStats.set(deviceId, next)
  }

  /** Sticky true once the executor's provider shows up in THIS process' local
   *  registry (the `detection` execution.group) — from then on the per-frame
   *  call is in-process and raw pixels are zero-copy. Re-checks while false
   *  (a co-located sibling may register after the runner's first frames). */
  private executorCoLocatedSticky = false
  private executorCoLocated(): boolean {
    if (this.executorCoLocatedSticky) return true
    const local = this.ctx?.capabilities?.get('pipeline-executor')
    if (local !== undefined) {
      this.executorCoLocatedSticky = true
      this.ctx?.logger.info('executor co-located in this runner — raw in-process frame transport')
      return true
    }
    return false
  }

  /**
   * Refresh a device's package zone-union box, off the caller's path.
   *
   * Cross-addon reads go through `ctx.api` (the only cross-addon layer), and
   * they are RATE-LIMITED per device: this is reached from the per-frame
   * package gate, and two cap calls per frame would be a self-inflicted load
   * problem on the exact cameras the feature exists for.
   *
   * A FAILED read leaves the mirror untouched (D49): the last-known-good
   * geometry keeps being used, and a device that has never been read stays
   * absent from the map, which `motionNearPackageZone` treats as unknown and
   * fails OPEN on. Nothing here can make package detection quieter.
   */
  private refreshPackageZoneUnion(deviceId: number): void {
    const now = Date.now()
    const last = this.packageZoneUnionAt.get(deviceId) ?? 0
    if (now - last < PACKAGE_ZONE_UNION_TTL_MS) return
    this.packageZoneUnionAt.set(deviceId, now)
    const api = this.ctx.api
    if (!api) return
    void (async () => {
      try {
        const [zones, rules] = await Promise.all([
          api.zones.listZones.query({ deviceId }),
          api.zoneRules.listRules.query({ deviceId, stage: 'package' }),
        ])
        const zoneIds = new Set<string>(
          rules.filter((r) => r.enabled !== false).flatMap((r) => r.zoneIds),
        )
        const polygons = zones.filter((z) => zoneIds.has(z.id)).map((z) => z.polygon)
        const union = packageZoneUnion(polygons)
        const previous = this.packageZoneUnionByDevice.get(deviceId)
        this.packageZoneUnionByDevice.set(deviceId, union)
        if (previous === undefined && union !== undefined) {
          this.ctx.logger.info('package zone geometry resolved — motion proximity armed', {
            tags: { deviceId },
            meta: { zoneUnion: union, zones: polygons.length },
          })
        }
      } catch (err) {
        // Leave the mirror alone — see the docblock. Throttled by the TTL above.
        this.ctx.logger.warn('package zone geometry read failed — motion proximity fails open', {
          tags: { deviceId },
          meta: { error: err instanceof Error ? err.message : String(err) },
        })
      }
    })()
  }

  private async runMotionAnalysis(
    deviceId: number,
    frame: DecodedFrame,
    handle: FrameHandle | undefined,
  ): Promise<void> {
    const ctx = this.ctx
    const runner = this.runner
    if (!ctx || !runner) return

    // Task 10: this is the "existing motion-frame path" every arriving
    // substream frame flows through — teeing here (before the analyzer
    // round-trip below) is what lets an occupancy burst reuse decoded
    // motion frames instead of dialing. A no-op unless `startOccupancyTap`
    // armed a budget for this device.
    this.lastMotionFrameAt.set(deviceId, Date.now())
    this.teeOccupancyTapFrame(deviceId, frame, handle)

    const log = this.ctx.logger.withTags({ deviceId })
    const motionStart = Date.now()
    try {
      const api = this.ctx.api
      if (!api) {
        log.warn('runMotionAnalysis: this.ctx.api not available')
        return
      }
      // Always ship gray pixels inline to the motion provider (shm-ring removal
      // 2026-07-16 — the CB5 shm passthrough is gone). Motion frames were
      // already inline in the default session-decode path; this drops the dead
      // handle branch.
      const result = await api.motionDetection.analyze.mutate({
        deviceId,
        frame: toFrameInput(frame),
      })
      if (!result) return

      const detected = result.regions.length > 0
      // The recovery pass reads this on the next detection frame. Empty
      // regions are noted too: motion that stopped must not keep triggering
      // a second pass off the last positive blob.
      this.motionRegions.note(
        deviceId,
        result.regions,
        result.frameWidth,
        result.frameHeight,
        Date.now(),
      )

      // Is this motion NEAR the package zones? The settle-burst governor reads
      // this, and only this — the whole-frame `detected` below keeps its own
      // meaning for the phase machine. Cheap (a handful of box intersections)
      // and fails OPEN on unknown geometry, so a camera whose zones we could
      // not read behaves exactly as it did before proximity existed.
      this.lastMotionNearPackageZone.set(
        deviceId,
        motionNearPackageZone({
          regions: result.regions,
          frameWidth: result.frameWidth,
          frameHeight: result.frameHeight,
          zoneUnion: this.packageZoneUnionByDevice.get(deviceId),
        }),
      )

      // Emit `MotionOnMotionChanged` ONLY on transitions (analyzer runs
      // every motion frame at `motionFps`; we don't want one event per
      // frame). The runner's bus subscriber receives this and drives
      // the phase machine — same path Reolink's firmware events take.
      // No in-process `reportMotion` call here: the unified subscription
      // is the single dispatch point so onboard and analyzer go through
      // identical logic.
      const prevDetected = this.lastAnalyzerDetected.get(deviceId) ?? false
      if (detected !== prevDetected) {
        this.lastAnalyzerDetected.set(deviceId, detected)
        if (this.ctx.eventBus) {
          this.ctx.eventBus.emit(
            createEvent(
              EventCategory.MotionOnMotionChanged,
              // EventSource wrapper kept symmetric with the onboard
              // emit (Reolink/ONVIF/etc.) so consumers grouping by
              // addonId / deviceId see consistent provenance. `nodeId`
              // identifies which cluster node ran the analyzer.
              { type: 'device', id: deviceId, addonId: this.ctx.id, deviceId, nodeId: this.nodeId },
              {
                deviceId,
                detected,
                timestamp: frame.timestamp,
                source: 'analyzer',
                ...(detected ? { regions: result.regions } : {}),
              },
            ),
          )
        }
      }

      if (this.ctx.eventBus) {
        const motionPayload: MotionAnalysisPayload = {
          detected,
          regionCount: result.regions.length,
          regions: result.regions.map((r) => ({
            bbox: { x: r.bbox.x, y: r.bbox.y, w: r.bbox.w, h: r.bbox.h },
            pixelCount: r.pixelCount,
            intensity: r.intensity,
          })),
          frameWidth: frame.width,
          frameHeight: frame.height,
          analysisMs: result.analysisMs,
        }
        const analyzerSource = {
          type: 'device' as const,
          id: deviceId,
          addonId: this.ctx.id,
          deviceId,
          nodeId: this.nodeId,
        }
        this.ctx.eventBus.emit(
          createEvent(EventCategory.MotionAnalysis, analyzerSource, motionPayload),
        )

        const zonesPayload: MotionZonesRawPayload = {
          deviceId,
          timestamp: frame.timestamp,
          zones: result.rawRegions.map((r) => ({
            bbox: [r.bbox.x, r.bbox.y, r.bbox.x + r.bbox.w, r.bbox.y + r.bbox.h] as const,
            pixelCount: r.pixelCount,
            changeScore: r.intensity / 255,
          })),
          frameSize: { width: frame.width, height: frame.height },
        }
        this.ctx.eventBus.emit(
          createEvent(EventCategory.MotionZonesRaw, analyzerSource, zonesPayload),
        )
      }

      // frameAge = how stale the analyzed frame was (shm-ring commit → analysis
      // start). Large → decoder/ring behind, so the motion box lags real movement
      // even though emit→UI delivery is fast.
      const capturedAt = frame.capturedAt
      const motionFrameAge =
        typeof capturedAt === 'number' && capturedAt > 0 ? motionStart - capturedAt : -1
      runner.timingSampler.addMotionSample(deviceId, Date.now() - motionStart, motionFrameAge)
    } catch (error: unknown) {
      const msg = errMsg(error)
      log.error('runMotionAnalysis failed', { meta: { error: msg } })
    }
  }

  /**
   * Admit an occupancy recheck into the global queue. Deduped per camera (one
   * already queued or bursting is ignored; its latest frame-count wins) so a
   * fast recheck cadence can't stack requests. Draining is bounded by
   * `occupancyMaxConcurrent` so 25 cameras rechecking together don't spawn 25
   * parallel decoder dials.
   */
  private enqueueOccupancyBurst(deviceId: number, frames: number): void {
    // Battery sleep gate (D173). The recheck tick is armed by a session that
    // closed with objects still present, and it re-dials a decode — which on
    // a battery camera is a WAKE, issued 5 minutes after everyone stopped
    // asking. The camera went to sleep because the event ended; re-dialling it
    // to ask whether the event is still going is exactly the self-initiated
    // activation the contract forbids. A camera that is still AWAKE keeps the
    // recheck, which is when it is worth anything.
    //
    // Read off the in-memory mirror, never a fresh remote read: a gate that
    // round-trips is a gate that fails when the hub is busy (D49), and here a
    // failed read would re-dial the camera it is meant to protect.
    if (this.sleepingBatteryDevices.has(deviceId)) {
      this.ctx.logger.debug('occupancy recheck skipped — battery camera is sleeping', {
        tags: { deviceId },
      })
      return
    }
    this.occupancyFrames.set(deviceId, frames)
    if (this.occupancyBurstInFlight.has(deviceId) || this.occupancyQueued.has(deviceId)) return
    this.occupancyQueued.add(deviceId)
    this.occupancyQueue.push(deviceId)
    this.drainOccupancyQueue()
  }

  /** Start queued occupancy bursts up to the global concurrency cap. */
  private drainOccupancyQueue(): void {
    while (
      this.occupancyActiveCount < this.occupancyMaxConcurrent &&
      this.occupancyQueue.length > 0
    ) {
      const deviceId = this.occupancyQueue.shift()
      if (deviceId === undefined) break
      this.occupancyQueued.delete(deviceId)
      const frames = this.occupancyFrames.get(deviceId) ?? 4
      this.occupancyFrames.delete(deviceId)
      this.occupancyActiveCount++
      void this.runOccupancyBurst(deviceId, frames).finally(() => {
        this.occupancyActiveCount--
        this.drainOccupancyQueue()
      })
    }
  }

  /**
   * Shared burst-completion path (Task 9 report + Task 10 dial/tap
   * consolidation): clears the in-flight flag, reads the `found` flag the
   * `onResult` handler set while the burst was live, reports it to the
   * runner's arm/disarm state machine, and logs. Both the dial path
   * (`runOccupancyBurst`'s `cleanup`) and the tap path
   * (`finishOccupancyTap`) fold into this single implementation so the
   * found/report semantics can't drift between the two admission
   * mechanisms.
   */
  private finishOccupancyBurst(
    deviceId: number,
    log: IScopedLogger,
    summary: OccupancyBurstSummary,
  ): void {
    this.occupancyBurstInFlight.delete(deviceId)
    // Task 9: report the burst outcome back to the runner's arm/disarm
    // state machine. `found` reads the flag the `onResult` handler set
    // above while this burst was in flight — see `occupancyBurstFound`'s
    // doc for why that flag is unambiguous while `watching`. Since D652 the
    // burst reaches here only once its admitted frames have SETTLED, so the
    // flag has seen every result it is going to.
    const found = this.occupancyBurstFound.has(deviceId)
    this.occupancyBurstFound.delete(deviceId)
    // A burst that inferred NOTHING observed nothing: it is not evidence that
    // the scene is empty, so it produces no verdict and the arm's empty-burst
    // count is left exactly as it was (D652 ruling, D49 — a read that failed
    // changes nothing). It used to count as `found: false`, and two of them
    // disarmed the recheck on a camera nobody had looked at.
    if (summary.inferred === 0) {
      log.info('occupancy re-check: burst complete — nothing inferred, no verdict', {
        tags: { deviceId },
        meta: { ...summary, verdict: null },
      })
      return
    }
    this.runner?.reportOccupancyBurstOutcome(deviceId, found)
    const meta = { ...summary, found }
    // A verdict computed from fewer frames than the burst collected is a
    // branch that dropped work (D391): it is on the record, per camera.
    if (summary.lost > 0) {
      log.info('occupancy re-check: burst complete', { tags: { deviceId }, meta })
      return
    }
    log.debug('occupancy re-check: burst complete', { tags: { deviceId }, meta })
  }

  /**
   * Task 10: arm a TAP-based occupancy burst for a device whose analyzer
   * motion subscription is already flowing (`attachment.motionUnsubscribe
   * !== null` — see `runOccupancyBurst`). Frames feed in via
   * `teeOccupancyTapFrame`, called from `runMotionAnalysis` on every
   * arriving substream frame; NO new main-stream poller/decode session is
   * started. A safety timer (mirrors the dial path's) completes the burst
   * even if the motion subscription stops producing frames mid-burst.
   *
   * Returns a promise that resolves once the tap settles (budget drained or
   * safety timeout) — `runOccupancyBurst` awaits it so the global
   * `occupancyActiveCount` slot stays held for the tap's full duration, the
   * same as the dial path.
   */
  /**
   * Returns a promise that resolves with the tap's final `collected` count
   * once it settles (budget drained or safety timeout). The caller
   * (`runOccupancyBurst`) decides what to do with that count — report the
   * outcome via `finishOccupancyBurst` when frames were actually collected,
   * or fall back to a dial burst when the tap collected zero (Task 10
   * hardening #2). Resolving with the count rather than reporting from
   * inside the tap itself is what makes that fallback possible without
   * double-reporting.
   */
  private startOccupancyTap(
    deviceId: number,
    frames: number,
    log: IScopedLogger,
  ): Promise<OccupancyBurstSummary> {
    this.occupancyBurstInFlight.add(deviceId)
    this.occupancyBurstFound.delete(deviceId)
    log.debug('occupancy re-check: tapping live analyzer motion frames (no dial)', {
      meta: { frames },
    })

    return new Promise<OccupancyBurstSummary>((resolve) => {
      const safetyTimer = setTimeout(() => {
        const collected = this.occupancyTaps.get(deviceId)?.collected ?? 0
        log.debug('occupancy re-check: tap safety timeout reached', { meta: { collected } })
        this.finishOccupancyTap(deviceId)
      }, OCCUPANCY_BURST_SAFETY_TIMEOUT_MS)
      // The tap completes when its admitted frames have settled, not when the
      // last one was tee-d (D652).
      const ledger = new OccupancyBurstLedger({
        settleBoundMs: OCCUPANCY_BURST_SETTLE_BOUND_MS,
        onComplete: resolve,
      })
      this.occupancyTaps.set(deviceId, {
        remaining: frames,
        collected: 0,
        safetyTimer,
        ledger,
        resolve,
      })
    })
  }

  /**
   * Close the tap's COLLECTION. Idempotent: a no-op once the tap has already
   * closed (timer fired, or the budget already drained). The tap's promise
   * resolves later, from its ledger, once the frames it admitted have settled.
   */
  private finishOccupancyTap(deviceId: number): void {
    const tap = this.occupancyTaps.get(deviceId)
    if (!tap) return
    clearTimeout(tap.safetyTimer)
    this.occupancyTaps.delete(deviceId)
    tap.ledger.close()
  }

  /**
   * Tee an arriving analyzer motion frame into occupancy-burst detection
   * admission (Task 10). Called from `runMotionAnalysis` on EVERY
   * substream frame; a no-op unless `startOccupancyTap` armed a budget for
   * this device. The frame always feeds `enqueueOccupancyFrame` — the
   * handle may be `undefined` (e.g. the Epic-C per-session motion decode
   * worker never produces a shm handle) and `runInference` already falls
   * back to the pixel path in that case, so every arriving frame counts
   * toward the budget regardless of whether it carried a zero-copy handle.
   */
  private teeOccupancyTapFrame(
    deviceId: number,
    frame: DecodedFrame,
    handle: FrameHandle | undefined,
  ): void {
    const tap = this.occupancyTaps.get(deviceId)
    if (!tap) return
    const settle = tap.ledger.admit()
    if (!this.runner?.enqueueOccupancyFrame(deviceId, frame, handle, settle)) settle('lost')
    tap.collected++
    tap.remaining--
    if (tap.remaining <= 0) {
      this.finishOccupancyTap(deviceId)
    }
  }

  private async runOccupancyBurst(deviceId: number, frames: number): Promise<void> {
    if (this.occupancyBurstInFlight.has(deviceId)) return
    const attachment = this.attached.get(deviceId)
    if (!attachment) return
    const runner = this.runner
    if (!runner) return

    const log = this.ctx.logger.withTags({ deviceId })
    const api = this.ctx.api
    if (!api) {
      log.debug('runOccupancyBurst: ctx.api not available')
      return
    }

    // Task 10: when this camera's motion analyzer already holds a live
    // substream subscription (persistent `motionSources.includes('analyzer')`
    // path — see `attachCamera`), reuse its already-decoded frames instead of
    // dialing a brand-new main-stream decode session for the burst.
    // `attachment.motionUnsubscribe` is the runtime "handle exists" signal,
    // but a non-null handle does NOT prove frames are flowing — guarded-
    // session-decode can hand back its teardown synchronously, and a failed
    // `acquireSessionDecodeRestreamFrom` acquire never retries, leaving the
    // handle permanently non-null with zero frames arriving. `lastMotionFrameAt`
    // is the truthful liveness signal: only route to the tap when a motion
    // frame was actually teed within the freshness window.
    const lastFrameAt = this.lastMotionFrameAt.get(deviceId)
    const motionFresh =
      lastFrameAt !== undefined && Date.now() - lastFrameAt < MOTION_FRESHNESS_WINDOW_MS
    if (attachment.motionUnsubscribe !== null && motionFresh) {
      const summary = await this.startOccupancyTap(deviceId, frames, log)
      if (summary.frames > 0) {
        this.finishOccupancyBurst(deviceId, log, summary)
        return
      }
      // Task 10 hardening #2: the tap looked live (fresh motion frame,
      // non-null unsubscribe) but collected NOTHING by the safety timeout —
      // e.g. the subscription stalled mid-burst. Reporting `found: false`
      // here would be strictly worse than the old dial-only behaviour, so
      // fall back to a single dial burst for this SAME burst instead of
      // reporting. `alreadyInFlight: true` reuses the slot the tap already
      // holds (`occupancyBurstInFlight`/`occupancyActiveCount` stay single-
      // counted) and there is no further fallback from the dial path, so
      // this can never loop back into another tap.
      log.debug('occupancy re-check: tap collected 0 frames, falling back to dial', {
        meta: { frames },
      })
      await this.runOccupancyDial(deviceId, frames, attachment, runner, api, log, true)
      return
    }

    await this.runOccupancyDial(deviceId, frames, attachment, runner, api, log, false)
  }

  /**
   * Dial-path occupancy burst: spins up a fresh per-session decode worker
   * (session-decode) over the main stream and collects `frames` decoded frames
   * (or times out at {@link OCCUPANCY_BURST_SAFETY_TIMEOUT_MS}). Called either directly
   * from `runOccupancyBurst` (no live/fresh motion tap available,
   * `alreadyInFlight: false`) or as the Task 10 hardening #2 fallback after
   * a zero-collected tap (`alreadyInFlight: true` — the tap already claimed
   * the `occupancyBurstInFlight`/`occupancyBurstFound` slot, so this must
   * NOT re-add it).
   */
  private async runOccupancyDial(
    deviceId: number,
    frames: number,
    attachment: AttachedCamera,
    runner: PipelineRunner,
    api: AddonApi,
    log: IScopedLogger,
    alreadyInFlight: boolean,
  ): Promise<void> {
    const config = attachment.config
    const retainedFrames = this.retainedFrames

    if (!alreadyInFlight) {
      this.occupancyBurstInFlight.add(deviceId)
      this.occupancyBurstFound.delete(deviceId)
    }
    log.debug('occupancy re-check: starting burst', { meta: { frames, fallback: alreadyInFlight } })

    let count = 0
    /** Collection is over: no further frame is admitted to this burst. */
    let admissionClosed = false
    /** The burst has reported its verdict (or its lack of one). */
    let settled = false
    let teardown: SessionDecodeTeardown | null = null

    // The burst COMPLETES on inference, not on enqueue (D652): the verdict
    // reads the results. Closing collection and completing are two moments —
    // collection closing DRAINS the worker at once (no more decoding), and the
    // drain keeps the frames it admitted readable until they are inferred.
    const cleanup = (summary: OccupancyBurstSummary): void => {
      if (settled) return
      settled = true
      this.finishOccupancyBurst(deviceId, log, summary)
    }
    const ledger = new OccupancyBurstLedger({
      settleBoundMs: OCCUPANCY_BURST_SETTLE_BOUND_MS,
      onComplete: cleanup,
    })
    const closeAdmission = (): void => {
      if (admissionClosed) return
      admissionClosed = true
      clearTimeout(safetyTimer)
      // Stop decoding NOW: the burst has what it came for. A drain, not a kill
      // — the frames it admitted live in this worker until they are read.
      teardown?.('drain')
      ledger.close()
    }
    /** Offer one collected frame to the burst; `true` = the runner admitted it. */
    const admit = (frame: DecodedFrame, handle: FrameHandle | undefined): boolean => {
      const settle = ledger.admit()
      const admitted = runner.enqueueOccupancyFrame(deviceId, frame, handle, settle)
      if (!admitted) settle('lost')
      count++
      if (count >= frames) closeAdmission()
      return admitted
    }

    const safetyTimer = setTimeout(() => {
      log.debug('occupancy re-check: safety timeout reached', { meta: { collected: count } })
      closeAdmission()
    }, OCCUPANCY_BURST_SAFETY_TIMEOUT_MS)

    // Dial the burst through a disposable per-session decode worker over the
    // broker copy restream (the shared shm frame-handle poller was removed with
    // @camstack/shm-ring on 2026-07-16). `startGuardedSessionDecode` returns the
    // teardown SYNCHRONOUSLY and releases the restream immediately if the burst
    // settles before the acquire completes — no orphan worker, no leaked
    // refcount. Decoded rgb frames are retained in the node RAM store so the
    // occupancy detection's post-analysis can cut media (same handle path as
    // the standing detection decode).
    teardown = startGuardedSessionDecode({
      logger: log,
      admitWorker: this.buildLiveWorkerAdmit(deviceId, 'occupancy'),
      ...this.liveWorkerSlotWaiter(deviceId),
      acquire: () =>
        this.acquireSessionDecodeRestream(
          api,
          config.deviceId,
          config.detectionStreamId,
          `session-decode:occupancy:${config.deviceId}`,
          resolveSessionDecodeHostname(config, process.env['CAMSTACK_HUB_URL']),
          resolveSessionDecodeOwnerNodeId(config),
        ),
      startPump: (source, hooks) => {
        const useLocalFrameRef = this.executorCoLocated()
        return startSessionDecodePump({
          fork: this.forkDecodeWorkerWithLease,
          lease: this.resolveSessionLeaseKnobs,
          hwaccel: this.resolveSessionHwaccel,
          // The live-worker slot returns at the worker's real exit (D652).
          onWorkerGone: hooks.onWorkerGone,
          logger: log,
          source,
          opts: { fps: config.detectionFps, format: 'rgb' },
          // Collection is over but the burst is still waiting for its frames'
          // results (D652): the worker is DRAINING by then (decode stopped,
          // admitted frames kept readable), and a frame that still arrives is
          // refused before any pixel is materialized.
          shouldMaterializeFrame: () => !admissionClosed,
          ...(useLocalFrameRef
            ? {
                frameRegistry: localFrameRegistry,
                // Under backpressure the pixels are copied while the frame is
                // still reserved (see `inlineWhen` in the pump) — the same rule
                // the shm passthrough applies, asked per frame.
                inlineWhen: () => runner.detectionBackpressure(config.deviceId),
                inlineViewSpec: SPLIT_DETECTION_VIEW,
                onFrameRef: (frame: DecodedFrame, nativeCrop?: NativeCropRequester): boolean => {
                  if (admissionClosed) return false
                  const handle = writeRetainedDetectionFrame(
                    retainedFrames,
                    config.deviceId,
                    frame,
                    this.retention,
                  )
                  if (handle && nativeCrop) {
                    this.nativeCropRegistry.register(handle, nativeCrop, config.deviceId)
                    this.bindFrameCutter(handle, nativeCrop)
                  }
                  const admitted = admit(frame, handle)
                  if (admitted) nativeCrop?.markInferred()
                  return admitted
                },
              }
            : { inlineViewSpec: SPLIT_DETECTION_VIEW }),
          acquireSpawnSlot: this.buildDecodeSpawnAcquire(log, 'occupancy'),
          // The decode died: nothing more will be collected, and the frames it
          // already admitted settle on their own (a dead worker fails them fast).
          onEnded: () => closeAdmission(),
          onDecodedFrame: (frame, nativeCrop) => {
            if (admissionClosed) return
            const handle = writeRetainedDetectionFrame(
              retainedFrames,
              config.deviceId,
              frame,
              this.retention,
            )
            if (handle && nativeCrop) {
              this.nativeCropRegistry.register(handle, nativeCrop, config.deviceId)
              this.bindFrameCutter(handle, nativeCrop)
            }
            // Same mark as the standing detection decode: a burst frame that
            // entered the detection queue is one post-analysis can later name.
            if (admit(frame, handle)) nativeCrop?.markInferred()
          },
        })
      },
    })

    // Guard the pathological case where collection closed synchronously (e.g.
    // an immediate `onEnded`) before `teardown` was assigned — tear it down now.
    if (admissionClosed) {
      clearTimeout(safetyTimer)
      teardown('drain')
    }
  }

  private emitInferenceResult(
    deviceId: number,
    frame: DecodedFrame,
    result: FrameResult,
    handle: FrameHandle | undefined,
    source: DetectionSource,
    occasion: InferenceOccasion,
  ): void {
    const ctx = this.ctx
    if (!ctx?.eventBus) return

    // The new FrameResult already carries width/height/timestamp at the
    // root + debug.stepTimings / debug.totalInferenceMs. No frameMetadata
    // wrapper needed — the hub subscribes and reads `payload.frame`
    // directly. The `frameHandle` lets post-analysis consumers (Task 8)
    // resolve the original decoded frame zero-copy from the shm ring.
    // `capturedAt` (shm-commit wall-clock) is forwarded so downstream
    // consumers can measure true frame-capture → delivery latency.
    const capturedAt = frame.capturedAt
    // `detailSteps` was precomputed once at attach time (see
    // `deriveDetailSteps`) — an omitted attachment (e.g. a race with
    // detach) degrades to no announce rather than throwing. An attached camera
    // with NO child steps announces an EMPTY list (D692): "no recogniser runs
    // here" is an answer the notification centre's grouped windows close on,
    // while a missing field reads as "unknown" and makes them wait.
    // The root-supply plan's announce (D730) supersedes the attach-time one once
    // a frame has been inferred: it is the same derivation plus `filledBy`.
    const detailSteps =
      this.rootSupplyCache.get(deviceId)?.announces ?? this.attached.get(deviceId)?.detailSteps
    // `emittedAt` is stamped HERE, at the handover to the bus, and is
    // unconditional — a frame with no `capturedAt` must still be measurable.
    // It is what lets a consumer tell a late DELIVERY (starved) apart from its
    // own slow processing (waiting): the two produce an identical signature —
    // a silence, then a burst-drain — and nothing else in the system separates
    // them. Read `frame-lag-observer.ts` in `addon-post-analysis` before
    // interpreting the number: this clock is the RUNNER's, so only the delta
    // against a camera's own baseline is trustworthy.
    const payload: PipelineInferenceResultPayload = {
      deviceId,
      frame: result,
      nodeId: this.nodeId,
      frameHandle: handle,
      emittedAt: Date.now(),
      ...(typeof capturedAt === 'number' && capturedAt > 0 ? { capturedAt } : {}),
      ...(detailSteps !== undefined ? { detailSteps } : {}),
      // WHICH root detector produced these boxes. A camera-native result
      // reaches this emit through the same callback as the pipeline's, with
      // the same frame and the same handle — the discriminator is this field,
      // not a door of its own, which is what lets an onboard-born track carry
      // the `detailSteps` announce above and get a face, a plate and an
      // embedding like any other.
      source,
      // WHY it was inferred. A recheck burst and a session frame are the same
      // pixels through the same steps, and the stationary ledger keeps separate
      // tallies for them — it could not, while every burst arrived unlabelled.
      occasion,
    }

    this.ctx.eventBus.emit(
      createEvent(
        EventCategory.PipelineInferenceResult,
        { type: 'device', id: deviceId, nodeId: this.nodeId },
        payload,
      ),
    )
  }

  /**
   * Emit periodic metric snapshots: one runner-load event for the
   * node + one camera-metrics event per attached camera. Subscribed
   * by admin-ui dashboards (LiveLoadPanel, NodeDetailHeader,
   * CameraStreamPanel) to drive live overlays without polling.
   *
   * Skipped when there are no cameras attached so quiet dev runs
   * don't emit needless bus traffic. The runner-load event is still
   * emitted in that case because the dashboards rely on it to see
   * "agent reachable, idle".
   */
  private emitMetricsSnapshot(): void {
    const ctx = this.ctx
    const runner = this.runner
    if (!ctx?.eventBus || !runner) return
    const timestamp = Date.now()

    // Runner-load snapshot. Skip emit when the load payload is
    // bytewise-identical to the previous one (idle node — same
    // running-cap counts, same queue depths, same memory). Heartbeat
    // re-emits every METRICS_HEARTBEAT_MS so the "agent reachable"
    // chip in the UI doesn't go stale.
    void this.getLocalLoad()
      .then((load) => {
        if (!ctx.eventBus) return
        const json = JSON.stringify(load)
        const prev = this.lastEmittedRunnerLoad
        const heartbeatDue = !prev || timestamp - prev.emittedAt >= METRICS_HEARTBEAT_MS
        if (prev && prev.json === json && !heartbeatDue) return
        this.lastEmittedRunnerLoad = { json, emittedAt: timestamp }
        ctx.eventBus.emit(
          createEvent(
            EventCategory.PipelineRunnerLoadSnapshot,
            { type: 'node', id: this.nodeId, nodeId: this.nodeId },
            { nodeId: this.nodeId, load, timestamp },
          ),
        )
      })
      .catch(() => {
        // Skip this tick on transient failure — next interval will
        // reconcile. No need to log: the snapshot is a soft observability
        // path, not a correctness boundary.
      })

    // Per-camera metrics snapshot — same defer pattern.
    if (this.attached.size === 0) return
    for (const deviceId of this.attached.keys()) {
      const metrics = runner.getCameraMetrics(deviceId)
      if (!metrics) continue
      const json = JSON.stringify(metrics)
      const prev = this.lastEmittedCameraMetrics.get(deviceId)
      const heartbeatDue = !prev || timestamp - prev.emittedAt >= METRICS_HEARTBEAT_MS
      if (prev && prev.json === json && !heartbeatDue) continue
      this.lastEmittedCameraMetrics.set(deviceId, { json, emittedAt: timestamp })
      ctx.eventBus.emit(
        createEvent(
          EventCategory.PipelineCameraMetricsSnapshot,
          { type: 'device', id: deviceId, nodeId: this.nodeId },
          { deviceId, nodeId: this.nodeId, metrics, timestamp },
        ),
      )
    }
  }

  // ── Standard ICamstackAddon — three-level settings API (Phase 3) ─────
  //
  // The runner is a per-node addon with only ADDON-LEVEL settings (no
  // per-device overrides, no cluster-wide tunables). All four tuning
  // fields live in `getAddonSettings()`. When the UI surface moves in
  // Phase 9 these will be rendered under Pipeline -> node -> Settings.

  protected globalSettingsSchema() {
    return this.schema({
      sections: [
        {
          id: 'pipeline-runner-tuning',
          title: 'Pipeline Runner',
          tab: 'scheduler',
          // Stored ONCE for the cluster (no `perNode`): every node's runner
          // reads these values, so they are edited on Cluster → Settings.
          description:
            "Values every node's detection runner uses. A node's own decode limits (Engine & decoder) take precedence over the two decode values.",
          columns: 2,
          fields: [
            {
              type: 'slider',
              key: 'maxConcurrentInferences',
              label: 'Scheduler concurrency',
              description:
                'Most inferences a node runs at once, across all its cameras. Not the same as the pool threads on the node Scheduler tab.',
              min: 1,
              max: 16,
              step: 1,
              default: DEFAULT_CONFIG.maxConcurrentInferences,
              showValue: true,
            },
            {
              type: 'slider',
              key: 'maxQueueDepth',
              label: 'Max queue depth',
              description: 'Maximum frames held per camera before dropping.',
              min: 5,
              max: 100,
              step: 5,
              default: DEFAULT_CONFIG.maxQueueDepth,
              showValue: true,
            },
            {
              type: 'slider',
              key: 'targetLoadPercent',
              label: 'Target load',
              description: 'Percentage of inference capacity to target before throttling FPS.',
              min: 50,
              max: 100,
              step: 5,
              default: DEFAULT_CONFIG.targetLoadPercent,
              unit: '%',
              showValue: true,
            },
            {
              type: 'slider',
              key: 'minThrottledFps',
              label: 'Min throttled FPS',
              description: 'Lowest FPS the runner will allow when load-shedding.',
              min: 1,
              max: 10,
              step: 1,
              default: DEFAULT_CONFIG.minThrottledFps,
              showValue: true,
            },
            {
              type: 'slider',
              key: 'maxConcurrentDecodeSpawns',
              label: 'Max concurrent decode-worker spawns',
              description:
                'How many camera decoders a node may START at the same moment; the rest wait their turn. Stops a burst of motion on many cameras from overloading the GPU.',
              min: 1,
              max: 16,
              step: 1,
              default: DEFAULT_CONFIG.maxConcurrentDecodeSpawns,
              showValue: true,
            },
            {
              type: 'slider',
              key: 'maxLiveDecodeWorkers',
              label: 'Max live decode workers',
              description:
                'Most camera decoders running at once on a node (the RAM budget below usually decides first). A camera that does not fit is retried as soon as one frees up.',
              min: 1,
              max: 32,
              step: 1,
              default: DEFAULT_CONFIG.maxLiveDecodeWorkers,
              showValue: true,
            },
            {
              type: 'slider',
              key: 'nodeDecodeBudgetMb',
              label: 'Decode worker RAM budget (MB)',
              description:
                'RAM a node lets its camera decoders use, unless the node sets its own on Engine & decoder. Left at the default, each node uses half its RAM (2–16 GB). Each decoder counts ~660 MB with the default full-resolution crop settings, so raising those lowers how many decoders run at once.',
              min: 1024,
              max: 32_768,
              step: 512,
              default: DEFAULT_CONFIG.nodeDecodeBudgetMb,
              showValue: true,
            },
          ],
        },
        {
          id: 'node-decode-limits',
          title: 'Decode limits',
          tab: 'engine',
          description:
            "How much live decode THIS node may run. Auto uses the cluster default above, else half this node's RAM. The runner picks up changes on its next lease refresh.",
          columns: 2,
          fields: [
            {
              type: 'slider',
              key: 'decodeBudgetMb',
              label: 'Decode RAM budget (MB)',
              description: 'RAM for live camera decoders on this node. Auto = cluster / half RAM.',
              min: 1024,
              max: 65_536,
              step: 512,
              default: undefined,
              showValue: true,
              nullable: true,
              nullLabel: 'Auto',
              perNode: true,
            },
            {
              type: 'slider',
              key: 'decodeMaxLiveWorkers',
              label: 'Max live decode workers',
              description:
                'Most camera decoders running at once on this node. Auto = cluster Max live decode workers.',
              min: 1,
              max: 32,
              step: 1,
              default: undefined,
              showValue: true,
              nullable: true,
              nullLabel: 'Auto',
              perNode: true,
            },
          ],
        },
      ],
    })
  }

  protected async onConfigChanged(): Promise<void> {
    this.runner?.updateLimits(this.config)
    // Hot-resize the decode-worker spawn gate (P5). In-flight permits are
    // preserved; growing wakes queued forks immediately, shrinking drains
    // naturally (see Semaphore.resize).
    this.spawnGate?.resize(Math.max(1, this.config.maxConcurrentDecodeSpawns))
    // Lowering this never tears down a running session — see
    // `LiveDecodeWorkerAdmission.resize`; the count drains as sessions end.
    this.applyNodeDecodeLimits('settings')
    this.ctx.logger.info('pipeline-runner tuning updated', {
      meta: {
        maxQueueDepth: this.config.maxQueueDepth,
        maxConcurrentInferences: this.config.maxConcurrentInferences,
        targetLoadPercent: this.config.targetLoadPercent,
        minThrottledFps: this.config.minThrottledFps,
        maxConcurrentDecodeSpawns: this.config.maxConcurrentDecodeSpawns,
        maxLiveDecodeWorkers: this.config.maxLiveDecodeWorkers,
        nodeDecodeBudgetMb: this.config.nodeDecodeBudgetMb,
        decodeCeilingInForce: this.liveWorkers?.ceiling,
        decodeWorkerFootprintMb: decodeWorkerFootprintMb(this.nativeLease.current()),
      },
    })
  }
}

/**
 * Static `customActions` catalog — read by the addon registry at boot time
 * (before instantiating the addon class) so cross-process Moleculer routes
 * can be wired for `addons.custom.<action>` dispatch. Mirrors the pattern
 * in addon-benchmark/index.ts.
 */
export { pipelineRunnerBenchActions as customActions } from './bench-actions.js'
export { FrameQueue } from './frame-queue.js'
// Re-export for tests / consumers that need direct class access.
export { PipelineRunner } from './runner.js'
export { Semaphore } from './semaphore.js'
export { PipelineTimingSampler } from './timing-sampler.js'
