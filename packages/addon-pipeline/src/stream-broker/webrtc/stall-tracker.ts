/**
 * stall-tracker — "is the media LANDING?", measured on the transport, not
 * guessed from a hint.
 *
 * ## Why this exists
 *
 * The ladder's only failure signal used to be packet LOSS: RTCP Receiver
 * Reports (`AdaptiveSession.onReceiverReport`) and the client's reported
 * `packetLossPercent`. On the live hub that signal is empty — 48 h of logs
 * carry 48 `webrtc loss` lines and every one of them says
 * `hasReceiverReport=false`, and `adaptive: scheduling renegotiation` does
 * not appear once. A ladder fed only by loss therefore never moves.
 *
 * Worse, it moves the WRONG WAY during a freeze. The client-loss path derives
 * loss as `Δlost / (Δlost + Δreceived)`, which is **0 when nothing arrives
 * at all** — there are no gaps in a sequence that received no packets. The
 * broker synthesizes a monotonic loss sample from that 0, so a completely
 * frozen stream hands `LossTracker` two in-window samples at 0 % loss:
 * `hasEvidence()` true, `isFailing()` false — "healthy". The ladder's reply
 * to a freeze was to CLIMB.
 *
 * So the question a freeze answers is not "how much was lost" but "did
 * anything arrive". `ClientNetworkStats.estimatedBandwidthKbps` — already
 * reported every 2 s by the player from `RTCPeerConnection.getStats()`
 * (`Δ bytesReceived / Δ timestamp` on the inbound video track) — is exactly
 * that measurement, and the broker was reading only `packetLossPercent` off
 * the same record and throwing it away.
 *
 * ## The rule
 *
 * A stall is declared only when the client reports a receive rate that
 * cannot carry any video WHILE the server is still putting RTP on the wire.
 * Both halves are load-bearing:
 *
 *  - without the server-side half, a paused camera, a battery source between
 *    wakes, or a session whose feed is legitimately idle reads as a stall and
 *    the ladder would walk itself to the floor for no reason;
 *  - without the client-side half there is no evidence at all — which is the
 *    state the ladder was in.
 *
 * An UNKNOWN rate is `null`, never `0` (D393). A client that has not reported
 * (an app in the background, a dropped telemetry mutation, a session younger
 * than the first 2 s window) has told us nothing, and nothing is not a stall;
 * a stale record is discarded on age rather than folded into "0 kbps".
 *
 * ## Judged on DELIVERY, not on an absolute floor (D635, 2026-09-25)
 *
 * The first version compared the client's last 2 s receive rate with absolute
 * floors (64 kbps stall, 128 kbps recover/climb). Those floors assumed the
 * smallest rung is "hundreds of kbps". Device 104's `low` rung is ~41 kbps
 * between IDRs with an IDR every ~4 s: its 2 s windows alternated above and
 * below 128, so the ladder could neither climb nor confirm a stall — it
 * "never moved" — and a rung steadily under 64 kbps with a long GOP would have
 * confirmed a stall on a perfect picture. The floors measured the rung's own
 * bitrate (demand), not whether the link carried it.
 *
 * The tracker now judges the RATIO of what the client received to what the
 * broker sent, over the same window of at least one GOP (`delivery-meter.ts`).
 * An IDR burst cannot mask a stall (the ratio is over bytes, not peaks), and a
 * quiet sub stream cannot be one (it lands whole).
 */

import type { DeliveryWindow } from './delivery-meter.js'

/** One evaluation's worth of transport truth. */
export interface StallSample {
  /**
   * Received vs sent over the delivery window (≥ one GOP) — `null` when
   * unknown. Unknown is NOT zero: too few client reports to cover a GOP, or a
   * stale newest one, means nobody looked. Judges partial delivery and climbs.
   */
  readonly delivery: DeliveryWindow | null
  /**
   * The newest single client report (2 s) against the same 2 s of sends —
   * `null` when unknown. A TOTAL freeze is unambiguous on one report, so a
   * stall may START here without waiting for a whole GOP of zeros (I3).
   */
  readonly recent: DeliveryWindow | null
  /**
   * More than one adaptive session of this device is on the broker: the
   * device-scoped client record may be ANOTHER viewer's (last writer wins), so
   * `delivery`/`recent` are unknown (null) and a try-climb is refused (I2).
   */
  readonly telemetryShared: boolean
  /**
   * Is the client reporting at all (a fresh report exists, even if too few to
   * cover a window)? Separates "not measured YET" — which refuses a climb —
   * from "no telemetry at all", which must behave as before this tracker.
   */
  readonly clientReporting: boolean
  /** Did the broker put RTP on the wire since the previous evaluation? */
  readonly serverSending: boolean
}

export interface StallTrackerConfig {
  /**
   * Below this delivery ratio the media is not landing at all. 0.25.
   *
   * A link that delivers a quarter of what is sent cannot show a moving
   * picture on any rung: three reference frames in four are gone. It is also
   * well clear of the ~10 % a window can be off when an IDR sits at its edge
   * (`delivery-meter.ts`, 100 ms buckets), so alignment noise cannot start a
   * stall on a healthy link.
   */
  readonly stallDeliveryRatio: number
  /**
   * Ratio that clears a stall. 0.5 — twice the stall ratio.
   *
   * A single threshold makes a link hovering at the boundary flip
   * stalled/healthy on alternate windows and the ladder oscillate with it.
   * The two thresholds are a Schmitt trigger; 2× is the smallest multiplier
   * that leaves a real dead band while still declaring recovery promptly.
   */
  readonly recoverDeliveryRatio: number
  /**
   * Below this ratio on the newest 2 s report the picture is FROZEN, and a
   * stall starts at once. 0.1 — "received ≈ 0": a healthy report that missed
   * an IDR sent in its last 50 ms (see `delivery-meter.ts`) still carries its
   * P-frames and reads ~0.25 on a sparse rung, never under 0.1.
   */
  readonly freezeDeliveryRatio: number
  /**
   * Fewest kbps SENT over the newest report for it to judge a freeze. 16
   * (32 kbit in 2 s ≈ 4 KB): the quietest rung this hub serves sends ~80 kbit
   * of P-frames per report; below 16 kbps the broker was all but idle and
   * "nothing arrived" means nothing was sent.
   */
  readonly freezeMinSentKbps: number
  /**
   * Ratio a climb requires. 0.9.
   *
   * Promoting spends bandwidth; the rung we are on must be landing (nearly)
   * whole first. 0.9 and not 1.0 because the two halves are summed over the
   * same sub-windows only to the 100 ms bucket, and a report stamped on
   * receipt at the hub trails the client's own window by the report latency.
   */
  readonly climbDeliveryRatio: number
  /**
   * How long the stall must persist before it counts.
   *
   * 6 000 ms = three consecutive evaluations at the controller's 2 s tick.
   * One bad window is routine (a getStats window that straddles a burst, a
   * moment of app backgrounding). Three in a row, with the server still
   * sending, is a freeze a person can see. It is also well inside
   * `LossTrackerConfig.analyzeWindowMs` (15 s), so a stall is caught long
   * before the loss window could have accumulated anything.
   */
  readonly stallConfirmMs: number
  /**
   * Blackout after a tier change. 8 000 ms, matching
   * `LossTrackerConfig.waitAfterResetMs`.
   *
   * A tier change is a close-and-recreate re-offer, so the new session
   * genuinely delivers ~0 kbps while ICE and DTLS re-establish. Measuring
   * through that would read every switch as a fresh stall and cascade
   * high→mid→low in three ticks.
   */
  readonly waitAfterChangeMs: number
}

/** What the tracker measured, for the log line that accompanies a switch. */
export interface StallEvidence {
  /** Client receive rate over the delivery window, kbps; null = unknown. */
  readonly clientKbps: number | null
  /** Broker send rate over the same window, kbps; null = unknown. */
  readonly sentKbps: number | null
  /** `clientKbps / sentKbps`; null when either is unknown or nothing was sent. */
  readonly deliveryRatio: number | null
  /** The window both were measured over, ms; null = unknown. */
  readonly deliveryWindowMs: number | null
  readonly stalledForMs: number
  readonly serverSending: boolean
}

/** What the broker knows when it builds one evaluation's sample. */
export interface StallSampleInput {
  readonly delivery: DeliveryWindow | null
  readonly recent: DeliveryWindow | null
  readonly clientReporting: boolean
  readonly serverSending: boolean
  /** Adaptive sessions of this device on this broker, this one included. */
  readonly adaptiveSessionsOnDevice: number
}

/**
 * The one place the device-scoped telemetry is judged ownable. With more than
 * one adaptive session of the device, the record may be another viewer's:
 * delivery is unknown ("no telemetry" semantics — the loss path judges) and
 * the sample says so, so the ladder refuses a try-climb on it.
 */
export function buildStallSample(input: StallSampleInput): StallSample {
  if (input.adaptiveSessionsOnDevice > 1) {
    return {
      delivery: null,
      recent: null,
      clientReporting: false,
      telemetryShared: true,
      serverSending: input.serverSending,
    }
  }
  return {
    delivery: input.delivery,
    recent: input.recent,
    clientReporting: input.clientReporting,
    telemetryShared: false,
    serverSending: input.serverSending,
  }
}

/** Why the transport forbids a promotion right now. */
export type ClimbRefusal = 'stall-building' | 'delivery'

/** The transport's verdict on a promotion. */
export type ClimbSafety =
  | { readonly safe: true }
  | { readonly safe: false; readonly reason: ClimbRefusal }

const UNKNOWN_EVIDENCE: StallEvidence = {
  clientKbps: null,
  sentKbps: null,
  deliveryRatio: null,
  deliveryWindowMs: null,
  stalledForMs: 0,
  serverSending: false,
}

function ratioOf(delivery: DeliveryWindow | null): number | null {
  if (delivery === null) return null
  const { receivedKbps, sentKbps } = delivery
  if (!Number.isFinite(receivedKbps) || !Number.isFinite(sentKbps) || sentKbps <= 0) return null
  return receivedKbps / sentKbps
}

/**
 * Windowed "the media stopped arriving" detector. Pure state machine: no
 * clock of its own, no side effects — `observe` is the only mutator and every
 * decision is a function of the samples it was given.
 */
export class StallTracker {
  /** When the current uninterrupted stall began; null when not stalling. */
  private stallStartedAt: number | null = null
  private blackoutUntil = 0
  private lastEvidence: StallEvidence = UNKNOWN_EVIDENCE
  private clientReporting = false
  private telemetryShared = false

  constructor(private readonly config: StallTrackerConfig) {}

  /** A tier change just happened — ignore the re-offer's own dead air. */
  markChanged(now: number): void {
    this.stallStartedAt = null
    this.blackoutUntil = now + this.config.waitAfterChangeMs
  }

  /**
   * Fold one evaluation into the window. Returns nothing; ask `isStalled`.
   *
   * Three outcomes, and the middle one is the reason this is not a simple
   * boolean: a ratio at or above `recoverDeliveryRatio` CLEARS the stall, a
   * ratio below `stallDeliveryRatio` with the server sending starts or extends
   * it, and anything between the two (or unknown, or nothing sent) HOLDS
   * whatever the window already believed.
   */
  observe(sample: StallSample, now: number): void {
    const ratio = ratioOf(sample.delivery)
    const measured = (stalledForMs: number): StallEvidence => ({
      clientKbps: sample.delivery?.receivedKbps ?? null,
      sentKbps: sample.delivery?.sentKbps ?? null,
      deliveryRatio: ratio,
      deliveryWindowMs: sample.delivery?.windowMs ?? null,
      stalledForMs,
      serverSending: sample.serverSending,
    })
    this.clientReporting = sample.clientReporting
    this.telemetryShared = sample.telemetryShared
    if (now < this.blackoutUntil) {
      this.stallStartedAt = null
      this.lastEvidence = measured(0)
      return
    }
    const recent =
      sample.recent !== null && sample.recent.sentKbps >= this.config.freezeMinSentKbps
        ? ratioOf(sample.recent)
        : null
    const frozen = recent !== null && recent < this.config.freezeDeliveryRatio
    const recovered = recent !== null && recent >= this.config.recoverDeliveryRatio
    // The GOP window judges PARTIAL delivery — unless the newest report shows
    // the picture back: after a freeze the window keeps its zeros for a few
    // ticks and would otherwise confirm a stall on a recovered link.
    const starved = ratio !== null && ratio < this.config.stallDeliveryRatio && !recovered
    // Recovery is judged on the NEWEST report when there is one: the GOP
    // window still holds the pre-freeze bytes for a few ticks and would clear
    // a freeze it has not caught up with.
    const current = recent ?? ratio
    if ((frozen || starved) && sample.serverSending) {
      this.stallStartedAt ??= now
    } else if (current !== null && current >= this.config.recoverDeliveryRatio) {
      this.stallStartedAt = null
    }
    // else: in the dead band, unknown, or the server is not sending — hold.
    this.lastEvidence = measured(this.stalledForMs(now))
  }

  private stalledForMs(now: number): number {
    return this.stallStartedAt === null ? 0 : now - this.stallStartedAt
  }

  /** True once the stall has persisted for `stallConfirmMs`. */
  isStalled(now: number): boolean {
    if (now < this.blackoutUntil) return false
    return this.stalledForMs(now) >= this.config.stallConfirmMs
  }

  /**
   * May the ladder PROMOTE on this evaluation, as far as the transport knows?
   *
   * No while a stall is building, and no while the rung we are on is not
   * landing (nearly) whole — promoting there spends bandwidth the session has
   * just been shown not to have, and the loss path cannot object: a stream
   * delivering almost nothing reports almost no loss.
   *
   * Unknown refuses only while the client IS reporting — the window is simply
   * not covered yet, and climbing then would promote a link measured at 10 %
   * a few seconds later. A deployment with no client telemetry at all must
   * behave exactly as it did before this tracker existed; the loss path's own
   * `hasEvidence` is the gate there.
   */
  climbSafety(now: number): ClimbSafety {
    if (now < this.blackoutUntil) return { safe: true }
    if (this.stallStartedAt !== null) return { safe: false, reason: 'stall-building' }
    const ratio = this.lastEvidence.deliveryRatio
    if (ratio === null)
      return this.clientReporting ? { safe: false, reason: 'delivery' } : { safe: true }
    return ratio >= this.config.climbDeliveryRatio
      ? { safe: true }
      : { safe: false, reason: 'delivery' }
  }

  /** Was the device's client record possibly another viewer's at the last evaluation? */
  get isTelemetryShared(): boolean {
    return this.telemetryShared
  }

  /** Was the client reporting at the last evaluation (even if not yet covering a window)? */
  get isClientReporting(): boolean {
    return this.clientReporting
  }

  /** What the last `observe` measured — for the switch's log line. */
  evidence(now: number): StallEvidence {
    return { ...this.lastEvidence, stalledForMs: this.stalledForMs(now) }
  }
}
