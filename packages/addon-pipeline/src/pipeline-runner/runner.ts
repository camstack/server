import type {
  CameraMetrics,
  CameraNativeDetection,
  CameraPhase,
  DecodedFrame,
  DetectionSource,
  DetectionSources,
  InferenceOccasion,
  FrameHandle,
  FrameInput,
  FrameRef,
  FrameResult,
  IScopedLogger,
  MotionRegion,
  MotionSource,
  SessionTrigger,
  OrchestratorMetrics,
  PipelinePhaseMode,
} from '@camstack/types'
import { DEFAULT_NATIVE_LEASE_SETTINGS } from '@camstack/types'
import type { CameraLoadSample } from './frame-governor.js'
import { FrameGovernor } from './frame-governor.js'
import { REASON_INFERENCE_TIMEOUT } from './failure-report.js'
import { FrameQueue, ownFrame } from './frame-queue.js'
import { PreRollLane } from './pre-roll-lane.js'
import { isContinuousRetainEnabled } from './on-demand-retention.js'
import type { DetectionSourcePlan, OnboardDetectionSlot } from './detection-source-plan.js'
import {
  ONBOARD_ROOT_IDLE_REPORT_MS,
  onboardRootDetections,
  planDetectionSources,
} from './detection-source-plan.js'
import { Semaphore } from './semaphore.js'
import { tallyBelowFloor } from './below-floor-tally.js'
import { PipelineTimingSampler } from './timing-sampler.js'
import type { MacroGateSettings } from '../detection-pipeline/pipeline/macro-gate.js'

export type StreamType = 'motion' | 'detection'

/**
 * Metadata accompanying a phase transition emitted by the runner.
 * The addon wrapping the scheduler turns this into a `motion`
 * cap-state slice + an `onMotionChanged` bus event.
 */
export type PhaseTransitionMeta =
  | MotionPhaseTransitionMeta
  | AttachPhaseTransitionMeta
  | DetachPhaseTransitionMeta

/** The motion gate of an `on-motion` registration opened or its cooldown closed it. */
export interface MotionPhaseTransitionMeta {
  readonly cause: 'motion'
  readonly source: MotionSource
  readonly regions?: ReadonlyArray<MotionRegion>
  readonly timestamp: number
  readonly cooldownMs: number
}

/**
 * The phase opened because the camera was ATTACHED `always-on`. Every
 * on-motion detection SESSION attaches that way, so this is the shape of every
 * session open on this fleet. `trigger` is the motion that opened the session
 * as the orchestrator dispatched it (`sessionTrigger` on the attach, D672 rule
 * 11 amended 2026-10-06); absent when the attach had no motion behind it.
 *
 * Until 2026-10-06 the open carried a hardcoded `source: 'analyzer'` + the
 * cooldown, and the close emitted nothing: the live phase badge latched
 * "Active" after every session, and the events list read "Motion detected —
 * phase active (analyzer, 30s cooldown)" on cameras that do not even list the
 * analyzer.
 */
export interface AttachPhaseTransitionMeta {
  readonly cause: 'attach'
  readonly timestamp: number
  readonly trigger?: SessionTrigger
}

/** The camera was DETACHED while `active`: the session is over. */
export interface DetachPhaseTransitionMeta {
  readonly cause: 'detach'
  readonly timestamp: number
}

export interface RunnerConfig {
  readonly maxQueueDepth: number
  readonly maxConcurrentInferences: number
  readonly targetLoadPercent: number
  readonly minThrottledFps: number
  /**
   * Run inference on a detection frame (heavy, semaphore-limited). `handle`
   * is the shm `FrameHandle` for the SAME frame when the CB5 passthrough gate
   * elected to hand it to the executor (zero-copy read); `undefined` when the
   * gate fell back to shipping pixels (`frame`). `frame` (pixels) is ALWAYS
   * supplied so the callback can pick either transport per the handle.
   */
  readonly processFrame: (
    deviceId: number,
    frame: FrameInput,
    handle: FrameHandle | undefined,
  ) => Promise<FrameResult | null>
  /**
   * Analyze a motion frame for activity (lightweight, no semaphore). `handle`
   * mirrors {@link processFrame} — the shm `FrameHandle` when the passthrough
   * gate elected it, else `undefined` (pixel fallback).
   */
  readonly analyzeMotion: (
    deviceId: number,
    frame: DecodedFrame,
    handle: FrameHandle | undefined,
  ) => Promise<void>
  /** Releases the queue owner's process-local frame lease. */
  readonly releaseFrameRef?: (
    ref: FrameRef,
    reason: 'success' | 'error' | 'drop' | 'detach',
  ) => void
  /**
   * Pending-retention cleanup (admission → result). Must not invalidate a
   * detection already transferred to the late-media store on `success`.
   */
  readonly releaseRetention?: (
    handle: FrameHandle,
    reason: 'success' | 'error' | 'drop' | 'detach',
  ) => void
  /**
   * Hydrate the RAM retained-frame fallback with a content-sized view before
   * the local `frameRef` is released. Best-effort; native tiles stay primary.
   */
  readonly hydrateRetainedFrame?: (handle: FrameHandle) => Promise<unknown>
  /**
   * Say that this frame WILL BE ASKED ABOUT, so the decode worker keeps a
   * native copy of it when the next pull supersedes it.
   *
   * The worker's lease admits a frame on the premise that "a native crop can
   * only ever name a frameId that rode an INFERENCE RESULT" — which is why the
   * mark is called `markInferred` and why it is sent from the enqueue turn.
   * On a camera whose ROOT detector is the firmware that premise is simply
   * false: nothing is enqueued to the ML, nothing is marked, and yet the
   * result is published with a handle that post-analysis names moments later.
   * The worker has been saying so all along — `native crop named an UNINFERRED
   * frame … the 'inferred' lease-admission premise does not hold on this path`.
   *
   * Measured on device 106: 645 leases offered, 1 admitted, 0 frames kept, and
   * every later crop a miss. Inference was never the fact the lease needed —
   * it was a PROXY for "somebody will ask", and on this path the proxy is false
   * while the fact is true.
   */
  readonly markFrameAskable?: (handle: FrameHandle) => void
  /**
   * Fired on every phase transition (`watching ↔ active`). The
   * surrounding addon hooks this to (1) write the device's `motion`
   * cap-state slice via the unified `device-state.setCapSlice`
   * entrypoint and (2) emit `motion.onMotionChanged` on the bus.
   * Optional — test harnesses skip it.
   */
  readonly onPhaseChanged?: (
    deviceId: number,
    phase: CameraPhase,
    meta: PhaseTransitionMeta,
  ) => void
  /** Optional scoped logger; when provided, motion-gate transitions log here. */
  readonly logger?: IScopedLogger
  readonly onOccupancyRecheck?: (deviceId: number, frames: number) => void
  /**
   * Upper bound on a single `processFrame` call, in ms. A call that has not
   * settled by then has its PERMIT released and its (eventual) result
   * discarded — the call itself cannot be cancelled, but it stops holding the
   * runner hostage.
   *
   * This exists because an unbounded await wedged the whole runner on
   * 2026-07-30: `tick()` returns immediately while `semaphore.available <= 0`,
   * so N hung calls (N = `maxConcurrentInferences`) stop EVERY camera on the
   * node from being inferred. Motion kept flowing — `drainMotionQueues()` runs
   * before that gate — which is exactly why it read as "the camera sees
   * movement and detects nothing" for 30+ minutes.
   *
   * Default {@link DEFAULT_INFERENCE_TIMEOUT_MS}, well above the worst
   * legitimate inference observed on this fleet (~8.6 s under GPU contention).
   */
  readonly inferenceTimeoutMs?: number
  /**
   * How long the scheduler may sit with zero available permits AND queued
   * detection work before it says so, in ms. Bounds the "silent" window: the
   * outage above produced not one line in 30 minutes.
   * Default {@link DEFAULT_INFERENCE_STALL_WARN_MS}.
   */
  readonly inferenceStallWarnMs?: number
  /**
   * Per-CAMERA inference outcome counter (`failure-contribution`, family
   * `inference`).
   *
   * `reason` absent = the call returned inside the deadline — the DENOMINATOR.
   * ~120 `inference timed out` in six hours across seven cameras were never
   * investigated on 2026-08-28, and the reason is that the log line could be
   * counted but not divided: 120 timeouts out of 120 000 admitted frames and
   * out of 1 200 are opposite findings that read identically.
   *
   * Optional so the runner stays constructible in tests without a counter.
   */
  readonly noteInferenceOutcome?: (deviceId: number, reason?: string) => void
  /**
   * How many frames of ONE camera may be in inference at once. The decode
   * worker holds `holdFrames` native frames for the runner's lazy refs and
   * evicts the OLDEST when a newer marked frame lands, so more than
   * `holdFrames - 1` outstanding refs of one camera is a guarantee that the
   * earliest are unreadable by the time the engine gets to them (a cold engine
   * at session start let 16 in: ids 1–8 were gone, 2026-09-06). Defaults to
   * the shipped hold minus one; the wrapper keeps it in step with the lease
   * setting through {@link PipelineRunner.setMaxInflightPerCamera}.
   */
  readonly maxInflightPerCamera?: number
  /**
   * Frames one camera's PRE-ROLL lane may hold (see `pre-roll-lane.ts`). This is
   * the RAM bound on a catch-up burst — each entry owns its pixels — and it is
   * deliberately separate from `maxQueueDepth`, which the latest-only live
   * queue ignores. Absent ⇒ {@link DEFAULT_MAX_PRE_ROLL_QUEUE_DEPTH}.
   */
  readonly maxPreRollQueueDepth?: number
}

/**
 * Default depth of one camera's pre-roll lane.
 *
 * 12 frames over a ~4 s retained window is one frame per ~333 ms of footage.
 * The measured miss it has to reach — device 102, a cyclist scored
 * `vehicle 0.5669` 1.68 s before the live track was born, then 0.5366 100 ms
 * later, peaking 0.7876 — sits comfortably inside that stride, and the transit
 * lasted ~2.5 s, so a 333 ms stride offers ~7 chances at it.
 *
 * The COST is what fixes the number: at the 40 ms/frame inference this hub
 * measures, 12 frames is ~480 ms of ONE inference permit, one-shot at session
 * open, taken only when a permit would still be spare for live
 * (see {@link PRE_ROLL_PERMIT_RESERVE}). Raising it buys temporal density in
 * history that the decoder has already paid to produce; it does not buy
 * anything the live path was going to see anyway.
 */
export const DEFAULT_MAX_PRE_ROLL_QUEUE_DEPTH = 12

/**
 * Inference permits kept out of reach of the pre-roll lane.
 *
 * A catch-up burst is bounded work, but several cameras opening on the SAME
 * motion event would otherwise start their bursts together and occupy every
 * permit with history while a live frame waits behind them. Reserving one
 * permit makes that impossible without any cross-camera coordination: the lane
 * simply never dispatches unless a permit would still be free afterwards.
 */
export const PRE_ROLL_PERMIT_RESERVE = 1

/**
 * Bound on one `processFrame` call. Chosen well above the slowest legitimate
 * inference seen in production (8 102 ms, GPU contention on the hub) so the
 * timeout only ever fires on a call that is genuinely never coming back.
 */
const DEFAULT_INFERENCE_TIMEOUT_MS = 20_000

/** Grace period before a permit-starved scheduler with queued work warns. */
const DEFAULT_INFERENCE_STALL_WARN_MS = 60_000

/** Re-warn cadence while a stall persists, so a wedge stays visible. */
const INFERENCE_STALL_REWARN_MS = 60_000

/**
 * Sentinel distinguishing "the bound expired" from a legitimate `null`
 * (`processFrame` returning no result). A unique symbol, so it can never
 * collide with a value the executor produces.
 */
const TIMED_OUT: unique symbol = Symbol('inference-timed-out')

/**
 * Per-camera registration. Mirrors the public RunnerCameraConfig but
 * narrowed to the fields the scheduler core actually needs (mode, fps,
 * cooldown). Broker subscription details are owned by the addon class
 * wrapping this scheduler — they don't reach the scheduler itself.
 */
export interface CameraRegistration {
  /** Operator-facing scheduling mode for the SW detection pipeline.
   *  `'disabled'` — scheduler stays in `'idle'`, never processes frames.
   *  `'always-on'` — initial phase `'active'`, no motion-gate fallback.
   *  `'on-motion'` — initial phase `'watching'`, motion-gated. */
  readonly detectionMode: PipelinePhaseMode
  /**
   * Which root detectors this camera runs (`planDetectionSources`). Absent is
   * `['pipeline']` — an attach older than the field behaves as it always did.
   */
  readonly detectionSources?: DetectionSources
  /** What opened this attach (a session attach only) — named on the `attach` phase event. */
  readonly sessionTrigger?: SessionTrigger
  /**
   * The OPERATOR's gate on a detection — `enabledMacroClasses` and the
   * `minConfidence<Macro>` floors, read off the ROOT step's settings.
   *
   * Carried on the registration because the onboard root needs it and the
   * executor, which is where it used to be applied, is not on that path. On a
   * camera whose root is the firmware these had never run on a single
   * detection: the recorder refused to act on them for exactly that reason
   * (`not-pipeline`), because acting would have made the operator's sliders
   * describe one detection while the recording followed another.
   */
  readonly objectGate?: MacroGateSettings
  readonly fps: number
  readonly motionCooldownMs?: number
  /** Master toggle — the occupancy recheck timer only arms when this is true. */
  readonly occupancyRecheckEnabled?: boolean
  readonly occupancyRecheckSec?: number
  readonly occupancyRecheckFrames?: number
}

export type ResultCallback = (
  deviceId: number,
  frame: DecodedFrame,
  result: FrameResult,
  streamType: StreamType,
  handle: FrameHandle | undefined,
  /**
   * WHICH root detector produced `result`. Passed, never inferred: the
   * alternative is reading it back out of a frame id, and a discriminator that
   * has to be parsed out of a string is one rename away from being wrong.
   */
  source: DetectionSource,
  /**
   * WHY this frame was inferred — a session frame the pipeline was decoding
   * anyway, or a periodic occupancy-recheck burst. Passed for the same reason
   * `source` is: the alternative is inferring it downstream from the camera's
   * phase, and a discriminator nobody states is one refactor away from lying.
   */
  occasion: InferenceOccasion,
) => Promise<void> | void

/**
 * Detection-queue entry — the runner's detection path carries the
 * `FrameHandle` paired with the decoded frame end-to-end so that the
 * emitted `PipelineInferenceResultPayload` can name the same shm slot
 * downstream consumers (post-analysis) read pixels from. Motion frames
 * never propagate beyond the runner so the motion queue keeps queueing
 * bare `DecodedFrame`s.
 */
export interface DetectionQueueEntry {
  readonly frame: DecodedFrame
  /**
   * The shm `FrameHandle` for zero-copy passthrough, or `undefined` when the
   * frame arrived WITHOUT a mappable handle — the shm poller's foreign/remote
   * fallback, or the Epic C per-session decode worker (IPC pixels, no shm ring
   * at all). Downstream `processFrame`/result callbacks already accept
   * `FrameHandle | undefined` and gate on `handle !== undefined`.
   */
  readonly handle: FrameHandle | undefined
  /**
   * Why this frame is here — REQUIRED, and named by the enqueue path that
   * owns the frame, never inferred downstream.
   *
   * It was optional with an "absent = session" default, and from 2026-09-14
   * to 2026-09-16 the LIVE session path (`enqueueReservedDetectionFrame`)
   * stamped `'burst'` while only the pre-roll lane fell through to the
   * default. Every consumer counting "how much of this object's evidence came
   * from the periodic recheck" was therefore reading session frames — 40 431
   * "burst" agreements on one candidate, against a recheck that produces at
   * most 1 152 frames a day. A required field cannot fall through.
   */
  readonly occasion: InferenceOccasion
  /**
   * Told how this frame ENDED, exactly once (D652). The occupancy burst
   * completes on these, not on its enqueues. Absent for every frame nobody is
   * waiting on. See {@link FrameSettleOutcome}.
   */
  readonly onSettled?: (outcome: FrameSettleOutcome) => void
}

/**
 * How a queued detection frame ended (D652):
 * - `inferred` — a result came back and every result callback has run;
 * - `superseded` — a newer frame of the same camera took its place on the
 *   latest-only queue: the queue's design, not a loss;
 * - `lost` — the runner let it go without a result: cleared by a detach or a
 *   session close, failed, timed out, or answered with nothing.
 */
export type FrameSettleOutcome = 'inferred' | 'superseded' | 'lost'

/**
 * Motion-queue entry (CB5). Mirrors {@link DetectionQueueEntry}: the motion
 * path now carries the shm `FrameHandle` alongside the decoded frame so the
 * runner can hand a hub-local motion provider the handle (zero-copy read)
 * instead of re-serialising ~1.2MB of gray pixels over UDS. The handle is
 * optional — a poll that produced pixels without a mappable handle (foreign
 * source, remote fallback) still enqueues with `undefined` and the motion
 * provider reads the inline pixels.
 */
export interface MotionQueueEntry {
  readonly frame: DecodedFrame
  readonly handle: FrameHandle | undefined
}

export type DetectionStreamHandler = (deviceId: number, action: 'subscribe' | 'unsubscribe') => void

interface CameraState {
  readonly registration: CameraRegistration
  /**
   * The camera's most recent onboard detections, waiting to be paired with a
   * decoded frame. MUTABLE and single-slot on purpose: only the freshest push
   * can describe the frame about to be processed, and a queue of them would
   * hand the tracker the same subject several times from several instants.
   */
  onboardSlot: OnboardDetectionSlot | null
  readonly motionQueue: FrameQueue<MotionQueueEntry>
  readonly detectionQueue: FrameQueue<DetectionQueueEntry>
  /**
   * History frames waiting for a spare permit — FIFO, oldest first, drained
   * only when {@link CameraState.detectionQueue} is empty so a pre-roll frame
   * can never delay a live one.
   */
  readonly preRollQueue: PreRollLane<DetectionQueueEntry>
  readonly inferenceTimes: number[]
  /**
   * Frames the POOL deliberately refused (`FrameResult.shed`), as opposed to
   * frames the runner's own queues refused. Separate field, folded into the
   * reported `droppedFrames`, because the two have different causes and the
   * governor must keep reading the QUEUE counter alone — a pool shed is
   * already flow control and must not also throttle the camera that suffered it.
   */
  shedFrames: number
  /** Frames of this camera currently inside `processWithSemaphore`. */
  inflight: number
  processedCount: number
  startTime: number
  phase: CameraPhase
  motionCooldownTimer: ReturnType<typeof setTimeout> | null
  /**
   * Source that armed the current cooldown timer. Carried into the
   * transition-to-watching event so consumers know which path was
   * the last positive signal before timeout.
   */
  lastArmedSource: MotionSource | null
  /** Regions from the most recent positive `analyzer` event — undefined for `onboard`. */
  lastArmedRegions: ReadonlyArray<MotionRegion> | undefined
  occupancyTimer: ReturnType<typeof setInterval> | null
  /**
   * True while an `analyzeMotion` call is in flight for this camera. The drain
   * is single-flight per camera: newer frames overwrite the latest-only motion
   * queue (dropped) and are picked up when the in-flight call settles, bounding
   * concurrent motion RPCs to 1/camera (a slow motion provider can no longer
   * pile up unbounded fire-and-forget calls).
   */
  motionInFlight: boolean
  /**
   * Detection count from the runner's most recent inference result for this
   * camera (see {@link PipelineRunner.noteDetectionResult}). Read at the
   * active→watching transition to decide whether the occupancy recheck timer
   * arms for the upcoming `watching` phase — a session that closed with
   * nothing detected has no reason to keep polling an empty room.
   */
  lastResultDetections: number
  /**
   * Gates the occupancy timer body (see {@link PipelineRunner.registerCamera}):
   * the timer only fires `onOccupancyRecheck` while `watching && occupancyArmed`.
   * Set at the active→watching transition, cleared after two consecutive empty
   * bursts (see {@link PipelineRunner.reportOccupancyBurstOutcome}).
   */
  occupancyArmed: boolean
  /** Consecutive empty occupancy-burst outcomes since the timer last armed. */
  emptyBurstStreak: number
}

/**
 * Clone a {@link DetectionQueueEntry} for the queue's copy-on-retain
 * boundary: the inner frame's pixel buffer is detached via
 * {@link ownFrame}, the `FrameHandle` is carried through unchanged (it's
 * a plain serialisable record with no borrowed buffers).
 */
function ownDetectionEntry(entry: DetectionQueueEntry): DetectionQueueEntry {
  return {
    frame: ownFrame(entry.frame),
    handle: entry.handle,
    occasion: entry.occasion,
    // Carried through the copy-on-retain boundary: a clone that dropped it
    // would leave the frame's owner waiting on a settle that never comes.
    ...(entry.onSettled ? { onSettled: entry.onSettled } : {}),
  }
}

/**
 * Clone a {@link MotionQueueEntry} for the queue's copy-on-retain boundary —
 * same contract as {@link ownDetectionEntry}: detach the borrowed shm pixels,
 * carry the plain-record `FrameHandle` through unchanged.
 */
function ownMotionEntry(entry: MotionQueueEntry): MotionQueueEntry {
  return { frame: ownFrame(entry.frame), handle: entry.handle }
}

/**
 * CB5 shm FrameHandle passthrough gate. The runner hands the executor / motion
 * provider a zero-pixel shm `FrameHandle` (instead of re-serialising ~1.2MB of
 * pixels over UDS) ONLY while the pipeline is keeping up. The FrameRing is a
 * latest-wins seqlock with NO refcount, so deferring the pixel read from the
 * poll tick to the executor (after queue + semaphore + UDS) widens the
 * publish→read window — under backpressure the producer can recycle the slot
 * before the executor reads it (a silent drop). When the pipeline is backed up
 * we therefore fall back to copying pixels inline (today's behaviour).
 *
 * The per-camera detection `FrameQueue` is latest-only (capacity 1), so raw
 * queue length is 0/1 and the operative backpressure signal is inference
 * saturation on the shared semaphore — no spare inference permit ⇒ frames are
 * waiting ⇒ ship pixels. The queue-depth clause is kept for defence in depth
 * and future multi-slot queues.
 */
const HANDLE_PASSTHROUGH_MAX_QUEUE_DEPTH = 1

// Fallback cooldown when the runner registration omits an explicit
// `motionCooldownMs`. Aligned with the schema default in
// `pipeline-runner.cap.ts` (motionCooldownMsField.default) so
// always-on / synthetic registrations get the same window the
// device-settings schema serves to operator-driven attaches.
const DEFAULT_MOTION_COOLDOWN_MS = 30_000

// How often the runner recomputes the FrameGovernor's per-camera admission
// intervals from fresh sampler data. Decoupled from the 10s `pipeline stats`
// report interval — the governor needs to react faster than the log line.
const GOVERNOR_RECOMPUTE_INTERVAL_MS = 2_000

// Fallback decode-rate ceiling for an uncapped camera (`registration.fps ===
// 0`) when the runner hasn't measured any raw frame arrivals yet in the
// current recompute window (e.g. right after `start()`, before the first
// frame lands). Once frames arrive, the MEASURED arrival rate (see
// `recomputeGovernor`) supersedes this constant — it is only the cold-start
// floor, never a standing substitute for a real decode-rate reading.
const DEFAULT_DECODE_FPS = 25

function toFrameInput(frame: DecodedFrame): FrameInput {
  return {
    data: frame.data,
    width: frame.width,
    height: frame.height,
    format: frame.format,
    timestamp: frame.timestamp,
    ...(frame.frameRef ? { frameRef: frame.frameRef } : {}),
  }
}

/**
 * Pipeline runner scheduler — the per-node detection scheduler.
 *
 * Owns per-camera frame queues, the inference semaphore, the round-robin
 * scheduler, and the motion → detection phase machine. Inference and
 * motion analysis are delegated to caller-provided callbacks injected at
 * construction time so the scheduler stays decoupled from the surrounding
 * addon ecosystem (the addon class wrapping this scheduler injects
 * callbacks that resolve to the local pipeline-executor / motion-detection
 * caps when running in production).
 *
 * This class is intentionally framework-agnostic and side-effect-free
 * outside the callbacks — it can be unit tested with mock callbacks
 * without spinning up Moleculer or the addon framework.
 */
export class PipelineRunner {
  // Config is mutable (not `readonly`) because `updateLimits()` hot-reloads
  // the four tuning fields when the pipeline-runner addon's
  // `updateAddonSettings` is invoked via the new three-level settings API.
  // The callbacks (`processFrame`, `analyzeMotion`) are invariants captured
  // at construction and never changed.
  /** Abandoned inference calls that have not yet settled. A BURST reads as
   *  one rising number instead of N unrelated lines. */
  private inflightTimeouts = 0

  private config: RunnerConfig
  private readonly cameras = new Map<number, CameraState>()
  private readonly semaphore: Semaphore
  private readonly resultCallbacks: ResultCallback[] = []
  /** Last report per `deviceId:reason` for {@link noteOnboardRootIdle}. */
  private readonly onboardIdleReportedAt = new Map<string, number>()
  private readonly defaultRoundRobinKeys: number[] = []
  private defaultRoundRobinIndex = 0
  private intervalHandle: ReturnType<typeof setInterval> | null = null
  private detectionStreamHandler: DetectionStreamHandler | null = null
  private readonly logger: IScopedLogger | undefined
  readonly timingSampler = new PipelineTimingSampler()
  // Adaptive per-camera inference admission (targetLoadPercent/minThrottledFps
  // — see frame-governor.ts). Rebuilt when tuning changes so hot reload alters
  // live pacing rather than only the values returned by getLimits().
  private governor: FrameGovernor
  // Wall-clock of the last admitted detection frame per camera — the gate's
  // pacing clock (see `enqueueDetectionFrame`).
  private readonly lastAdmittedAt = new Map<number, number>()
  // Raw detection-frame ARRIVAL counts per camera since the last governor
  // recompute — counted BEFORE the phase/admission gate, so it reflects true
  // decode delivery rate regardless of throttling (avoids a throttle→lower
  // measured rate→lower ceiling feedback loop). Reset every recompute tick.
  private readonly arrivalCounts = new Map<number, number>()
  private lastGovernorRecomputeAt = Date.now()
  private governorIntervalHandle: ReturnType<typeof setInterval> | null = null
  /** When the scheduler first found itself with zero permits; null when healthy. */
  private inferenceStallSince: number | null = null
  /** Last stall warning, so a persistent wedge re-warns instead of going quiet. */
  private inferenceStallWarnedAt: number | null = null

  constructor(config: RunnerConfig) {
    this.config = config
    this.logger = config.logger
    this.semaphore = new Semaphore(config.maxConcurrentInferences)
    this.governor = new FrameGovernor({
      targetLoadPercent: config.targetLoadPercent,
      minThrottledFps: config.minThrottledFps,
      maxConcurrentInferences: config.maxConcurrentInferences,
    })
  }

  /**
   * Hot-reload the four tuning fields without tearing down the runner.
   * - `maxConcurrentInferences`: resized on the live semaphore; in-flight
   *   permits are preserved, new capacity is available immediately.
   * - `maxQueueDepth`: new `FrameQueue`s created from this point on use
   *   the updated ceiling. Existing per-camera queues are not resized
   *   (the FrameQueue implementation is latest-only and ignores maxSize
   *   anyway — see `frame-queue.ts` — so the field is effectively a
   *   metadata hint for observability).
   * - `targetLoadPercent` / `minThrottledFps` and inference concurrency:
   *   rebuild the live governor and immediately recompute admission intervals.
   *
   * Only keys present in the patch are overwritten; unspecified keys
   * retain their current value. Any illegal combination (e.g.
   * concurrency < 1) throws and leaves the runner unchanged.
   */
  updateLimits(patch: {
    readonly maxQueueDepth?: number
    readonly maxConcurrentInferences?: number
    readonly targetLoadPercent?: number
    readonly minThrottledFps?: number
  }): void {
    const next: RunnerConfig = {
      ...this.config,
      maxQueueDepth: patch.maxQueueDepth ?? this.config.maxQueueDepth,
      maxConcurrentInferences: patch.maxConcurrentInferences ?? this.config.maxConcurrentInferences,
      targetLoadPercent: patch.targetLoadPercent ?? this.config.targetLoadPercent,
      minThrottledFps: patch.minThrottledFps ?? this.config.minThrottledFps,
    }
    if (next.maxConcurrentInferences !== this.config.maxConcurrentInferences) {
      this.semaphore.resize(next.maxConcurrentInferences)
    }
    this.config = next
    this.governor = new FrameGovernor({
      targetLoadPercent: next.targetLoadPercent,
      minThrottledFps: next.minThrottledFps,
      maxConcurrentInferences: next.maxConcurrentInferences,
    })
    this.recomputeGovernor()
  }

  /** Read the current tuning fields for diagnostics / tests. */
  getLimits(): {
    readonly maxQueueDepth: number
    readonly maxConcurrentInferences: number
    readonly targetLoadPercent: number
    readonly minThrottledFps: number
  } {
    return {
      maxQueueDepth: this.config.maxQueueDepth,
      maxConcurrentInferences: this.config.maxConcurrentInferences,
      targetLoadPercent: this.config.targetLoadPercent,
      minThrottledFps: this.config.minThrottledFps,
    }
  }

  /** Set a handler called when the runner needs to subscribe/unsubscribe the detection stream. */
  onDetectionStreamChange(handler: DetectionStreamHandler): void {
    this.detectionStreamHandler = handler
  }

  registerCamera(deviceId: number, registration: CameraRegistration): void {
    const motionQueue = new FrameQueue<MotionQueueEntry>(this.config.maxQueueDepth, ownMotionEntry)
    const detectionQueue = new FrameQueue<DetectionQueueEntry>(
      this.config.maxQueueDepth,
      ownDetectionEntry,
      (entry, reason) => {
        if (entry.handle) this.config.releaseRetention?.(entry.handle, 'drop')
        if (entry.frame.frameRef) this.config.releaseFrameRef?.(entry.frame.frameRef, 'drop')
        entry.onSettled?.(reason === 'superseded' ? 'superseded' : 'lost')
      },
    )
    // Map the operator-facing detectionMode to the scheduler's initial
    // phase. `'disabled'` short-circuits everything (no subscribe, no
    // round-robin slot, no detection queue activity).
    const initialPhase: CameraPhase =
      registration.detectionMode === 'disabled'
        ? 'idle'
        : registration.detectionMode === 'always-on'
          ? 'active'
          : 'watching'

    const preRollQueue = new PreRollLane<DetectionQueueEntry>({
      capacity: this.config.maxPreRollQueueDepth ?? DEFAULT_MAX_PRE_ROLL_QUEUE_DEPTH,
      clone: ownDetectionEntry,
      dispose: (entry) => {
        if (entry.handle) this.config.releaseRetention?.(entry.handle, 'drop')
        if (entry.frame.frameRef) this.config.releaseFrameRef?.(entry.frame.frameRef, 'drop')
        entry.onSettled?.('lost')
      },
    })

    // WHICH root detector this camera was registered with, said once, at the
    // moment it is decided. The chain from the operator's pick to here crosses
    // a settings store, a resolve, an attach payload and a process boundary,
    // and when the camera kept running the ML root step with `['onboard']`
    // stored there was no way to tell WHERE it was lost — every link looked
    // right in isolation. A decision this long-travelled says what it decided.
    this.logger?.info('camera registered: root detectors', {
      tags: { deviceId },
      meta: {
        detectionSources: registration.detectionSources ?? null,
        ...planDetectionSources(registration.detectionSources),
      },
    })
    const state: CameraState = {
      registration,
      onboardSlot: null,
      motionQueue,
      detectionQueue,
      preRollQueue,
      inferenceTimes: [],
      shedFrames: 0,
      inflight: 0,
      processedCount: 0,
      startTime: Date.now(),
      phase: initialPhase,
      motionCooldownTimer: null,
      lastArmedSource: null,
      lastArmedRegions: undefined,
      occupancyTimer: null,
      motionInFlight: false,
      lastResultDetections: 0,
      // ARMED FROM BOOT, not from the first session that happens to close with
      // something in frame.
      //
      // Until 2026-09-14 a freshly registered camera was disarmed, and the
      // recheck is the ONLY thing that looks at a still scene: after a hub
      // restart an object already parked in view stayed invisible to the
      // stationary registry, and therefore to every occupancy rule, until
      // something else moved in front of it — on a quiet driveway,
      // indefinitely. That is the exact case the recheck exists for, and it was
      // the one case it could not serve.
      //
      // The cost is bounded and self-correcting: a camera with nothing parked
      // disarms after two consecutive empty bursts (see
      // `reportOccupancyBurstOutcome`), so an empty scene pays two bursts per
      // attach and nothing after.
      occupancyArmed: true,
      emptyBurstStreak: 0,
    }
    this.cameras.set(deviceId, state)

    // Surface REAL shedding in the periodic `pipeline stats` line: the
    // detection queue is latest-frame-only, so its cumulative
    // `droppedFrames` counter is the true overload signal. The sampler
    // reports the per-interval delta as the `dropped` field.
    this.timingSampler.setDroppedFramesSource(deviceId, () => detectionQueue.droppedFrames)

    // Round-robin scheduling applies only to `on-motion`. `always-on`
    // doesn't need a slot (always at the front of the queue).
    // `disabled` skips entirely.
    if (registration.detectionMode === 'on-motion') {
      this.defaultRoundRobinKeys.push(deviceId)
    }

    if (
      registration.detectionMode === 'on-motion' &&
      registration.occupancyRecheckEnabled === true &&
      (registration.occupancyRecheckSec ?? 0) > 0
    ) {
      state.occupancyTimer = setInterval(
        () => {
          // Armed only when the last session closed with detections still
          // present (see `transitionToWatching`) and disarmed after 2
          // consecutive empty bursts (see `reportOccupancyBurstOutcome`) —
          // an empty room stops paying the decode-dial + inference burst
          // cost on every tick.
          if (state.phase === 'watching' && state.occupancyArmed) {
            this.config.onOccupancyRecheck?.(deviceId, registration.occupancyRecheckFrames ?? 4)
          }
        },
        (registration.occupancyRecheckSec ?? 0) * 1000,
      )
    }

    if (initialPhase === 'active') {
      this.detectionStreamHandler?.(deviceId, 'subscribe')
      // Always-on cameras start in `active` immediately — emit the
      // synthetic ON transition so consumers (motion cap-state +
      // bus event) see the same shape the gated path produces. It names the
      // motion the orchestrator dispatched the session on (never a guess),
      // and the matching close is emitted by `unregisterCamera`.
      this.config.onPhaseChanged?.(deviceId, 'active', {
        cause: 'attach',
        timestamp: Date.now(),
        ...(registration.sessionTrigger !== undefined
          ? { trigger: registration.sessionTrigger }
          : {}),
      })
    }
    // `idle` (detectionMode='disabled') intentionally never emits a
    // phase event or subscribes — the runner registered the camera
    // for accounting but nothing flows.
  }

  unregisterCamera(deviceId: number): void {
    const state = this.cameras.get(deviceId)
    if (!state) return

    if (state.motionCooldownTimer !== null) {
      clearTimeout(state.motionCooldownTimer)
      state.motionCooldownTimer = null
    }

    if (state.occupancyTimer !== null) {
      clearInterval(state.occupancyTimer)
      state.occupancyTimer = null
    }

    if (state.phase === 'active') {
      this.detectionStreamHandler?.(deviceId, 'unsubscribe')
      // The phase this camera announced is over. Without this close, every
      // consumer of the transition stream (the live phase badge, the events
      // list) held `active` from one session's attach until the next one.
      this.config.onPhaseChanged?.(deviceId, 'watching', {
        cause: 'detach',
        timestamp: Date.now(),
      })
    }

    state.motionQueue.clear()
    this.discardQueuedDetectionFrames(deviceId, state, 'detach')
    this.timingSampler.clearDroppedFramesSource(deviceId)
    this.cameras.delete(deviceId)
    this.lastAdmittedAt.delete(deviceId)
    this.arrivalCounts.delete(deviceId)

    const idx = this.defaultRoundRobinKeys.indexOf(deviceId)
    if (idx !== -1) {
      this.defaultRoundRobinKeys.splice(idx, 1)
      if (this.defaultRoundRobinIndex >= this.defaultRoundRobinKeys.length) {
        this.defaultRoundRobinIndex = 0
      }
    }
  }

  enqueueMotionFrame(deviceId: number, frame: DecodedFrame, handle: FrameHandle | undefined): void {
    const state = this.cameras.get(deviceId)
    if (!state) return
    state.motionQueue.enqueue({ frame, handle })
  }

  /**
   * Returns whether the frame was ADMITTED to the detection queue — i.e.
   * whether it will reach inference. The caller uses that to mark the frame's
   * native lease worth keeping (`NativeCropRequester.markInferred`): a native
   * crop can only ever name a frameId that rode an inference result, so a
   * frame rejected here is one nobody can ask for. A `false` here is the whole
   * saving; do not turn it back into `void` for tidiness.
   */
  enqueueDetectionFrame(
    deviceId: number,
    frame: DecodedFrame,
    handle: FrameHandle | undefined,
  ): boolean {
    if (!this.reserveDetectionFrame(deviceId)) return false
    return this.enqueueReservedDetectionFrame(deviceId, frame, handle)
  }

  /**
   * Reserve adaptive admission before a session-decode frame is materialized.
   * This is intentionally pixel-free: the pump can skip `toBuffer()` entirely
   * when the frame is outside the governor interval, avoiding RGB conversion,
   * IPC and retention work. Raw arrivals are counted here, before the gate, so
   * recomputation never feeds the throttled output rate back in as source FPS.
   */
  reserveDetectionFrame(deviceId: number, now = Date.now()): boolean {
    const state = this.cameras.get(deviceId)
    if (!state) return false
    this.arrivalCounts.set(deviceId, (this.arrivalCounts.get(deviceId) ?? 0) + 1)
    if (state.phase !== 'active') return false
    const interval = this.governor.minIntervalMs(deviceId)
    if (interval > 0) {
      const last = this.lastAdmittedAt.get(deviceId) ?? 0
      if (now - last < interval) return false // governed: skip inference admission
      this.lastAdmittedAt.set(deviceId, now)
    }
    return true
  }

  /**
   * Queue a frame whose admission was already reserved synchronously through
   * {@link reserveDetectionFrame}. Kept separate so the ordinary public path
   * cannot accidentally count one source frame twice.
   */
  /**
   * True when a frame enqueued NOW would wait for an inference slot before
   * the executor reads its pixels — the window in which a lazy `frameRef` is
   * a gamble on the worker's 8-slot hold. The detection queue keeps only the
   * latest frame, so the queue can never be "deep": the semaphore is the one
   * live signal (the shm passthrough reads the same one). Asked at enqueue
   * time so the pump can copy the pixels while the frame is still reserved.
   */
  detectionBackpressure(deviceId: number): boolean {
    const state = this.cameras.get(deviceId)
    if (!state) return true
    return this.semaphore.available <= 0 || state.inflight >= this.maxInflightPerCamera()
  }

  /** The per-camera in-flight cap in force (config, else the shipped hold minus one). */
  private maxInflightPerCamera(): number {
    return Math.max(
      1,
      this.config.maxInflightPerCamera ?? DEFAULT_NATIVE_LEASE_SETTINGS.holdFrames - 1,
    )
  }

  /**
   * Follow a resized native-frame hold. Running inferences are untouched; the
   * next pick is measured against the new cap.
   */
  setMaxInflightPerCamera(cap: number): void {
    this.config = { ...this.config, maxInflightPerCamera: cap }
  }

  /**
   * Queue one PRE-ROLL frame — a frame decoded out of the restreamer's retained
   * history at session open, carrying its own capture moment
   * (`session-decode/media-clock.ts`), not the moment it was decoded.
   *
   * Deliberately NOT routed through {@link reserveDetectionFrame}: that gate
   * paces on WALL CLOCK, and a catch-up burst delivers seconds of media inside
   * milliseconds of wall clock, so the governor would reject the whole burst
   * bar one frame. The burst's own bound is a MEDIA-time stride applied
   * upstream, under an explicit frame + wall-clock budget
   * (`session-decode/pre-roll-burst.ts`); by the time a frame reaches here it
   * has already been chosen.
   *
   * `false` means the lane is full or the camera is not taking detection
   * frames. The caller LOGS that: a burst silently truncated by the lane and a
   * burst that fit read identically otherwise, and this is a branch that drops
   * work.
   */
  enqueuePreRollFrame(
    deviceId: number,
    frame: DecodedFrame,
    handle: FrameHandle | undefined,
  ): boolean {
    const state = this.cameras.get(deviceId)
    if (!state || state.phase !== 'active') return false
    // History of a SESSION: the camera was moving-triggered and this is what it
    // buffered before the trigger. Not a burst — nobody re-dialled a still scene.
    return state.preRollQueue.enqueue({ frame, handle, occasion: 'session' })
  }

  /**
   * Whether one more history frame would be taken. Asked BEFORE pixels are
   * materialized so a burst that has already filled the lane costs no RGB
   * conversion, no IPC and no retention work — the same pixel-free discipline
   * the live path gets from `reserveDetectionFrame`.
   */
  preRollLaneAccepting(deviceId: number): boolean {
    const state = this.cameras.get(deviceId)
    if (!state || state.phase !== 'active') return false
    return (
      state.preRollQueue.size <
      (this.config.maxPreRollQueueDepth ?? DEFAULT_MAX_PRE_ROLL_QUEUE_DEPTH)
    )
  }

  /** Frames of history waiting for a spare permit, for the session report line. */
  preRollQueueDepth(deviceId: number): number {
    return this.cameras.get(deviceId)?.preRollQueue.size ?? 0
  }

  /**
   * Frames this camera lane REFUSED because it was full — or `null` when the
   * camera is no longer registered and the count cannot be read (a report
   * that lands after a detach). A failed read is `null`, never `0` (D393):
   * zero would say "nothing refused" about a lane nobody looked at.
   */
  preRollRefusedCount(deviceId: number): number | null {
    return this.cameras.get(deviceId)?.preRollQueue.refused ?? null
  }

  /**
   * Whether the node has a permit to spare for history right now — i.e. one
   * would still be free after the burst took one. See
   * {@link PRE_ROLL_PERMIT_RESERVE}.
   */
  preRollDispatchable(): boolean {
    return this.semaphore.available > PRE_ROLL_PERMIT_RESERVE
  }

  enqueueReservedDetectionFrame(
    deviceId: number,
    frame: DecodedFrame,
    handle: FrameHandle | undefined,
  ): boolean {
    const state = this.cameras.get(deviceId)
    if (!state || state.phase !== 'active') return false
    ;(frame as { _enqueuedAt?: number })._enqueuedAt = Date.now()
    // A LIVE frame of an active motion session. This line said `'burst'` from
    // 2026-09-14 (d946ce42e) to 2026-09-16 and every session frame on the
    // fleet was filed as a periodic recheck — see `DetectionQueueEntry.occasion`.
    state.detectionQueue.enqueue({ frame, handle, occasion: 'session' })
    return true
  }

  /**
   * `handle` is optional (mirrors {@link DetectionQueueEntry.handle}) — the
   * dial path (`runOccupancyBurst`'s `startFrameHandlePoller`) always has a
   * real shm handle, but Task 10's analyzer-tap path can feed a frame whose
   * motion subscription never produced one (e.g. the per-session motion
   * decode worker). `runInference` already falls back to the pixel path
   * when the handle is absent.
   */
  enqueueOccupancyFrame(
    deviceId: number,
    frame: DecodedFrame,
    handle: FrameHandle | undefined,
    onSettled?: (outcome: FrameSettleOutcome) => void,
  ): boolean {
    const state = this.cameras.get(deviceId)
    if (!state) return false
    if (state.phase !== 'watching') return false
    ;(frame as { _enqueuedAt?: number })._enqueuedAt = Date.now()
    // The ONE place a burst is named: the periodic occupancy recheck, admitted
    // only while the camera is `watching` — i.e. while its motion gate says the
    // scene is still. Everything downstream reads this instead of guessing
    // from the camera's phase.
    //
    // `onSettled` is how the burst learns this frame is DONE (D652). `false`
    // returned here means it was never admitted, and the caller settles it.
    state.detectionQueue.enqueue({
      frame,
      handle,
      occasion: 'burst',
      ...(onSettled ? { onSettled } : {}),
    })
    return true
  }

  /**
   * Report a motion event for a camera. Drives the unified phase
   * machine for both motion sources (analyzer + onboard):
   *
   *   - Every `detected: true` (any source) clears + rearms the
   *     cooldown timer and transitions watching → active. The same
   *     timer applies regardless of which source(s) are configured;
   *     concurrent sources just keep refreshing the same window.
   *   - `detected: false` is a no-op. Onboard sources never send an
   *     explicit clear, and the analyzer's "false" pulses would
   *     otherwise fight the cooldown when motion paused briefly
   *     during a scene. The timer is the single closure path.
   *   - Timer expiry transitions active → watching.
   *
   * Always-on cameras silently ignore reportMotion calls — they're
   * already in `active` and have no cooldown.
   *
   * `source` and `regions` propagate into the phase-transition event
   * so the wrapping addon can attach them to the cap-state slice +
   * bus event.
   */
  reportMotion(
    deviceId: number,
    detected: boolean,
    source: MotionSource = 'analyzer',
    regions: ReadonlyArray<MotionRegion> | undefined = undefined,
  ): void {
    const state = this.cameras.get(deviceId)
    if (!state) return

    // `always-on` ignores motion (already active); `disabled` ignores
    // motion (camera registered but never subscribed to detection).
    // Only `on-motion` flows through the cooldown path.
    if (state.registration.detectionMode !== 'on-motion') return
    if (!detected) return

    state.lastArmedSource = source
    state.lastArmedRegions = regions
    const cooldownMs = state.registration.motionCooldownMs ?? DEFAULT_MOTION_COOLDOWN_MS

    if (state.motionCooldownTimer !== null) {
      clearTimeout(state.motionCooldownTimer)
      state.motionCooldownTimer = null
    }

    if (state.phase === 'watching') {
      this.transitionToActive(deviceId, state, source, regions, cooldownMs)
    }

    state.motionCooldownTimer = setTimeout(() => {
      state.motionCooldownTimer = null
      this.transitionToWatching(deviceId, state, cooldownMs)
    }, cooldownMs)
  }

  getPhase(deviceId: number): CameraPhase | undefined {
    return this.cameras.get(deviceId)?.phase
  }

  /**
   * Record the detection count from the runner's most recent inference
   * result for this camera. The addon wrapping the scheduler calls this
   * from its `onResult` callback — the runner itself stays event-agnostic
   * (it never inspects `FrameResult` shapes), it only remembers the raw
   * count that `transitionToWatching` reads to decide whether the
   * occupancy recheck timer arms for the upcoming `watching` phase.
   */
  noteDetectionResult(deviceId: number, detectionCount: number): void {
    const state = this.cameras.get(deviceId)
    if (!state) return
    state.lastResultDetections = detectionCount
  }

  /**
   * Report the outcome of a completed occupancy recheck burst (see
   * `RunnerConfig.onOccupancyRecheck`). Called by the addon once it knows
   * whether any burst frame's inference result had detections.
   *
   * - `found: true` — resets the empty-burst streak. The timer stays armed;
   *   a genuine occupant is a separate `reportMotion` event that reopens the
   *   session through the existing motion/dispatch path — this method does
   *   not itself flip the phase.
   * - `found: false` — increments the streak; after 2 consecutive empty
   *   bursts the timer disarms (`occupancyArmed = false`) until the next
   *   active→watching transition re-evaluates from scratch.
   */
  reportOccupancyBurstOutcome(deviceId: number, found: boolean): void {
    const state = this.cameras.get(deviceId)
    if (!state) return
    if (found) {
      state.emptyBurstStreak = 0
      return
    }
    state.emptyBurstStreak++
    if (state.emptyBurstStreak >= 2) {
      state.occupancyArmed = false
    }
  }

  onResult(callback: ResultCallback): void {
    this.resultCallbacks.push(callback)
  }

  start(): void {
    if (this.intervalHandle !== null) return
    this.intervalHandle = setInterval(() => this.tick(), 10)
    this.timingSampler.start()
    this.lastGovernorRecomputeAt = Date.now()
    this.governorIntervalHandle = setInterval(
      () => this.recomputeGovernor(),
      GOVERNOR_RECOMPUTE_INTERVAL_MS,
    )
    this.governorIntervalHandle?.unref?.()
  }

  stop(): void {
    if (this.intervalHandle !== null) {
      clearInterval(this.intervalHandle)
      this.intervalHandle = null
    }
    if (this.governorIntervalHandle !== null) {
      clearInterval(this.governorIntervalHandle)
      this.governorIntervalHandle = null
    }
    this.timingSampler.stop()

    for (const state of this.cameras.values()) {
      if (state.motionCooldownTimer !== null) {
        clearTimeout(state.motionCooldownTimer)
        state.motionCooldownTimer = null
      }
      if (state.occupancyTimer !== null) {
        clearInterval(state.occupancyTimer)
        state.occupancyTimer = null
      }
    }
  }

  /**
   * Recompute the {@link FrameGovernor}'s per-camera admission intervals
   * from fresh sampler + arrival data. Called on the {@link
   * GOVERNOR_RECOMPUTE_INTERVAL_MS} tick started by `start()`; also exposed
   * so tests can prime the governor deterministically without waiting on a
   * timer. `now` defaults to the wall clock but is accepted explicitly so a
   * caller can pass a fixed instant for reproducible elapsed-time math.
   */
  recomputeGovernor(now: number = Date.now()): void {
    const elapsedSec = Math.max((now - this.lastGovernorRecomputeAt) / 1000, 0.001)
    const avgInferenceMsByCamera = this.timingSampler.avgInferenceMsByCamera()
    const samples = new Map<number, CameraLoadSample>()
    for (const [deviceId, state] of this.cameras) {
      // Split the node budget only across cameras with an ACTIVE session —
      // idle/watching cameras run no inference, so counting them would dilute
      // the share and throttle the lone active camera below its configured fps
      // on an otherwise-idle node (spec §1).
      if (state.phase !== 'active') continue
      const arrivals = this.arrivalCounts.get(deviceId) ?? 0
      const measuredDecodeFps = arrivals / elapsedSec
      samples.set(deviceId, {
        avgInferenceMs: avgInferenceMsByCamera.get(deviceId) ?? 0,
        configuredFps: state.registration.fps,
        decodeFps: measuredDecodeFps > 0 ? measuredDecodeFps : DEFAULT_DECODE_FPS,
      })
    }
    this.governor.update(samples)
    this.arrivalCounts.clear()
    this.lastGovernorRecomputeAt = now
  }

  getMetrics(): OrchestratorMetrics {
    let totalQueueDepth = 0
    let totalInferenceTime = 0
    let totalInferenceCount = 0

    for (const state of this.cameras.values()) {
      totalQueueDepth += state.motionQueue.size + state.detectionQueue.size
      for (const t of state.inferenceTimes) {
        totalInferenceTime += t
        totalInferenceCount++
      }
    }

    return {
      activeCameras: this.cameras.size,
      throttledCameras: this.governor.throttledCount(),
      avgInferenceTimeMs: totalInferenceCount > 0 ? totalInferenceTime / totalInferenceCount : 0,
      queueDepth: totalQueueDepth,
    }
  }

  getCameraMetrics(deviceId: number): CameraMetrics | undefined {
    const state = this.cameras.get(deviceId)
    if (!state) return undefined

    const elapsedMs = Date.now() - state.startTime
    const elapsedSec = elapsedMs / 1000
    const actualFps = elapsedSec > 0 ? state.processedCount / elapsedSec : 0

    const times = state.inferenceTimes
    const avgInference = times.length > 0 ? times.reduce((a, b) => a + b, 0) / times.length : 0

    return {
      detectionMode: state.registration.detectionMode,
      configuredFps: state.registration.fps,
      actualFps,
      queueDepth: state.motionQueue.size + state.detectionQueue.size,
      avgInferenceTimeMs: avgInference,
      // Queue overflow (the runner refused the frame) PLUS pool sheds (the
      // worker refused it). Both are a frame that produced no detection, which
      // is the only thing a consumer of this number cares about.
      droppedFrames:
        state.motionQueue.droppedFrames + state.detectionQueue.droppedFrames + state.shedFrames,
      phase: state.phase,
    }
  }

  getAllCameraMetrics(): Array<{ deviceId: number } & CameraMetrics> {
    const results: Array<{ deviceId: number } & CameraMetrics> = []
    for (const [deviceId] of this.cameras) {
      const metrics = this.getCameraMetrics(deviceId)
      if (metrics) {
        results.push({ deviceId, ...metrics })
      }
    }
    return results
  }

  getAttachedCameras(): readonly number[] {
    return [...this.cameras.keys()]
  }

  private transitionToActive(
    deviceId: number,
    state: CameraState,
    source: MotionSource,
    regions: ReadonlyArray<MotionRegion> | undefined,
    cooldownMs: number,
  ): void {
    state.phase = 'active'
    // Reset: the arm decision at this session's close must reflect ONLY
    // detections observed during THIS session, not a stale carryover from
    // whatever session (or occupancy burst) last called noteDetectionResult.
    state.lastResultDetections = 0
    this.logger?.info('motion gate opened — phase=active', {
      tags: { deviceId },
      meta: { detectionMode: state.registration.detectionMode, source },
    })
    this.detectionStreamHandler?.(deviceId, 'subscribe')
    this.config.onPhaseChanged?.(deviceId, 'active', {
      cause: 'motion',
      source,
      regions,
      timestamp: Date.now(),
      cooldownMs,
    })
  }

  private transitionToWatching(deviceId: number, state: CameraState, cooldownMs: number): void {
    state.phase = 'watching'
    this.discardQueuedDetectionFrames(deviceId, state, 'session-close')
    // Re-evaluate the occupancy recheck arm from scratch on every session
    // close: armed iff the session that just ended still had detections in
    // its last inference result. A room that emptied out before the
    // cooldown expired gets no standing recheck burden.
    state.occupancyArmed = state.lastResultDetections > 0
    state.emptyBurstStreak = 0
    this.logger?.info('motion gate closed — phase=watching', {
      tags: { deviceId },
      meta: { lastSource: state.lastArmedSource, occupancyArmed: state.occupancyArmed },
    })
    this.detectionStreamHandler?.(deviceId, 'unsubscribe')
    // Last source that armed the timer carries the OFF event payload —
    // analyzer or onboard, whatever last fired before the silence
    // window expired. Regions are intentionally not propagated on
    // OFF: they describe a positive observation, not a closure.
    const source: MotionSource = state.lastArmedSource ?? 'analyzer'
    this.config.onPhaseChanged?.(deviceId, 'watching', {
      cause: 'motion',
      source,
      regions: undefined,
      timestamp: Date.now(),
      cooldownMs,
    })
    state.lastArmedSource = null
    state.lastArmedRegions = undefined
  }

  /**
   * Throw away the frames still QUEUED for a camera whose session is ending.
   *
   * A branch that drops work says so (D391, D652). These are frames the runner
   * admitted and will now never infer — the live queue's latest frame and, on a
   * detach, whatever history is left in the pre-roll lane. Frames already in
   * flight are not touched here: they finish, and the decode worker they live
   * in drains before it is killed (`SESSION_DECODE_DRAIN_BOUND_MS`).
   */
  private discardQueuedDetectionFrames(
    deviceId: number,
    state: CameraState,
    reason: 'detach' | 'session-close',
  ): void {
    const queued = state.detectionQueue.size
    // A frame someone is WAITING on (an occupancy burst's) is a real loss; the
    // newest live frame of a session that is ending is routine.
    const awaited = state.detectionQueue.peek()?.onSettled !== undefined ? 1 : 0
    // A session close keeps the lane: its history belongs to the camera, and a
    // detach (which follows a close on the orchestrator's path) clears it.
    const preRoll = reason === 'detach' ? state.preRollQueue.size : 0
    state.detectionQueue.clear()
    if (reason === 'detach') state.preRollQueue.clear()
    if (queued + preRoll === 0) return
    const meta = { reason, queued, awaited, preRoll, inflight: state.inflight }
    // INFO only when admitted work nobody else will do was lost — an awaited
    // burst frame, or history the session had admitted (D391). The routine
    // close of a live session drops one latest-only frame; that is debug.
    if (awaited + preRoll > 0) {
      this.logger?.info('detection frames discarded with the session', {
        tags: { deviceId },
        meta,
      })
      return
    }
    this.logger?.debug('detection frames discarded with the session', {
      tags: { deviceId },
      meta,
    })
  }

  private tick(): void {
    this.drainMotionQueues()

    if (this.semaphore.available <= 0) {
      // Every permit is in flight. That is normal under load and pathological
      // when it never ends — report the difference instead of returning mute.
      this.noteInferenceStall()
      return
    }
    this.inferenceStallSince = null
    this.inferenceStallWarnedAt = null

    const picked = this.pickNextDetectionFrame()
    if (!picked) return

    const { deviceId, entry, state } = picked
    const frameInput = toFrameInput(entry.frame)

    void this.processWithSemaphore(deviceId, entry, frameInput, state, 'detection')
  }

  private drainMotionQueues(): void {
    for (const [deviceId, state] of this.cameras) {
      // Single-flight per camera: skip while an analyzeMotion is pending. The
      // motion queue is latest-only, so newer frames overwrite the pending slot
      // (dropped) and the freshest is drained once the in-flight call settles.
      if (state.motionInFlight) continue
      if (state.motionQueue.size === 0) continue
      const entry = state.motionQueue.dequeue()
      if (!entry) continue
      // Motion is drained on the scheduler tick (not on the poll tick), so it
      // never widens the shm publish→read window under backpressure the way the
      // semaphore-gated detection path can. Hand the handle through
      // unconditionally when present — a recycled slot still degrades to an
      // empty result on the motion-provider side.
      state.motionInFlight = true
      void Promise.resolve(this.config.analyzeMotion(deviceId, entry.frame, entry.handle))
        .catch(() => {
          // Error isolation — a failed motion analysis must not wedge the camera.
        })
        .finally(() => {
          state.motionInFlight = false
        })
    }
  }

  private async processWithSemaphore(
    deviceId: number,
    entry: DetectionQueueEntry,
    frameInput: FrameInput,
    state: CameraState,
    streamType: StreamType,
  ): Promise<void> {
    const pickedAt = Date.now()
    const { frame, handle } = entry
    state.inflight += 1
    // `frame.timestamp` is the codec PTS (shm-ring `frame.meta.pts`), NOT a
    // wall-clock time — subtracting it from Date.now() yields a ~1.7e12 garbage
    // "latency". `_enqueuedAt` is the wall-clock stamp written when the frame
    // entered the detection queue (see enqueueDetectionFrame); fall back to
    // `pickedAt` (also wall-clock) so all latency math stays in one time base.
    const enqueuedAt = (frame as { _enqueuedAt?: number })._enqueuedAt ?? pickedAt

    // WHICH root detector this camera runs. Read before the semaphore on
    // purpose: a camera whose root step is the CAMERA's must not take an
    // inference permit at all — holding one while the accelerator is idle is
    // exactly the share this mode exists to give back, and on a saturated node
    // it would starve the cameras that do need it.
    const plan = planDetectionSources(state.registration.detectionSources)
    if (!plan.runsPipeline) {
      try {
        await this.processOnboardRoot(deviceId, entry, state, streamType, plan)
      } finally {
        state.inflight -= 1
      }
      return
    }

    const rawRelease = await this.semaphore.acquire()
    // Release-once: the timeout path and the settle path both reach for it, and
    // the semaphore itself does not de-duplicate (a second call would mint a
    // permit that was never acquired).
    let released = false
    const release = (): void => {
      if (released) return
      released = true
      rawRelease()
    }
    const semAcquiredAt = Date.now()
    // CB5 passthrough gate — hand the executor the zero-pixel shm handle only
    // while keeping up (spare inference permit + shallow queue). Under
    // backpressure the ring slot may recycle before the executor reads it, so
    // fall back to shipping pixels (undefined handle → runInference sends
    // `frame`). `handle` (unchanged) still threads to the result callback so
    // the emitted inference-result event names the same slot. See
    // HANDLE_PASSTHROUGH_MAX_QUEUE_DEPTH.
    const executorHandle: FrameHandle | undefined =
      state.detectionQueue.size <= HANDLE_PASSTHROUGH_MAX_QUEUE_DEPTH &&
      this.semaphore.available > 0
        ? handle
        : undefined
    let frameReleaseReason: 'success' | 'error' | 'drop' = 'error'
    try {
      const result = await this.awaitInferenceBounded(deviceId, frameInput, executorHandle, release)
      // Timed out: the permit is already back, and this frame's result — if the
      // orphan call ever produces one — is stale by the width of the timeout.
      // Emitting it would put a minutes-old frame on the live bus.
      if (result === TIMED_OUT) {
        frameReleaseReason = 'drop'
        return
      }
      const inferDoneAt = Date.now()
      const inferenceMs = inferDoneAt - semAcquiredAt

      state.inferenceTimes.push(inferenceMs)
      if (state.inferenceTimes.length > 100) {
        state.inferenceTimes.shift()
      }
      state.processedCount++

      if (result) {
        // A shed is work THROWN AWAY, and nothing counted it until 2026-08-13:
        // `droppedFrames` summed the two queue-overflow counters, which this
        // fleet does not produce (three nodes shedding at 563/283/114 episodes
        // an hour while every queue signal read 0). Any consumer asking "is
        // this node keeping up" — the node-stress score above all — was
        // therefore blind to the dominant saturation mode here.
        if (result.shed === true) state.shedFrames++
        // BOTH sources means both, on ONE frame result. Merged here rather
        // than emitted as a second event: two results for one frame is the
        // two-plane arrangement this whole change exists to end — the tracker
        // would see one subject twice, from two instants, and spend its
        // cross-class rules deciding whether they are the same thing.
        //
        // The result stays attributed to `'pipeline'`: the accelerator DID
        // run on this frame, and calling it onboard would hide that.
        await this.notifyCallbacks(
          deviceId,
          frame,
          plan.runsOnboard ? this.mergeOnboardDetections(state, result, frame) : result,
          streamType,
          handle,
          'pipeline',
          entry.occasion,
        )
        frameReleaseReason = 'success'
        const emittedAt = Date.now()

        const capturedAt = frame.capturedAt
        this.timingSampler.addSample(deviceId, {
          queueWait: pickedAt - enqueuedAt,
          semaphoreWait: semAcquiredAt - pickedAt,
          inference: inferenceMs,
          resultToEmit: emittedAt - inferDoneAt,
          // capturedAt is the shm-ring commit wall-clock; pickedAt − capturedAt
          // is how stale the frame was when inference started. <0/absent → unknown.
          frameAge: typeof capturedAt === 'number' && capturedAt > 0 ? pickedAt - capturedAt : -1,
          // Wall-clock pipeline latency: enqueue → result emitted. (Capture →
          // enqueue, i.e. RTSP decode + shm-ring write, is not measured here —
          // the shm frame carries only a PTS, no wall-clock capture stamp.)
          endToEnd: emittedAt - enqueuedAt,
          detections: result.detections?.length ?? 0,
          // What the operator's class floor took from the tracker (D665).
          belowFloor: tallyBelowFloor(result.discarded),
        })
      } else frameReleaseReason = 'drop'
    } catch {
      frameReleaseReason = 'error'
    } finally {
      state.inflight -= 1
      release()
      try {
        if (frameReleaseReason === 'success' && handle && isContinuousRetainEnabled()) {
          await this.config.hydrateRetainedFrame?.(handle)
        }
      } catch {
        // Best-effort: a failed content-sized hydrate must not skip release.
      }
      if (handle) this.config.releaseRetention?.(handle, frameReleaseReason)
      if (frame.frameRef) this.config.releaseFrameRef?.(frame.frameRef, frameReleaseReason)
      entry.onSettled?.(frameReleaseReason === 'success' ? 'inferred' : 'lost')
    }
  }

  /**
   * Fold the camera's pending boxes into a result the ML pass just produced.
   *
   * Consumes the slot exactly as {@link processOnboardRoot} does — the same
   * push must never be pinned onto a second frame — and returns `result`
   * untouched when there is nothing fresh to add, so the common quiet frame
   * allocates nothing.
   */
  private mergeOnboardDetections(
    state: CameraState,
    result: FrameResult,
    frame: DecodedFrame,
  ): FrameResult {
    const pairing = onboardRootDetections(
      state.onboardSlot,
      { timestamp: Date.now(), width: frame.width, height: frame.height },
      state.registration.objectGate,
    )
    if (pairing.kind !== 'paired') return result
    state.onboardSlot = null
    return { ...result, detections: [...(result.detections ?? []), ...pairing.detections] }
  }

  /**
   * The CAMERA is this camera's root step.
   *
   * Same shape as the pipeline path and deliberately so: one decoded frame, one
   * `FrameResult`, the same `notifyCallbacks`, the same handle, the same
   * retention release. Everything downstream — subject tiles, birth evidence,
   * the `detailSteps` announce, the overlay, the tracker — cannot tell which
   * detector produced the boxes, which is the entire point. What it does NOT do
   * is take an inference permit: the accelerator is never asked.
   *
   * A frame with no fresh onboard detection produces NO result rather than an
   * empty one. An empty `FrameResult` is a positive statement ("I looked and
   * there was nothing"), and this path did not look — it decoded a frame while
   * the camera happened to be silent. Emitting emptiness would tell the
   * tracker every silent frame is evidence of absence and coast every subject
   * to death between two pushes.
   */
  private async processOnboardRoot(
    deviceId: number,
    entry: DetectionQueueEntry,
    state: CameraState,
    streamType: StreamType,
    plan: DetectionSourcePlan,
  ): Promise<void> {
    const { frame, handle } = entry
    let frameReleaseReason: 'success' | 'error' | 'drop' = 'drop'
    try {
      if (!plan.runsOnboard) {
        // No root detector at all. The operator emptied the list; the frame is
        // decoded (something else asked for the stream) and nothing looks at
        // it. Said once per camera per interval so "detection does nothing" has
        // an answer.
        this.noteOnboardRootIdle(deviceId, 'no-source')
        return
      }
      const pairing = onboardRootDetections(
        state.onboardSlot,
        { timestamp: Date.now(), width: frame.width, height: frame.height },
        state.registration.objectGate,
      )
      if (pairing.kind !== 'paired') {
        // `gated` is the operator's own settings refusing every box, which is a
        // different fact from an idle camera and must not read as one.
        if (pairing.kind === 'gated') state.onboardSlot = null
        this.noteOnboardRootIdle(deviceId, pairing.kind)
        return
      }
      // Consumed. The same push must not be pinned onto a second frame — the
      // tracker would read one subject standing perfectly still across frames
      // it was never seen in.
      state.onboardSlot = null
      state.processedCount++
      const result: FrameResult = {
        kind: 'frame',
        frameId: `onboard-${String(deviceId)}-${String(frame.timestamp)}`,
        deviceId,
        timestamp: Date.now(),
        width: frame.width,
        height: frame.height,
        detections: pairing.detections,
      }
      state.lastResultDetections = pairing.detections.length
      // The firmware is this camera's root detector, so nothing enqueued this
      // frame to the ML and nothing marked it. It is nonetheless published with
      // a handle below, and post-analysis asks for its pixels within seconds.
      if (handle) this.config.markFrameAskable?.(handle)
      await this.notifyCallbacks(
        deviceId,
        frame,
        result,
        streamType,
        handle,
        'onboard',
        entry.occasion,
      )
      frameReleaseReason = 'success'
    } catch {
      frameReleaseReason = 'error'
    } finally {
      try {
        if (frameReleaseReason === 'success' && handle && isContinuousRetainEnabled()) {
          await this.config.hydrateRetainedFrame?.(handle)
        }
      } catch {
        // Best-effort: a failed content-sized hydrate must not skip release.
      }
      if (handle) this.config.releaseRetention?.(handle, frameReleaseReason)
      if (frame.frameRef) this.config.releaseFrameRef?.(frame.frameRef, frameReleaseReason)
      entry.onSettled?.(frameReleaseReason === 'success' ? 'inferred' : 'lost')
    }
  }

  /**
   * Report — once per camera per interval — that the onboard root step decoded
   * a frame and produced nothing, with WHICH of the reasons it was. Sampled
   * because it fires at detection fps on a silent camera, which is most of the
   * time and is not itself a fault.
   */
  private noteOnboardRootIdle(deviceId: number, reason: string): void {
    const now = Date.now()
    const key = `${String(deviceId)}:${reason}`
    const last = this.onboardIdleReportedAt.get(key) ?? 0
    if (now - last < ONBOARD_ROOT_IDLE_REPORT_MS) return
    this.onboardIdleReportedAt.set(key, now)
    this.logger?.info('onboard root step produced nothing for a decoded frame', {
      tags: { deviceId },
      meta: { reason },
    })
  }

  /**
   * The camera spoke. Held until a decoded frame can be paired with it.
   *
   * Gated by the CALLER on `detectionSources` — this method is the mechanism,
   * not the policy, and a camera that does not name `onboard` never reaches it.
   */
  reportNativeDetection(
    deviceId: number,
    detections: readonly CameraNativeDetection[],
    frameWidth?: number,
    frameHeight?: number,
  ): void {
    const state = this.cameras.get(deviceId)
    if (!state) return
    state.onboardSlot = {
      at: Date.now(),
      detections,
      ...(frameWidth !== undefined ? { frameWidth } : {}),
      ...(frameHeight !== undefined ? { frameHeight } : {}),
    }
  }

  /**
   * Await `processFrame` with a hard bound. On expiry the permit is released
   * immediately (via the caller's release-once closure) and {@link TIMED_OUT}
   * is returned; the underlying call is left to settle into the void, since
   * the executor contract offers no cancellation.
   */
  private async awaitInferenceBounded(
    deviceId: number,
    frameInput: FrameInput,
    executorHandle: FrameHandle | undefined,
    release: () => void,
  ): Promise<FrameResult | null | typeof TIMED_OUT> {
    const timeoutMs = this.config.inferenceTimeoutMs ?? DEFAULT_INFERENCE_TIMEOUT_MS
    let timer: ReturnType<typeof setTimeout> | null = null
    const expiry = new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs)
      timer.unref?.()
    })
    try {
      // Kept as its OWN reference: on expiry we still want to know when the
      // abandoned call finally settles, and racing consumes the value.
      const inflight = this.config.processFrame(deviceId, frameInput, executorHandle)
      const outcome = await Promise.race([inflight, expiry])
      if (outcome === TIMED_OUT) {
        // Hand the permit back BEFORE logging so the scheduler resumes on the
        // next 10 ms tick rather than waiting on the log sink.
        release()
        this.inflightTimeouts += 1
        this.config.noteInferenceOutcome?.(deviceId, REASON_INFERENCE_TIMEOUT)
        // Measured 2026-07-31: 1290 of these in six hours across all three
        // nodes, arriving in BURSTS — 96 in eight seconds, 64 in one — with
        // `availablePermits` at 1 in 77% of them. Those are not independent
        // 20-second calls; they are a wave of in-flight calls all crossing the
        // deadline together, i.e. the shared inference path stalled as a whole
        // and then released. Two hypotheses were killed by the same data: it is
        // not cold model load after an attach (only 1-7% land within 5-30 s of
        // one, median distance 257 s), and it is not a permit wedge (a permit
        // was free).
        //
        // What the line could not say is WHICH engine stalled, so a burst could
        // not be attributed. It now carries that, plus how many timeouts are
        // outstanding — a burst reads as one rising number instead of N
        // unrelated lines.
        this.logger?.warn('inference timed out — permit released, result discarded', {
          tags: { deviceId },
          meta: {
            timeoutMs,
            availablePermits: this.semaphore.available,
            outstandingTimeouts: this.inflightTimeouts,
          },
        })
        // The abandoned call usually DOES settle later. How long after the
        // deadline it arrives is the stall's real length — the number that
        // separates "slow" from "stopped", and the one nothing recorded.
        const deadlineAt = Date.now()
        const noteSettled = (fate: 'resolved' | 'rejected'): void => {
          this.inflightTimeouts = Math.max(0, this.inflightTimeouts - 1)
          this.logger?.info('inference: abandoned call settled after the deadline', {
            tags: { deviceId },
            meta: {
              lateByMs: Date.now() - deadlineAt,
              totalMs: timeoutMs + (Date.now() - deadlineAt),
              fate,
              outstandingTimeouts: this.inflightTimeouts,
            },
          })
        }
        inflight.then(
          () => noteSettled('resolved'),
          () => noteSettled('rejected'),
        )
      } else {
        // THE DENOMINATOR: a call that came back inside the deadline. It lives
        // in an `else` because the timeout branch above FALLS THROUGH to this
        // return — noting unconditionally would count every timeout twice, once
        // as a failure and once as its own denominator, and the published rate
        // would be half of the real one.
        this.config.noteInferenceOutcome?.(deviceId)
      }
      return outcome
    } finally {
      if (timer !== null) clearTimeout(timer)
    }
  }

  /**
   * Called on every tick that finds zero available permits. Warns once the
   * starvation outlives `inferenceStallWarnMs` WITH queued work — queued work
   * is the discriminator: a runner with no permits and no backlog is simply
   * busy, while one with a backlog it cannot touch is wedged.
   */
  private noteInferenceStall(): void {
    let queuedFrames = 0
    for (const state of this.cameras.values()) queuedFrames += state.detectionQueue.size
    if (queuedFrames === 0) {
      this.inferenceStallSince = null
      this.inferenceStallWarnedAt = null
      return
    }

    const now = Date.now()
    if (this.inferenceStallSince === null) {
      this.inferenceStallSince = now
      return
    }

    const stalledMs = now - this.inferenceStallSince
    const warnAfterMs = this.config.inferenceStallWarnMs ?? DEFAULT_INFERENCE_STALL_WARN_MS
    if (stalledMs < warnAfterMs) return
    if (
      this.inferenceStallWarnedAt !== null &&
      now - this.inferenceStallWarnedAt < INFERENCE_STALL_REWARN_MS
    ) {
      return
    }
    this.inferenceStallWarnedAt = now

    // One line per starved camera, each carrying its own deviceId, because the
    // question asked of this is always per-camera ("why is 101 worse than 102").
    for (const [deviceId, state] of this.cameras) {
      if (state.detectionQueue.size === 0) continue
      this.logger?.warn('no inference permit available while frames are queued', {
        tags: { deviceId },
        meta: {
          stalledMs,
          queuedFrames: state.detectionQueue.size,
          droppedFrames: state.detectionQueue.droppedFrames,
          phase: state.phase,
          concurrency: this.semaphore.concurrency,
        },
      })
    }
  }

  private async notifyCallbacks(
    deviceId: number,
    frame: DecodedFrame,
    result: FrameResult,
    streamType: StreamType,
    handle: FrameHandle | undefined,
    source: DetectionSource,
    occasion: InferenceOccasion,
  ): Promise<void> {
    for (const callback of this.resultCallbacks) {
      try {
        await callback(deviceId, frame, result, streamType, handle, source, occasion)
      } catch {
        // Error isolation: individual callback failures don't affect others
      }
    }
  }

  private pickNextDetectionFrame(): {
    deviceId: number
    entry: DetectionQueueEntry
    state: CameraState
  } | null {
    for (const [deviceId, state] of this.cameras) {
      if (
        state.registration.detectionMode === 'always-on' &&
        state.detectionQueue.size > 0 &&
        state.inflight < this.maxInflightPerCamera()
      ) {
        const entry = state.detectionQueue.dequeue()!
        return { deviceId, entry, state }
      }
    }

    // No round-robin cameras is not "nothing to do": an `always-on` camera can
    // still have history waiting, so fall through to the lane rather than
    // returning here.
    if (this.defaultRoundRobinKeys.length === 0) return this.pickNextPreRollFrame()

    const startIndex = this.defaultRoundRobinIndex
    for (let i = 0; i < this.defaultRoundRobinKeys.length; i++) {
      const idx = (startIndex + i) % this.defaultRoundRobinKeys.length
      const deviceId = this.defaultRoundRobinKeys[idx]
      if (!deviceId) continue
      const state = this.cameras.get(deviceId)
      if (!state) continue

      // A queued frame is dispatched in `active` AND in `watching`. Only the
      // occupancy recheck can put a frame on a watching camera's queue
      // (`enqueueDetectionFrame` refuses it, `transitionToWatching` clears it),
      // and until 2026-09-16 this line asked for `active` alone: the recheck's
      // frames were ACCEPTED, sat on a latest-only queue overwriting each
      // other, and the survivor was inferred on the first tick of the NEXT
      // session — minutes stale, and after the burst had already reported
      // `found: false` because nothing had run while it was in flight. Two
      // such reports disarm the timer, so the recheck disarmed itself on every
      // on-motion camera. A frame this runner accepts is a frame it runs.
      if (
        (state.phase === 'active' || state.phase === 'watching') &&
        state.detectionQueue.size > 0 &&
        state.inflight < this.maxInflightPerCamera()
      ) {
        this.defaultRoundRobinIndex = (idx + 1) % this.defaultRoundRobinKeys.length
        const entry = state.detectionQueue.dequeue()
        if (!entry) continue
        return { deviceId, entry, state }
      }
    }

    return this.pickNextPreRollFrame()
  }

  /**
   * The catch-up lane, reached ONLY after every camera's live queue came back
   * empty. That ordering IS the priority rule: a live frame is always picked
   * first, so a pre-roll frame can never delay one — and the burst simply
   * stops progressing while the camera is busy, which is the correct behaviour
   * for one-shot work whose value does not decay.
   */
  private pickNextPreRollFrame(): {
    deviceId: number
    entry: DetectionQueueEntry
    state: CameraState
  } | null {
    if (!this.preRollDispatchable()) return null
    for (const [deviceId, state] of this.cameras) {
      if (state.phase !== 'active') continue
      if (state.preRollQueue.size === 0) continue
      if (state.detectionQueue.size > 0) continue
      if (state.inflight >= this.maxInflightPerCamera()) continue
      const entry = state.preRollQueue.dequeue()
      if (!entry) continue
      return { deviceId, entry, state }
    }
    return null
  }
}
