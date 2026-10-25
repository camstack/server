/**
 * PRE-ROLL MECHANICS — how a window of retained history is CUT, BUDGETED and
 * BOUNDED. Not how wide it is: that is the prebuffer's, and the prebuffer's
 * alone (`prebuffer.ts`, D381).
 *
 * WHAT LIVES HERE. Three mechanisms, none of them a setting:
 *
 * - {@link selectPreRollStart} — which retained keyframe access unit a burst
 *   starts at. Keyframe-aligned because D57's "the whole GOP or none of it" is
 *   the reason this selects among marks rather than slicing by time.
 * - {@link preRollBudgetBytes} — what a window of a given width WEIGHS on a
 *   stream of a measured bitrate, and the ring ceiling it has to fit inside.
 * - {@link preRollSpanBound} / {@link preRollPacketCeiling} — D57's join bound,
 *   widened for the one session that asked for history, with the packet ceiling
 *   scaled by the same factor so the defensive backstop stays a RATE.
 *
 * WHAT USED TO LIVE HERE AND DOES NOT. `resolvePreRollMs`,
 * `resolveRecordingPreRollMs`, `DEFAULT_PRE_ROLL_MS`,
 * `DEFAULT_RECORDING_PRE_ROLL_MS` and their two ceilings — a whole
 * CONFIGURATION layer, two windows deep, that decided how much history each
 * kind of consumer got. It is gone: the prebuffer decides, once, and a consumer
 * asks for what it holds. The mechanics below are unchanged, because the
 * failures they encode (an unpaced burst, a flat byte cap, a silently truncated
 * window) are about cutting history, not about choosing how much to keep.
 *
 * WHAT IT STILL CANNOT DO. Spending history is not creating it. A source that
 * was idle when motion fired has none, the selection falls back to the current
 * GOP, and the honest outcome is the ordinary join burst.
 */
import { PREBUFFER_MAX_MS } from './prebuffer.js'
import type { PrimeBurstBound } from './rtsp/rtsp-restreamer.js'

/**
 * One retained keyframe access unit, as the caller's window sees it.
 *
 * `ageMs` is MEDIA time back from the newest retained packet — the 90 kHz RTP
 * clock for the source-RTP ring, `EncodedPacket.pts` for the decoder-seed ring.
 * Wall clock is deliberately not used: every bound this composes with (D57's
 * span, the live-edge rule) is measured in media time, and a burst's cost to
 * its consumer is the media it carries, not how long ago it arrived.
 */
export interface PreRollMark {
  /** Index of the AU's FIRST packet within the retained window. */
  readonly index: number
  /** Media-time age (ms) of that packet, relative to the newest retained one. */
  readonly ageMs: number
}

/** Where a pre-roll burst starts, and how far back that reached. */
export interface PreRollSelection {
  /** Index the window starts at; `-1` when no keyframe is retained at all. */
  readonly startIndex: number
  /** Media-time age (ms) of the first delivered packet — the REALIZED pre-roll. */
  readonly ageMs: number
  /** Keyframe AUs before the newest one. `0` = the current GOP (today). */
  readonly gopsBack: number
}

const NOTHING: PreRollSelection = { startIndex: -1, ageMs: 0, gopsBack: 0 }

/**
 * Clamp a window ALREADY resolved by the prebuffer to something this module can
 * cut.
 *
 * One clamp for every mechanism below — the selection, the packet ceiling and
 * the span bound — so a caller cannot get a wider window out of one of them
 * than out of the others. {@link PREBUFFER_MAX_MS} is the ceiling because the
 * prebuffer is the only thing that sets a window now; it was
 * `RECORDING_PRE_ROLL_MAX_MS`, and before that the DETECTION ceiling, which
 * silently truncated every recording burst to 6 s the moment there were two
 * windows — D192's failure, one layer down.
 */
function usablePreRoll(value: number | undefined): number {
  if (value === undefined) return 0
  if (!Number.isFinite(value) || value <= 0) return 0
  return Math.min(PREBUFFER_MAX_MS, value)
}

/**
 * Choose the keyframe access unit a pre-roll burst starts at.
 *
 * The OLDEST mark that is still inside the window wins; when none is (the
 * current GOP is itself older than `preRollMs`, i.e. a long-GOP camera with a
 * short pre-roll) the newest mark is returned, because the alternative to the
 * current GOP is nothing at all — the blind start Stage 0 exists to prevent.
 *
 * The boundary is INCLUSIVE: a keyframe exactly `preRollMs` old is inside.
 * Everything delivered after a keyframe is younger than it, so starting at a
 * mark inside the window is what makes "no frame older than `preRollMs` is
 * delivered" a property of the slice rather than a per-packet filter.
 *
 * Scans instead of assuming order: a caller that appends marks and rebases
 * indices after a trim is one refactor away from handing this an unsorted
 * array, and the failure would be a silently wider window.
 */
export function selectPreRollStart(
  marks: readonly PreRollMark[],
  preRollMs: number,
): PreRollSelection {
  if (marks.length === 0) return NOTHING

  const window = usablePreRoll(preRollMs)
  let newest: PreRollMark = marks[0]!
  let chosen: PreRollMark | null = null

  for (const mark of marks) {
    if (mark.ageMs < newest.ageMs) newest = mark
    if (window > 0 && mark.ageMs <= window && (chosen === null || mark.ageMs > chosen.ageMs)) {
      chosen = mark
    }
  }

  const pick = chosen ?? newest
  // `gopsBack` counts marks strictly younger than the chosen one, so it stays
  // correct for an unsorted input and reads as "how many GOPs of history".
  let gopsBack = 0
  for (const mark of marks) if (mark.ageMs < pick.ageMs) gopsBack++

  return { startIndex: pick.index, ageMs: pick.ageMs, gopsBack }
}

/**
 * Budget when the broker has not measured a bitrate for this stream yet — the
 * historical flat cap, kept verbatim as the honest "we do not know".
 *
 * `bitrateKbps` is 0 for the first stats window after every dial and after
 * every reset, so this is the value in force exactly while the ring is filling
 * for the first time.
 */
export const PRE_ROLL_UNKNOWN_BITRATE_BYTES = 8 * 1024 * 1024

/**
 * Hard ceiling on the WHOLE source-RTP ring (history + the current GOP).
 *
 * Lives here, next to the pre-roll budget, because the two numbers are one
 * number: a history budget above the ring cap is not a wider window, it is a
 * ring that overflows and calls `resetRtpPreBuffer`, which drops the join
 * bootstrap of EVERY consumer — WebRTC viewers included — for as long as the
 * condition holds. Keeping them in separate files is how they came to disagree.
 * Read by `StreamBroker.captureRtpForPreBuffer`.
 */
export const RTP_RING_MAX_BYTES = 24 * 1024 * 1024

/**
 * Bytes of the ring reserved for the CURRENT GOP, which the pre-roll budget
 * does not measure and cannot evict.
 *
 * `trimRtpRingToPreRollWindow` budgets the HISTORY only — everything before the
 * current GOP's keyframe — because the current GOP is the Stage 0 baseline and
 * keeps growing after every trim. So the history budget has to leave room for
 * it, or the sum overflows the ring even though the history alone fits.
 */
export const PRE_ROLL_CURRENT_GOP_RESERVE_BYTES = 8 * 1024 * 1024

/**
 * Absolute per-stream ceiling on retained pre-roll HISTORY.
 *
 * The bitrate-derived budget is what the window COSTS; this is the most any one
 * stream may spend regardless. Past it the operator has configured a window this
 * node cannot afford on that camera, and the broker says so rather than
 * delivering silently less (D192).
 *
 * **DERIVED, not chosen.** It was a free-standing `32 * 1024 * 1024` — 8 MiB
 * ABOVE the ring it has to fit inside. A ≳13 Mbps stream at a 10 s window was
 * therefore authorised to overflow its own ring and cycle `resetRtpPreBuffer`:
 * the pre-roll knob, turned up, would have taken every viewer's join bootstrap
 * with it. Deriving it from {@link RTP_RING_MAX_BYTES} minus the current-GOP
 * reserve makes the inversion unrepresentable rather than merely fixed.
 */
export const PRE_ROLL_ABSOLUTE_MAX_BYTES = RTP_RING_MAX_BYTES - PRE_ROLL_CURRENT_GOP_RESERVE_BYTES

/**
 * Headroom over the OBSERVED mean bitrate.
 *
 * `BrokerStatsSchema.bitrateKbps` is a mean over the stats window; a GOP
 * carrying an IDR plus a scene change is well above it. Budgeting at exactly
 * the mean would drop the oldest GOP on every busy second, so the window would
 * be the one the operator asked for only while nothing moved — which is the
 * opposite of when it is needed.
 */
export const PRE_ROLL_BITRATE_HEADROOM = 1.5

/** A resolved byte budget, and whether the absolute ceiling had to bite. */
export interface PreRollBudget {
  /** Bytes of HISTORY (everything before the current GOP) this stream may retain. */
  readonly bytes: number
  /**
   * True when {@link PRE_ROLL_ABSOLUTE_MAX_BYTES} truncated the bitrate-derived
   * budget. The caller LOGS this: a window that silently delivers less than it
   * promises is the exact failure D192 was written against, and a clamp nobody
   * prints is indistinguishable from a camera that was simply not warm yet.
   */
  readonly clamped: boolean
}

/**
 * The byte budget for the history a `windowMs` pre-roll needs on a stream
 * observed at `observedKbps`.
 *
 * Replaces a FLAT 8 MiB cap. That constant was a promise the feature could not
 * keep in either direction: above ~6.5 Mbps it silently truncated the window
 * (a 4K main stream asked for 10 s and got 6), and below it, it authorised a
 * doorbell at 512 kbps to hold 8 MiB — 16x what its own window weighs.
 */
export function preRollBudgetBytes(windowMs: number, observedKbps: number): PreRollBudget {
  if (!Number.isFinite(windowMs) || windowMs <= 0) return { bytes: 0, clamped: false }
  if (!Number.isFinite(observedKbps) || observedKbps <= 0) {
    return { bytes: PRE_ROLL_UNKNOWN_BITRATE_BYTES, clamped: false }
  }
  // kbps * ms / 8 = bytes (the two thousands cancel), times the headroom.
  const raw = Math.round((windowMs * observedKbps * PRE_ROLL_BITRATE_HEADROOM) / 8)
  if (raw > PRE_ROLL_ABSOLUTE_MAX_BYTES) {
    return { bytes: PRE_ROLL_ABSOLUTE_MAX_BYTES, clamped: true }
  }
  return { bytes: raw, clamped: false }
}

/**
 * The packet ceiling for a burst carrying `preRollMs` of pre-roll.
 *
 * `PRIME_MAX_PACKETS` is a defensive backstop against RTP timestamps that
 * stopped describing the stream — "far more packets than this much media time
 * can contain" — not a tuning knob. Read as an absolute it would silently kill
 * pre-roll on exactly the cameras that need it (a 4K main stream at 8 Mbps
 * fills 2 000 MTU-sized packets in under 3 s), so it is applied as the RATE it
 * always was: the same packets-per-span, over the span actually requested.
 * Never shrinks the ceiling.
 */
export function preRollPacketCeiling(bound: PrimeBurstBound, preRollMs: number): number {
  const window = usablePreRoll(preRollMs)
  if (window <= 0 || bound.maxSpanMs <= 0) return bound.maxPackets
  const factor = Math.max(1, Math.ceil(window / bound.maxSpanMs))
  return bound.maxPackets * factor
}

/**
 * The span bound a DETECTION session's burst is held to while pre-roll is on.
 *
 * D57's bound is untouched for every other consumer; for this one it becomes
 * the wider of the two, because withholding a burst for being as wide as the
 * operator configured would make the knob read as ON and behave as OFF.
 */
export function preRollSpanBound(bound: PrimeBurstBound, preRollMs: number): PrimeBurstBound {
  const window = usablePreRoll(preRollMs)
  if (window <= 0) return bound
  return {
    maxSpanMs: Math.max(bound.maxSpanMs, window),
    maxPackets: preRollPacketCeiling(bound, window),
  }
}
