/**
 * `AudioSubscriptionController` — audio subscription plane (C17 + C10's audio
 * half, S7 extraction).
 *
 * Owns every piece of state driving hub-side audio analysis for a camera:
 * the live per-device broker subscriptions (`audioSubscriptions`), the
 * per-device async mutex serializing subscribe/teardown critical sections
 * (`audioSubLocks`, backed by the shared `KeyedAsyncLock`), the shutdown
 * guard flag, the lazy-audio-motion teardown timers, the audio-node
 * assignment/balancer state (`audioAssignments`), and the audio-analyzer
 * readiness tracking (`readyAudioNodes`/`lastSeenAudioEpochByNode`).
 *
 * Extracted verbatim (mechanical, zero logic change) from `index.ts` — see
 * `docs/superpowers/specs/2026-07-11-orchestrator-refactor-analysis.md` §3.2
 * for the design and smell #7/#15/#19 for the specific dedup this step does:
 *
 *   - smell #7: the four near-identical "teardown-prior → subscribe →
 *     keep-if-active-else-unsub" sequences collapse into ONE
 *     {@link AudioSubscriptionController.resubscribe}. Only THREE of the
 *     four sites are actually identical enough to merge (`reattachForDevice`,
 *     `startDetection`'s audio block, `recoverPipelineStage`'s audio
 *     branch — see `resubscribe`'s doc comment for the exact proof). The
 *     fourth (`handleLazyAudioMotion`'s subscribe half) has a genuinely
 *     different idempotency contract — see that method's doc comment —
 *     and stays its own sequence.
 *   - smell #15: the 8-variable mutable PCM-window closure + the
 *     result→event-payload builder moved to `audio-window-accumulator.ts`
 *     (`AudioWindowAccumulator` + `buildAudioResultFrame`) — and then, in
 *     D461, out of this package entirely. See below.
 *   - smell #19: the former sibling `audioNodeByDevice` string map was
 *     dropped — it duplicated `audioAssignments` (both written only in
 *     `recordAudioAssignment`, always cleared together); its one distinct
 *     read (`reattachForNode`'s loop) now reads `assignment.nodeId` off
 *     `audioAssignments` directly.
 *
 * ## This controller owns the POLICY, not the bytes (D461)
 *
 * It used to own both. `subscribeAudioStream` drained the broker's chunk
 * plane, accumulated ~1 s windows and pushed them to
 * `audioAnalyzer.analyseChunk` — for a process that neither produced nor
 * consumed the audio. The PCM crossed hub-main twice for the buffering alone,
 * and because the expansion to f32le happened HERE, D455's source-bytes lever
 * could only reach the two legs before this one. Poller, accumulator and the
 * result event now live in `audio-analyzer` (`audio-device-attachments.ts`),
 * which pulls from the broker under an `attachDevice` / `detachDevice` pair.
 *
 * What is left here is every question about WHETHER and WHERE: the
 * `audio-analysis` binding gate, the `audioMode` schedule, the on-motion
 * window, the audio-track probe, the per-device node assignment and the
 * settings read. The watchdog's audio liveness is no longer a per-chunk tap —
 * it is fed from the `PipelineAudioInferenceResult` event
 * (`orchestrator-subscriptions.ts`), which is the analyzer saying it produced
 * a window.
 *
 * Deps are injected closures (mirrors the `AgentLoadService`/
 * `PipelineSettingsStore` pattern) so the controller never reaches into the
 * addon's `this`. `getLedgerConfig`/`getActiveDetectionConfig` read the
 * placement ledger / `activeDetections` map through closures, never the raw
 * maps directly — the controller has no dependency on `PlacementLedger` or
 * the class's detection-wiring state beyond these two narrow reads.
 */
import type {
  AddonApi,
  CameraDetectionConfig,
  CamProfile,
  IEventBus,
  IScopedLogger,
  ReadinessTransition,
  RunnerCameraConfig,
  Unsubscribe,
} from '@camstack/types'
import { errMsg, makeSourceBrokerId, nodePin } from '@camstack/types'
import { type AudioNodeLoad, balanceAudio } from './audio-load-balancer.js'
import { selectAudioCamStream } from './audio-stream-selection.js'
import type { AudioTrackProbe } from './audio-track-probe.js'
import { KeyedAsyncLock } from './keyed-async-lock.js'
import type { AudioNodeAssignment } from './orchestrator-types.js'

/** Key under which the orchestrator stores the per-device audio node pin. */
export const AUDIO_NODE_SETTING = 'audioNodeId'

/**
 * Fallback quiet period for an `audioMode: 'on-motion'` window when the camera
 * carries no `audioMotionWindowMs` (mirrors the runner cap's
 * `audioMotionWindowMsField.default`). Long enough that two PIR wakes on a
 * battery camera land in one window instead of two stream re-dials.
 */
export const DEFAULT_AUDIO_MOTION_WINDOW_MS = 90_000

export interface AudioSubscriptionControllerDeps {
  readonly api: () => AddonApi | null
  readonly eventBus: IEventBus
  readonly logger: IScopedLogger
  /** Reads the per-device settings store — used for the `audioNodeId` pin. */
  readonly readDeviceStore: (deviceId: number) => Promise<Record<string, unknown>>
  // The `audio` watchdog tap used to live here, fed per decoded chunk by this
  // controller's own poll loop. The poll loop is gone (D461) and the tap now
  // hangs off `PipelineAudioInferenceResult` in `orchestrator-subscriptions.ts`
  // — the analyzer saying it produced a window. Leaving the dep here would
  // have read as "the controller still reports audio liveness", which is
  // exactly the leftover that makes a live gap look covered.
  /**
   * Broker-observed audio-track evidence for the stream the audio would ride.
   * The SAME reading the watchdog's audio stage arms on
   * (`audio-track-probe.ts`) — two readers of one classifier, so the
   * subscription and the watchdog can never disagree about whether a camera
   * has audio.
   */
  readonly probeAudioTrack: (deviceId: number, camStreamId: string) => Promise<AudioTrackProbe>
  /**
   * This device's `CamProfile → sourceCamStreamId` map — the SAME read
   * `buildDetectionConfig` uses (`DetectionWiringController.fetchAssignedProfiles`,
   * one `listAllProfileSlots`), so the audio plane and the detection plane can
   * never disagree about which rung is backed by which cam-stream.
   *
   * `null` means the read FAILED (transient broker RPC), never "no slots" —
   * that is the empty map. {@link selectAudioCamStream} errs differently on
   * each, and folding them together is the failure D393 names.
   */
  readonly assignedProfiles: (deviceId: number) => Promise<ReadonlyMap<CamProfile, string> | null>
  /** `clusterRoles.ingestNode` — camera-source acquisition owner for the audio-chunk poller. */
  readonly ingestNode: () => string
  readonly localNodeId: () => string
  readonly enabledAudioNodes: () => readonly string[]
  /** `clusterRoles.audioNode` — the singleton audio-analyzer role node. */
  readonly audioNodeRole: () => string
  /** `isCapActiveForDevice(deviceId, 'audio-analysis')` — binding gate. */
  readonly isAudioAnalysisActive: (deviceId: number) => Promise<boolean>
  /** `activeDetections.has(deviceId)` — the keep-if-active-else-unsub check. */
  readonly isDetectionActive: (deviceId: number) => boolean
  /** `activeDetections.get(deviceId)` — fallback source for `reattachForDevice`'s audio config. */
  readonly getActiveDetectionConfig: (deviceId: number) => CameraDetectionConfig | undefined
  /** `ledger.getConfig(deviceId)` — primary source for `reattachForDevice`'s audio config. */
  readonly getLedgerConfig: (deviceId: number) => RunnerCameraConfig | null
  readonly scheduleReconcile: () => void
}

export class AudioSubscriptionController {
  /**
   * Per-device audio broker unsubscribe callbacks. Exactly one live handle
   * per device — every mutation runs inside {@link withAudioSubLock} so a
   * prior handle is always torn down before it is replaced. `protected` so
   * `audio-sub-lock.spec.ts`'s test subclass can assert the post-condition
   * (exactly one live handle per device) without casts.
   */
  protected readonly audioSubscriptions = new Map<number, Unsubscribe>()
  /**
   * Per-device async mutex serializing the get→teardown→subscribe→set
   * sequence — backed by the generic `KeyedAsyncLock`. `protected` so
   * `audio-sub-lock.spec.ts`'s test subclass can read `.size` without casts
   * (mirrors the pre-S7 `protected audioSubLocks` field's test-seam
   * convention).
   */
  protected readonly audioSubLocks = new KeyedAsyncLock<number>({
    isShuttingDown: () => this.audioShuttingDown,
  })
  /**
   * Set true at the very start of shutdown (before the teardown loop / map
   * clears). Once set, `withAudioSubLock` turns queued/new critical
   * sections into no-ops and `storeAudioSub` refuses to store (immediately
   * unsubscribing instead), so a section that was mid-`await
   * subscribeAudioStream` (or queued) when shutdown began cannot resurrect a
   * zombie entry into the cleared `audioSubscriptions` map. `protected` so a
   * test subclass can drive the shutdown guard without casts.
   */
  protected audioShuttingDown = false
  /**
   * Per-device pending lazy-audio teardown timer (closes audio sub after
   * motion cooldown when `audioMode === 'on-motion'`).
   */
  private readonly lazyAudioTeardownTimers = new Map<number, ReturnType<typeof setTimeout>>()
  /**
   * Per-device OPEN on-motion audio window — the quiet timer that closes it.
   *
   * Separate from {@link lazyAudioTeardownTimers} (which is armed by a
   * FALLING edge) because the two answer different questions, and only this
   * one can answer the battery case: camera-native providers emit motion as a
   * rising edge only, so a falling edge may never arrive at all. Presence of a
   * key here means "a motion window is currently open for this device", which
   * is also what lets a reattach during an open window re-subscribe instead of
   * refusing (see `subscribeAudioStream`).
   */
  private readonly motionAudioWindowTimers = new Map<number, ReturnType<typeof setTimeout>>()
  /**
   * Per-device audio node assignment — the SOLE source of truth (smell #19:
   * the former sibling `audioNodeByDevice` string map was a pure derivative,
   * written/cleared only in lockstep with this map and read in exactly one
   * place (`reattachForNode`'s loop, now `assignment.nodeId` below); dropped
   * as a zero-behavior-change cleanup).
   */
  private readonly audioAssignments = new Map<number, AudioNodeAssignment>()
  /** Nodes known to have a ready audio-analyzer. */
  private readonly readyAudioNodes = new Set<string>()
  /** Last seen readiness epoch per node for audio-analyzer. */
  private readonly lastSeenAudioEpochByNode = new Map<string, number>()

  constructor(private readonly deps: AudioSubscriptionControllerDeps) {}

  /**
   * Read-only view of the live subscription map. Test-seam only — backs
   * `PipelineOrchestratorAddon`'s `audioSubscriptions` compat getter, which
   * `bindings-e2e.spec.ts`'s cast-based read depends on. Production code
   * never reads this.
   */
  get subscriptionsSnapshot(): ReadonlyMap<number, Unsubscribe> {
    return this.audioSubscriptions
  }

  // ── Assignment / load accessors (cap-facing, thin delegates) ──────────

  getAssignment(deviceId: number): AudioNodeAssignment | null {
    return this.audioAssignments.get(deviceId) ?? null
  }

  getAssignments(): AudioNodeAssignment[] {
    return [...this.audioAssignments.values()]
  }

  getNodeLoad(): AudioNodeLoad[] {
    return this.collectAudioNodeLoad()
  }

  /** Drop a device's cached assignment (manual pin/unpin — next dispatch re-balances). */
  clearAssignment(deviceId: number): void {
    this.audioAssignments.delete(deviceId)
  }

  /** Drop a node from the ready set (agent offline / detection-pipeline readiness `down`). */
  markNodeOffline(nodeId: string): void {
    this.readyAudioNodes.delete(nodeId)
  }

  /**
   * Seed a node as ready WITHOUT going through the epoch-gated
   * {@link handleAudioAnalyzerReadiness} — the boot-time local seed
   * (`readyAudioNodes.add(localNodeId)` — audio-analyzer starts on hub).
   */
  seedReadyNode(nodeId: string): void {
    this.readyAudioNodes.add(nodeId)
  }

  // ── Dispatch / balancing ────────────────────────────────────────────

  private async readAudioNodePin(deviceId: number): Promise<string | null> {
    try {
      const store = await this.deps.readDeviceStore(deviceId)
      const v = store[AUDIO_NODE_SETTING]
      return typeof v === 'string' && v.length > 0 && v !== 'auto' ? v : null
    } catch {
      return null
    }
  }

  private collectAudioNodeLoad(): AudioNodeLoad[] {
    const counts = new Map<string, number>()
    for (const assignment of this.audioAssignments.values()) {
      counts.set(assignment.nodeId, (counts.get(assignment.nodeId) ?? 0) + 1)
    }
    const nodes: AudioNodeLoad[] = []
    for (const nodeId of this.readyAudioNodes) {
      if (!this.deps.enabledAudioNodes().includes(nodeId)) continue
      nodes.push({ nodeId, deviceCount: counts.get(nodeId) ?? 0 })
    }
    return nodes
  }

  private recordAudioAssignment(deviceId: number, nodeId: string, pinned: boolean): void {
    const assignment: AudioNodeAssignment = {
      deviceId,
      nodeId,
      pinned,
      assignedAt: Date.now(),
    }
    this.audioAssignments.set(deviceId, assignment)
  }

  /**
   * Resolve (and cache) the audio-analyzer node for `deviceId`. Prefers an
   * existing assignment, then a manual pin, then the singleton
   * `clusterRoles.audioNode` role (while it is a currently-ready audio
   * node), then falls back to the load balancer.
   */
  async dispatch(deviceId: number): Promise<string> {
    // Prefer existing assignment — avoids re-balancing on every re-subscription.
    const existing = this.audioAssignments.get(deviceId)
    if (existing) return existing.nodeId

    const preferredNode = await this.readAudioNodePin(deviceId)
    const loads = this.collectAudioNodeLoad()

    // If no audio nodes are known yet, fall back to local.
    if (loads.length === 0) {
      this.recordAudioAssignment(deviceId, this.deps.localNodeId(), false)
      return this.deps.localNodeId()
    }

    // Audio is a cluster-wide SINGLETON role (placement-model §6): every
    // camera's audio analysis runs on `clusterRoles.audioNode`. An explicit
    // per-device pin still overrides it (legacy escape hatch); otherwise the
    // role node is used whenever it is a currently-eligible audio node, and we
    // only fall back to the load balancer when the role node is unavailable.
    if (!preferredNode) {
      const roleNode = this.deps.audioNodeRole()
      if (loads.some((load) => load.nodeId === roleNode)) {
        this.recordAudioAssignment(deviceId, roleNode, false)
        return roleNode
      }
    }

    const decision = balanceAudio({ nodes: loads, preferredNode })
    const nodeId = decision?.nodeId ?? this.deps.localNodeId()
    const pinned = decision?.reason === 'manual'
    this.recordAudioAssignment(deviceId, nodeId, pinned)
    return nodeId
  }

  // ── Readiness ─────────────────────────────────────────────────────────

  /**
   * Act on an `audio-analyzer` readiness transition for `nodeId`. On a new
   * `ready` epoch, re-attaches audio for every camera already dispatched to
   * that node (an audio-analyzer restart otherwise leaves already-dispatched
   * cameras' audio subscriptions pointing at the dead analyzer — frozen
   * levels) and requests a reconcile in case cameras were stranded while the
   * node was offline.
   */
  async handleAudioAnalyzerReadiness(t: ReadinessTransition, nodeId: string): Promise<void> {
    if (t.state !== 'ready') {
      this.readyAudioNodes.delete(nodeId)
      return
    }
    const lastEpoch = this.lastSeenAudioEpochByNode.get(nodeId) ?? 0
    if (t.epoch <= lastEpoch) return
    this.lastSeenAudioEpochByNode.set(nodeId, t.epoch)
    this.readyAudioNodes.add(nodeId)
    this.deps.logger.info('audio-analyzer ready — node now available for audio dispatch', {
      tags: { nodeId },
      meta: { epoch: t.epoch },
    })
    await this.reattachForNode(nodeId)
    this.deps.scheduleReconcile()
  }

  // ── Reattach / resubscribe ──────────────────────────────────────────

  /**
   * Re-establish audio subscriptions for every camera whose audio is routed
   * to `nodeId`, after that node's audio-analyzer (re)started. Idempotent.
   */
  async reattachForNode(nodeId: string): Promise<void> {
    for (const [deviceId, assignment] of this.audioAssignments) {
      if (assignment.nodeId !== nodeId) continue
      await this.reattachForDevice(deviceId)
    }
  }

  /**
   * Re-establish the audio subscription for ONE camera under its current
   * pin/balance. No-op when the device has no runner/detection config
   * (mirrors the original early-return — never enters the lock, never tears
   * down an existing handle, in that case).
   *
   * Phase 3 slice 2 (Task 2): an idle session-mode (`on-motion`) camera never
   * gets a ledger `cameraConfigs` entry — falls back to
   * `getActiveDetectionConfig` (set unconditionally by `startDetection`) for
   * the `CameraDetectionConfig` shape `subscribeAudioStream` wants.
   */
  async reattachForDevice(deviceId: number): Promise<void> {
    const cached = this.deps.getLedgerConfig(deviceId)
    // `subscribeAudioStream` wants a `CameraDetectionConfig`; the cached
    // runner config carries every field except `enabled` (it tracks
    // `pipelineEnabled`). Derive `enabled` from it for the audio sub.
    const audioCfg: CameraDetectionConfig | undefined = cached
      ? { ...cached, enabled: cached.pipelineEnabled }
      : this.deps.getActiveDetectionConfig(deviceId)
    if (!audioCfg) return
    try {
      await this.resubscribe(deviceId, audioCfg)
    } catch (err: unknown) {
      this.deps.logger.error('audio re-attach failed', {
        tags: { deviceId },
        meta: { error: errMsg(err) },
      })
    }
  }

  /**
   * Collapsed resubscribe sequence (smell #7) — teardown-prior →
   * `subscribeAudioStream` → keep-if-active-else-unsub, inside the same
   * per-device lock the whole way (so a prior handle is never orphaned).
   *
   * Shared by THREE of the four original call sites, verified
   * byte-for-byte-equivalent modulo the `cfg` source:
   *
   *   - `reattachForDevice` (above): computes `audioCfg` from the ledger
   *     config (or `activeDetections` fallback), returns BEFORE entering the
   *     lock when falsy — so it only ever calls `resubscribe` with a truthy
   *     `cfg`, exercising the "teardown + subscribe" branch below.
   *   - `startDetection`'s audio block (index.ts): calls
   *     `resubscribe(deviceId, config)` with the always-truthy function
   *     parameter — same branch.
   *   - `recoverPipelineStage`'s audio branch (index.ts, stays on the class
   *     — C18 watchdog glue): computes `audioCfg` from the ledger config too,
   *     but — UNLIKE `reattachForDevice` — calls `resubscribe` UNCONDITIONALLY
   *     even when `audioCfg` is `undefined` (no cached config). The original
   *     always tore down the existing handle in that case (force-drop a
   *     possibly-stale/dead subscription on watchdog-flagged recovery) and
   *     only skipped the `subscribeAudioStream` call. `cfg?` optional here
   *     reproduces exactly that: teardown always runs; subscribe is skipped
   *     when `cfg` is falsy.
   *
   * NOT used by `handleLazyAudioMotion`'s subscribe half (the fourth site) —
   * that one guards with "skip if a subscription already exists" instead of
   * tearing down first, a genuinely different idempotency contract (motion
   * re-fires every 1-2s while active; unconditional teardown-first there
   * would restart the audio broker subscription on every re-fire instead of
   * being a no-op). See `handleLazyAudioMotion`'s doc comment.
   */
  async resubscribe(deviceId: number, cfg?: CameraDetectionConfig): Promise<void> {
    await this.withAudioSubLock(deviceId, async () => {
      const prior = this.audioSubscriptions.get(deviceId)
      if (prior) {
        try {
          prior()
        } catch {
          /* swallow */
        }
        this.audioSubscriptions.delete(deviceId)
      }
      if (!cfg) return
      const unsub = await this.subscribeAudioStream(deviceId, cfg)
      if (unsub) {
        if (this.deps.isDetectionActive(deviceId)) {
          this.storeAudioSub(deviceId, unsub)
        } else {
          unsub()
        }
      }
    })
  }

  /**
   * Lazy audio gate handler. Fires on every `MotionOnMotionChanged` event
   * for a device whose `audioMode === 'on-motion'`.
   *
   * - `detected:true` → cancel any pending teardown, open the audio sub if
   *   not already open, and arm/rearm the QUIET WINDOW. Idempotent: re-fires
   *   of the same `true` while subscribed only push the quiet timer out —
   *   deliberately NOT routed through {@link resubscribe} (which always tears
   *   down first): motion re-fires can arrive every 1-2s, so a teardown-first
   *   sequence here would restart the audio stream on every re-fire instead
   *   of leaving it open. That idempotence IS the anti-churn guarantee: a
   *   burst of motion can never produce a burst of stream re-dials.
   * - `detected:false` → schedule teardown after the device's motion
   *   cooldown window.
   *
   * **Why the quiet window is the primary closer.** Camera-native motion is a
   * RISING EDGE ONLY: the Reolink driver emits `detected:true` at both of its
   * emit sites (native Baichuan push AND the email-push SMTP path used by
   * sleeping battery cams) and never a falling counterpart — only the
   * frame-diff analyzer emits falls, and an onboard-only camera has no
   * standing analyzer. So the `detected:false` branch below is unreachable on
   * exactly the cameras `on-motion` exists for, and before the quiet window
   * the audio subscription simply stayed open forever: `on-motion` degraded
   * into `always-on`, which on a battery camera means a flat battery. The two
   * closers coexist — whichever fires first wins.
   */
  async handleLazyAudioMotion(
    deviceId: number,
    detected: boolean,
    config: CameraDetectionConfig,
  ): Promise<void> {
    if (config.audioMode !== 'on-motion') return
    const log = this.deps.logger.withTags({ deviceId })
    if (detected) {
      // Cancel pending teardown so a re-fire keeps the sub open.
      const pendingTeardown = this.lazyAudioTeardownTimers.get(deviceId)
      if (pendingTeardown) {
        clearTimeout(pendingTeardown)
        this.lazyAudioTeardownTimers.delete(deviceId)
      }
      // Arm/rearm the quiet window BEFORE subscribing: the window flag is
      // what makes `subscribeAudioStream` accept an on-motion device, both
      // for the call just below and for any reattach/rebalance that lands
      // while the window is open.
      const windowMs = config.audioMotionWindowMs ?? DEFAULT_AUDIO_MOTION_WINDOW_MS
      const alreadyOpen = this.motionAudioWindowTimers.has(deviceId)
      this.armMotionAudioWindow(deviceId, windowMs)
      await this.withAudioSubLock(deviceId, async () => {
        if (this.audioSubscriptions.has(deviceId)) return
        // Audio binding may have been operator-toggled OFF since dispatch
        // — re-check inside subscribeAudioStream covers it.
        const unsub = await this.subscribeAudioStream(deviceId, config)
        if (unsub) {
          this.storeAudioSub(deviceId, unsub)
          log.info('lazy audio: window opened on motion', {
            meta: { windowMs, rearmed: alreadyOpen },
          })
        }
      })
      return
    }
    // detected === false: schedule teardown after cooldown.
    // Intentional optimistic pre-lock read: this is just a cheap scheduling
    // guard that skips arming a cooldown timer when no sub exists. The
    // authoritative teardown re-checks `audioSubscriptions.get(deviceId)`
    // INSIDE `withAudioSubLock` (below), so a stale `true` here only ever
    // costs a spurious timer — never a double-teardown or an orphaned handle.
    if (!this.audioSubscriptions.has(deviceId)) return
    const existing = this.lazyAudioTeardownTimers.get(deviceId)
    if (existing) clearTimeout(existing)
    const cooldownMs = config.motionCooldownMs ?? 30_000
    const timer = setTimeout(() => {
      this.lazyAudioTeardownTimers.delete(deviceId)
      // Same closer as the quiet window — one definition of "closed", so the
      // two paths can never leave the window flag and the subscription in
      // disagreement.
      void this.closeMotionAudioWindow(deviceId, 'motion-cooldown-elapsed').catch(
        (err: unknown) => {
          this.deps.logger.warn('lazy audio: cooldown teardown failed', {
            tags: { deviceId },
            meta: { error: errMsg(err) },
          })
        },
      )
    }, cooldownMs)
    this.lazyAudioTeardownTimers.set(deviceId, timer)
  }

  /**
   * (Re)arm the quiet timer that closes an open on-motion audio window.
   * Rearming replaces the timer only — it never touches the live audio
   * subscription, so extending a window costs nothing.
   */
  private armMotionAudioWindow(deviceId: number, windowMs: number): void {
    const existing = this.motionAudioWindowTimers.get(deviceId)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      this.motionAudioWindowTimers.delete(deviceId)
      void this.closeMotionAudioWindow(deviceId, 'quiet-window-elapsed').catch((err: unknown) => {
        this.deps.logger.warn('lazy audio: quiet-window teardown failed', {
          tags: { deviceId },
          meta: { error: errMsg(err) },
        })
      })
    }, windowMs)
    this.motionAudioWindowTimers.set(deviceId, timer)
  }

  /** True while a motion-driven audio window is open for this device. */
  private isMotionAudioWindowOpen(deviceId: number): boolean {
    return this.motionAudioWindowTimers.has(deviceId)
  }

  /**
   * Close an on-motion audio window and drop its subscription. Shared by both
   * closers (quiet window elapsed / falling edge cooldown) so they can never
   * disagree about what "closed" means. `reason` is logged so a camera that
   * loses audio can always be told WHY from the per-device log view.
   */
  private async closeMotionAudioWindow(deviceId: number, reason: string): Promise<void> {
    const pendingWindow = this.motionAudioWindowTimers.get(deviceId)
    if (pendingWindow) {
      clearTimeout(pendingWindow)
      this.motionAudioWindowTimers.delete(deviceId)
    }
    await this.withAudioSubLock(deviceId, async () => {
      const unsub = this.audioSubscriptions.get(deviceId)
      if (!unsub) return
      try {
        unsub()
      } catch {
        /* swallow — best-effort teardown */
      }
      this.audioSubscriptions.delete(deviceId)
      this.deps.logger.info('lazy audio: window closed', {
        tags: { deviceId },
        meta: { reason },
      })
    })
  }

  /**
   * Audio teardown for one device — the audio half of `stopDetection`.
   * Tears down through the per-device lock so it can't race a concurrent
   * subscribe (which would re-store a handle this teardown never sees).
   */
  async stopForDevice(deviceId: number): Promise<void> {
    await this.withAudioSubLock(deviceId, async () => {
      const unsub = this.audioSubscriptions.get(deviceId)
      if (unsub) {
        try {
          unsub()
        } catch {
          /* swallow */
        }
        this.audioSubscriptions.delete(deviceId)
      }
    })
    const lazyTimer = this.lazyAudioTeardownTimers.get(deviceId)
    if (lazyTimer) {
      clearTimeout(lazyTimer)
      this.lazyAudioTeardownTimers.delete(deviceId)
    }
    // The device is being stopped outright — any open motion window goes with
    // it, or a later reattach would see a window that no motion is sustaining.
    const windowTimer = this.motionAudioWindowTimers.get(deviceId)
    if (windowTimer) {
      clearTimeout(windowTimer)
      this.motionAudioWindowTimers.delete(deviceId)
    }
    this.audioAssignments.delete(deviceId)
  }

  /**
   * Centralized write into `audioSubscriptions`. If shutdown has begun, the
   * map has already been (or is about to be) cleared lock-free in
   * `shutdown()`; storing here would leak a zombie entry whose `unsub` is
   * never called. So when shutting down we immediately invoke `unsub`
   * (best-effort, error-swallowed) and DO NOT store. `protected` so
   * `audio-sub-lock.spec.ts`'s test subclass can assert the shutdown-guard
   * behavior without casts.
   */
  protected storeAudioSub(deviceId: number, unsub: Unsubscribe): void {
    if (this.audioShuttingDown) {
      try {
        unsub()
      } catch {
        /* swallow — best-effort cleanup during shutdown */
      }
      return
    }
    this.audioSubscriptions.set(deviceId, unsub)
  }

  /**
   * Serialize an audio-subscription critical section per device. `fn` is
   * chained onto the device's current lock tail, so concurrent calls for the
   * SAME deviceId run sequentially (FIFO); different deviceIds never block
   * each other. Thin delegate onto the `audioSubLocks` `KeyedAsyncLock`
   * instance. `protected` so `audio-sub-lock.spec.ts`'s test subclass can
   * drive the lock without casts.
   */
  protected withAudioSubLock(deviceId: number, fn: () => Promise<void>): Promise<void> {
    return this.audioSubLocks.run(deviceId, fn)
  }

  /**
   * Subscribe to decoded audio chunks for a camera and feed them into the
   * audio-analyzer. Reads the analyzer's settings via its own
   * `resolveDeviceSettings(deviceId)` method so the orchestrator does not
   * touch the audio-analyzer schema field names directly.
   */
  protected async subscribeAudioStream(
    deviceId: number,
    config: CameraDetectionConfig,
  ): Promise<Unsubscribe | null> {
    const api = this.deps.api()
    if (!api) {
      this.deps.logger.warn('this.ctx.api not available — cannot subscribe audio', {
        tags: { deviceId },
      })
      return null
    }

    // Per-device bindings gate the audio-analysis wrapper. Operator
    // toggle (setWrapperActive:false) short-circuits without opening
    // the stream.
    if (!(await this.deps.isAudioAnalysisActive(deviceId))) return null

    // Mode-based gate (operator-facing schedule):
    //   - `'disabled'` — never subscribe, even with the wrapper bound.
    //     Battery cams default here so the audio decoded stream
    //     doesn't hold the substream open.
    //   - `'always-on'` — subscribe immediately, run continuously.
    //     Default for non-battery cams.
    //   - `'on-motion'` — subscribe only while a motion window is open
    //     (opened + kept alive by `handleLazyAudioMotion`, closed by the
    //     quiet timer). Outside a window this refuses, which is what frees
    //     the broker pre-buffer + audio-codec session on an idle camera.
    if (config.audioMode === 'disabled') {
      this.deps.logger.debug('audio subscribe skipped: audioMode=disabled', {
        tags: { deviceId },
      })
      return null
    }
    if (config.audioMode === 'on-motion' && !this.isMotionAudioWindowOpen(deviceId)) {
      // Lazy path: wait for a motion window to open. The
      // MotionOnMotionChanged subscription drives it (see
      // `handleLazyAudioMotion`). Skipping here means the steady-state
      // "watching" camera holds no audio subscriber + no decoded-audio
      // chunks, freeing the broker's pre-buffer + audio-codec session.
      //
      // The window check — rather than an unconditional refusal — is what
      // keeps a reattach honest: a rebalance or `reattachForDevice` landing
      // mid-window used to tear the subscription down and then refuse to
      // rebuild it, silently muting the camera until the NEXT motion event.
      this.deps.logger.info('audio subscribe deferred: audioMode=on-motion, no window open', {
        tags: { deviceId },
      })
      return null
    }

    // Which stream audio rides. NOT `motionStreamId` any more: on this fleet
    // the motion rung is a broker-spawned `derived:mid-to-low` transcode, and
    // an audio subscription is broker DEMAND — `hasLiveIntent()` counts
    // `audioChunkPlane.subscriberCount`, and the derived feeder is spawned and
    // torn down on that same demand edge. A listener that wanted only sound
    // therefore paid for, and pinned open, a full video re-encode. The rule is
    // now explicit and lives in one pure function: an audio-only consumer
    // never causes a video transcode. See `audio-stream-selection.ts`.
    const selection = selectAudioCamStream({
      // Absent reads as `auto` — the lowest AVAILABLE native rung, which is the
      // behaviour of every camera nobody has touched.
      pick: config.audioStreamPick ?? 'auto',
      motionStreamId: config.motionStreamId,
      assigned: await this.deps.assignedProfiles(deviceId),
    })
    if (selection.kind === 'refused') {
      // Say it rather than spawning the transcode. A branch that drops work
      // silently reads as "never happened", and this one is the difference
      // between a camera with no audio analysis and a camera nobody noticed
      // had none.
      this.deps.logger.warn(
        'audio subscription REFUSED — no native rung to listen on (an audio-only consumer never causes a video transcode)',
        {
          tags: { deviceId },
          meta: {
            reason: selection.reason,
            // What the operator asked for, verbatim, so the answer to "which
            // stream is my audio on" is in the line that says there is none.
            pick: selection.pick,
            rejectedCamStreamId: selection.rejectedCamStreamId,
            motionStreamId: config.motionStreamId,
            hint:
              selection.reason === 'pick-unassigned'
                ? 'this camera no longer publishes the rung its audio is pinned to — repoint the Audio stream setting, or set it back to Auto'
                : 'assign a native (non-derived) stream to one of this camera’s profile slots, or pick a rung explicitly',
          },
        },
      )
      return null
    }
    const audioStream = selection.camStreamId
    const audioBrokerId = makeSourceBrokerId(deviceId, audioStream)
    this.deps.logger.info('audio stream selected', {
      tags: { deviceId },
      meta: {
        camStreamId: audioStream,
        profile: selection.profile,
        selectedBy: selection.selectedBy,
        derived: selection.derived,
        pick: config.audioStreamPick ?? 'auto',
        motionStreamId: config.motionStreamId,
        // An operator pick that names a transcode is honoured, not overridden —
        // but the cost it carries is never left implicit.
        ...(selection.derived
          ? {
              note: 'this pick is a derived stream — the audio subscription keeps its transcode feeder alive',
            }
          : {}),
      },
    })

    // Cheapest question first, and the one nothing used to ask: does the
    // SELECTED stream carry audio AT ALL? A stream the broker positively
    // reports as audio-less is REFUSED — there is deliberately no fallback to
    // another stream. Which rung carries audio is settled one step above
    // (`selectAudioCamStream`); substituting one HERE would make "which stream
    // is my audio on" unanswerable and would hide the very misconfiguration
    // this line reports. Inconclusive evidence (cold broker, failed read)
    // subscribes as before — see `audio-track-probe.ts`.
    const probe = await this.deps.probeAudioTrack(deviceId, audioStream)
    if (probe.kind === 'absent') {
      this.deps.logger.warn('audio subscription REFUSED — this stream carries no audio track', {
        tags: { deviceId },
        meta: {
          camStreamId: audioStream,
          brokerId: audioBrokerId,
          selectedBy: selection.selectedBy,
          profile: selection.profile,
          hint: 'point the camera’s audio at a stream that has an audio track — no stream is substituted automatically',
        },
      })
      return null
    }

    const settings = await api.audioAnalysis.resolveDeviceSettings.query({
      deviceId,
    })
    if (!settings) {
      this.deps.logger.warn('audio-analysis returned no settings — audio subscription skipped', {
        tags: { deviceId },
      })
      return null
    }

    // Resolve and cache the audio-analyzer node for this device.
    const audioNodeId = await this.dispatch(deviceId)
    const isRemoteAudio = audioNodeId !== this.deps.localNodeId()
    this.deps.logger.info('audio subscription: resolved audio node', {
      tags: { deviceId },
      meta: { audioNodeId, isRemote: isRemoteAudio },
    })

    // ── The analyzer PULLS from here on (D461) ────────────────────────────
    //
    // What used to sit between these lines was the relay: a poller draining
    // the broker's chunk plane, an eight-variable window accumulator, and a
    // push back out to `audioAnalyzer.analyseChunk`. This process neither
    // produced nor consumed the audio — it buffered it, and every byte crossed
    // hub-main twice for that. The code had been a closure INSIDE the broker's
    // process; when the `pipeline` group was dissolved nobody moved it, and
    // its own docblock recorded the reason as if it were a decision.
    //
    // D455 settled which way it had to go. It put the SOURCE bytes on the
    // plane, but only for a consumer that DECLARES it can read them — and the
    // declaring consumer was the accumulator, sitting in a third process that
    // had to expand before forwarding. So legs one and two went coded and legs
    // three and four stayed on f32le at ~49 MB/min each. Moving the
    // accumulator into `audio-analyzer` makes the subscriber the decoder: the
    // negotiation needs no third interlocutor and both remaining legs stay
    // coded. ~196 -> ~25 MB/min, composed.
    //
    // What stayed here is everything above this comment — whether this camera's
    // audio runs at all, on which stream, with which settings, on which node.
    // That is policy, and policy is this addon's job. The bytes are not.
    const attach = await api.audioAnalyzer.attachDevice.mutate(
      {
        deviceId,
        brokerId: audioBrokerId,
        // Camera-source acquisition lives on the cluster owner; the analyzer
        // pins every `streamBroker` call to it, exactly as the poller did from
        // here. Resolved DIRECTLY from `clusterRoles.ingestNode` (not
        // `this.sourceOwner()` / `resolveSourceOwner`, which gate on unrelated
        // conditions) — audio needs no hostname, subscribe/pull/unsubscribe
        // are pure RPC and the transport addresses the pinned node.
        ingestNodeId: this.deps.ingestNode(),
        // Read ONCE per subscription, as it always was. A settings change
        // re-subscribes, which re-attaches.
        settings,
      },
      nodePin(audioNodeId),
    )
    if (!attach.attached) {
      // The analyzer refused (shutting down, or no api). Report it — a camera
      // whose audio silently never started is the failure D427 exists for.
      this.deps.logger.warn('audio subscription REFUSED by the analyzer', {
        tags: { deviceId },
        meta: { audioNodeId, brokerId: audioBrokerId },
      })
      return null
    }
    this.deps.logger.info('Audio stream subscribed', {
      tags: { deviceId },
      meta: { audioNodeId, brokerId: audioBrokerId, replaced: attach.replaced },
    })

    return () => {
      // The broker subscription now lives in a process this addon does not
      // supervise, so the detach is a call that can FAIL. It is reported, and
      // the broker reaps a subscription nobody drains rather than trusting it
      // (`AudioChunkPlane`'s idle lease) — a detach lost to an offline node
      // would otherwise pin the source dial open for the broker's whole life.
      void api.audioAnalyzer.detachDevice
        .mutate({ deviceId }, nodePin(audioNodeId))
        .catch((err: unknown) => {
          this.deps.logger.warn('audio detachDevice failed — the broker lease will reclaim it', {
            tags: { deviceId },
            meta: { audioNodeId, brokerId: audioBrokerId, error: errMsg(err) },
          })
        })
    }
  }

  // ── Shutdown ──────────────────────────────────────────────────────────

  /**
   * Set true at the very start of `onShutdown`, before the audio teardown /
   * map clears below. Once set, `withAudioSubLock` turns queued/new critical
   * sections into no-ops and `storeAudioSub` refuses to store, so no
   * critical section that was in-flight (or queued) when shutdown began can
   * resurrect a zombie subscription into the cleared `audioSubscriptions`
   * map. MUST be called before anything else in `onShutdown` that could
   * race a queued audio critical section (mirrors the original
   * `this.audioShuttingDown = true` being the very first statement).
   */
  beginShutdown(): void {
    this.audioShuttingDown = true
  }

  /**
   * Full audio teardown — combines the former `onShutdown`'s two separate
   * audio blocks (lazy-teardown-timer clear, then — after several unrelated
   * session/reconcile/load-shed clears — subscription teardown + lock clear
   * + assignment-map clears) into one call. Safe to combine: both blocks
   * are synchronous with no interleaved `await`, and every original
   * statement between them (`sessionRegistry.clear()`,
   * `cameraFpsMap.clear()`, `remoteHealthAttempts.clear()`,
   * `loadShedState.clear()`, `loadShedResumeTimer` cleanup) touches state
   * fully disjoint from anything audio — so their relative order to each
   * other is unaffected, and the audio-internal order (timers →
   * subscriptions → lock → assignment maps) is reproduced exactly.
   */
  shutdown(): void {
    for (const t of this.lazyAudioTeardownTimers.values()) clearTimeout(t)
    this.lazyAudioTeardownTimers.clear()
    for (const t of this.motionAudioWindowTimers.values()) clearTimeout(t)
    this.motionAudioWindowTimers.clear()

    for (const unsub of this.audioSubscriptions.values()) {
      try {
        unsub()
      } catch {
        /* swallow — best-effort cleanup */
      }
    }
    this.audioSubscriptions.clear()
    // Process teardown: drop any per-device lock tails. We don't await them
    // (best-effort shutdown) — clearing only releases references; in-flight
    // sections resolve against the now-empty map harmlessly.
    this.audioSubLocks.clear()
    this.audioAssignments.clear()
    this.readyAudioNodes.clear()
  }
}
