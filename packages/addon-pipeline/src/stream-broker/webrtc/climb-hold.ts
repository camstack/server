/**
 * Why the adaptive ladder is NOT climbing right now (D635).
 *
 * Before this, "held for a reason" and "no ladder at all" looked identical:
 * the controller recorded only the moves it MADE, so a session held on `low`
 * for its whole life showed "never moved" — on device 104 for 70 s of a
 * perfect LAN link. A hold is now a first-class value: the controller sets it
 * on every tick that does not promote, the broker logs it on CHANGE, and the
 * session debug carries it to the viewer's "Quality ladder" line.
 */
import type { WebrtcClimbHold, WebrtcClimbHoldCode, WebrtcTryBlocker } from '@camstack/types'

/**
 * - `stall-building` — the client is receiving ≪ what is sent; not yet a stall.
 * - `delivery` — the rung we are on is not landing whole.
 * - `no-evidence` — no receiver feedback in the loss window: silence is not health.
 * - `warming` — healthy, and accumulating the streak the next rung needs.
 * - `cooldown` — too soon after the last change.
 * - `capacity` — a MEASURED probe is below the next rung's bar.
 * - `try-unclean` — no capacity evidence, and the path is not clean enough to try.
 * - `try-backoff` — a try reverted; waiting out its exponential backoff.
 * - `trial` — this rung IS a try; it reverts if it does not land.
 * - `suspended` — the track carries recorded playback; the ladder is frozen.
 */
export type ClimbHoldCode = WebrtcClimbHoldCode

/**
 * The controller's hold: the wire shape without the rendered `summary`, with
 * `code` and `tryBlockedBy` typed to what THIS build emits (the wire carries
 * them as open strings — see `WEBRTC_CLIMB_HOLD_CODES`).
 */
export type ClimbHold = Omit<
  WebrtcClimbHold,
  'summary' | 'code' | 'tryBlockedBy' | 'tryDeliveryRatio' | 'tryMaxLossRatio'
> & {
  readonly code: ClimbHoldCode
  readonly tryBlockedBy: WebrtcTryBlocker | null
  /** Optional on the wire; this build always knows its own thresholds. */
  readonly tryDeliveryRatio: number
  readonly tryMaxLossRatio: number
}

/** The wire shape: the hold plus the line the broker logs. */
export function toWireClimbHold(h: ClimbHold): WebrtcClimbHold {
  return { ...h, summary: describeClimbHold(h) }
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`
}

/** A rate, or "unknown" — never a fabricated 0 kbps (D393). */
function kbps(v: number | null): string {
  return v === null ? 'unknown' : `${String(Math.round(v))} kbps`
}

function deliveryPart(h: ClimbHold): string | null {
  if (h.deliveryRatio === null || h.deliveryWindowMs === null) return null
  return `delivery ${h.deliveryRatio.toFixed(2)} over ${seconds(h.deliveryWindowMs)}`
}

/** `mid needs 2160 kbps (1800 × 1.2)`, or `(client threshold)` for an unmeasured rung. */
function barPart(h: ClimbHold): string {
  const basis =
    h.nextTierKbps !== null && h.nextTierKbps > 0
      ? `(${String(Math.round(h.nextTierKbps))} × ${String(h.capacityMargin)})`
      : '(client threshold)'
  return `${h.nextTier} needs ${kbps(h.neededKbps)} ${basis}`
}

function witnesses(h: ClimbHold): string {
  const remb = h.capacityKbps === null ? 'no REMB' : `REMB ${kbps(h.capacityKbps)}`
  const probe = h.probeKbps === null ? 'no probe' : `probe ${kbps(h.probeKbps)}`
  return `${remb}, ${probe}`
}

function blockerPart(h: ClimbHold): string {
  switch (h.tryBlockedBy) {
    case 'delivery':
      return h.deliveryRatio === null
        ? 'delivery not measured'
        : `delivery ${h.deliveryRatio.toFixed(2)} < ${h.tryDeliveryRatio.toFixed(2)}`
    case 'loss':
      return `loss ≥ ${String(Math.round(h.tryMaxLossRatio * 1000) / 10)}%`
    case 'rtt':
      return 'RTT unstable'
    case 'shared-telemetry':
      return "another viewer shares this camera's telemetry"
    case null:
      return 'unknown'
  }
}

function revertPart(h: ClimbHold): string {
  const r = h.lastRevert
  if (r === null) return 'a try reverted'
  const why = r.stalled
    ? 'stall'
    : r.deliveryRatio === null
      ? 'loss'
      : `delivery ${r.deliveryRatio.toFixed(2)}`
  return `tried ${r.tier}, reverted: ${why}`
}

/**
 * One line, English, numbers included — the same text the broker logs and the
 * viewer shows under its localized hold label. Every number is one the
 * controller actually used; an unknown one is said to be unknown.
 */
export function describeClimbHold(h: ClimbHold): string {
  const delivery = deliveryPart(h)
  switch (h.code) {
    case 'stall-building':
      return `held: stall building (${delivery ?? 'delivery unknown'})`
    case 'delivery':
      return delivery === null
        ? 'held: delivery not yet measured over one GOP'
        : `held: ${delivery} < ${h.climbDeliveryRatio.toFixed(2)}`
    case 'no-evidence':
      return 'held: no receiver feedback in the loss window'
    case 'warming':
      return `climbing: healthy ${seconds(h.healthyForMs ?? 0)} of ${seconds(h.requiredHealthyMs ?? 0)} before ${h.nextTier}`
    case 'cooldown':
      return 'held: too soon after the last change'
    case 'capacity':
      return `held: probe ${kbps(h.probeKbps)}, ${h.capacityKbps === null ? 'no REMB' : `REMB ${kbps(h.capacityKbps)}`} < ${barPart(h)}`
    case 'try-unclean':
      return `held: no capacity evidence for ${h.nextTier} (${witnesses(h)}); not clean enough to try: ${blockerPart(h)}`
    case 'try-backoff':
      return `held: ${revertPart(h)}; next try in ${seconds(h.retryInMs ?? 0)}`
    case 'trial':
      return `trying ${h.nextTier}: ${seconds(h.trialForMs ?? 0)} of ${seconds(h.trialMs ?? 0)} (reverts if it does not land)`
    case 'suspended':
      return 'held: recorded playback on the track (ladder suspended)'
  }
}

/**
 * Which hold changes deserve a log line (review m3). A code logs when it
 * differs from the last one logged AND has not itself been logged within
 * `quietMs` — a link hovering at 0.90–0.95 delivery cycles delivery →
 * warming → try-unclean and used to write a line every 4–8 s for ever.
 * Progress (`warming`, `trial`) never logs; the switch line covers moves.
 */
export class HoldLogGate {
  private last: ClimbHoldCode | null = null
  private readonly loggedAt = new Map<ClimbHoldCode, number>()

  constructor(private readonly quietMs: number) {}

  shouldLog(code: ClimbHoldCode, now: number): boolean {
    if (code === 'warming' || code === 'trial') return false
    if (code === this.last) return false
    const at = this.loggedAt.get(code)
    if (at !== undefined && now - at < this.quietMs) return false
    this.last = code
    this.loggedAt.set(code, now)
    return true
  }
}
