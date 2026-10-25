/**
 * occupancy-recheck-controller — the periodic look at a still scene, owned by
 * the component that survives between sessions (D547).
 *
 * ## Why it lives here and not in the runner
 *
 * The runner has a recheck of its own (`PipelineRunner.registerCamera`,
 * `runner.ts:704`): an interval created only for an `on-motion` registration,
 * firing only in phase `watching`. No camera on this fleet ever receives such
 * a registration. A session dispatch attaches the camera `always-on` with
 * `motionSources: []` (`session-dispatch-controller.ts`) and detaches it on
 * `motion_cleared`; between sessions the camera is not registered anywhere.
 * Measured on the hub, 48 h to 2026-09-20: 5 611 `always-on` attaches, 0
 * `on-motion`, `pipelineRunner.getLocalCameras` → `[]`, and `burstAgreed=0` on
 * every stationary entry born. The mechanism the ledger's "occasion B" (D508)
 * describes had no producer.
 *
 * The orchestrator already copies `occupancyRecheckEnabled / Sec / Frames`
 * into every session config, and it is the only thing that knows a session
 * closed. So the cadence is armed here, and it must hold "equalmente in
 * pipeline indifferentemente dal tipo" — the same on every camera, however it
 * is dispatched.
 *
 * ## What one recheck is
 *
 * 1. Attach the camera on the node its last session ran on, with the session
 *    config re-shaped by {@link buildRecheckAttachConfig}: `on-motion` (the
 *    runner starts it `watching`, the one phase it admits a burst frame in),
 *    `motionSources: []` (no motion event can flip it active), audio off,
 *    pre-roll off, and the runner's OWN recheck interval off — one cadence,
 *    owned here.
 * 2. Ask the runner for an out-of-band burst (`requestOccupancyBurst`), which
 *    dials a bounded decode, labels its frames `'burst'`, and reports each
 *    result to post-analysis — where a burst observation agrees on IoU alone
 *    (`observationAgrees`, D508).
 * 3. After {@link RECHECK_BURST_WINDOW_MS} — the runner's own safety timeout
 *    plus dial time — detach, unless a session attached meanwhile on the same
 *    node and superseded the registration (the session owns it now).
 *
 * ## The discipline, kept from the runner
 *
 * Armed only by a session that closed having seen a subject; a found burst
 * resets the empty streak; two consecutive empty bursts disarm it until the
 * next session re-arms. A refusal is NOT an empty room: a sleeping battery
 * camera (D173) disarms without a strike, and every other refusal is skipped
 * and re-tried at the next tick. Every branch that skips or drops work says so,
 * per camera.
 */
import type {
  IScopedLogger,
  OccupancyBurstRefusal,
  OccupancyLookRefusal,
  RunnerCameraConfig,
} from '@camstack/types'
import { errMsg } from '@camstack/types'

/**
 * How long a recheck registration lives once the burst was accepted. The
 * runner settles a burst at `OCCUPANCY_BURST_SAFETY_TIMEOUT_MS` (8 s) after
 * the dial; the dial itself is bounded by the decode-spawn gate. 15 s covers
 * both on this fleet and is short enough that a camera is never held for a
 * meaningful share of its 300 s cadence.
 */
export const RECHECK_BURST_WINDOW_MS = 15_000

/** Consecutive empty bursts after which the cadence disarms. */
export const RECHECK_DISARM_AFTER_EMPTY = 2

/** The `reason` every orchestrator recheck carries into the runner's log. */
export const RECHECK_REASON = 'orchestrator-recheck'

/**
 * D691 — the EARLY LOOK. An occupancy edge commits only on a sample that lands
 * after its sustain window, and a departure's session usually closes before
 * that (the car drives off, motion clears): 102 on 2026-10-01 closed 1.3 s
 * before its 29 s sustain ended and the edge waited 4 min 52 s for the cadence
 * above. The notification centre, which alone knows a flip is pending, asks
 * for ONE look at the sustain's end ({@link OccupancyRecheckController.requestEarlyLook});
 * the dial is the recheck's own (attach, `requestOccupancyBurst`, detach), so
 * the commit is scene evidence and the census still never testifies to an
 * absence (D393).
 */
export const EARLY_LOOK_REASON = 'occupancy-sustain-look'

/** Past the sustain's end: the burst's frames must reach the watcher AFTER
 *  the window, and a dial takes a moment. */
export const EARLY_LOOK_MARGIN_MS = 2_000

/** An ask further out than this is refused: a sustain that long is past any
 *  rule this hub writes, and a timer that long is the cadence's job. */
export const EARLY_LOOK_MAX_DELAY_MS = 15 * 60_000

/** Why an early look was not scheduled — the cap's own vocabulary. */
export type EarlyLookRefusal = OccupancyLookRefusal

/** The answer to one early-look ask. */
export type EarlyLookAnswer =
  | { readonly scheduled: true; readonly dueInMs: number }
  | { readonly scheduled: false; readonly refusedBecause: EarlyLookRefusal }

/** Which dial a burst is: the cadence's tick folds its outcome into the
 *  disarm streak and re-arms; an early look does neither. */
type BurstKind = 'cadence' | 'early-look'

export interface OccupancyRecheckDeps {
  readonly attachOn: (nodeId: string, config: RunnerCameraConfig) => Promise<void>
  readonly detachOn: (nodeId: string, deviceId: number) => Promise<void>
  readonly requestBurstOn: (
    nodeId: string,
    deviceId: number,
    frames: number,
    reason: string,
  ) => Promise<{ started: boolean; refusedBecause?: OccupancyBurstRefusal }>
  /** Is a detection session running for this device right now? */
  readonly isSessionActive: (deviceId: number) => boolean
  readonly logger: IScopedLogger
}

/** What a session close tells the recheck. */
export interface SessionCloseForRecheck {
  /** The session tracked at least one subject at some point — the runner's
   *  `lastResultDetections > 0`, read from the orchestrator's side. */
  readonly sawSubject: boolean
}

/** The streak the disarm rule folds over. */
export interface BurstStreak {
  readonly emptyStreak: number
}

export interface BurstFold extends BurstStreak {
  readonly armed: boolean
}

/** A found burst resets the streak; two consecutive empty ones disarm. */
export function foldBurstOutcome(streak: BurstStreak, found: boolean): BurstFold {
  if (found) return { emptyStreak: 0, armed: true }
  const emptyStreak = streak.emptyStreak + 1
  return { emptyStreak, armed: emptyStreak < RECHECK_DISARM_AFTER_EMPTY }
}

/**
 * The registration a recheck rides on, derived from the SESSION config so the
 * stream, steps, zones and root detector are the camera's own.
 */
export function buildRecheckAttachConfig(session: RunnerCameraConfig): RunnerCameraConfig {
  return {
    ...session,
    detectionMode: 'on-motion',
    motionSources: [],
    audioMode: 'disabled',
    occupancyRecheckEnabled: false,
    preRollInferenceEnabled: false,
  }
}

interface BurstInFlight {
  readonly nodeId: string
  /** A session attached on this node while the burst ran: the registration is
   *  the session's now, and this burst must not detach it. */
  superseded: boolean
  found: boolean
}

interface DeviceRecheckState {
  lastNodeId: string
  lastConfig: RunnerCameraConfig
  armed: boolean
  emptyStreak: number
  timer: ReturnType<typeof setTimeout> | null
  burst: BurstInFlight | null
  /** The ONE pending early look (D691) and the instant it is due. */
  earlyLook: { readonly timer: ReturnType<typeof setTimeout>; readonly dueAt: number } | null
  /** The early look since the last session has dialled (review H2): further
   *  asks are refused `already-looked` until the next session re-arms it. */
  earlyLookSpent: boolean
}

export class OccupancyRecheckController {
  private readonly devices = new Map<number, DeviceRecheckState>()

  constructor(private readonly deps: OccupancyRecheckDeps) {}

  /**
   * A session was dispatched: remember where and with what, cancel any pending
   * tick (the session sees the scene itself), and supersede a burst in flight
   * on the same node — the session attach replaced its registration.
   */
  noteSessionDispatched(deviceId: number, nodeId: string, config: RunnerCameraConfig): void {
    const state = this.stateFor(deviceId, nodeId, config)
    state.lastNodeId = nodeId
    state.lastConfig = config
    // A real session re-arms the early-look budget (review H2): ONE look per
    // session, never one per re-armed flip.
    state.earlyLookSpent = false
    // The pending recheck is deliberately NOT cancelled here. Cancelling it
    // restarted the interval from zero on every dispatch, so a camera whose
    // sessions are closer together than `occupancyRecheckSec` never reached a
    // tick at all — which is precisely the camera this exists for, a street
    // with parked cars and traffic. Measured on the live hub 2026-09-20:
    // ~100 arms in an hour and zero bursts. `tick` already refuses to run
    // while a session is active and re-arms itself, so the cadence is safe to
    // let stand through session churn.
    if (state.burst !== null && state.burst.nodeId === nodeId) {
      state.burst.superseded = true
      this.deps.logger.debug('occupancy recheck: burst superseded by a session on the same node', {
        tags: { deviceId, nodeId },
        meta: { deviceId, nodeId },
      })
    }
  }

  /** A session closed: arm the cadence iff it saw a subject and the camera
   *  has the recheck enabled. Re-evaluated from scratch on every close. */
  noteSessionClosed(deviceId: number, close: SessionCloseForRecheck): void {
    const state = this.devices.get(deviceId)
    if (state === undefined) return
    const cfg = state.lastConfig
    const enabled = cfg.occupancyRecheckEnabled === true && (cfg.occupancyRecheckSec ?? 0) > 0
    // Arming only ever goes UP here. A session that saw nothing is not
    // evidence that the parked objects left — it is a session that saw
    // nothing, and the one thing allowed to disarm is two consecutive EMPTY
    // BURSTS, which is the question actually being asked. The same reasoning
    // governs the streak: only a close that really saw a subject clears it,
    // or a stream of empty sessions would reset the disarm counter forever
    // and the recheck could never give up on a genuinely empty scene.
    if (close.sawSubject) state.emptyStreak = 0
    state.armed = state.armed || (enabled && close.sawSubject)
    if (!state.armed) {
      // A branch that drops work says so — at debug, because on a busy camera
      // it is one line per session.
      this.deps.logger.debug('occupancy recheck: not armed', {
        tags: { deviceId },
        meta: { deviceId, enabled, sawSubject: close.sawSubject },
      })
      return
    }
    // Arm, but do not RE-arm: a timer already counting down is left alone.
    // Re-scheduling on every close restarts the interval from zero, which on
    // a busy camera postpones the recheck forever — the same defect as
    // cancelling on dispatch, one line further down the same path.
    if (state.timer === null) this.schedule(deviceId, state)
  }

  /** Every inference result the orchestrator sees; a burst result with
   *  detections is what makes a burst "found". */
  noteInferenceResult(
    deviceId: number,
    occasion: string | undefined,
    detectionCount: number,
  ): void {
    const state = this.devices.get(deviceId)
    if (state === undefined || state.burst === null) return
    if (occasion === 'burst' && detectionCount > 0) state.burst.found = true
  }

  /**
   * An occupancy flip is pending on this camera and can commit `afterMs` from
   * now (D691): look at the scene then, once. Bounded to ONE pending look per
   * camera — a second ask moves it to the LATER end (one sample after both
   * windows commits both; a shorter-sustain key on the same camera therefore
   * waits for the longer one) and never adds a dial. ONE look per session: once
   * a look has dialled, every ask is refused `already-looked` until the next
   * session (review H2 — a look's own burst can re-arm a flickering flip).
   * Refused, by name, for a camera no session was ever dispatched for (no node,
   * no config to attach with) and for an ask outside
   * `[0, EARLY_LOOK_MAX_DELAY_MS]`. Not gated on `occupancyRecheckEnabled`: the
   * look commits a notification, not a parked-object census, and the runner
   * still refuses a sleeping battery camera.
   */
  requestEarlyLook(deviceId: number, afterMs: number, reason: string): EarlyLookAnswer {
    const state = this.devices.get(deviceId)
    if (state === undefined)
      return this.refuseEarlyLook(deviceId, afterMs, reason, 'unknown-camera')
    if (!Number.isFinite(afterMs) || afterMs < 0 || afterMs > EARLY_LOOK_MAX_DELAY_MS) {
      return this.refuseEarlyLook(deviceId, afterMs, reason, 'out-of-range')
    }
    if (state.earlyLookSpent) {
      return this.refuseEarlyLook(deviceId, afterMs, reason, 'already-looked')
    }
    const now = Date.now()
    const dueAt = now + afterMs + EARLY_LOOK_MARGIN_MS
    const pending = state.earlyLook
    if (pending !== null && pending.dueAt >= dueAt) {
      return { scheduled: true, dueInMs: pending.dueAt - now }
    }
    if (pending !== null) clearTimeout(pending.timer)
    const timer = setTimeout(() => {
      state.earlyLook = null
      void this.earlyLook(deviceId, reason).catch((err: unknown) => {
        this.deps.logger.warn('occupancy early look: failed', {
          tags: { deviceId },
          meta: { deviceId, error: errMsg(err) },
        })
      })
    }, dueAt - now)
    timer.unref?.()
    state.earlyLook = { timer, dueAt }
    // Info once per look; a flickering flip that moves it is debug, or a
    // flicker would be one info line per sample.
    const line = {
      tags: { deviceId },
      meta: { deviceId, dueInMs: dueAt - now, reason, moved: pending !== null },
    }
    if (pending === null) this.deps.logger.info('occupancy early look: scheduled', line)
    else this.deps.logger.debug('occupancy early look: moved to the later sustain end', line)
    return { scheduled: true, dueInMs: dueAt - now }
  }

  /** A dropped ask leaves the edge to the cadence — said, per camera. */
  private refuseEarlyLook(
    deviceId: number,
    afterMs: number,
    reason: string,
    refusedBecause: EarlyLookRefusal,
  ): EarlyLookAnswer {
    this.deps.logger.info('occupancy early look: refused — the cadence will commit the edge', {
      tags: { deviceId },
      meta: { deviceId, afterMs, reason, refusedBecause },
    })
    return { scheduled: false, refusedBecause }
  }

  /** The device left the orchestrator's knowledge. */
  forget(deviceId: number): void {
    const state = this.devices.get(deviceId)
    if (state === undefined) return
    this.cancelCadence(state)
    this.cancelEarlyLook(deviceId, state, 'camera-forgotten')
    this.devices.delete(deviceId)
  }

  shutdown(): void {
    for (const [deviceId, state] of this.devices) {
      this.cancelCadence(state)
      this.cancelEarlyLook(deviceId, state, 'shutdown')
    }
    this.devices.clear()
  }

  private async earlyLook(deviceId: number, reason: string): Promise<void> {
    const state = this.devices.get(deviceId)
    if (state === undefined) return
    if (this.deps.isSessionActive(deviceId)) {
      // The session IS the look: its frames commit the edge themselves. Not a
      // drop, and on an arrival this is the ordinary case — debug.
      this.deps.logger.debug('occupancy early look: skipped — a session is sampling the scene', {
        tags: { deviceId },
        meta: { deviceId, reason },
      })
      return
    }
    if (state.burst !== null) {
      // A burst already in flight on this camera: a second dial would be
      // refused by the runner. Its frames may predate the sustain end, so the
      // edge may wait for the cadence — said, per camera.
      this.reportDroppedLook(deviceId, 'burst-in-flight', reason)
      return
    }
    state.earlyLookSpent = true
    await this.runBurst(deviceId, state, 'early-look')
  }

  private stateFor(
    deviceId: number,
    nodeId: string,
    config: RunnerCameraConfig,
  ): DeviceRecheckState {
    let state = this.devices.get(deviceId)
    if (state === undefined) {
      state = {
        lastNodeId: nodeId,
        lastConfig: config,
        armed: false,
        emptyStreak: 0,
        timer: null,
        burst: null,
        earlyLook: null,
        earlyLookSpent: false,
      }
      this.devices.set(deviceId, state)
    }
    return state
  }

  /**
   * The CADENCE timer only. Never the early look (review H1): every re-arm of
   * the cadence — a close, a skipped tick, a settle — went through one cancel
   * that also dropped a pending look, silently, in exactly the order
   * production runs (the flip arms while the session is still open).
   */
  private cancelCadence(state: DeviceRecheckState): void {
    if (state.timer !== null) {
      clearTimeout(state.timer)
      state.timer = null
    }
  }

  /** Drop a pending early look — only when the camera itself goes away. */
  private cancelEarlyLook(deviceId: number, state: DeviceRecheckState, why: string): void {
    if (state.earlyLook === null) return
    clearTimeout(state.earlyLook.timer)
    state.earlyLook = null
    this.reportDroppedLook(deviceId, why, null)
  }

  /** A look that will not run leaves its edge to the cadence — said, per camera. */
  private reportDroppedLook(deviceId: number, why: string, reason: string | null): void {
    this.deps.logger.info('occupancy early look: dropped — the cadence will commit the edge', {
      tags: { deviceId },
      meta: { deviceId, why, reason },
    })
  }

  private schedule(deviceId: number, state: DeviceRecheckState): void {
    this.cancelCadence(state)
    const delayMs = (state.lastConfig.occupancyRecheckSec ?? 0) * 1000
    const timer = setTimeout(() => {
      state.timer = null
      void this.tick(deviceId).catch((err: unknown) => {
        this.deps.logger.warn('occupancy recheck: tick failed', {
          tags: { deviceId },
          meta: { deviceId, error: errMsg(err) },
        })
      })
    }, delayMs)
    timer.unref?.()
    state.timer = timer
  }

  private async tick(deviceId: number): Promise<void> {
    const state = this.devices.get(deviceId)
    if (state === undefined || !state.armed) return
    if (this.deps.isSessionActive(deviceId)) {
      // The session is looking at the scene at full rate; a burst would add a
      // second dial for nothing. Skipped, not struck, and re-armed.
      this.deps.logger.debug('occupancy recheck: skipped — a session is active', {
        tags: { deviceId },
        meta: { deviceId },
      })
      this.schedule(deviceId, state)
      return
    }
    if (state.burst !== null) {
      this.schedule(deviceId, state)
      return
    }
    await this.runBurst(deviceId, state, 'cadence')
  }

  /**
   * Attach, burst, and detach after the window. The CADENCE re-arms on a
   * transient failure and folds the outcome into its streak; an EARLY LOOK
   * (D691) does neither — it is one sample for one pending edge, and its
   * failure leaves that edge to the cadence.
   */
  private async runBurst(
    deviceId: number,
    state: DeviceRecheckState,
    kind: BurstKind,
  ): Promise<void> {
    const cadence = kind === 'cadence'
    const reasonTag = cadence ? RECHECK_REASON : EARLY_LOOK_REASON
    const nodeId = state.lastNodeId
    const config = buildRecheckAttachConfig(state.lastConfig)
    const frames = Math.max(1, state.lastConfig.occupancyRecheckFrames ?? 4)
    const burst: BurstInFlight = { nodeId, superseded: false, found: false }
    state.burst = burst
    try {
      await this.deps.attachOn(nodeId, config)
    } catch (err) {
      state.burst = null
      this.deps.logger.warn(
        cadence
          ? 'occupancy recheck: attach failed — retried next tick'
          : 'occupancy early look: attach failed — the cadence will commit the edge',
        { tags: { deviceId, nodeId }, meta: { deviceId, nodeId, error: errMsg(err), kind } },
      )
      if (cadence) this.schedule(deviceId, state)
      return
    }
    const answer = await this.deps
      .requestBurstOn(nodeId, deviceId, frames, reasonTag)
      .catch((err: unknown) => ({ started: false, error: errMsg(err) }))
    if (!answer.started) {
      const refusedBecause = 'refusedBecause' in answer ? answer.refusedBecause : undefined
      const error = 'error' in answer ? answer.error : undefined
      await this.release(deviceId, state, burst)
      // D173: a sleeping battery camera is never re-dialled by us; the next
      // session re-arms. Everything else is a transient — try again next tick.
      const asleep = refusedBecause === 'battery-asleep'
      if (asleep && cadence) state.armed = false
      this.deps.logger.info('occupancy recheck: burst refused', {
        tags: { deviceId, nodeId },
        meta: {
          deviceId,
          nodeId,
          kind,
          refusedBecause: refusedBecause ?? null,
          error: error ?? null,
          rearmed: cadence && !asleep,
        },
      })
      if (cadence && !asleep) this.schedule(deviceId, state)
      return
    }
    this.deps.logger.info('occupancy recheck: burst dispatched', {
      tags: { deviceId, nodeId },
      meta: {
        deviceId,
        nodeId,
        frames,
        kind,
        recheckSec: state.lastConfig.occupancyRecheckSec ?? null,
      },
    })
    const window = setTimeout(() => {
      const settled = cadence
        ? this.settle(deviceId, state, burst)
        : this.settleEarlyLook(deviceId, state, burst)
      void settled.catch((err: unknown) => {
        this.deps.logger.warn('occupancy recheck: settle failed', {
          tags: { deviceId, nodeId },
          meta: { deviceId, nodeId, error: errMsg(err) },
        })
      })
    }, RECHECK_BURST_WINDOW_MS)
    window.unref?.()
  }

  private async settle(
    deviceId: number,
    state: DeviceRecheckState,
    burst: BurstInFlight,
  ): Promise<void> {
    await this.release(deviceId, state, burst)
    const fold = foldBurstOutcome({ emptyStreak: state.emptyStreak }, burst.found)
    state.emptyStreak = fold.emptyStreak
    state.armed = fold.armed
    this.deps.logger.info('occupancy recheck: burst complete', {
      tags: { deviceId, nodeId: burst.nodeId },
      meta: {
        deviceId,
        nodeId: burst.nodeId,
        found: burst.found,
        emptyStreak: fold.emptyStreak,
        armed: fold.armed,
        superseded: burst.superseded,
      },
    })
    if (state.armed && !this.deps.isSessionActive(deviceId)) this.schedule(deviceId, state)
    else if (state.armed) {
      // A session is running: its close re-arms from scratch.
      state.armed = false
    }
  }

  /** An early look's end: detach, and say what it saw. No streak, no re-arm. */
  private async settleEarlyLook(
    deviceId: number,
    state: DeviceRecheckState,
    burst: BurstInFlight,
  ): Promise<void> {
    await this.release(deviceId, state, burst)
    this.deps.logger.info('occupancy early look: burst complete', {
      tags: { deviceId, nodeId: burst.nodeId },
      meta: { deviceId, nodeId: burst.nodeId, found: burst.found, superseded: burst.superseded },
    })
  }

  /** Detach the recheck registration unless a session took it over. */
  private async release(
    deviceId: number,
    state: DeviceRecheckState,
    burst: BurstInFlight,
  ): Promise<void> {
    if (state.burst === burst) state.burst = null
    if (burst.superseded) return
    await this.deps.detachOn(burst.nodeId, deviceId).catch((err: unknown) => {
      this.deps.logger.warn('occupancy recheck: detach failed', {
        tags: { deviceId, nodeId: burst.nodeId },
        meta: { deviceId, nodeId: burst.nodeId, error: errMsg(err) },
      })
    })
  }
}
