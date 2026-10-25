/**
 * The judge, and the two answers that are NOT "short".
 *
 * Every number here is a measurement on 3836 (D623) — see the module's own
 * docblock for the table these cases are drawn from.
 */
import { describe, expect, it } from 'vitest'

import {
  CLIP_DURATION_SHORTFALL_TOLERANCE_S,
  describeTruncation,
  judgeClipDuration,
  truncationReasonCode,
} from '../clip-truncation.js'

describe('judgeClipDuration', () => {
  it('names the operator’s own truncated serve short, with the shortfall', () => {
    const verdict = judgeClipDuration({
      // `1790183010-1790183055`, the 45 s row the camera reported `complete`.
      expectedMs: 45_000,
      deliveredSeconds: 4.26,
      frames: 126,
    })
    expect(verdict).toEqual({
      kind: 'short',
      expectedSeconds: 45,
      deliveredSeconds: 4.26,
      shortfallSeconds: 45 - 4.26,
    })
    expect(truncationReasonCode(verdict)).toBe('stream-short')
    expect(describeTruncation(verdict)).toContain('4.3 s of 45.0 s')
  })

  /**
   * The whole reason this is a shortfall and not a distance. Four of the five
   * clean serves measured ran LONGER than their row, one by 24.6 s.
   */
  it('accepts a serve that runs LONGER than its row', () => {
    expect(
      judgeClipDuration({ expectedMs: 45_000, deliveredSeconds: 69.569, frames: 900 }),
    ).toEqual({ kind: 'complete', expectedSeconds: 45, deliveredSeconds: 69.569 })
    expect(
      judgeClipDuration({ expectedMs: 122_000, deliveredSeconds: 124.65, frames: 1_600 }),
    ).toEqual({ kind: 'complete', expectedSeconds: 122, deliveredSeconds: 124.65 })
  })

  it('accepts the worst clean shortfall measured, and refuses one past the tolerance', () => {
    // 43 s row → 42.986 s: −0.015 s, the only shortfall in five clean serves.
    expect(
      judgeClipDuration({ expectedMs: 43_000, deliveredSeconds: 42.986, frames: 560 }).kind,
    ).toBe('complete')
    // Exactly at the bound is still whole; a hair past it is short.
    expect(
      judgeClipDuration({
        expectedMs: 43_000,
        deliveredSeconds: 43 - CLIP_DURATION_SHORTFALL_TOLERANCE_S,
        frames: 560,
      }).kind,
    ).toBe('complete')
    expect(
      judgeClipDuration({
        expectedMs: 43_000,
        deliveredSeconds: 43 - CLIP_DURATION_SHORTFALL_TOLERANCE_S - 0.01,
        frames: 560,
      }).kind,
    ).toBe('short')
  })

  /**
   * A serve with ZERO media is not a short serve, it is nothing — and it is
   * diagnosed at the camera's replay session, not at the clip. Measured: the
   * camera grants a session, answers `PLAY 200` and sends no RTP.
   */
  it('separates a stream that carried no media from one that came up short', () => {
    const empty = judgeClipDuration({ expectedMs: 45_000, deliveredSeconds: null, frames: 0 })
    expect(empty).toEqual({ kind: 'empty', expectedSeconds: 45 })
    expect(truncationReasonCode(empty)).toBe('stream-empty')
    expect(describeTruncation(empty)).toContain('no video at all')
    // The frame count is asked FIRST: a mux that wrote no frame can still have
    // reported a stamp, and that stamp is not a span to be short of.
    expect(judgeClipDuration({ expectedMs: 45_000, deliveredSeconds: 0.4, frames: 0 }).kind).toBe(
      'empty',
    )
  })

  it('says unknown rather than complete when nothing measured a span', () => {
    expect(judgeClipDuration({ expectedMs: 45_000, deliveredSeconds: null, frames: 126 })).toEqual({
      kind: 'unknown',
      reason: 'duration-unmeasured',
    })
    expect(judgeClipDuration({ expectedMs: 0, deliveredSeconds: 4.26, frames: 126 })).toEqual({
      kind: 'unknown',
      reason: 'row-window-unknown',
    })
  })

  it('has nothing to say about a whole clip', () => {
    const whole = judgeClipDuration({ expectedMs: 43_000, deliveredSeconds: 42.986, frames: 560 })
    expect(truncationReasonCode(whole)).toBeNull()
    expect(describeTruncation(whole)).toBeNull()
  })
})
