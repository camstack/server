/**
 * Stage 2 of the motion-start parity work: PRE-ROLL.
 *
 * Stage 0 stopped a detection decode session from starting BLIND (it is served
 * the current-GOP join burst instead of waiting for the next live IDR). Stage 2
 * asks the opposite question: the motion edge has already happened when the
 * session attaches, so the first analyzed frame should PREDATE it.
 *
 * The whole feature reduces to one selection: given the keyframe access units a
 * broker still retains, which one does the burst start at? These tests pin that
 * selection and its boundary, because every path that could get it wrong is
 * expensive and silent:
 *
 * - starting EARLIER than `preRollMs` means the operator asked for 2 s of
 *   history and a decoder was handed 9, re-clocking a stale backlog into the
 *   motion window it was meant to analyse;
 * - starting at a NON-keyframe means nothing decodes at all (D57: "the choice
 *   is the whole GOP or none of it" — a window cut from the tail cannot be
 *   decoded);
 * - `preRollMs: 0` doing ANYTHING is a regression of D57 + the live-edge rule
 *   for every camera on the fleet, since 0 is the shipped default.
 */
import { describe, expect, it } from 'vitest'
import {
  type PreRollMark,
  PRE_ROLL_ABSOLUTE_MAX_BYTES,
  PRE_ROLL_BITRATE_HEADROOM,
  PRE_ROLL_UNKNOWN_BITRATE_BYTES,
  preRollBudgetBytes,
  preRollPacketCeiling,
  preRollSpanBound,
  selectPreRollStart,
} from '../pre-roll.js'
import { DEFAULT_PREBUFFER_SEC, PREBUFFER_MAX_MS } from '../prebuffer.js'

/**
 * Four retained GOPs, oldest first, each 2 s of media apart. `ageMs` is media
 * time back from the newest retained packet — exactly what a broker computes
 * from the 90 kHz RTP clock (or from `EncodedPacket.pts`).
 */
const MARKS: readonly PreRollMark[] = [
  { index: 0, ageMs: 6000 },
  { index: 30, ageMs: 4000 },
  { index: 60, ageMs: 2000 },
  { index: 90, ageMs: 500 },
]

describe('selectPreRollStart — the pre-roll boundary', () => {
  it('preRollMs 0 selects the CURRENT GOP — today’s behaviour, byte-for-byte', () => {
    const sel = selectPreRollStart(MARKS, 0)
    expect(sel.startIndex).toBe(90)
    expect(sel.gopsBack).toBe(0)
    expect(sel.ageMs).toBe(500)
  })

  it('a keyframe EXACTLY at preRollMs is inside the window and IS delivered', () => {
    // 2000 ms of pre-roll, and a GOP whose keyframe is 2000 ms old: inclusive.
    expect(selectPreRollStart(MARKS, 2000).startIndex).toBe(60)
  })

  it('a keyframe one millisecond OLDER than preRollMs is NOT delivered', () => {
    // Same ring, 1999 ms asked for: the 2000 ms-old GOP falls outside, so the
    // window starts at the next keyframe inside it. Nothing older is served.
    const sel = selectPreRollStart(MARKS, 1999)
    expect(sel.startIndex).toBe(90)
    expect(sel.ageMs).toBeLessThanOrEqual(1999)
  })

  it('never selects a packet older than preRollMs, over the whole ring', () => {
    for (let preRollMs = 0; preRollMs <= 8000; preRollMs += 1) {
      const sel = selectPreRollStart(MARKS, preRollMs)
      // The one admitted exception is the current GOP: it is the D57 baseline
      // and is served whatever its age, exactly as it is today.
      if (sel.gopsBack > 0) expect(sel.ageMs).toBeLessThanOrEqual(preRollMs)
    }
  })

  it('reaches back MORE than one GOP when the window allows it', () => {
    const sel = selectPreRollStart(MARKS, 5000)
    expect(sel.startIndex).toBe(30)
    expect(sel.gopsBack).toBe(2)
  })

  it('a pre-roll wider than the ring stops at the oldest retained keyframe', () => {
    const sel = selectPreRollStart(MARKS, 60_000)
    expect(sel.startIndex).toBe(0)
    expect(sel.gopsBack).toBe(3)
  })

  it('falls back to the current GOP when even IT is older than the window', () => {
    // A 4 s-GOP camera with 1 s of pre-roll asked for: there is no keyframe
    // inside the window, and the alternative to the current GOP is nothing at
    // all — which is the blind start Stage 0 exists to prevent.
    const longGop: readonly PreRollMark[] = [
      { index: 0, ageMs: 8000 },
      { index: 40, ageMs: 4000 },
    ]
    const sel = selectPreRollStart(longGop, 1000)
    expect(sel.startIndex).toBe(40)
    expect(sel.gopsBack).toBe(0)
  })

  it('an empty ring selects nothing rather than index 0', () => {
    expect(selectPreRollStart([], 4000).startIndex).toBe(-1)
  })

  it('is order-independent — the oldest QUALIFYING keyframe wins', () => {
    const shuffled: readonly PreRollMark[] = [
      { index: 90, ageMs: 500 },
      { index: 0, ageMs: 6000 },
      { index: 60, ageMs: 2000 },
      { index: 30, ageMs: 4000 },
    ]
    expect(selectPreRollStart(shuffled, 4000).startIndex).toBe(30)
  })

  it('a non-finite pre-roll is treated as off, never as Infinity of history', () => {
    expect(selectPreRollStart(MARKS, Number.NaN).startIndex).toBe(90)
    expect(selectPreRollStart(MARKS, Number.POSITIVE_INFINITY).startIndex).toBe(90)
    expect(selectPreRollStart(MARKS, -1000).startIndex).toBe(90)
  })
})

describe('preRollPacketCeiling — the defensive backstop stays a RATE', () => {
  it('is unchanged while pre-roll is off', () => {
    expect(preRollPacketCeiling({ maxSpanMs: 2000, maxPackets: 2000 }, 0)).toBe(2000)
  })

  it('scales with the media time the operator asked for', () => {
    // The ceiling exists to catch timestamps that stopped describing the stream
    // (wrap, an all-intra latch), i.e. packets far beyond what this much media
    // can contain. Asking for 3× the span must not turn it into a silent cap on
    // the feature itself.
    expect(preRollPacketCeiling({ maxSpanMs: 2000, maxPackets: 2000 }, 6000)).toBe(6000)
  })

  it('never shrinks the ceiling', () => {
    expect(preRollPacketCeiling({ maxSpanMs: 4000, maxPackets: 2000 }, 500)).toBe(2000)
  })
})

/**
 * TWO WINDOWS, ONE RING (D193).
 *
 * The ring retains `max(detection, recording)`; each intent is SERVED its own
 * number. These pin the second window's knob and the byte budget that replaced
 * the flat 8 MiB cap — the constant that silently turned "10 s" into 6 s on a
 * 4K camera, which is exactly the promise/delivery divergence D192 forbids.
 */
describe('preRollBudgetBytes — the ceiling is derived from the bitrate, not guessed', () => {
  it('is 0 while the window is off — the budget is never consulted then', () => {
    expect(preRollBudgetBytes(0, 8000).bytes).toBe(0)
  })

  it('an UNMEASURED bitrate falls back to the historical flat budget, unclamped', () => {
    const budget = preRollBudgetBytes(10_000, 0)
    expect(budget.bytes).toBe(PRE_ROLL_UNKNOWN_BITRATE_BYTES)
    expect(budget.clamped).toBe(false)
  })

  it('10 s at 8 Mbps buys 10 s of 8 Mbps — with headroom, not 8 MiB', () => {
    const budget = preRollBudgetBytes(10_000, 8000)
    // 10 s * 8000 kbps = 10 MB of media; the old flat cap held 8 MiB and would
    // have truncated the window the operator asked for.
    expect(budget.bytes).toBeGreaterThan((10_000 * 1000 * 8) / 8 / 1000)
    expect(budget.bytes).toBe(Math.round((10_000 * 8000 * PRE_ROLL_BITRATE_HEADROOM) / 8))
    expect(budget.clamped).toBe(false)
  })

  it('a low-bitrate camera gets a SMALLER budget than the old flat cap', () => {
    expect(preRollBudgetBytes(10_000, 512).bytes).toBeLessThan(PRE_ROLL_UNKNOWN_BITRATE_BYTES)
  })

  it('clamps at the absolute per-stream ceiling and SAYS it clamped', () => {
    const budget = preRollBudgetBytes(PREBUFFER_MAX_MS, 100_000)
    expect(budget.bytes).toBe(PRE_ROLL_ABSOLUTE_MAX_BYTES)
    expect(budget.clamped).toBe(true)
  })

  it('a non-finite bitrate is unmeasured, never Infinity of budget', () => {
    expect(preRollBudgetBytes(10_000, Number.NaN).bytes).toBe(PRE_ROLL_UNKNOWN_BITRATE_BYTES)
  })
})

describe('the mechanics admit the WHOLE prebuffer, never a narrower ceiling of their own', () => {
  /**
   * This block is what is left of "two windows, two ceilings" (D193). It used
   * to prove that a 10 s RECORDING window was not silently truncated at the 6 s
   * DETECTION ceiling — a real failure, one layer below D192's. With one
   * configuration there is one ceiling, and what has to stay true is that these
   * three mechanisms all clamp at IT and not at something smaller: a selector
   * that refused the keyframe the prebuffer retained, or a span bound that
   * withheld a burst for being as wide as the prebuffer is configured, would
   * make the knob read as ON and behave as OFF.
   */
  it('selects a keyframe as far back as the prebuffer is configured to retain', () => {
    const marks: readonly PreRollMark[] = [
      { index: 0, ageMs: 9000 },
      { index: 40, ageMs: 6000 },
      { index: 80, ageMs: 0 },
    ]
    // 9 s back is well beyond the OLD detection ceiling (6 s) and inside a
    // prebuffer configured at its maximum.
    expect(selectPreRollStart(marks, PREBUFFER_MAX_MS).startIndex).toBe(0)
  })

  it('does not withhold a burst for being as wide as the prebuffer — the D192 failure', () => {
    const bound = { maxSpanMs: 2000, maxPackets: 2000 }
    expect(preRollSpanBound(bound, PREBUFFER_MAX_MS).maxSpanMs).toBe(PREBUFFER_MAX_MS)
  })

  it('the shipped default is inside the ceiling, so no camera relies on the clamp', () => {
    expect(DEFAULT_PREBUFFER_SEC * 1000).toBeLessThanOrEqual(PREBUFFER_MAX_MS)
    const bound = { maxSpanMs: 2000, maxPackets: 2000 }
    expect(preRollSpanBound(bound, DEFAULT_PREBUFFER_SEC * 1000).maxSpanMs).toBe(
      DEFAULT_PREBUFFER_SEC * 1000,
    )
  })

  it('still refuses a window wider than the one ceiling in the system', () => {
    const marks: readonly PreRollMark[] = [
      { index: 0, ageMs: PREBUFFER_MAX_MS + 1000 },
      { index: 10, ageMs: 0 },
    ]
    expect(selectPreRollStart(marks, 999_000).startIndex).toBe(10)
  })
})
