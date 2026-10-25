import { CAM_PROFILE_ORDER, type CamProfile, type WebrtcTryBlocker } from '@camstack/types'
import { LossTracker, type LossSample, type LossTrackerConfig } from './loss-tracker.js'
import {
  StallTracker,
  type StallEvidence,
  type StallSample,
  type StallTrackerConfig,
} from './stall-tracker.js'
import type { ClimbHold, ClimbHoldCode } from './climb-hold.js'
import { capacityBarKbps, judgeCapacity, type CapacityEvidence } from './climb-capacity.js'
import { RttWindow } from './rtt-stability.js'
import {
  NO_TRY_HISTORY,
  TrialWatch,
  tryBackoffMs,
  type TrialConfig,
  type TryClimbCarry,
} from './try-climb.js'

/** ABR tier == the broker profile tier. */
export type Tier = CamProfile
const TIER_ORDER: readonly Tier[] = CAM_PROFILE_ORDER

/**
 * Why the ladder moved, carried to the caller so the switch's log line can
 * name it and the numbers it rests on. `loss` is the historical RTCP /
 * client-loss path; `stall` is the measured "nothing is arriving" path;
 * `healthy` is a promotion; `trial-revert` is a tried rung that did not land
 * and was stepped back within its first window (D635).
 */
export type LadderCause = 'loss' | 'stall' | 'healthy' | 'trial-revert'

/** The measurement a decision rests on, for the log line. */
export interface LadderDecision {
  readonly cause: LadderCause
  /** Loss ratio over the tracker's window at the moment of the decision. */
  readonly lossRatio: number
  readonly stall: StallEvidence
  /** A promotion made WITHOUT capacity evidence — a try, reverted fast if it does not land. */
  readonly trial: boolean
}

/**
 * The cause as the wire (`WebrtcLadderDecision.cause`) can carry it. The wire
 * enum predates the try-climb, and widening it would make a server built
 * before it reject this broker's debug answer (the router validates output).
 * A trial revert is reported as what undelivered bytes are — `stall` when the
 * stall confirmed, else `loss` — and the climb hold carries the exact account
 * ("tried mid, reverted: delivery 0.60").
 */
export function wireLadderCause(decision: LadderDecision, stallConfirmMs: number): WireLadderCause {
  if (decision.cause !== 'trial-revert') return { cause: decision.cause }
  return {
    cause: decision.stall.stalledForMs >= stallConfirmMs ? 'stall' : 'loss',
    causeDetail: 'trial-revert',
  }
}

/** A cause as the wire carries it: the legacy enum, plus the finer name when there is one. */
export interface WireLadderCause {
  readonly cause: 'loss' | 'stall' | 'healthy'
  readonly causeDetail?: 'trial-revert'
}

/** Which clean-path condition refused a try. */
export type TryBlocker = WebrtcTryBlocker

/** What a hold may add beyond the measurements every hold carries. */
interface HoldExtra {
  readonly trialForMs?: number
  readonly tryBlockedBy?: TryBlocker
}

export interface AdaptiveControllerConfig
  extends LossTrackerConfig,
    StallTrackerConfig,
    TrialConfig {
  /** Healthy time required for the first promotion attempt. */
  readonly upgradeHealthyMs: number
  /** Multiplier applied after each successful promotion in this viewer session. */
  readonly upgradeHealthyGrowthFactor: number
  /** Ceiling for the progressive healthy-time ramp (failure backoff may exceed it). */
  readonly maxProgressiveUpgradeHealthyMs: number
  readonly minTimeBetweenChangesMs: number
  /**
   * Ceiling on the exponential re-attempt backoff applied to a tier that has
   * already failed in this session (see {@link AdaptiveControllerOptions.priorFailures}).
   */
  readonly maxUpgradeBackoffMs: number
  /**
   * How far the receiver's bandwidth estimate must exceed the next rung's
   * bitrate before a climb. 1.2 — a rung's measured average hides its IDR
   * bursts, and a link with exactly the average in hand stutters on every
   * keyframe; 20 % is the same headroom the client probe's thresholds carry
   * against the rung bitrates they map to (`adaptive-downlink.ts`).
   */
  readonly climbCapacityMargin: number
  /**
   * Delivery ratio a TRY needs (no capacity evidence). 0.95 — stricter than
   * the 0.9 an evidenced climb needs, because nothing else vouches for room.
   */
  readonly tryClimbDeliveryRatio: number
  /** Loss ratio a try must stay under. 0.01 — a fifth of the 5 % failing bar. */
  readonly tryClimbMaxLossRatio: number
  /** First backoff after a failed try. 30 000 ms, doubling per consecutive failure. */
  readonly tryBackoffBaseMs: number
  /** Backoff ceiling. 600 000 ms — a link that keeps failing is retried every 10 min. */
  readonly tryBackoffMaxMs: number
}

export interface AdaptiveControllerOptions {
  readonly initialTier: Tier
  readonly config: AdaptiveControllerConfig
  /**
   * Per-tier count of MEASURED downgrades this viewer's session has already
   * suffered, carried across the close-and-recreate re-offer that a tier
   * switch performs.
   *
   * Why it must be carried: a tier switch tears the session (and therefore
   * this controller) down and builds a new one. Without this, the rebuilt
   * controller had no memory that the rung above had JUST been measured
   * unusable, and re-attempted it on the plain hysteresis — so a link that
   * cannot carry `high` oscillated climb → stutter → downgrade → climb for
   * the whole session.
   */
  readonly priorFailures?: ReadonlyMap<Tier, number>
  /** Successful promotions inherited across close-and-recreate re-offers. */
  readonly priorUpgradeCount?: number
  /**
   * The rung's expected bitrate, kbps, from the broker's own measurement of
   * that rung — `null` when unknown (an idle rung has measured nothing). The
   * capacity gate compares the receiver's estimate against it; unknown never
   * vetoes a climb.
   */
  readonly expectedTierKbps?: (tier: Tier) => number | null
  /**
   * Try-climb memory from the previous controller of this viewer session —
   * whether this rung is a trial (and from where), and the backoff after a
   * failed try. See `try-climb.ts`.
   */
  readonly tryClimb?: TryClimbCarry
  readonly onSwitchTier: (tier: Tier, decision: LadderDecision) => void
  readonly onReduceMtu: (decision: LadderDecision) => void
  readonly onTranscodeDown: (decision: LadderDecision) => void
}

function positiveOrNull(v: number | null): number | null {
  return v !== null && Number.isFinite(v) && v > 0 ? v : null
}

/**
 * Ladder state machine for an adaptive WebRTC session. Fed loss samples
 * (RTCP RR or client-reported) via `onLoss`; `tick` evaluates the ladder.
 * Downgrade order: tier high→mid→low, then MTU reduction at low, then
 * transcode-down. Side effects run through injected callbacks (testable
 * without werift).
 *
 * An UPGRADE requires all three of:
 *  1. the session clock — measured from the FIRST tick, not from the unix
 *     epoch — showing `upgradeHealthyMs` without a failing verdict;
 *  2. actual receiver feedback in the window (`LossTracker.hasEvidence`) —
 *     a session that has produced no RTCP at all is not "healthy", it is
 *     silent, and climbing on silence spends bandwidth never shown to exist;
 *  3. the target tier's re-attempt backoff, which doubles per measured
 *     failure of that tier in this session;
 *  4. the transport showing the CURRENT rung landing whole
 *     (`StallTracker.climbSafety`, a delivery ratio over one GOP — D635);
 *  5. capacity: evidence (REMB or the viewer's probe) clearing the next
 *     rung's bar confirms the climb; a MEASURED probe below it holds; with no
 *     evidence either way the ladder TRIES the rung on a clean path (delivery
 *     ≥ 0.95, loss < 1 %, RTT stable) and reverts within the rung's first
 *     window if it does not land, backing off 30 s → 10 min (D635, round 2).
 *
 * Every tick that does not promote leaves a {@link ClimbHold} naming why.
 */
export class AdaptiveController {
  private readonly tracker: LossTracker
  private readonly stalls: StallTracker
  private tier: Tier
  private mtuReduced = false
  private transcodeEngaged = false
  private lastChangeAt = 0
  private healthySince = 0
  /**
   * Whether the session clock has been armed by the first evaluation. The
   * clock is `Date.now()`, so leaving `healthySince` / `lastChangeAt` at 0
   * would read as "healthy since 1970" and hand out a free upgrade on the
   * very first tick, before a single loss sample had been seen. A boolean
   * (not a `startedAt === 0` sentinel) because 0 is a legitimate clock value.
   */
  private armed = false
  private readonly failures: Map<Tier, number>
  private upgradeCount: number
  private capacity: CapacityEvidence = { rembKbps: null, probeKbps: null, probeFresh: false }
  private readonly rtt = new RttWindow()
  private tryCarry: TryClimbCarry
  /** Non-null while the current rung is a trial. */
  private trial: TrialWatch | null
  private hold: ClimbHold | null = null

  constructor(private readonly opts: AdaptiveControllerOptions) {
    this.tracker = new LossTracker(opts.config)
    this.stalls = new StallTracker(opts.config)
    this.tier = opts.initialTier
    this.failures = new Map(opts.priorFailures ?? [])
    this.upgradeCount = Math.max(0, opts.priorUpgradeCount ?? 0)
    const carried = opts.tryClimb ?? NO_TRY_HISTORY
    // A re-offer can land back on the rung it came from (the wanted rung was
    // unavailable, `prefers-tier-fallback`): that is not a trial, and
    // "reverting" it would re-offer the same rung (review m13).
    this.tryCarry =
      carried.trialFrom === opts.initialTier ? { ...carried, trialFrom: null } : carried
    this.trial =
      this.tryCarry.trialFrom !== null ? new TrialWatch(this.tryCarry.trialFrom, opts.config) : null
  }

  /** What the NEXT controller of this viewer session must inherit about tries. */
  get tryClimbCarry(): TryClimbCarry {
    return this.tryCarry
  }

  get currentTier(): Tier {
    return this.tier
  }

  /**
   * Per-tier measured-failure counts, INCLUDING those inherited from earlier
   * rungs of the same viewer session. The server snapshots this into the
   * adaptive intent so the session's next controller inherits it.
   */
  get failureCounts(): ReadonlyMap<Tier, number> {
    return this.failures
  }

  get successfulUpgradeCount(): number {
    return this.upgradeCount
  }

  onLoss(sample: LossSample, now: number): void {
    this.tracker.track(sample, now)
  }

  /**
   * Fold one TRANSPORT measurement into the ladder — what the client actually
   * received, and whether the broker was sending at the time.
   *
   * This is the half the ladder was missing. Packet loss cannot see a freeze
   * (a stream delivering nothing reports 0 % loss, because there are no gaps
   * in a sequence that received no packets), and the client's downlink hint
   * cannot see one either — it is a one-shot HTTP burst measured at connect
   * time, on a path the media does not take. See `stall-tracker.ts`.
   */
  onThroughput(sample: StallSample, now: number): void {
    this.stalls.observe(sample, now)
  }

  /**
   * The capacity witnesses, kbps — `null` when unknown: the receiver's REMB
   * (capped by what is sent, so evidence only FOR room) and the viewer's
   * downlink probe for this session (a path measurement, evidence both ways).
   * See `climb-capacity.ts`.
   */
  onCapacity(evidence: CapacityEvidence): void {
    this.capacity = {
      rembKbps: positiveOrNull(evidence.rembKbps),
      probeKbps: positiveOrNull(evidence.probeKbps),
      probeFresh: evidence.probeFresh,
    }
  }

  /** The client's round-trip time, ms; null/0 = unknown. One of a try's conditions. */
  onRtt(rttMs: number | null, now: number): void {
    this.rtt.observe(rttMs, now)
  }

  /**
   * The session now serves `tier`, decided OUTSIDE this ladder's own tick
   * (D733): the viewer's downlink probe placed it there, or the rung the ladder
   * asked for is not served and the switch landed on the one that is.
   *
   * Before D733 both were a close-and-recreate re-offer, which built a NEW
   * controller on the rung the session landed on. The ladder ends up where that
   * new controller started: on `tier`, not on trial (a probe IS capacity
   * evidence; a fallback rung was not tried), with its healthy clock and change
   * blackout starting now, and with no promotion counted. The measured-failure
   * memory is kept: a rung this session already proved unusable stays backed off.
   */
  settleOn(tier: Tier, now: number): void {
    this.armed = true
    this.hold = null
    this.tier = tier
    this.mtuReduced = false
    this.transcodeEngaged = false
    this.trial = null
    this.tryCarry = { ...this.tryCarry, trialFrom: null }
    this.commitChange(now)
    this.healthySince = now
  }

  /** Why the ladder did not climb on the last evaluation; null = at the top, or it just moved. */
  get climbHold(): ClimbHold | null {
    return this.hold
  }

  /**
   * Freeze the ladder for this evaluation instead of ticking it.
   *
   * Called while the session's track is NOT carrying the live source — D42
   * put recorded playback and scrub on the same track with a moving source
   * pointer, and in those modes the live feed is gated, so receiver feedback
   * measures the recorded feeder, not the camera tier. Acting on it is
   * incoherent in both directions: a downgrade cannot shrink a file, an
   * upgrade cannot enlarge one, and EITHER destroys the feeder (a tier switch
   * is a close-and-recreate re-offer) — dropping the viewer back to live at
   * the wrong moment with nothing to restore the pointer.
   *
   * Holds the climb clock so time spent in recorded modes can never
   * accumulate into an upgrade on the return to live.
   */
  suspend(now: number): void {
    if (!this.armed) {
      this.armed = true
      this.lastChangeAt = now
    }
    this.healthySince = now
    this.trial?.restart()
    this.setHold('suspended', now)
    // Recorded/scrub modes gate the live feed, so the client's receive rate
    // measures the FEEDER, not the camera tier — a paused scrub reads exactly
    // like a frozen stream. Blank the window and hold it blanked for the
    // blackout past the return to live.
    this.stalls.markChanged(now)
  }

  tick(now: number): void {
    if (!this.armed) {
      this.armed = true
      this.healthySince = now
      this.lastChangeAt = now
    }
    // A tried rung is judged first, and only on whether it LANDS: its own
    // stall or loss reverts it to the rung it came from, not one further down.
    if (this.trial !== null && this.judgeTrial(now)) return
    // A measured stall outranks loss and outranks the client's hint: it is
    // the only signal that answers "is the picture moving". It is checked
    // FIRST because during a freeze the loss path reads healthy (0 % loss on
    // a stream receiving nothing) and would otherwise promote.
    if (this.stalls.isStalled(now)) {
      this.healthySince = now
      this.hold = null
      this.handleFailing(now, 'stall')
      return
    }
    if (this.tracker.isFailing(now)) {
      this.healthySince = now
      this.hold = null
      this.handleFailing(now, 'loss')
      return
    }
    const safety = this.stalls.climbSafety(now)
    if (!safety.safe) {
      // A stall building, or the current rung not landing whole. Not enough
      // to downgrade; more than enough to refuse a promotion.
      this.healthySince = now
      this.setHold(safety.reason, now)
      return
    }
    if (!this.tracker.hasEvidence(now)) {
      // No receiver feedback in the window — neither healthy nor failing.
      // Hold the climb clock so silence can never accumulate into an upgrade.
      this.healthySince = now
      this.setHold('no-evidence', now)
      return
    }
    this.handleHealthy(now)
  }

  private nextTier(): Tier | null {
    const idx = TIER_ORDER.indexOf(this.tier)
    return idx <= 0 ? null : (TIER_ORDER[idx - 1] ?? null)
  }

  /**
   * Record why this evaluation did not climb. At the top rung there is nothing
   * to hold — except a `trial`, which names the rung being tried.
   */
  private setHold(code: ClimbHoldCode, now: number, extra: HoldExtra = {}): void {
    const next = code === 'trial' ? this.tier : this.nextTier()
    if (next === null) {
      this.hold = null
      return
    }
    const ev = this.stalls.evidence(now)
    const clockRunning =
      code === 'warming' ||
      code === 'cooldown' ||
      code === 'capacity' ||
      code === 'try-unclean' ||
      code === 'try-backoff'
    const nextTierKbps = this.opts.expectedTierKbps?.(next) ?? null
    this.hold = {
      code,
      nextTier: next,
      deliveryRatio: ev.deliveryRatio,
      deliveryWindowMs: ev.deliveryWindowMs,
      climbDeliveryRatio: this.opts.config.climbDeliveryRatio,
      capacityKbps: this.capacity.rembKbps,
      probeKbps: this.capacity.probeKbps,
      nextTierKbps,
      capacityMargin: this.opts.config.climbCapacityMargin,
      neededKbps: capacityBarKbps(next, nextTierKbps, this.opts.config.climbCapacityMargin),
      tryBlockedBy: extra.tryBlockedBy ?? null,
      tryDeliveryRatio: this.opts.config.tryClimbDeliveryRatio,
      tryMaxLossRatio: this.opts.config.tryClimbMaxLossRatio,
      retryInMs: code === 'try-backoff' ? Math.max(0, this.tryCarry.notBefore - now) : null,
      lastRevert: this.tryCarry.lastRevert,
      trialForMs: code === 'trial' ? (extra.trialForMs ?? 0) : null,
      trialMs: code === 'trial' ? this.opts.config.trialMs : null,
      healthyForMs: clockRunning ? now - this.healthySince : null,
      requiredHealthyMs: this.requiredHealthyMs(next),
      since: this.hold?.code === code ? this.hold.since : now,
    }
  }

  /**
   * Judge the rung on trial. Returns true when this evaluation is consumed
   * (still running, or reverted); false when the trial was just kept and the
   * ordinary ladder takes over.
   */
  private judgeTrial(now: number): boolean {
    const watch = this.trial
    if (watch === null) return false
    const verdict = watch.judge(now, {
      deliveryRatio: this.stalls.evidence(now).deliveryRatio,
      clientReporting: this.stalls.isClientReporting,
      stalled: this.stalls.isStalled(now),
      lossFailing: this.tracker.isFailing(now),
    })
    if (verdict.kind === 'running') {
      // No climb from a rung still on trial: the next streak starts once it is kept.
      this.healthySince = now
      this.setHold('trial', now, { trialForMs: verdict.forMs })
      return true
    }
    this.trial = null
    if (verdict.kind === 'kept') {
      this.tryCarry = NO_TRY_HISTORY
      this.healthySince = now
      return false
    }
    const failures = this.tryCarry.failures + 1
    const tried = this.tier
    this.tryCarry = {
      failures,
      notBefore:
        now +
        tryBackoffMs(failures, this.opts.config.tryBackoffBaseMs, this.opts.config.tryBackoffMaxMs),
      lastRevert: {
        tier: tried,
        deliveryRatio: verdict.deliveryRatio,
        stalled: verdict.stalled,
        at: now,
      },
      trialFrom: null,
    }
    this.hold = null
    this.tier = watch.from
    this.mtuReduced = false
    this.transcodeEngaged = false
    this.opts.onSwitchTier(watch.from, this.decisionAt(now, 'trial-revert'))
    this.commitChange(now)
    this.healthySince = now
    return true
  }

  /**
   * Which clean-path condition refuses a TRY, or null when the path is clean.
   * A client that sends no telemetry at all cannot measure delivery; there the
   * loss path is the judge, as it was before delivery existed.
   */
  private tryBlocker(now: number): TryBlocker | null {
    // The device record may be another viewer's: nothing here is this
    // session's own evidence of a clean path (review I2).
    if (this.stalls.isTelemetryShared) return 'shared-telemetry'
    const ratio = this.stalls.evidence(now).deliveryRatio
    if (
      ratio === null
        ? this.stalls.isClientReporting
        : ratio < this.opts.config.tryClimbDeliveryRatio
    ) {
      return 'delivery'
    }
    if (this.tracker.lossRatio() >= this.opts.config.tryClimbMaxLossRatio) return 'loss'
    if (this.rtt.stability(now) === 'unstable') return 'rtt'
    return null
  }

  private canUpgrade(now: number): boolean {
    return now - this.lastChangeAt >= this.opts.config.minTimeBetweenChangesMs
  }

  /**
   * How long the link must read healthy before `tier` may be re-attempted.
   * Doubles per measured failure of that tier in this session, capped at
   * `maxUpgradeBackoffMs`.
   */
  private requiredHealthyMs(tier: Tier): number {
    const failures = this.failures.get(tier) ?? 0
    const progressiveMs = Math.min(
      this.opts.config.upgradeHealthyMs *
        this.opts.config.upgradeHealthyGrowthFactor ** this.upgradeCount,
      this.opts.config.maxProgressiveUpgradeHealthyMs,
    )
    if (failures <= 0) return progressiveMs
    return Math.min(progressiveMs * 2 ** failures, this.opts.config.maxUpgradeBackoffMs)
  }

  private commitChange(now: number): void {
    this.lastChangeAt = now
    this.tracker.markChanged(now)
    this.stalls.markChanged(now)
  }

  /** The measurement this decision rests on, snapshotted for the log line. */
  private decisionAt(now: number, cause: LadderCause, trial = false): LadderDecision {
    return {
      cause,
      lossRatio: this.tracker.lossRatio(),
      stall: this.stalls.evidence(now),
      trial,
    }
  }

  private handleFailing(now: number, cause: LadderCause): void {
    const decision = this.decisionAt(now, cause)
    const idx = TIER_ORDER.indexOf(this.tier)
    if (idx < TIER_ORDER.length - 1) {
      const failed = this.tier
      this.failures.set(failed, (this.failures.get(failed) ?? 0) + 1)
      this.tier = TIER_ORDER[idx + 1]!
      this.opts.onSwitchTier(this.tier, decision)
      this.commitChange(now)
      return
    }
    // at lowest tier
    if (!this.mtuReduced) {
      this.mtuReduced = true
      this.opts.onReduceMtu(decision)
      this.commitChange(now)
      return
    }
    if (!this.transcodeEngaged) {
      this.transcodeEngaged = true
      this.opts.onTranscodeDown(decision)
      this.commitChange(now)
    }
  }

  private handleHealthy(now: number): void {
    const next = this.nextTier()
    if (next === null) {
      this.hold = null
      return
    }
    // Capacity holds do not reset the healthy clock: missing room is not an
    // unhealthy link, and the streak must be ready the moment room appears.
    const capacity = judgeCapacity(
      this.capacity,
      next,
      this.opts.expectedTierKbps?.(next) ?? null,
      this.opts.config.climbCapacityMargin,
    )
    if (capacity.kind === 'probe-short') {
      this.setHold('capacity', now)
      return
    }
    if (capacity.kind === 'none' && now < this.tryCarry.notBefore) {
      this.setHold('try-backoff', now)
      return
    }
    if (now - this.healthySince < this.requiredHealthyMs(next)) {
      this.setHold('warming', now)
      return
    }
    if (!this.canUpgrade(now)) {
      this.setHold('cooldown', now)
      return
    }
    if (capacity.kind === 'sufficient') {
      this.promote(now, next, false)
      return
    }
    const blocker = this.tryBlocker(now)
    if (blocker !== null) {
      this.setHold('try-unclean', now, { tryBlockedBy: blocker })
      return
    }
    this.promote(now, next, true)
  }

  private promote(now: number, next: Tier, trial: boolean): void {
    const from = this.tier
    this.hold = null
    this.tier = next
    this.mtuReduced = false
    this.transcodeEngaged = false
    this.upgradeCount += 1
    this.tryCarry = { ...this.tryCarry, trialFrom: trial ? from : null }
    this.trial = trial ? new TrialWatch(from, this.opts.config) : null
    this.opts.onSwitchTier(next, this.decisionAt(now, 'healthy', trial))
    this.commitChange(now)
    this.healthySince = now
  }
}
