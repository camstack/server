/**
 * `SessionDispatchController` — session-time detection dispatch for
 * `on-motion` cameras (Phase 3 slice 2, C16, S11 Task 2 extraction).
 *
 * Owns the ephemeral `DetectionSessionRegistry` (ACTIVE session tracking,
 * distinct from the standing `assignments` map — see that class's own field
 * doc), a dedicated `KeyedAsyncLock` serializing per-device session
 * dispatch/teardown critical sections (mirrors the audio controller's
 * `audioSubLocks`, keyed separately so a session op never serializes behind
 * an unrelated audio op for the same device), the shutdown guard, and
 * `motionWatchByDevice` (the watch-only analyzer attach on the singleton
 * `clusterRoles.motionNode` role for an idle on-motion camera).
 *
 * Extracted verbatim (mechanical, zero logic change) from `index.ts` — every
 * method body, log message, and control-flow branch is unchanged; only the
 * storage backing (`this.<field>` → `this.<field>` on this class when the
 * field moved here too, `this.X` addon calls → `this.deps.X` injected
 * closures when the state/method stayed on `index.ts`) differs.
 *
 * **C1 safety (CRITICAL — read before touching this file):** `stopDetection`
 * on the addon class carries a concurrency fix (C1) that makes a
 * `stopDetection` racing a motion-triggered `handleSessionMotion` dispatch
 * leave no orphan session/assignment/attach. Its two halves both moved here
 * byte-for-byte:
 *   - {@link SessionDispatchController.stopForDevice} deletes the addon's
 *     `activeDetections` entry (via `deps.dropActiveDetection`) INSIDE the
 *     SAME session-lock critical section as the session detach/deregister —
 *     see that method's doc comment for the full race it closes.
 *   - {@link SessionDispatchController.handleSessionMotion}'s `'dispatch'`
 *     branch ALWAYS enters the session lock (no pre-lock early return) and
 *     RE-READS `activeDetections` (via `deps.getActiveDetectionConfig`)
 *     INSIDE the lock, bailing if the config is gone or no longer
 *     `on-motion`, instead of trusting the config captured before the lock.
 * Neither the lock/re-read/bail ordering nor the atomicity of the
 * delete-under-lock changed in this move — only the storage backing.
 *
 * `sessionRegistry` is a public (not `private`) readonly field — `index.ts`
 * exposes its own `protected get sessionRegistry()` test-seam compat
 * accessor onto it (mirrors the `audioSubscriptions` compat-getter pattern
 * from the S7 extraction) so `on-motion-session-cutover.spec.ts`'s subclass
 * keeps observing real session state after this move, and the
 * `deregisterSession` closures wired into `ReconcileController` /
 * `NodeLifecycleHandler` reach it directly.
 */
import type {
  CameraDetectionConfig,
  MotionSource,
  MotionSources,
  PipelineAssignment,
  RunnerCameraConfig,
  RunnerLocalLoad,
  SessionTrigger,
  ShareAffinityElection,
  Zone,
} from '@camstack/types'
import {
  errMsg,
  type IScopedLogger,
  type MotionTriggeredBy,
  type SessionPlacementPolicy,
} from '@camstack/types'
import type { AgentLoadService } from './agent-load-service.js'
import {
  type EarlyLookAnswer,
  OccupancyRecheckController,
  type OccupancyRecheckDeps,
} from './occupancy-recheck-controller.js'
import { resolveAttachPipeline } from './attach-pipeline.js'
import { DEFAULT_BALANCER_INPUT_TTL_MS, TtlMemo } from './balancer-input-cache.js'
import {
  DetectionSessionRegistry,
  type DetectionSessionEdge,
} from './detection-session-registry.js'
import type { InferenceDeviceRotation } from './device-balancer.js'
import { pickInferenceDevice, selectedDeviceKey } from './device-balancer.js'
import type { ShareElectionHistory } from './share-election-history.js'
import { detectionFpsForTrigger } from './device-detection-settings.js'
import {
  decideSessionAction,
  decideSessionLifecycle,
  type SessionCloseReason,
} from './dispatch-reconcile.js'
import {
  BALANCE_LOAD_BUDGET_MS,
  DISPATCH_RECONCILE_BUDGET_MS,
  type DispatchTimings,
  raceBudget,
} from './dispatch-timing.js'
import { KeyedAsyncLock } from './keyed-async-lock.js'
import { balance } from './load-balancer.js'
import type { BalancerDecision } from './load-balancer.js'
import type { SessionPlacementStats } from './session-placement-stats.js'
import type { SessionAffinityMemory } from './session-affinity.js'
import { countRunningByNode, electNodeByShareWithAffinity } from './session-share-placement.js'
import type { NodeTopologyService } from './node-topology.js'
import type { PipelineSettingsStore } from './pipeline-settings-store.js'
import type { EligibilityCatalogRead } from './orchestrator-types.js'
import type { PendingReason, PlacementLedger } from './placement-ledger.js'

/**
 * Fallback session-hold cap (ms) when a device's resolved
 * `CameraDetectionConfig` carries no `maxSessionHoldMs` (mirrors the runner
 * cap's `maxSessionHoldMsField.default`). Bounds how long an on-motion session
 * is held open past the cooldown while a non-stationary track stays live.
 */
export const DEFAULT_MAX_SESSION_HOLD_MS = 120_000

/**
 * Minimum time a detection session stays open, whatever closes it.
 *
 * Live measurement 2026-08-21 (25.6 min, 817 sessions): median duration 4.0 s,
 * 57.6% under 5 s, and **820 of 822 closes were the hub's explicit
 * `motion_cleared` falling edge** — which closed the session instantly, so
 * `motionCooldownMs` / the track hold / `maxSessionHoldMs` decided 2 closes in
 * total. Camera 104 opened and closed 249 sessions in 25 minutes; every close
 * dropped its assignment and every reopen re-elected a node, which is the
 * 2-3 second flicker the operator reported on the placement column — and a full
 * detach+attach round trip per flicker.
 *
 * This is a FLOOR under the existing clocks, not a new authority over them
 * (D62): `motionCooldownMs` still decides how long after the last motion tick a
 * session stays open, and a close that arrives before the floor is DEFERRED to
 * the deadline rather than dropped. If a motion tick lands during the deferral
 * the session simply stays open on the normal cooldown clock — no re-election,
 * no second dispatch.
 *
 * 10 s is the operator's number. It is well under `motionCooldownMs`'s 30 s
 * default (so on a camera with a well-behaved VMD the floor never fires) and
 * well under `DEFAULT_MAX_SESSION_HOLD_MS`, so it cannot interact with either.
 * Exported so a test asserts against the same value the controller uses.
 */
export const MIN_SESSION_OPEN_MS = 10_000

/**
 * How old the "a subject is tracked on this camera" signal may be and still
 * mean PRESENT.
 *
 * The signal is fed per tracked frame from `PipelineAnalyticsFrameTracked`
 * (`hasLiveTrack`), and a session camera runs its detector continuously while
 * attached — so frames arrive at `detectionFps`, i.e. hundreds of milliseconds
 * apart, not seconds. 4 s therefore tolerates roughly a 4× pipeline stall
 * before a live subject is declared gone.
 *
 * It is deliberately NOT `motionCooldownMs` (30 s default). The cooldown
 * answers "how long after the last motion tick do we stay open" — a question
 * about MOTION, on a signal that ticks per motion event. Reusing it as the
 * staleness window for a per-FRAME signal would keep every session alive for a
 * further 30-60 s after the scene emptied, which is the load fault this whole
 * change exists to avoid.
 */
export const SUBJECT_PRESENT_STALE_MS = 4_000

/**
 * Cadence at which a held session re-asks whether the subject is still there.
 * Derived from {@link SUBJECT_PRESENT_STALE_MS}, never a second number: the
 * worst-case tail after a subject leaves is `staleMs + recheckMs`, so halving
 * it bounds the tail at 1.5× the staleness window instead of 2×.
 */
export const SUBJECT_PRESENCE_RECHECK_MS = Math.floor(SUBJECT_PRESENT_STALE_MS / 2)

/**
 * Sampling stride for the "session motion: already active, fallback
 * rearmed" debug line — see `activeRefireCountByDevice`. Motion refires
 * on a busy camera arrive roughly once per second; a stride of 100 keeps
 * roughly one line per device per couple of minutes while `refireCount`
 * in the line preserves the exact number.
 */
const REFIRE_LOG_SAMPLE_EVERY = 100

/**
 * Sampling stride for the "session motion dropped — the camera does not list
 * this source" line. First drop per (camera, trigger), then every Nth — the
 * running count rides along in `dropCount`. The runner's analyzer
 * side-channel emits `source: 'analyzer'` transitions on onboard-only
 * cameras, and those are exactly what the gate drops, so they may be frequent.
 */
export const SOURCE_GATE_LOG_SAMPLE_EVERY = 50

/** Where the source gate refused: on the pre-lock config, or on the re-read inside the lock. */
export type SourceGateWhere = 'pre-lock' | 'in-lock'

/**
 * Freshness window for the balancer inputs a session dispatch reads (see
 * {@link TtlMemo}). Re-exported from the shared default so a test can assert
 * against the same number the controller uses rather than a copy of it.
 */
export const BALANCER_INPUT_TTL_MS = DEFAULT_BALANCER_INPUT_TTL_MS

/**
 * Single key for the balancer inputs that are CLUSTER-wide rather than
 * per-node (agent load, the node cap map, the node weight map). {@link TtlMemo}
 * is keyed; these three simply have one key each.
 */
const CLUSTER_KEY = 'cluster'

/**
 * Cadence of the background balancer-input refresh.
 *
 * Half the TTL, so a memo that is being refreshed is never allowed to expire
 * between ticks — which is the whole point: a camera that fires once an hour
 * must still find a FRESH answer waiting, or the cache buys it nothing and it
 * pays the full read on the motion path exactly as before.
 *
 * The ticker only ever re-reads keys that are already held, so it costs nothing
 * until the first session dispatch and stops mattering the moment
 * {@link SessionDispatchController.shutdown} clears it.
 */
const BALANCER_REFRESH_INTERVAL_MS = Math.floor(BALANCER_INPUT_TTL_MS / 2)

/**
 * What the lifecycle rule saw at the instant it decided to close — carried
 * into the close so the log line can name the work it is about to drop
 * without re-reading state the close has already torn down.
 */
/**
 * The `sessionTrigger` a session attach carries: the source that passed the
 * camera's gate and what raised it, with the attached sensor's name when the
 * camera-sensors resolution knows it. Pure — the name lookup is in memory.
 */
export function buildSessionTrigger(
  cameraId: number,
  source: MotionSource,
  triggeredBy: MotionTriggeredBy,
  sensorNameOf: ((cameraId: number, sensorId: number) => string | undefined) | undefined,
): SessionTrigger {
  if (triggeredBy.kind !== 'sensor') return { source, triggeredBy }
  const sensorName = sensorNameOf?.(cameraId, triggeredBy.deviceId)
  return { source, triggeredBy, ...(sensorName !== undefined ? { sensorName } : {}) }
}

export interface SessionCloseObservation {
  readonly openForMs: number
  /** Age of the last "a subject is tracked here" frame, or `null` if never. */
  readonly sinceSubjectSeenMs: number | null
  readonly maxHoldMs: number
}

export interface SessionDispatchControllerDeps {
  /**
   * A detection session opened or closed (D907). Feeds the blind monitor's
   * in-memory motion mirror; optional so existing harnesses build.
   */
  readonly onSessionEdge?: (edge: DetectionSessionEdge) => void
  readonly ledger: PlacementLedger
  readonly topology: NodeTopologyService
  readonly loadService: AgentLoadService
  readonly settingsStore: PipelineSettingsStore
  /** Thin seam onto `PlacementService.attachOn` (via the addon's own delegate). */
  readonly attachOn: (nodeId: string, config: RunnerCameraConfig) => Promise<void>
  /** Thin seam onto `PlacementService.detachOn` (via the addon's own delegate). */
  readonly detachOn: (nodeId: string, deviceId: number) => Promise<void>
  /**
   * `pipelineRunner.requestOccupancyBurst`, pinned to a node — the producer of
   * the occupancy recheck on session-dispatched cameras (D547, see
   * `occupancy-recheck-controller.ts`). Optional so existing harnesses build;
   * a controller built without it arms no recheck and SAYS SO at boot, because
   * a recheck that silently never runs is the defect this exists to close.
   */
  readonly requestBurstOn?: OccupancyRecheckDeps['requestBurstOn']
  /** Thin seam onto `ledger.recordAssignment`. */
  readonly recordAssignment: (
    deviceId: number,
    agentNodeId: string,
    reason: PipelineAssignment['reason'],
    pinned: boolean,
  ) => void
  /** Thin seam onto `ledger.dropAssignment`. */
  readonly dropAssignment: (deviceId: number, emit: 'unassigned' | 'silent') => void
  /** Reconcile runner truth before choosing a node for a fresh ephemeral session. */
  readonly reconcilePlacementFromRunners: () => Promise<void>
  /** `activeDetections.get(deviceId)` — the addon's per-device active detection config cache. */
  readonly getActiveDetectionConfig: (deviceId: number) => CameraDetectionConfig | undefined
  /**
   * The name of a sensor attached to a camera, from the camera-sensors
   * resolution in memory (`CameraSensorsController.sensorNameOf`). Named on the
   * session attach's `sessionTrigger` so the phase event can say which sensor
   * opened the session. Optional: a harness without it sends the deviceId only.
   */
  readonly sensorNameOf?: (cameraId: number, sensorId: number) => string | undefined
  /**
   * `activeDetections.delete(deviceId)` — see the class doc +
   * {@link SessionDispatchController.stopForDevice} for why this MUST run
   * inside the same session lock as the session detach/deregister (C1).
   */
  readonly dropActiveDetection: (deviceId: number) => void
  /** `zonesProvider?.listZones({ deviceId }) ?? []` on the addon. */
  readonly listZones: (deviceId: number) => Promise<readonly Zone[]>
  /** Thin seam onto `this.readPipelinePin` on the addon. */
  readonly readPipelinePin: (deviceId: number) => Promise<string | null>
  /**
   * The ENABLED + live-AVAILABLE inference devices for a node as a
   * `deviceKey → weight` map (probe ∪ stored opt-OUT set, AUTO = all enabled).
   * Seam onto `PipelineOrchestratorAddon.resolveEligibleInferenceDevices` — the
   * probe-aware authority that replaced the store-only, opt-in read (audit
   * R2/F1/F4). Empty / single entry ⇒ leave `deviceKey` unset.
   */
  readonly getEligibleInferenceDevices: (
    nodeId: string,
    read: EligibilityCatalogRead,
  ) => Promise<Record<string, number>>
  /** Can this node still infer? See `PlacementServiceDeps.isNodeInferenceUsable`
   *  — same mirror, same fail-open contract. */
  readonly isNodeInferenceUsable: (nodeId: string) => boolean
  /** Per-device concurrent-session caps (`deviceKey → maxSessions`) for the device balancer. */
  readonly getInferenceDeviceCaps: (nodeId: string) => Promise<Record<string, number>>
  /** The camera's soft node+device pin (`pipelineDeviceKey`), or null for auto. */
  readonly readPipelineDevicePin: (deviceId: number) => Promise<string | null>
  /**
   * Fair chooser among inference devices the capacity tier could not separate.
   * Shared with `PlacementService` (one rotation per orchestrator) — standing
   * attaches and on-motion sessions consume the SAME accelerators, so they must
   * consume the same rotation or each would think it alone was spreading load.
   */
  readonly inferenceRotation: InferenceDeviceRotation
  /** Recent share elections (nodes and devices), so sequential sessions follow the weights. */
  readonly shareHistory?: ShareElectionHistory
  /**
   * Each camera's last session placement (D916): under `share` the next
   * session keeps it while it is within one session of the turn holder.
   * Absent = every session is a fresh election (test harnesses).
   */
  readonly sessionAffinity?: SessionAffinityMemory
  /**
   * The cluster's session placement policy (D748), read per dispatch.
   * Absent = `least-loaded` (the policy before D748; test harnesses).
   */
  readonly sessionPlacement?: () => SessionPlacementPolicy
  /** What placement did — fed on every session change, start and yield (D748). */
  readonly placementStats?: SessionPlacementStats
  readonly logger: IScopedLogger
}

export class SessionDispatchController {
  /**
   * Ephemeral registry of ACTIVE session-time detection sessions. Public
   * (not `private`) — see the class doc for the two production/test reasons
   * `index.ts` reaches through it directly.
   */
  readonly sessionRegistry = new DetectionSessionRegistry(
    (sessions) =>
      this.deps.placementStats?.noteSessions(
        sessions.map((s) => ({ nodeId: s.nodeId, deviceKey: s.deviceKey ?? '' })),
      ),
    (edge) => this.deps.onSessionEdge?.(edge),
  )
  /**
   * `deviceId|deviceKey` of device pins the session path has already said it
   * ignored — one line per stale pin, not one per session (D748).
   */
  private readonly reportedStalePins = new Set<string>()
  /**
   * Per-device async mutex for session dispatch/teardown critical sections —
   * backed by the generic `KeyedAsyncLock` (mirrors the audio controller's
   * `audioSubLocks`). Once {@link shutdown} sets {@link shuttingDown},
   * queued/new sections become no-ops so they cannot resurrect a session
   * into the cleared maps.
   */
  private readonly sessionLocks = new KeyedAsyncLock<number>({
    isShuttingDown: () => this.shuttingDown,
  })
  /** Set true at the very start of {@link shutdown} — see that method's doc comment. */
  private shuttingDown = false
  /**
   * Per-device watch-only attach for session-mode (`detectionMode:'on-motion'`)
   * analyzer-class cameras (Phase 3 slice 2). Mirrors the audio controller's
   * `audioAssignments` shape: nodeId of the `clusterRoles.motionNode` role
   * node currently holding a `motionSources:['analyzer'],
   * detectionMode:'disabled'` attach that keeps the grey-decode motion
   * analyzer emitting `MotionOnMotionChanged` while the camera is idle.
   * Deliberately NOT `assignments`/`recordAssignment` — a standing entry
   * there would make `decideSessionAction`'s `hasStandingAttach` check
   * always true and permanently suppress session dispatch. The subtractive
   * attachment reconcile preserves this intentional exception through
   * {@link isMotionWatchAttachment}; every other unassigned session-mode
   * attach is a stale detection session and is removed.
   *
   * I1 (known limitation, tracked Slice-3/4 follow-up): being absent from
   * `assignments` also means this attach has NO failover — see
   * {@link ensureMotionWatch}'s doc comment for the bounce/reassignment
   * scenario where an analyzer-class on-motion camera silently stops
   * dispatching.
   */
  private readonly motionWatchByDevice = new Map<number, string>()

  /**
   * The last session REFUSAL per camera (D650 rounds 3–4): the elected device
   * could not run the camera root, so no session opened and nothing was
   * recorded. Two readers:
   *  - the refusal line fires once per CHANGE of this entry, not on every
   *    motion edge (a camera re-elected onto the same device every few
   *    seconds is one fact, not a log storm);
   *  - the camera status reads it through {@link refusalReason} and shows
   *    `pending:<reason>` in `reasons.detection`, where a STANDING camera's
   *    pending reason already appears — an armed camera whose every session
   *    is refused must not look like a healthy one waiting for motion.
   * Deliberately NOT the ledger's `pendingReasons`: an entry there counts as a
   * standing attach in {@link handleSessionMotion} and would freeze the camera
   * idle — the trap `isIdleSessionCamera` (index.ts) flags. Cleared when a
   * session opens and when the camera's detection is stopped.
   */
  private readonly sessionRefusals = new Map<number, PendingReason>()

  /**
   * Per-device wall-clock of the last frame on which the tracker still had a
   * subject — ANY tracked object, moving or stopped — while a session was
   * active. The session-hold's only liveness input.
   *
   * It used to record only NON-stationary tracks, which made the hold unable
   * to keep a session open for a subject that had STOPPED — the one subject
   * the stationary registry needs to observe for its full 30 s promotion
   * window. Presence is the right predicate precisely because the thing that
   * ENDS it is the promotion: a promoted object is dropped by the tracker and
   * its later detections are suppressed by the registry, so it stops being
   * present and the session closes without anyone asking it to.
   *
   * Fed by {@link noteSubjectPresent} from the orchestrator's
   * `PipelineAnalyticsFrameTracked` tap; pruned on every teardown/stop so it
   * never holds a stale entry for an idle device. A single timestamp per
   * device (not a track-id set) keeps it self-healing: a dropped or late frame
   * event just goes stale and lets the session close.
   */
  private readonly lastSubjectSeenAt = new Map<number, number>()

  /**
   * Per-device count of objects the TRACKER held on the last tracked frame of
   * the active session — moving OR still (D652). Diagnostics only: it decides
   * nothing. {@link lastSubjectSeenAt} is presence as the HOLD sees it, which
   * the producer's stillness valve deliberately subtracts a still subject from;
   * this is what lets a close say whether it ended tracks the tracker still
   * had. Fed by {@link noteTrackedFrame}; pruned with the session.
   */
  private readonly lastLiveTrackCount = new Map<number, number>()

  /**
   * Per-device count of "motion refired while the session was already
   * active" no-ops since the current session was dispatched. Drives the
   * SAMPLED debug line in the dispatch path: on a busy camera the refire
   * fires on every motion tick (observed 4 772 rows/hour hub-wide,
   * 2026-08-01), so the line logs on the first refire and every
   * `REFIRE_LOG_SAMPLE_EVERY`th, carrying the running count. Reset on a
   * fresh dispatch so the "session stayed alive across N refires" number
   * is per-session, not per-process.
   */
  private readonly activeRefireCountByDevice = new Map<number, number>()

  /**
   * Per `${deviceId}:${trigger}` count of motion events dropped because the
   * camera's `motionSources` does not list the trigger. Drives the SAMPLED
   * drop line ({@link noteSourceGateDrop}).
   */
  private readonly sourceGateDrops = new Map<string, number>()

  /**
   * The five reads {@link dispatchDetectionSession} needs before it can pick a
   * node, memoised for {@link BALANCER_INPUT_TTL_MS} and refreshed OFF the
   * dispatch path once each dispatch completes. Measured at 832 ms on the
   * motion path — all of it inside the blind ramp between motion and the first
   * inferenced frame, and none of it an answer that changes meaningfully inside
   * one motion event.
   *
   * The cache can only ever help: a miss does exactly the read the un-cached
   * code did, and a read that throws with a stale answer in hand serves the
   * stale answer rather than failing the dispatch (see {@link TtlMemo.get}).
   */
  private readonly agentLoads = new TtlMemo<string, readonly RunnerLocalLoad[]>({
    load: () => this.deps.loadService.collectAgentLoad({ onlyEnabled: true }),
  })
  private readonly nodeCaps = new TtlMemo<string, Record<string, number | null>>({
    load: () => this.deps.settingsStore.buildNodeCaps(),
  })
  private readonly nodeWeights = new TtlMemo<string, Record<string, number>>({
    load: () => this.deps.settingsStore.buildNodeWeights(),
  })
  private readonly eligibleInferenceDevices = new TtlMemo<string, Record<string, number>>({
    // A MISS is a motion-start dispatch waiting on the answer: it may wait for
    // the node's catalog, as a first placement does. The REFRESHER waits for
    // nobody: one bounded round, and a node that does not answer fails the
    // read so the memo keeps its last answer. The unbounded form here looped
    // forever per departed node — a getSchema plus a 30 s acquire per round,
    // for as long as the key was held (D3).
    load: (nodeId, read) =>
      this.deps.getEligibleInferenceDevices(
        nodeId,
        read === 'refresh' ? 'one-round' : 'await-catalog',
      ),
  })
  private readonly inferenceDeviceCaps = new TtlMemo<string, Record<string, number>>({
    load: (nodeId) => this.deps.getInferenceDeviceCaps(nodeId),
  })

  /** Background refresher for {@link agentLoads} et al. Null until first use. */
  private balancerRefreshTimer: ReturnType<typeof setInterval> | null = null

  /**
   * The occupancy recheck for session-dispatched cameras (D547). The runner's
   * own recheck lives on an `on-motion` registration no camera receives; this
   * one is armed by the session close, which only this controller sees.
   */
  private readonly recheck: OccupancyRecheckController | null

  constructor(private readonly deps: SessionDispatchControllerDeps) {
    const requestBurstOn = deps.requestBurstOn
    if (requestBurstOn === undefined) {
      this.recheck = null
      deps.logger.info(
        'occupancy recheck has no burst producer on this build — no session-dispatched camera will be re-sampled',
        { meta: { why: 'SessionDispatchControllerDeps.requestBurstOn absent' } },
      )
    } else {
      this.recheck = new OccupancyRecheckController({
        attachOn: (nodeId, config) => deps.attachOn(nodeId, config),
        detachOn: (nodeId, deviceId) => deps.detachOn(nodeId, deviceId),
        requestBurstOn,
        isSessionActive: (deviceId) => this.sessionRegistry.has(deviceId),
        logger: deps.logger,
      })
    }
  }

  /**
   * D691 — the notification centre says an occupancy flip is pending on this
   * camera and can commit `afterMs` from now: one burst at the sustain's end.
   * A build with no burst producer refuses by name rather than accepting an
   * ask nothing will serve.
   */
  requestEarlyOccupancyLook(deviceId: number, afterMs: number, reason: string): EarlyLookAnswer {
    if (this.recheck === null) {
      this.deps.logger.info('occupancy early look: refused — no burst producer on this build', {
        tags: { deviceId },
        meta: { deviceId, afterMs, reason },
      })
      return { scheduled: false, refusedBecause: 'no-burst-producer' }
    }
    return this.recheck.requestEarlyLook(deviceId, afterMs, reason)
  }

  /**
   * Every inference result the orchestrator sees, for the recheck's
   * found/empty verdict: a `'burst'` result with detections is a found burst.
   */
  noteInferenceResult(
    deviceId: number,
    occasion: string | undefined,
    detectionCount: number,
  ): void {
    this.recheck?.noteInferenceResult(deviceId, occasion, detectionCount)
  }

  /**
   * Placement changed — this controller just attached or detached something, so
   * the AGENT LOAD it cached is not merely old, it is wrong.
   *
   * Invalidate rather than let it age out: a load snapshot that still counts a
   * camera this controller has already detached makes the very next dispatch
   * balance against a camera that is not there, which on a two-node cluster
   * with an alphabetical tie-break is enough to land it on the wrong node.
   * Followed immediately by a refresh, so the correction happens off the
   * dispatch path — and a dispatch that arrives before that refresh lands joins
   * the in-flight read instead of reading the invalidated value.
   *
   * Node caps, weights and the inference-device rosters are untouched: they are
   * settings/topology, not placement, and this controller never changes them.
   */
  private notePlacementChanged(): void {
    this.agentLoads.invalidate(CLUSTER_KEY)
    this.refreshBalancerInputs()
  }

  /**
   * Re-read every balancer input, off whatever path called this. Never awaited
   * by a dispatch, never throws. Also arms the periodic refresh on first use —
   * without a ticker the memo is only ever warm right after a dispatch, and a
   * camera that fires once an hour (the population this exists for) would find
   * it cold every time.
   */
  private refreshBalancerInputs(): void {
    this.ensureBalancerRefreshTimer()
    void Promise.all([
      this.agentLoads.refresh(CLUSTER_KEY),
      this.nodeCaps.refresh(CLUSTER_KEY),
      this.nodeWeights.refresh(CLUSTER_KEY),
      // Per-NODE, so only the nodes actually dispatched to are re-read; keys
      // nobody has used lately are dropped by `refreshAll` itself.
      this.eligibleInferenceDevices.refreshAll(),
      this.inferenceDeviceCaps.refreshAll(),
    ]).catch(() => undefined)
  }

  /** Arm the periodic refresh once; a no-op afterwards and after shutdown. */
  private ensureBalancerRefreshTimer(): void {
    if (this.balancerRefreshTimer !== null || this.shuttingDown) return
    const timer = setInterval(() => {
      void Promise.all([
        this.agentLoads.refreshAll(),
        this.nodeCaps.refreshAll(),
        this.nodeWeights.refreshAll(),
        this.eligibleInferenceDevices.refreshAll(),
        this.inferenceDeviceCaps.refreshAll(),
      ]).catch(() => undefined)
    }, BALANCER_REFRESH_INTERVAL_MS)
    timer.unref?.()
    this.balancerRefreshTimer = timer
  }

  /**
   * Record that at least one object was still TRACKED on `deviceId` this frame
   * — the freshness signal every close path consults to hold the session open
   * (see {@link lastSubjectSeenAt}). No-op unless a session is currently active
   * (nothing to hold otherwise), which also bounds the map to live sessions.
   * Telemetry-lossy by design: a missed frame simply lets presence go stale and
   * the session close on schedule.
   */
  noteSubjectPresent(deviceId: number, at: number = Date.now()): void {
    if (!this.sessionRegistry.has(deviceId)) return
    this.lastSubjectSeenAt.set(deviceId, at)
  }

  /**
   * Record how many objects the tracker held on this frame — the count the
   * close line reports as `liveTracks` (D652). Every tracked frame, not only
   * the ones that hold the session: a still subject is exactly the case that
   * stops holding it. No-op without an active session, which also bounds the
   * map. Telemetry-lossy (D8): a dropped frame leaves the previous count.
   */
  noteTrackedFrame(deviceId: number, liveTrackCount: number): void {
    if (!this.sessionRegistry.has(deviceId)) return
    this.lastLiveTrackCount.set(deviceId, liveTrackCount)
  }

  /**
   * `sessionRegistry.has(deviceId)` — the closure other controllers (Task 3's
   * standing-machinery guards, `index.ts`'s `isIdleSessionCamera`) consume
   * instead of reaching into `sessionRegistry` directly.
   */
  hasActiveSession(deviceId: number): boolean {
    return this.sessionRegistry.has(deviceId)
  }

  /** Whether this exact unassigned runner attach is an intentional analyzer motion watch. */
  isMotionWatchAttachment(deviceId: number, nodeId: string): boolean {
    return this.motionWatchByDevice.get(deviceId) === nodeId
  }

  /** Node currently hosting this device's ACTIVE detection session, or `null` when idle. */
  activeSessionNode(deviceId: number): string | null {
    return this.sessionRegistry.get(deviceId)?.nodeId ?? null
  }

  /**
   * Close an ACTIVE detection session so the next motion event re-dispatches
   * it fresh — used by `assignPipeline` when the operator pins a session-mode
   * camera to a node OTHER than the one its session currently runs on (the
   * cam-104 case: a busy camera's session never cools down, so without this
   * the stale pre-pin placement survived indefinitely).
   *
   * Deliberately NOT `stopForDevice`: the camera must stay ARMED —
   * `activeDetections` (the dispatch gate `handleSessionMotion` re-reads
   * inside the lock) and any motion-watch attach are both left untouched, so
   * the very next `MotionOnMotionChanged` re-runs `dispatchDetectionSession`,
   * which reads the (just-persisted) pin and lands on the pinned node via the
   * balancer's manual affinity. Runs under the session lock so it cannot race
   * an in-flight dispatch/teardown for the same device.
   */
  async closeSessionForReassign(deviceId: number): Promise<void> {
    await this.sessionLocks.run(deviceId, async () => {
      const session = this.sessionRegistry.get(deviceId)
      if (!session) return
      await this.deps.detachOn(session.nodeId, deviceId).catch((err: unknown) => {
        this.deps.logger.warn('assignPipeline: session detach failed', {
          tags: { deviceId, nodeId: session.nodeId },
          meta: { error: errMsg(err) },
        })
      })
      // Silent drop + deregister — mirrors `scheduleSessionTeardown`'s
      // teardown half (the session's `assignments` record goes with it, so no
      // stale `{pinned:false}` row shadows the new pin in the admin UI).
      this.deps.dropAssignment(deviceId, 'silent')
      this.sessionRegistry.deregister(deviceId)
      this.lastSubjectSeenAt.delete(deviceId)
      this.lastLiveTrackCount.delete(deviceId)
      // The camera just left this node — the cached agent load still counts it.
      this.notePlacementChanged()
    })
  }

  /**
   * Ensure a watch-only attach exists on the singleton `clusterRoles.motionNode`
   * role for an analyzer-class, session-mode (`detectionMode:'on-motion'`)
   * camera (Phase 3 slice 2, Task 2). Idempotent — a no-op once
   * `motionWatchByDevice` already has an entry for this device;
   * `startDetection`'s own "already active → stopDetection first" guard
   * (and `stopForDevice`'s teardown of `motionWatchByDevice`) is what makes
   * a config change re-ensure with fresh values rather than going stale.
   *
   * Deliberately NOT routed through `dispatchCamera`/`recordAssignment` — see
   * the `motionWatchByDevice` field doc for why a standing `assignments`
   * entry here would wedge `decideSessionAction` into permanent `'ignore'`.
   *
   * I1 — known limitation, tracked as a Slice-3/4 follow-up: because this
   * attach is deliberately kept OUT of `assignments`, it has NO failover.
   * Every other standing/session placement is re-derived on node
   * disconnect/reconnect (`handleNodeDisconnect`/`handleNodeConnect`) by
   * walking `assignments`/`cameraConfigs` — this watch-only attach is
   * invisible to that machinery. If the `clusterRoles.motionNode` node
   * bounces, or the role is reassigned to a different node, an
   * analyzer-class on-motion camera's watch attach on the OLD node is never
   * recreated on the new one: `motionWatchByDevice` still (wrongly) reports
   * an entry, so this method's idempotency guard (`if
   * (this.motionWatchByDevice.has(deviceId)) return`) makes it a permanent
   * no-op. The camera silently stops receiving `MotionOnMotionChanged` and
   * therefore stops dispatching detection sessions, with no error surfaced,
   * until an explicit stop/start (which clears `motionWatchByDevice`) or an
   * addon restart. Not fixed here — the live fleet is all-onboard-motion
   * today, so this path is currently unreached — but documented so it is
   * not silent.
   */
  async ensureMotionWatch(deviceId: number, config: CameraDetectionConfig): Promise<void> {
    if (this.motionWatchByDevice.has(deviceId)) return
    const nodeId = this.deps.topology.clusterRoles.motionNode
    const zones = await this.deps.listZones(deviceId)
    const watchConfig: RunnerCameraConfig = {
      deviceId,
      motionCooldownMs: config.motionCooldownMs,
      motionFps: config.motionFps,
      detectionFps: config.detectionFps,
      motionStreamId: config.motionStreamId,
      detectionStreamId: config.detectionStreamId,
      motionSources: ['analyzer'],
      pipelineEnabled: false,
      steps: [],
      audio: null,
      zones,
      detectionMode: 'disabled',
      audioMode: 'disabled',
      onboardMotionDrivesAnalyzer: config.onboardMotionDrivesAnalyzer,
      occupancyRecheckEnabled: config.occupancyRecheckEnabled,
      occupancyRecheckSec: config.occupancyRecheckSec,
      occupancyRecheckFrames: config.occupancyRecheckFrames,
      preRollInferenceEnabled: config.preRollInferenceEnabled,
      preRollInferenceFrames: config.preRollInferenceFrames,
      // WHICH ROOT DETECTOR. Carried explicitly, and its absence here was not
      // a harmless omission: `RunnerCameraConfig.detectionSources` is optional,
      // so tsc said nothing, and the transport's `withCapInputDefaults` then
      // filled the gap with the cap's declared default `['pipeline']` before
      // the runner ever saw the payload. An operator who picked `['onboard']`
      // had it stored, resolved and carried correctly all the way to this
      // literal — and then silently replaced, on every on-motion camera, which
      // is most of them. The always-on branch went through `buildRunnerConfig`
      // and was never affected, which is why the feature looked like it worked.
      //
      // The tell is in the log: `attachCamera received config` lists the keys
      // in order, and `detectionSources` appeared AFTER `frameSource`/`nodeId`
      // — i.e. appended by the default merge, not present in the object.
      detectionSources: config.detectionSources,
    }
    await this.deps.attachOn(nodeId, watchConfig)
    this.motionWatchByDevice.set(deviceId, nodeId)
  }

  /**
   * Session-time motion gate (Phase 3 slice 2). Fires on every
   * `MotionOnMotionChanged` event for a device with a cached detection
   * config. Mirrors `handleLazyAudioMotion`'s shape but drives the
   * orchestrator's own attach/detach lifecycle (via `decideSessionAction`)
   * instead of an audio subscription.
   *
   *   - `detected: true` dispatches a session if idle, then arms (or rearms)
   *     a fallback teardown timer (`motionCooldownMs`, default 30s). Reolink
   *     onboard never emits a falling edge, so this timer is the close path
   *     when the hub stays silent after the last rising edge.
   *   - `detected: false` from the hub asks the session to close, through the
   *     SAME rule the fallback timer uses ({@link resolveSessionLifecycleLocked}).
   *     It no longer bypasses the hold and the cap: it used to, and that made
   *     both unreachable on every camera that emits a falling edge — 502 of
   *     503 closes on device 102 in 24 h. An explicit clear still wins over
   *     the cooldown; it does not win over a subject that is still there.
   *
   * LIVE as of Task 2: `startDetection` no longer standing-attaches on-motion
   * cameras, so `hasStandingAttach` is false for them and `decideSessionAction`
   * actually dispatches/tears down sessions here. Always-on cameras keep the
   * standing attach, so `hasStandingAttach` stays true for them and
   * `decideSessionAction` still returns `'ignore'`.
   */
  async handleSessionMotion(
    deviceId: number,
    detected: boolean,
    emittedAt: number | undefined,
    trigger: MotionSource,
    /** What raised this motion (D672): the camera itself, or an attached sensor. */
    triggeredBy: MotionTriggeredBy,
  ): Promise<void> {
    // Motion→attach latency, split into the segments that have DIFFERENT
    // causes. On 2026-07-30 device 101 took 16.8 s from its own motion event
    // to `attachCamera`, while the same path took <0.5 s four minutes
    // earlier — and nothing in the log could say which segment was slow, so
    // three hypotheses stayed alive (late edge from the provider, a session
    // lock held by an in-flight teardown's `detachOn` RPC, or event-bus
    // delivery lag). Each segment below discriminates one of them.
    const receivedAt = Date.now()
    const busLagMs = emittedAt !== undefined ? receivedAt - emittedAt : undefined

    const config = this.deps.getActiveDetectionConfig(deviceId)
    if (!config) return
    // The camera's own list is the gate, for BOTH edges: an unlisted source
    // (the runner's analyzer side-channel on an onboard-only camera) must
    // neither open, rearm nor close a session.
    if (!config.motionSources.includes(trigger)) {
      this.noteSourceGateDrop(deviceId, trigger, detected, config.motionSources, 'pre-lock')
      return
    }

    const action = decideSessionAction({
      detectionMode: config.detectionMode,
      detected,
      hasActiveSession: this.sessionRegistry.has(deviceId),
      hasStandingAttach:
        (this.deps.ledger.hasAssignment(deviceId) || this.deps.ledger.hasPending(deviceId)) &&
        !this.sessionRegistry.has(deviceId),
    })

    if (action === 'ignore') return

    if (action === 'dispatch') {
      // No pre-lock early return: `scheduleSessionTeardown`'s timer body does
      // NOT synchronously deregister the session — it awaits `detachOn` (an
      // RPC) and only deregisters after, under the session lock. A stale
      // outside-the-lock `sessionRegistry.has` check during that window would
      // bail out and let the in-flight teardown deregister a session that
      // should have stayed open. Always enter the lock — mirrors
      // `handleLazyAudioMotion`'s `detected:true` branch, which has no
      // pre-lock early return either. Rearming the fallback timer must also
      // happen INSIDE the lock so it can't race the teardown body (which
      // runs under the same lock): a refire queued behind an in-flight
      // teardown rearms (or no-ops if already deregistered) and then
      // re-dispatches, since the teardown body will have deregistered by
      // then.
      //
      // C1 fix: re-read `activeDetections` (via `deps.getActiveDetectionConfig`)
      // INSIDE the lock rather than dispatching with the `config` captured
      // above (before the lock). `stopForDevice` deletes `activeDetections`
      // (via `deps.dropActiveDetection`) inside this SAME lock (see that
      // method's doc comment) — that makes stop and this dispatch mutually
      // exclusive, but only if this callback bails when the re-read comes
      // back empty (stopped) or mode-changed mid-flight, instead of
      // trusting the stale pre-lock capture. Without this re-read, a
      // dispatch queued behind a just-finished stop would use the pre-lock
      // `config` to attach a session with no `activeDetections` entry left
      // to ever tear it down again.
      const lockRequestedAt = Date.now()
      await this.sessionLocks.run(deviceId, async () => {
        const lockAcquiredAt = Date.now()
        const cur = this.deps.getActiveDetectionConfig(deviceId)
        if (!cur || cur.detectionMode !== 'on-motion') return
        // Same gate on the re-read config: the list may have changed while
        // this event queued behind the lock.
        if (!cur.motionSources.includes(trigger)) {
          this.noteSourceGateDrop(deviceId, trigger, detected, cur.motionSources, 'in-lock')
          return
        }
        const cooldownMs = cur.motionCooldownMs ?? 30_000
        // Already running: rearm the fallback close clock. Logged so an
        // operator asking "why no dispatch line?" is not left reading
        // silence — this branch is the common, healthy case. And BECAUSE
        // it is the common case it is sampled: on a busy camera it fires
        // per motion tick (4 772 rows/hour hub-wide, 2026-08-01), so only
        // the first refire of a session and every
        // `REFIRE_LOG_SAMPLE_EVERY`th log, with the running count carried
        // in `refireCount` so no information is lost.
        if (this.sessionRegistry.has(deviceId)) {
          this.scheduleSessionTeardown(deviceId, cooldownMs)
          const refireCount = (this.activeRefireCountByDevice.get(deviceId) ?? 0) + 1
          this.activeRefireCountByDevice.set(deviceId, refireCount)
          if (refireCount === 1 || refireCount % REFIRE_LOG_SAMPLE_EVERY === 0) {
            this.deps.logger.debug('session motion: already active, fallback rearmed', {
              tags: { deviceId },
              meta: {
                refireCount,
                sampledEvery: REFIRE_LOG_SAMPLE_EVERY,
                lockWaitMs: lockAcquiredAt - lockRequestedAt,
                ...(busLagMs !== undefined ? { busLagMs } : {}),
              },
            })
          }
          return
        }
        this.activeRefireCountByDevice.delete(deviceId)
        const timings = await this.dispatchDetectionSession(deviceId, cur, trigger, triggeredBy)
        if (this.sessionRegistry.has(deviceId)) {
          this.scheduleSessionTeardown(deviceId, cooldownMs)
        }
        const doneAt = Date.now()
        this.deps.logger.info('session motion → attach latency', {
          tags: { deviceId },
          meta: {
            triggeredBy,
            // Provider emit → our subscription. Isolates a late motion EDGE
            // (or bus delivery lag) from anything the orchestrator does.
            ...(busLagMs !== undefined ? { busLagMs } : {}),
            // Time spent waiting on the per-device session lock — an
            // in-flight teardown awaiting `detachOn` holds it.
            lockWaitMs: lockAcquiredAt - lockRequestedAt,
            // Census + balancer + config + `attachOn` RPC — and, since D440,
            // each of those on its own: `dispatchMs 5032` with `attachMs 13`
            // is a different fault from `dispatchMs 5032` with `attachMs 5000`.
            dispatchMs: doneAt - lockAcquiredAt,
            ...timings,
            // What the operator actually experiences.
            totalMs: doneAt - receivedAt,
            ...(emittedAt !== undefined ? { sinceMotionMs: doneAt - emittedAt } : {}),
          },
        })
      })
      return
    }

    // action === 'teardown' — explicit `detected: false` from the hub. It asks
    // the SAME question every other close path asks: hold while a subject is
    // still present (bounded by `maxSessionHoldMs`), else close, else defer to
    // `MIN_SESSION_OPEN_MS`. Before 2026-08-27 this branch consulted only the
    // floor, which is why the hold and the cap were unreachable code on every
    // camera that emits a falling edge. See {@link resolveSessionLifecycleLocked}.
    await this.sessionLocks.run(deviceId, async () => {
      await this.resolveSessionLifecycleLocked(deviceId, 'motion_cleared')
    })
  }

  /**
   * A motion event dropped by the source gate. Said, never silent — but
   * sampled per (camera, trigger): the first drop and every
   * {@link SOURCE_GATE_LOG_SAMPLE_EVERY}th, with the running `dropCount`.
   */
  private noteSourceGateDrop(
    deviceId: number,
    trigger: MotionSource,
    detected: boolean,
    configured: MotionSources,
    where: SourceGateWhere,
  ): void {
    const key = `${deviceId}:${trigger}`
    const dropCount = (this.sourceGateDrops.get(key) ?? 0) + 1
    this.sourceGateDrops.set(key, dropCount)
    if (dropCount !== 1 && dropCount % SOURCE_GATE_LOG_SAMPLE_EVERY !== 0) return
    this.deps.logger.info('session motion dropped — the camera does not list this source', {
      tags: { deviceId },
      meta: {
        trigger,
        detected,
        configured,
        where,
        dropCount,
        sampledEvery: SOURCE_GATE_LOG_SAMPLE_EVERY,
      },
    })
  }

  /**
   * The session's node. `least-loaded` (and any node pin, under either
   * policy) is `balance()` exactly as before. `share` holds the node shares
   * of PARALLEL sessions (D748): sessions now running and standing cameras
   * count toward their node, and a node at its cap or drowning yields —
   * logged with the reason, and counted against the node in the stats.
   */
  private electSessionNode(input: {
    readonly deviceId: number
    readonly policy: SessionPlacementPolicy
    readonly loads: readonly RunnerLocalLoad[]
    readonly preferredAgent: string | null
    readonly nodeCaps: Record<string, number | null>
    readonly weights: Record<string, number>
    readonly eligible: readonly string[]
    /** The node the camera's previous session ran on (D916), or null. */
    readonly previousNodeId: string | null
  }): SessionNodeElection {
    const balanced = (): BalancerDecision | null =>
      balance({
        nodes: input.loads,
        preferredAgent: input.preferredAgent,
        nodeCaps: input.nodeCaps,
        weights: input.weights,
        eligibleNodes: input.eligible,
      })
    if (input.policy !== 'share' || input.preferredAgent) {
      return { decision: balanced(), share: null }
    }
    const running = countRunningByNode([
      ...this.sessionRegistry.list().map((s) => ({ deviceId: s.deviceId, nodeId: s.nodeId })),
      ...this.deps.ledger
        .listAssignments()
        .map((a) => ({ deviceId: a.deviceId, nodeId: a.agentNodeId })),
    ])
    // The load census is memoised: a node that LEFT can still be in it for a
    // few seconds. `balance()` happened to steer away from it on its stale
    // count; a share election would hand an idle departed node the session.
    // Only nodes the topology still knows are candidates (D750).
    const present = new Set(this.deps.topology.knownRunnerNodeIds())
    const share = electNodeByShareWithAffinity({
      loads: input.loads,
      eligible: input.eligible.filter((nodeId) => present.has(nodeId)),
      weights: input.weights,
      caps: input.nodeCaps,
      runningByNode: running,
      ...(this.deps.shareHistory !== undefined ? { history: this.deps.shareHistory } : {}),
      previousNodeId: input.previousNodeId,
    })
    const election = share.election
    // Nothing electable (every node capped, none online): `balance()` names why.
    if (election.kind === 'none') return { decision: balanced(), share: null }
    if (election.reason === 'yield') {
      this.deps.placementStats?.noteYield(election.turnKey)
      this.deps.logger.info('detection session: share turn yielded — the node had no room', {
        tags: { deviceId: input.deviceId, nodeId: election.key },
        meta: { turnNodeId: election.turnKey, reason: election.yieldReason },
      })
    }
    const load = input.loads.find((l) => l.nodeId === election.key)
    return {
      decision: {
        kind: 'assigned',
        agentNodeId: election.key,
        reason: 'capacity',
        score: load ? load.attachedCameras + load.queueDepthTotal : 0,
      },
      share,
    }
  }

  /**
   * Say ONCE that a camera's device pin names a device this node does not
   * offer (disabled, absent): the session path ignores it, and the Load
   * balancing tab offers to clear it. Never cleared here (D748).
   */
  private noteStalePin(
    deviceId: number,
    pinnedDeviceKey: string | null,
    enabledDevices: Readonly<Record<string, number>>,
  ): void {
    if (pinnedDeviceKey === null || pinnedDeviceKey in enabledDevices) return
    const key = `${deviceId}|${pinnedDeviceKey}`
    if (this.reportedStalePins.has(key)) return
    this.reportedStalePins.add(key)
    this.deps.logger.warn(
      'device pin ignored — the pinned device is not enabled on the elected node',
      {
        tags: { deviceId },
        meta: { pin: pinnedDeviceKey, enabled: Object.keys(enabledDevices).join(',') },
      },
    )
  }

  /**
   * Dispatch a session-time detection attach for an on-motion camera whose
   * `decideSessionAction` returned `'dispatch'`. Builds a session
   * `RunnerCameraConfig` the same way `startDetection` does, but forces
   * `detectionMode: 'always-on'` + `motionSources: []` — a pure detector
   * that runs immediately while attached; the orchestrator (not the runner)
   * owns the on/off lifecycle via motion events, not a local motion gate.
   *
   * Deliberately NOT a call into `dispatchCamera` — this reuses only the
   * balancer inputs (`readPipelinePin` / `collectAgentLoad` /
   * `detectionEligibleNodes` / `buildNodeCaps` / `buildNodeWeights` →
   * `balance()`) that `dispatchCamera`'s own balancer branch uses. It
   * intentionally skips `dispatchCamera`'s load-shed deferral, `motionNode`
   * role preference, watchdog registration, and decoder-node resolution —
   * none of those apply to an ephemeral, seconds-long detection session.
   * Keeping this standalone (rather than threading a session flag through
   * `dispatchCamera`) avoids any risk of changing that already-live
   * standing-camera path.
   */
  private async dispatchDetectionSession(
    deviceId: number,
    config: CameraDetectionConfig,
    /**
     * What opened this session. Decides the rate it runs at
     * (`detectionFpsForTrigger`, D392): a `device-activity` session lasts as
     * long as the device's job does, so it is capped; every other trigger
     * keeps the camera's own `detectionFps`. Absent (a re-dispatch with no
     * event behind it) is the camera rate.
     */
    trigger: MotionSource | undefined,
    /**
     * What raised the motion that opened this session (D672). Registered with
     * the session and said on its lines, and — with `trigger` — carried on the
     * attach as `sessionTrigger` so the runner's phase event names it (D672
     * rule 11 as amended 2026-10-06). The runner decides nothing on it.
     */
    triggeredBy: MotionTriggeredBy,
  ): Promise<DispatchTimings | null> {
    const log = this.deps.logger.withTags({ deviceId })

    // The placement census, under a budget (D440). It runs UNGUARDED: the
    // census exists to remove this very camera's orphans (a runner that kept
    // the camera across an orchestrator restart), and a guarded device is one
    // the pure reconcile leaves alone.
    const reconcileStartedAt = Date.now()
    const census = this.deps.reconcilePlacementFromRunners()
    const censusOutcome = await raceBudget(census, DISPATCH_RECONCILE_BUDGET_MS)
    const reconcileMs = Date.now() - reconcileStartedAt
    const reconcileBudgetExceeded = censusOutcome.kind === 'budget-exceeded'
    // Guard the dispatch so the subtractive reconcile can never mistake an
    // in-flight session dispatch for an orphan or a stale assignment —
    // mirrors `dispatchCamera`'s use of `dispatchingDevices`. Taken NOW, i.e.
    // after the census when it settled, and held PAST the dispatch when it
    // did not: a census that snapshots the runners after this attach lands,
    // from a fan-out that ran before it, would otherwise read the fresh
    // assignment as stale and deregister the session it never saw.
    const dispatchGuard = this.deps.ledger.markDispatching(deviceId)
    const releaseGuard = (): void => {
      if (!reconcileBudgetExceeded) {
        dispatchGuard.dispose()
        return
      }
      void census.finally(() => dispatchGuard.dispose())
    }
    if (reconcileBudgetExceeded) {
      // The one segment whose cost is another node's event loop, and until
      // now the one that said nothing while it cost five seconds.
      log.warn('detection session: placement census overran its budget — placing without it', {
        meta: { budgetMs: DISPATCH_RECONCILE_BUDGET_MS },
      })
    } else if (censusOutcome.kind === 'rejected') {
      log.warn('detection session: placement census failed — placing on the ledger as it is', {
        meta: { error: errMsg(censusOutcome.error), reconcileMs },
      })
    }

    const balanceStartedAt = Date.now()
    const preferredAgent = await this.deps.readPipelinePin(deviceId)
    // Memoised — see `agentLoads` / `refreshBalancerInputs`. A cold cache falls
    // through to exactly the reads that used to be here; a re-read that
    // overruns its budget yields to the last known load (D441), because the
    // memo is invalidated after every dispatch and a burst's next camera
    // always finds that re-read in flight — 9 205 ms of it on a saturated
    // hub-main.
    const loadAnswer = await this.agentLoads.getWithin(CLUSTER_KEY, BALANCE_LOAD_BUDGET_MS)
    const loads = loadAnswer.value
    if (loadAnswer.stale) {
      log.warn(
        'detection session: agent load read overran its budget — balancing on the last known load',
        { meta: { budgetMs: BALANCE_LOAD_BUDGET_MS, loadAgeMs: loadAnswer.ageMs } },
      )
    }
    // A node whose every enabled accelerator went unavailable is dropped here
    // — it stays online and fails every inference it is handed. Fails OPEN
    // when the filter would empty the set (a cold cluster is not a broken one).
    const allEligible = this.deps.topology.detectionEligibleNodes(deviceId)
    const usableEligible = allEligible.filter((n) => this.deps.isNodeInferenceUsable(n))
    const eligible = usableEligible.length > 0 ? usableEligible : allEligible
    if (usableEligible.length > 0 && usableEligible.length < allEligible.length) {
      log.info('nodes dropped from session placement — no usable inference device', {
        meta: { dropped: allEligible.filter((n) => !usableEligible.includes(n)) },
      })
    }
    const nodeCaps = await this.nodeCaps.get(CLUSTER_KEY)
    const weights = await this.nodeWeights.get(CLUSTER_KEY)

    const policy = this.deps.sessionPlacement?.() ?? 'least-loaded'
    const previous = this.deps.sessionAffinity?.previous(deviceId) ?? null
    const { decision, share: nodeShare } = this.electSessionNode({
      deviceId,
      policy,
      loads,
      preferredAgent,
      nodeCaps,
      weights,
      eligible,
      previousNodeId: previous?.nodeId ?? null,
    })

    if (!decision || decision.kind !== 'assigned') {
      log.warn('detection session: no eligible node — will retry on next motion', {
        meta: { reason: decision?.kind === 'pending' ? decision.reason : 'no-runners-online' },
      })
      releaseGuard()
      return null
    }

    const targetNodeId = decision.agentNodeId
    const balancedAt = Date.now()

    // Phase 4 multi-device: pick which of the target node's ENABLED inference
    // devices this session runs on, spreading concurrent sessions across the
    // node's accelerators (NPU / iGPU / Coral) by active-session count. Absent /
    // <2 enabled ⇒ `undefined` (the runner uses its single default accelerator —
    // the safe, opt-in-others default). The chosen key is recorded on both the
    // attach config (the runner forwards it to `runPipeline`, T5) AND the session
    // registry (so the next pick sees this session's load).
    const enabledDevices = await this.eligibleInferenceDevices.get(targetNodeId)
    // Real per-device load from the chosen node's getLocalLoad().devices (Block
    // B) — counts standing + session inference on each accelerator, which the
    // orchestrator's own session registry alone would miss (audit F6).
    const targetLoad = loads.find((n) => n.nodeId === targetNodeId)
    const deviceCaps = await this.inferenceDeviceCaps.get(targetNodeId)
    const pinnedDeviceKey = await this.deps.readPipelineDevicePin(deviceId)
    // No `currentDeviceKey`: an on-motion session is ephemeral and has no
    // standing placement, and treating the PREVIOUS session's device as
    // UNCONDITIONALLY sticky would freeze this camera onto one accelerator
    // forever — the starvation the rotation exists to fix. The previous device
    // enters only as `previousDeviceKey` (D916): kept while it is offered here
    // (enabled ∧ available — a device in backoff is not) and within one session
    // of the share's turn holder, left as soon as it is further off.
    const previousDeviceKey =
      previous !== null && previous.nodeId === targetNodeId ? previous.deviceKey : null
    this.noteStalePin(deviceId, pinnedDeviceKey, enabledDevices)
    const selection = pickInferenceDevice({
      eligible: enabledDevices,
      loads: targetLoad?.devices ?? [],
      caps: deviceCaps,
      pinnedDeviceKey:
        pinnedDeviceKey !== null && pinnedDeviceKey in enabledDevices ? pinnedDeviceKey : null,
      rotation: this.deps.inferenceRotation,
      policy,
      ...(this.deps.shareHistory !== undefined
        ? { shareHistory: this.deps.shareHistory, historyScope: targetNodeId }
        : {}),
      previousDeviceKey,
    })
    const deviceKey = selectedDeviceKey(selection)
    // The ONE line that says which accelerators were in play and why this one
    // won. Fires once per session dispatch (never per frame). Without it, an
    // enabled-but-never-chosen device is invisible — see the class-level note
    // in `device-balancer.ts`.
    log.info('inference device selection', {
      tags: { deviceId, nodeId: targetNodeId },
      meta: {
        path: 'session',
        eligible: selection.eligibleKeys,
        chosen: deviceKey ?? null,
        reason: selection.reason,
        ...(selection.kind === 'selected'
          ? { tied: selection.tiedKeys, tieBreak: selection.tieBreak }
          : {}),
        ...(pinnedDeviceKey ? { pin: pinnedDeviceKey } : {}),
        ...(selection.kind === 'selected' && selection.affinity !== undefined
          ? {
              sticky: selection.affinity.sticky,
              stickyReason: selection.affinity.reason,
              previousDeviceKey: selection.affinity.previousDeviceKey,
              turnKey: selection.affinity.turnKey,
            }
          : {}),
      },
    })

    const deviceSelectedAt = Date.now()
    // The attach's pipeline — structure resolved for the ELECTED device and
    // its same-node jump roster, the elected device's provisioning on the
    // tree, each roster entry's provisioning for the steps it may run (D650).
    // One owner for every path that sets steps: `resolveAttachPipeline`.
    const outcome = await resolveAttachPipeline(
      { deviceId, nodeId: targetNodeId, deviceKey, eligible: enabledDevices, caps: deviceCaps },
      this.deps.settingsStore,
    )
    if (outcome.kind === 'root-refused') {
      // The NAMED refusal (D650 round 3): a session on a device that cannot
      // run the camera's root would detect nothing. No attach, no record; the
      // next motion edge re-elects. Said once per change of the refusal, and
      // exposed to the camera status (round 4) — see `sessionRefusals`.
      const reason: PendingReason = `root-unrunnable:${targetNodeId}/${outcome.deviceKey ?? 'default-pool'}`
      // A placement that cannot run the camera root is no placement to stay on.
      this.deps.sessionAffinity?.forget(deviceId)
      if (this.sessionRefusals.get(deviceId) !== reason) {
        this.sessionRefusals.set(deviceId, reason)
        log.error('detection session refused — the elected device cannot run the camera root', {
          tags: { deviceId, nodeId: targetNodeId },
          meta: {
            reason,
            deviceKey: outcome.deviceKey ?? null,
            droppedRoots: outcome.droppedRoots.join(','),
            hint: 'the root is never jumped: enable a device on this node whose format ships the root model, or disable the device that cannot; said once until the refusal changes',
          },
        })
      }
      releaseGuard()
      return null
    }
    const pipeline = outcome.pipeline
    const zones = await this.deps.listZones(deviceId)
    // The rate this session opens at, decided by what opened it. Said out loud
    // when it is not the camera's own rate: a session running at a tenth of
    // the configured fps must never be something an operator has to infer.
    const sessionDetectionFps = detectionFpsForTrigger(config, trigger)
    if (sessionDetectionFps !== config.detectionFps) {
      log.info('session opened at the device-activity rate', {
        meta: {
          trigger,
          detectionFps: sessionDetectionFps,
          cameraDetectionFps: config.detectionFps,
        },
      })
    }
    const sessionConfig: RunnerCameraConfig = {
      deviceId,
      ...(pipeline.deviceKey ? { deviceKey: pipeline.deviceKey } : {}),
      ...(pipeline.inferenceDevices ? { inferenceDevices: pipeline.inferenceDevices } : {}),
      motionCooldownMs: config.motionCooldownMs,
      motionFps: config.motionFps,
      detectionFps: sessionDetectionFps,
      motionStreamId: config.motionStreamId,
      detectionStreamId: config.detectionStreamId,
      motionSources: [],
      pipelineEnabled: config.pipelineEnabled,
      steps: pipeline.steps,
      audio: pipeline.audio,
      zones,
      detectionMode: 'always-on',
      audioMode: config.audioMode,
      onboardMotionDrivesAnalyzer: config.onboardMotionDrivesAnalyzer,
      occupancyRecheckEnabled: config.occupancyRecheckEnabled,
      occupancyRecheckSec: config.occupancyRecheckSec,
      occupancyRecheckFrames: config.occupancyRecheckFrames,
      preRollInferenceEnabled: config.preRollInferenceEnabled,
      preRollInferenceFrames: config.preRollInferenceFrames,
      // WHICH ROOT DETECTOR — see the same field on `ensureMotionWatch`. This
      // is the site that mattered: a SESSION attach is what an on-motion camera
      // gets, which is most of them.
      detectionSources: config.detectionSources,
      ...(trigger !== undefined
        ? {
            sessionTrigger: buildSessionTrigger(
              deviceId,
              trigger,
              triggeredBy,
              this.deps.sensorNameOf,
            ),
          }
        : {}),
    }

    const configuredAt = Date.now()
    let attachedAt = configuredAt
    try {
      await this.deps.attachOn(targetNodeId, sessionConfig)
      attachedAt = Date.now()
      this.deps.recordAssignment(
        deviceId,
        targetNodeId,
        decision.reason,
        decision.reason === 'manual',
      )
      this.sessionRegistry.register(deviceId, targetNodeId, Date.now(), triggeredBy, deviceKey)
      this.deps.sessionAffinity?.note(deviceId, targetNodeId, deviceKey ?? null)
      this.deps.placementStats?.noteStart(targetNodeId, deviceKey ?? '')
      if (this.sessionRefusals.delete(deviceId)) {
        // The state change back: a camera the status showed as refused now
        // detects. Without this line the last error stands unanswered.
        log.info('detection session refusal cleared — a session opened', {
          tags: { deviceId, nodeId: targetNodeId },
          meta: deviceKey ? { deviceKey } : {},
        })
      }
      this.recheck?.noteSessionDispatched(deviceId, targetNodeId, sessionConfig)
      log.info('detection session: dispatched on motion', {
        // `deviceId` alongside `nodeId`: an on-motion attach is always read per
        // CAMERA ("why did 102 attach late?"), and the node alone cannot answer
        // it on a node that owns a dozen cameras.
        tags: { deviceId, nodeId: targetNodeId },
        meta: {
          reason: decision.reason,
          trigger,
          triggeredBy,
          ...(deviceKey ? { deviceKey } : {}),
          ...describeNodeElection(policy, targetNodeId, nodeShare),
        },
      })
    } finally {
      releaseGuard()
      // Off the dispatch path by construction: the attach has already landed
      // (or failed) and nothing awaits this. It leaves the memo reflecting the
      // load this dispatch just created, so the next camera in the same burst
      // still balances against a current picture.
      this.notePlacementChanged()
    }
    return {
      reconcileMs,
      reconcileBudgetExceeded,
      balanceMs: balancedAt - balanceStartedAt,
      balanceLoadStale: loadAnswer.stale,
      deviceSelectMs: deviceSelectedAt - balancedAt,
      configMs: configuredAt - deviceSelectedAt,
      attachMs: attachedAt - configuredAt,
    }
  }

  /**
   * Schedule a session teardown after `cooldownMs` of no rising-edge motion.
   * This is the FALLBACK close path — armed (and rearmed) on every
   * `detected: true`. It no longer owns the hold or the cap: the timer body
   * just asks {@link resolveSessionLifecycleLocked}, which is the same
   * question the falling edge and the deferred close ask.
   *
   * Mirrors `handleLazyAudioMotion`'s teardown half: a no-op if no session is
   * currently active, else arms a timer (replacing any prior one via
   * `sessionRegistry.setTeardownTimer`). Rearm-on-refire is handled by
   * `handleSessionMotion` calling this again.
   */
  private scheduleSessionTeardown(deviceId: number, cooldownMs: number): void {
    if (!this.sessionRegistry.has(deviceId)) return
    this.armLifecycleTimer(deviceId, 'cooldown_expired', cooldownMs)
  }

  /**
   * Arm (or re-arm) the ONE timer slot a session has, to re-ask
   * {@link resolveSessionLifecycleLocked} in `delayMs`.
   *
   * Every clock in this lifecycle is this timer: the motion cooldown, the
   * minimum-open deferral, and a presence hold's recheck. They share the slot
   * deliberately — `sessionRegistry.setTeardownTimer` replaces whatever was
   * armed, so a motion tick landing mid-deferral or mid-hold simply re-arms
   * with the cooldown and the session lives on, with no re-election and no
   * second dispatch.
   */
  private armLifecycleTimer(deviceId: number, reason: SessionCloseReason, delayMs: number): void {
    const log = this.deps.logger.withTags({ deviceId })
    const timer = setTimeout(() => {
      void this.sessionLocks
        .run(deviceId, async () => {
          await this.resolveSessionLifecycleLocked(deviceId, reason)
        })
        .catch((err: unknown) => {
          log.warn('detection session: lifecycle re-check failed', {
            meta: { error: errMsg(err), reason },
          })
        })
    }, delayMs)
    this.sessionRegistry.setTeardownTimer(deviceId, timer)
  }

  /**
   * Hold, defer or close — the single rule every lifecycle close path obeys.
   * MUST run inside `sessionLocks` for `deviceId`.
   *
   * All three paths funnel through here: the hub's explicit `motion_cleared`
   * falling edge, the `cooldown_expired` fallback timer, and the re-ask of a
   * close this method itself deferred. That is the fix — the hold, the
   * freshness read and `maxSessionHoldMs` used to live inside the COOLDOWN
   * TIMER's body, so a falling edge reached none of them. On device 102, 24 h,
   * 503 sessions: 502 closes were falling edges, the hold branch fired 0
   * times, `maxSessionHoldMs` fired 0 times, and the session-duration
   * distribution collapsed onto {@link MIN_SESSION_OPEN_MS} — median 10 221 ms
   * against a 10 000 ms floor. 30 s of promotion window was unreachable.
   *
   * `stopDetection` (`stopForDevice`) and the pin-reassign close
   * (`closeSessionForReassign`) deliberately do NOT come through here: those
   * are the operator removing the work, and neither a floor nor a hold may
   * delay a stop.
   */
  private async resolveSessionLifecycleLocked(
    deviceId: number,
    reason: SessionCloseReason,
  ): Promise<void> {
    const session = this.sessionRegistry.get(deviceId)
    if (!session) return
    const now = Date.now()
    const openForMs = now - session.startedAt
    const lastSeenAt = this.lastSubjectSeenAt.get(deviceId)
    const sinceSubjectSeenMs = lastSeenAt === undefined ? null : now - lastSeenAt
    // Re-read rather than capture: the operator can retune the cap mid-session,
    // and a session that outlives its config's disappearance must still close.
    const maxHoldMs =
      this.deps.getActiveDetectionConfig(deviceId)?.maxSessionHoldMs ?? DEFAULT_MAX_SESSION_HOLD_MS

    const verdict = decideSessionLifecycle({
      openForMs,
      minOpenMs: MIN_SESSION_OPEN_MS,
      maxHoldMs,
      sinceSubjectSeenMs,
      subjectStaleMs: SUBJECT_PRESENT_STALE_MS,
      recheckMs: SUBJECT_PRESENCE_RECHECK_MS,
    })

    if (verdict.kind === 'hold') {
      this.armLifecycleTimer(deviceId, reason, verdict.recheckInMs)
      this.deps.logger.debug('detection session: held open — subject still present', {
        tags: { deviceId, nodeId: session.nodeId },
        meta: {
          reason,
          openForMs,
          sinceSubjectSeenMs,
          recheckInMs: verdict.recheckInMs,
          subjectStaleMs: SUBJECT_PRESENT_STALE_MS,
          maxHoldMs,
        },
      })
      return
    }

    if (verdict.kind === 'defer-floor') {
      // A branch that changes the session lifecycle never runs silently. Debug,
      // not info: on a flapping camera this replaces an INFO close line, so the
      // net log volume goes DOWN.
      this.deps.logger.debug('detection session: close deferred to the minimum open time', {
        tags: { deviceId, nodeId: session.nodeId },
        meta: {
          reason,
          openForMs,
          closingInMs: verdict.delayMs,
          minOpenMs: MIN_SESSION_OPEN_MS,
          sinceSubjectSeenMs,
        },
      })
      this.armLifecycleTimer(deviceId, reason, verdict.delayMs)
      return
    }

    await this.closeActiveSessionLocked(deviceId, reason, {
      openForMs,
      sinceSubjectSeenMs,
      maxHoldMs,
    })
  }

  /**
   * Detach + drop assignment + deregister. MUST run inside `sessionLocks`
   * for `deviceId`. Callers have already decided not to hold and not to defer.
   *
   * **This branch drops work, so it says so.** Closing a session detaches the
   * runner: every track still live on that camera dies here, mid-life, with no
   * `end` key-event and no chance of ever reaching the stationary registry's
   * promotion window. It used to log one bare sentence. Measured on device 102
   * over 24 h it killed **223 live tracks across 503 closes (0.44 per close)**,
   * 95% of which had been motionless for at least a second, and not one line
   * named a single one of them — the gap had to be reconstructed by
   * hand-correlating timestamps. `subjectPresent` in this line is that number,
   * per close, per camera.
   */
  private async closeActiveSessionLocked(
    deviceId: number,
    reason: SessionCloseReason,
    observed: SessionCloseObservation,
  ): Promise<void> {
    const session = this.sessionRegistry.get(deviceId)
    if (!session) return
    const log = this.deps.logger.withTags({ deviceId })
    await this.deps.detachOn(session.nodeId, deviceId).catch((err: unknown) => {
      log.warn('detection session: teardown detach failed', {
        tags: { nodeId: session.nodeId },
        meta: { error: errMsg(err), reason },
      })
    })
    this.deps.dropAssignment(deviceId, 'unassigned')
    this.sessionRegistry.deregister(deviceId)
    this.lastSubjectSeenAt.delete(deviceId)
    // What the tracker still held on the session's last tracked frame. `null`
    // is UNKNOWN (no tracked frame arrived, or an older post-analysis that does
    // not send the count), never 0 — an unknown must not read as a departure.
    const liveTracks = this.lastLiveTrackCount.get(deviceId) ?? null
    this.lastLiveTrackCount.delete(deviceId)
    this.activeRefireCountByDevice.delete(deviceId)
    this.notePlacementChanged()

    const { openForMs, sinceSubjectSeenMs, maxHoldMs } = observed
    // The recheck arms only from a session that tracked something (D547):
    // `null` here means no frame of this session carried a subject.
    this.recheck?.noteSessionClosed(deviceId, { sawSubject: sinceSubjectSeenMs !== null })
    const subjectPresent =
      sinceSubjectSeenMs !== null && sinceSubjectSeenMs < SUBJECT_PRESENT_STALE_MS
    const meta = {
      reason,
      triggeredBy: session.triggeredBy,
      openForMs,
      sinceSubjectSeenMs,
      subjectPresent,
      liveTracks,
      maxHoldMs,
      minOpenMs: MIN_SESSION_OPEN_MS,
      subjectStaleMs: SUBJECT_PRESENT_STALE_MS,
    }
    if (subjectPresent) {
      // Only reachable once the cap is spent (the hold outranks everything
      // else), so this is the `maxSessionHoldMs` ceiling doing its job — and
      // it is still the destruction of a live track, which is never silent.
      log.warn(
        'detection session: closed at the max-hold cap with a subject still present — its live tracks end here',
        { tags: { nodeId: session.nodeId }, meta },
      )
      return
    }
    if (liveTracks !== null && liveTracks > 0) {
      // The tracker still held a subject the hold did not count as present —
      // a STILL subject the stillness valve subtracted, not a departure. The
      // policy that closed it is unchanged (D652 is diagnostics only); what
      // changes is that this close no longer reads like an empty scene, and
      // every track it ends is on the record.
      //
      // Level: when the hold SAW the subject and then let its presence go
      // stale, this is the valve doing exactly what it is for (a parked car)
      // — INFO, `liveTracks` in meta, or every parked car is a WARN nobody
      // reads. Live tracks the hold NEVER saw as present are not the valve's
      // doing, and a close that ends them stays a WARN.
      const designedValve = sinceSubjectSeenMs !== null
      const line =
        reason === 'motion_cleared'
          ? 'detection session: closed on motion clear while the tracker was still tracking a subject — its live tracks end here'
          : 'detection session: closed after motion cooldown while the tracker was still tracking a subject — its live tracks end here'
      const extras = { tags: { nodeId: session.nodeId }, meta }
      if (designedValve) log.info(line, extras)
      else log.warn(line, extras)
      return
    }
    log.info(
      reason === 'motion_cleared'
        ? 'detection session: closed on motion clear'
        : 'detection session: closed after motion cooldown',
      { tags: { nodeId: session.nodeId }, meta },
    )
  }

  /**
   * The session + motion-watch teardown half of `stopDetection` (the other
   * half — `releaseCamera` + `audio.stopForDevice` — lives in
   * `DetectionWiringController.stopDetection` since S11 Task 3, which calls
   * this AFTER those run, same ordering as before).
   *
   * Stopping/disabling/removing an on-motion camera must also close any
   * ACTIVE detection session and release the motion-watch attach.
   * `releaseCamera` (run by the caller before this) already detaches
   * whatever is in the placement ledger's assignments (which covers an
   * active session's runner attach, since `dispatchDetectionSession` records
   * one there too), but it knows nothing about `sessionRegistry` — without
   * this, a stale "active" entry would linger forever and
   * `handleSessionMotion`'s dispatch guard (`if
   * (this.sessionRegistry.has(deviceId)) return`) would then silently
   * swallow every future motion event for this device. Locked so this can't
   * race an in-flight `dispatchDetectionSession` / `scheduleSessionTeardown`
   * critical section for the same device.
   *
   * C1 fix: `deps.dropActiveDetection(deviceId)` (the former
   * `this.activeDetections.delete(deviceId)`) MUST happen INSIDE this same
   * lock, not after it. Without that, the caller's earlier, OUTSIDE-the-lock
   * `assignments.delete` (inside `releaseCamera`) opens a window where
   * `assignments` is already clear but `activeDetections` and
   * `sessionRegistry` are still populated; a `MotionOnMotionChanged` landing
   * in that window has `handleSessionMotion` capture the still-present
   * config BEFORE the lock, decide `'dispatch'` (no standing attach), and
   * queue its own session-lock call — which chains AFTER this one. Doing the
   * delete out here let that queued dispatch run once this section finished
   * (having already deregistered the OLD session) and re-attach a fresh
   * session using the stale captured config, with no `activeDetections`
   * entry left to ever tear it down again (a detection-forever leak). Moving
   * the delete inside the lock makes stop and a racing dispatch strictly
   * ordered: either this teardown runs first (a subsequently-queued dispatch
   * then re-reads `activeDetections` — see `handleSessionMotion` — finds it
   * gone, and bails), or a just-queued dispatch runs first (registering a
   * fresh session this teardown's `session` re-read then finds and tears
   * down too, since it reads `sessionRegistry` fresh at the top of this same
   * callback).
   */
  /**
   * Why this camera's LAST on-motion session was refused, or `undefined` when
   * it was not (or a session has opened since). The camera status renders it
   * as `pending:<reason>` — see `sessionRefusals`.
   */
  refusalReason(deviceId: number): PendingReason | undefined {
    return this.sessionRefusals.get(deviceId)
  }

  async stopForDevice(deviceId: number): Promise<void> {
    await this.sessionLocks.run(deviceId, async () => {
      const session = this.sessionRegistry.get(deviceId)
      if (session) {
        // M2: idempotent belt-and-suspenders detach — the caller's
        // `releaseCamera` already detached this same (nodeId, deviceId) pair
        // when the session's assignment was present, so this is USUALLY a
        // harmless no-op double RPC. Deliberately kept (not removed as
        // "redundant"): it is what makes this critical section
        // self-sufficient for a session a racing dispatch (re-)created
        // AFTER `releaseCamera` already ran but BEFORE this lock was taken —
        // that session was never seen by `releaseCamera` and has no other
        // detach path.
        await this.deps.detachOn(session.nodeId, deviceId).catch((err: unknown) => {
          this.deps.logger.warn('stopDetection: session detach failed', {
            tags: { deviceId, nodeId: session.nodeId },
            meta: { error: errMsg(err) },
          })
        })
        this.sessionRegistry.deregister(deviceId)
        // M1: symmetry with `scheduleSessionTeardown`, which also drops the
        // standing `assignments` entry it created for the session attach —
        // without this, a session torn down here (rather than via cooldown)
        // left a stale `assignments` entry that only self-healed on the next
        // reconcile pass. `'silent'` — no `PipelineCameraUnassigned` event,
        // matching the original bare `assignments.delete`.
        this.deps.dropAssignment(deviceId, 'silent')
        this.notePlacementChanged()
      }
      // C1: see the extended note above — this delete must stay inside the
      // session lock so it is atomic with the session detach/deregister
      // above with respect to a racing `handleSessionMotion` dispatch.
      this.deps.dropActiveDetection(deviceId)
      // Drop the session-hold liveness so a future session for this device
      // never starts with a stale "moving track" timestamp.
      this.lastSubjectSeenAt.delete(deviceId)
      this.lastLiveTrackCount.delete(deviceId)
      // A camera that no longer arms has no refused session to show.
      this.sessionRefusals.delete(deviceId)
      // The operator removed the work: no recheck may re-attach it.
      this.recheck?.forget(deviceId)
    })

    // Motion-watch teardown: release the watch-only attach on the motionNode
    // role (if any) ensured by `ensureMotionWatch`. Not routed through
    // `assignments`/`releaseCamera` (see `motionWatchByDevice`'s field doc),
    // so it needs its own explicit detach here.
    const watchNodeId = this.motionWatchByDevice.get(deviceId)
    if (watchNodeId) {
      await this.deps.detachOn(watchNodeId, deviceId).catch((err: unknown) => {
        this.deps.logger.warn('stopDetection: motion-watch detach failed', {
          tags: { deviceId, nodeId: watchNodeId },
          meta: { error: errMsg(err) },
        })
      })
      this.motionWatchByDevice.delete(deviceId)
    }
  }

  /**
   * Mirrors the former `onShutdown` session-teardown block exactly: set the
   * shutdown guard, then clear the session registry (cancelling any pending
   * teardown timers) and the motion-watch map. The original scattered these
   * three statements across `onShutdown` — flag set immediately after
   * `audio.beginShutdown()`, `sessionRegistry.clear()`/`sessionLocks.clear()`
   * several statements later (after `reconcile.dispose()` /
   * `pipelineWatchdog.stop()`), `motionWatchByDevice.clear()` later still
   * (after `audio.shutdown()`). Safe to consolidate into one call here:
   * `index.ts`'s own doc comment on that whole `onShutdown` prefix (from the
   * shutdown-guard flag through the `activeDetections` release loop) already
   * establishes it is fully synchronous — no `await` — so no queued session-
   * lock callback could ever observe an intermediate state regardless of
   * exactly where within that prefix these three statements run, and every
   * statement between their original positions (timer clears, subscription
   * unsub, `reconcile.dispose()`, `pipelineWatchdog.stop()`, `loadShed.dispose()`,
   * `audio.shutdown()`) touches state fully disjoint from session/motion-watch.
   */
  shutdown(): void {
    this.shuttingDown = true
    this.recheck?.shutdown()
    this.sessionRegistry.clear()
    this.motionWatchByDevice.clear()
    this.lastSubjectSeenAt.clear()
    this.lastLiveTrackCount.clear()
    this.sessionRefusals.clear()
    if (this.balancerRefreshTimer !== null) {
      clearInterval(this.balancerRefreshTimer)
      this.balancerRefreshTimer = null
    }
    // Balancer memos hold a picture of a cluster this controller no longer
    // observes; nothing may read them again.
    this.agentLoads.clear()
    this.nodeCaps.clear()
    this.nodeWeights.clear()
    this.eligibleInferenceDevices.clear()
    this.inferenceDeviceCaps.clear()
  }
}

/** The session's node, and the share election behind it when there was one. */
interface SessionNodeElection {
  readonly decision: BalancerDecision | null
  /** Null under `least-loaded`, a node pin, or when nothing was electable. */
  readonly share: ShareAffinityElection | null
}

/** The fields the dispatch line carries about the node election (D916). */
interface NodeElectionLogFields {
  readonly policy: SessionPlacementPolicy
  readonly sticky: boolean | null
  readonly stickyReason: string
  readonly previousNodeId: string | null
  readonly turnKey: string | null
  readonly recent: number | null
  readonly running: number | null
}

/**
 * What the node election saw, for the dispatch line: whether the camera stayed
 * on its previous node and why, whose turn it was, and the chosen node's
 * `recent` / `running` as the election counted them.
 */
function describeNodeElection(
  policy: SessionPlacementPolicy,
  chosenNodeId: string,
  share: ShareAffinityElection | null,
): NodeElectionLogFields {
  if (share === null) {
    return {
      policy,
      sticky: null,
      stickyReason: policy === 'share' ? 'pinned-or-unelectable' : 'not-share-policy',
      previousNodeId: null,
      turnKey: null,
      recent: null,
      running: null,
    }
  }
  const chosen = share.scored.find((c) => c.key === chosenNodeId)
  return {
    policy,
    sticky: share.sticky,
    stickyReason: share.affinityReason,
    previousNodeId: share.previousKey,
    turnKey: share.turnKey,
    recent: chosen !== undefined ? Math.round(chosen.recent * 100) / 100 : null,
    running: chosen?.running ?? null,
  }
}
