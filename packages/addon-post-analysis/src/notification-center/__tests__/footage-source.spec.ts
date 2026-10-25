/**
 * The selection rule: ring when the moment is inside it, recordings when it is
 * not — and it is about the MOMENT, never about the kind of notification.
 */

import { describe, expect, it } from 'vitest'
import { footageSourceFor } from '../footage-source.js'

const RING = 25
const NOW = 1_786_185_854_852

describe('footageSourceFor — the moment decides, nothing else', () => {
  it('serves a fresh moment from the warm ring', () => {
    expect(
      footageSourceFor({
        anchorMs: NOW - 4_000,
        nowMs: NOW,
        preRollSec: 4,
        ringRetentionSec: RING,
      }),
    ).toBe('ring')
  })

  it('counts the PRE-ROLL, not only the anchor: 22 s + 4 s of pre-roll is out', () => {
    // The anchor itself is comfortably inside 25 s. The oldest frame the cut
    // NEEDS is not, and that is the instant the ring has to still hold.
    expect(
      footageSourceFor({
        anchorMs: NOW - 22_000,
        nowMs: NOW,
        preRollSec: 4,
        ringRetentionSec: RING,
      }),
    ).toBe('recordings')
    // Same anchor, no pre-roll asked for — the ring can serve it after all.
    expect(
      footageSourceFor({
        anchorMs: NOW - 22_000,
        nowMs: NOW,
        preRollSec: 0,
        ringRetentionSec: RING,
      }),
    ).toBe('ring')
  })

  it('sends the 102 departure — eight minutes behind the car — to the recordings', () => {
    expect(
      footageSourceFor({
        anchorMs: NOW - 8 * 60_000,
        nowMs: NOW,
        preRollSec: 4,
        ringRetentionSec: RING,
      }),
    ).toBe('recordings')
  })

  it('sends a row that merely SAT in the outbox to the recordings too', () => {
    // Nothing occupancy-shaped about this one: a restart, a retry, an
    // unreachable target. The rule cannot tell them apart and must not — the
    // moment is old either way, and the ring holds it either way: not at all.
    expect(
      footageSourceFor({
        anchorMs: NOW - 15 * 60_000,
        nowMs: NOW,
        preRollSec: 4,
        ringRetentionSec: RING,
      }),
    ).toBe('recordings')
  })

  it('is MONOTONE — once the recordings own a window, a later clock never gives it back', () => {
    const anchorMs = NOW - 30_000
    const early = footageSourceFor({ anchorMs, nowMs: NOW, preRollSec: 4, ringRetentionSec: RING })
    const late = footageSourceFor({
      anchorMs,
      nowMs: NOW + 9_000,
      preRollSec: 4,
      ringRetentionSec: RING,
    })
    expect(early).toBe('recordings')
    expect(late).toBe('recordings')
  })

  it('answers ring for an unmeasurable or future anchor rather than queueing a render', () => {
    expect(
      footageSourceFor({
        anchorMs: Number.NaN,
        nowMs: NOW,
        preRollSec: 4,
        ringRetentionSec: RING,
      }),
    ).toBe('ring')
    expect(
      footageSourceFor({
        anchorMs: NOW + 60_000,
        nowMs: NOW,
        preRollSec: 4,
        ringRetentionSec: RING,
      }),
    ).toBe('ring')
  })
})
