/**
 * Stage 2 — the pre-roll history budget must FIT INSIDE the ring it lives in.
 *
 * The two numbers were 32 MiB (budget) and 24 MiB (ring cap), in two files. A
 * ≳13 Mbps stream at a 10 s window was therefore authorised to retain more
 * history than the whole ring may hold — and overflowing the ring calls
 * `resetRtpPreBuffer`, which drops the join bootstrap of EVERY consumer, WebRTC
 * viewers included. The knob, turned up, degraded everyone's picture.
 */
import { describe, expect, it } from 'vitest'
import {
  PRE_ROLL_ABSOLUTE_MAX_BYTES,
  PRE_ROLL_CURRENT_GOP_RESERVE_BYTES,
  preRollBudgetBytes,
  RTP_RING_MAX_BYTES,
} from '../pre-roll.js'
import { PREBUFFER_MAX_MS } from '../prebuffer.js'

describe('pre-roll byte budget vs the RTP ring ceiling', () => {
  it('leaves the current GOP room inside the ring', () => {
    // Positive and exact, not merely `<`: the budget IS the ring minus the
    // reserve, so a future edit to either number cannot re-open the gap.
    expect(PRE_ROLL_ABSOLUTE_MAX_BYTES + PRE_ROLL_CURRENT_GOP_RESERVE_BYTES).toBe(
      RTP_RING_MAX_BYTES,
    )
    expect(PRE_ROLL_CURRENT_GOP_RESERVE_BYTES).toBeGreaterThan(0)
  })

  it('never authorises a stream to retain more history than the ring can hold', () => {
    // The widest window this system can be configured with, at a bitrate well
    // past anything on the fleet: the clamp must still land under the ring.
    for (const kbps of [512, 4_000, 8_000, 13_000, 16_000, 40_000]) {
      const budget = preRollBudgetBytes(PREBUFFER_MAX_MS, kbps)
      expect(budget.bytes).toBeLessThanOrEqual(PRE_ROLL_ABSOLUTE_MAX_BYTES)
      expect(budget.bytes + PRE_ROLL_CURRENT_GOP_RESERVE_BYTES).toBeLessThanOrEqual(
        RTP_RING_MAX_BYTES,
      )
    }
  })

  it('still reports the clamp, so a truncated window is never silent (D192)', () => {
    // 15 s at 16 Mbps × 1.5 headroom = 45 MB raw — well over the ceiling.
    const budget = preRollBudgetBytes(PREBUFFER_MAX_MS, 16_000)
    expect(budget.clamped).toBe(true)
    expect(budget.bytes).toBe(PRE_ROLL_ABSOLUTE_MAX_BYTES)
  })

  it('leaves a modest stream unclamped — the ceiling is a ceiling, not the budget', () => {
    // A doorbell at 512 kbps over 10 s weighs ~960 KB: the bitrate-derived
    // budget must still be what it gets.
    const budget = preRollBudgetBytes(10_000, 512)
    expect(budget.clamped).toBe(false)
    expect(budget.bytes).toBeLessThan(PRE_ROLL_ABSOLUTE_MAX_BYTES)
    expect(budget.bytes).toBeGreaterThan(0)
  })
})
