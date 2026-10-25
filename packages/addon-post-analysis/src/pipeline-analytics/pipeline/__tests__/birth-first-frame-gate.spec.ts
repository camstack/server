import { describe, it, expect } from 'vitest'
import { decideBirthFirstFrameCapture } from '../birth-first-frame-gate.js'

describe('decideBirthFirstFrameCapture', () => {
  it('captures on a handled frame the track was OBSERVED in', () => {
    expect(decideBirthFirstFrameCapture({ hasFrameHandle: true, matchedThisFrame: true })).toEqual({
      capture: true,
    })
  })

  it('treats an ABSENT matched flag as matched (a pre-flag tracker output)', () => {
    expect(decideBirthFirstFrameCapture({ hasFrameHandle: true })).toEqual({ capture: true })
  })

  it('refuses a handle-less birth — nothing to crop THIS frame', () => {
    expect(decideBirthFirstFrameCapture({ hasFrameHandle: false, matchedThisFrame: true })).toEqual(
      {
        capture: false,
        refusedBecause: 'no-frame-handle',
      },
    )
  })

  /**
   * The 3829 defect. The confirmation gate defers a birth for up to
   * `maxDeferralMs` (2 s) and then confirms it on WHATEVER frame it is holding
   * — which for a short track is routinely a COASTED frame, after the subject's
   * last observation. Capturing there stamped the "primo" tile with an instant
   * later than the track's own `lastSeen` and cut the birth rectangle out of a
   * scene the subject had already left (`d035f251`: firstFrame 451 ms after the
   * track ended). `collectFirstFrameRetries` has always refused a coasted
   * frame; the BIRTH push never did.
   */
  it('refuses a COASTED birth frame — the subject was not in it', () => {
    expect(decideBirthFirstFrameCapture({ hasFrameHandle: true, matchedThisFrame: false })).toEqual(
      {
        capture: false,
        refusedBecause: 'coasted-frame',
      },
    )
  })

  it('names the coasted frame even when the handle is also absent — the refusal an operator can act on', () => {
    expect(
      decideBirthFirstFrameCapture({ hasFrameHandle: false, matchedThisFrame: false }),
    ).toEqual({ capture: false, refusedBecause: 'coasted-frame' })
  })
})
