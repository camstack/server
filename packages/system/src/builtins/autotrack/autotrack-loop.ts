/**
 * `AutotrackLoop` — the thin wiring between a `frame-tracked` payload and the
 * pure decision function, plus the two measurements.
 *
 * Everything with a decision in it lives in `autotrack-decision.ts` /
 * `target-selection.ts` and is pure; this class owns the state those functions
 * are threaded through, the clock (injected), and the logging. It performs no
 * I/O itself — commands go out through {@link AutotrackCommands}, which the
 * addon fills with `ctx.api.ptz.*`.
 *
 * ## The silence watchdog is not optional
 *
 * The input is TELEMETRY and may be dropped (D8, D11). A subject does not
 * disappear because the bus did, so a target released only by "a frame said it
 * was gone" would be held forever the moment the stream stopped. {@link tick}
 * runs off the event path, applies the SAME disappear delay to the silence,
 * and releases + homes. It is also what makes the D49 shape work: the gate
 * ("am I tracking") is in-memory state refreshed off the event path, and a
 * failed mirror read never spells the subject's disappearance.
 */
import type { IScopedLogger, ObjectDetection } from '@camstack/types'
import type { AutotrackLoopConfig, PtzAxisStep } from './autotrack-config.js'
import {
  type AutotrackDecision,
  type AutotrackLoopState,
  decideAutotrack,
  INITIAL_AUTOTRACK_LOOP_STATE,
} from './autotrack-decision.js'
import { computeNormalizedError, type NormalizedError } from './frame-error.js'
import {
  INITIAL_LATENCY_TALLY,
  INITIAL_PRESENCE_TALLY,
  type LatencyTally,
  type PresenceTally,
  recordLatency,
  recordPresence,
  summarize,
} from './frame-measurements.js'
import {
  applyMirrorRefresh,
  INITIAL_PTZ_MIRROR,
  type MirrorRefreshOutcome,
  type PtzMirror,
} from './ptz-mirror.js'
import {
  INITIAL_TARGET_SELECTION_STATE,
  selectTarget,
  type TargetCandidate,
  type TargetSelectionState,
} from './target-selection.js'

export interface PulseCommand {
  readonly deviceId: number
  readonly pan: PtzAxisStep
  readonly tilt: PtzAxisStep
  readonly speed: number
}

/** The only way this loop touches the camera. One self-terminating pulse, or
 *  home. There is deliberately no `continuousMove` and no `stop`. */
export interface AutotrackCommands {
  pulse(command: PulseCommand): Promise<void>
  goHome(deviceId: number): Promise<void>
}

export interface AutotrackLoopDeps {
  readonly deviceId: number
  readonly targetClass: string
  readonly armed: boolean
  readonly config: AutotrackLoopConfig
  readonly logger: IScopedLogger
  readonly commands: AutotrackCommands
  readonly now: () => number
}

/** The subset of the `frame-tracked` payload this loop reads. Named so the
 *  tests can build one without the event envelope. */
export interface TrackedFrame {
  readonly deviceId: number
  readonly timestamp: number
  readonly frameWidth: number
  readonly frameHeight: number
  readonly detections: readonly ObjectDetection[]
}

/**
 * Candidates of the configured class on this frame.
 *
 * A detection counts only when it carries a `track` — `buildOverlayDetections`
 * attaches one exactly to the boxes a tracked entry was ASSOCIATED with on this
 * frame, so this set is the observed-and-tracked set and nothing else.
 */
export function candidatesFromFrame(
  detections: readonly ObjectDetection[],
  targetClass: string,
): readonly TargetCandidate[] {
  const out: TargetCandidate[] = []
  for (const det of detections) {
    if (det.kind !== 'first-level') continue
    if (det.macroClass !== targetClass) continue
    const trackId = det.track?.trackId
    if (trackId === undefined) continue
    out.push({ trackId, areaPx: Math.max(0, det.bbox.width) * Math.max(0, det.bbox.height) })
  }
  return out
}

export class AutotrackLoop {
  private selection: TargetSelectionState = INITIAL_TARGET_SELECTION_STATE
  private loopState: AutotrackLoopState = INITIAL_AUTOTRACK_LOOP_STATE
  private mirror: PtzMirror = INITIAL_PTZ_MIRROR
  private latency: LatencyTally = INITIAL_LATENCY_TALLY
  private presence: PresenceTally = INITIAL_PRESENCE_TALLY
  private lastFrameAtMs: number | null = null
  private lastSummaryAtMs: number | null = null

  constructor(private readonly deps: AutotrackLoopDeps) {}

  /** Read-only view of the mirror, for the addon's startup log. */
  get ptzMirror(): PtzMirror {
    return this.mirror
  }

  /** Fold one refresh outcome into the mirror. Called by the TIMER, never from
   *  {@link onFrame}. */
  applyMirror(outcome: MirrorRefreshOutcome): void {
    const nowMs = this.deps.now()
    this.mirror = applyMirrorRefresh(this.mirror, outcome, nowMs)
    if (outcome.kind === 'failed') {
      this.deps.logger.warn('autotrack mirror refresh failed', {
        tags: { deviceId: this.deps.deviceId },
        meta: {
          error: outcome.error,
          consecutiveFailures: this.mirror.consecutiveFailures,
          // Explicitly: the previous answers still stand. A failed read
          // changes no gate (D49).
          moveImpulseMs: this.mirror.moveImpulseMs,
          nativeAutotrack: this.mirror.nativeAutotrack,
        },
      })
      return
    }
    this.deps.logger.debug('autotrack mirror refreshed', {
      tags: { deviceId: this.deps.deviceId },
      meta: {
        moveImpulseMs: this.mirror.moveImpulseMs,
        nativeAutotrack: this.mirror.nativeAutotrack,
      },
    })
  }

  /** One analysed frame. Measures first, then decides. */
  async onFrame(frame: TrackedFrame): Promise<void> {
    if (frame.deviceId !== this.deps.deviceId) return
    const nowMs = this.deps.now()
    this.lastFrameAtMs = nowMs

    // ── Measurement 1: bus latency, hub-side, for this hop. ──────────────
    const busLatencyMs = nowMs - frame.timestamp
    this.latency = recordLatency(this.latency, busLatencyMs)

    const candidates = candidatesFromFrame(frame.detections, this.deps.targetClass)
    const selected = selectTarget(this.selection, {
      nowMs,
      candidates,
      disappearDelayMs: this.deps.config.disappearDelayMs,
    })
    this.selection = selected.state

    // ── Measurement 2: was the HELD track on this frame? ─────────────────
    // Counted only while a target is held: a frame with nothing held is not
    // evidence about absence.
    if (selected.trackId !== null) {
      this.presence = recordPresence(this.presence, selected.present)
    }

    let error: NormalizedError | null = null
    if (selected.present && selected.trackId !== null) {
      const det = frame.detections.find((d) => d.track?.trackId === selected.trackId)
      if (det !== undefined) {
        error = computeNormalizedError(det.bbox, {
          frameWidth: frame.frameWidth,
          frameHeight: frame.frameHeight,
        })
      }
    }

    const result = decideAutotrack(this.loopState, {
      nowMs,
      armed: this.deps.armed,
      target:
        selected.present && selected.trackId !== null ? { trackId: selected.trackId, error } : null,
      targetLastSeenAtMs: this.selection.lastSeenAtMs,
      moveImpulseMs: this.mirror.moveImpulseMs,
      nativeAutotrack: this.mirror.nativeAutotrack,
      config: this.deps.config,
    })
    this.loopState = result.state

    this.logDecision(result.decision, {
      busLatencyMs,
      candidates: candidates.length,
      trackId: selected.trackId,
      present: selected.present,
      selection: selected.reason,
      error,
      source: 'frame',
    })
    await this.dispatch(result.decision)
    this.maybeSummarize(nowMs)
  }

  /**
   * Off-event-path tick: the silence watchdog.
   *
   * Evaluates the SAME disappear delay against the time since the last frame.
   * A stream that died is a target that is gone, and the head goes home —
   * which is also the only thing that would otherwise never happen, because
   * every other release is driven by a frame arriving.
   */
  async tick(): Promise<void> {
    const nowMs = this.deps.now()
    const lastFrameAtMs = this.lastFrameAtMs
    if (lastFrameAtMs === null) return
    const silentForMs = nowMs - lastFrameAtMs
    if (silentForMs < this.deps.config.disappearDelayMs) return
    // Nothing held ⇒ nothing to release. Silence on an idle camera is not an
    // event, and re-deciding every tick would only produce noise.
    const heldTrackId = this.selection.trackId
    if (heldTrackId === null) return

    this.selection = INITIAL_TARGET_SELECTION_STATE
    const result = decideAutotrack(this.loopState, {
      nowMs,
      armed: this.deps.armed,
      target: null,
      // The last frame stands in for the last sighting: silence for longer
      // than the delay is treated exactly like an absence for longer than it.
      targetLastSeenAtMs: lastFrameAtMs,
      moveImpulseMs: this.mirror.moveImpulseMs,
      nativeAutotrack: this.mirror.nativeAutotrack,
      config: this.deps.config,
    })
    this.loopState = result.state
    this.deps.logger.warn('autotrack frame silence', {
      tags: { deviceId: this.deps.deviceId },
      meta: {
        silentForMs,
        disappearDelayMs: this.deps.config.disappearDelayMs,
        heldTrackId,
      },
    })
    this.logDecision(result.decision, {
      busLatencyMs: null,
      candidates: 0,
      trackId: heldTrackId,
      present: false,
      selection: 'silence-released',
      error: null,
      source: 'tick',
    })
    await this.dispatch(result.decision)
  }

  /** Emit the aggregates now, whatever the schedule says. Used at shutdown so
   *  a short run still reports what it measured. */
  logSummary(): void {
    // Spread rather than passed through: `MeasurementSummary` is an interface
    // and an interface has no implicit index signature, so `LogExtras.meta`
    // (a `Record<string, unknown>`) will not take it directly. Spreading is
    // the documented way to get there without a cast.
    const meta: Record<string, unknown> = { ...summarize(this.latency, this.presence) }
    this.deps.logger.info('autotrack measurements', {
      tags: { deviceId: this.deps.deviceId },
      meta,
    })
  }

  private maybeSummarize(nowMs: number): void {
    const last = this.lastSummaryAtMs
    if (last !== null && nowMs - last < this.deps.config.measurementSummaryMs) return
    this.lastSummaryAtMs = nowMs
    this.logSummary()
  }

  private async dispatch(decision: AutotrackDecision): Promise<void> {
    if (decision.action === 'hold') return
    try {
      if (decision.action === 'home') {
        await this.deps.commands.goHome(this.deps.deviceId)
        return
      }
      await this.deps.commands.pulse({
        deviceId: this.deps.deviceId,
        pan: decision.pan,
        tilt: decision.tilt,
        speed: decision.speed,
      })
    } catch (err) {
      // A command that did not land is a branch that ACCEPTED work and
      // produced nothing — it says so (D391). The head stopped by itself
      // either way, so nothing is retried here.
      this.deps.logger.warn('autotrack command failed', {
        tags: { deviceId: this.deps.deviceId },
        meta: {
          action: decision.action,
          error: err instanceof Error ? err.message : String(err),
        },
      })
    }
  }

  private logDecision(decision: AutotrackDecision, context: DecisionLogContext): void {
    const meta = {
      source: context.source,
      busLatencyMs: context.busLatencyMs,
      candidates: context.candidates,
      trackId: context.trackId,
      trackPresent: context.present,
      selection: context.selection,
      // `null` here means UNMEASURABLE, never centred (D393).
      errorX: context.error === null ? null : round3(context.error.x),
      errorY: context.error === null ? null : round3(context.error.y),
      action: decision.action,
      reason: decision.action === 'pulse' ? null : decision.reason,
      pan: decision.action === 'pulse' ? decision.pan : null,
      tilt: decision.action === 'pulse' ? decision.tilt : null,
      moveImpulseMs: this.mirror.moveImpulseMs,
      nativeAutotrack: this.mirror.nativeAutotrack,
    }
    // Every decision is logged, the decisions NOT to move included — a loop
    // that holds must not be indistinguishable from a dead one (D391). The
    // holds sit at debug because they are the per-frame normal case; anything
    // that actually moves the head is info.
    if (decision.action === 'hold') {
      this.deps.logger.debug('autotrack hold', { tags: { deviceId: this.deps.deviceId }, meta })
      return
    }
    this.deps.logger.info('autotrack command', { tags: { deviceId: this.deps.deviceId }, meta })
  }
}

interface DecisionLogContext {
  /** `null` on a tick: there was no frame to measure the age of. */
  readonly busLatencyMs: number | null
  readonly candidates: number
  readonly trackId: string | null
  readonly present: boolean
  readonly selection: string
  readonly error: NormalizedError | null
  readonly source: 'frame' | 'tick'
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000
}
