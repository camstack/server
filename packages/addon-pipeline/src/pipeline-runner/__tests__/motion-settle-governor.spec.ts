import { describe, it, expect } from 'vitest'
import {
  MotionSettleGovernor,
  DEFAULT_MOTION_SETTLE_CONFIG,
  PACKAGE_DETECTION_STEP_ID,
} from '../motion-settle-governor.js'

const DEV = 7

function makeGovernor() {
  // Small, deterministic tunables for the tests.
  return new MotionSettleGovernor({
    settleMs: 3_000,
    pollIntervalMs: 45_000,
    burstCount: 5,
    burstIntervalMs: 5_000,
  })
}

/** A governor with the burst switched OFF, so the pre-burst assertions below
 *  keep testing exactly what they were written to test. */
function makeGovernorNoBurst() {
  return new MotionSettleGovernor({
    settleMs: 3_000,
    pollIntervalMs: 45_000,
    burstCount: 1,
    burstIntervalMs: 5_000,
  })
}

describe('MotionSettleGovernor', () => {
  it('runs once on the first evaluation to establish a cold-start baseline (poll)', () => {
    const g = makeGovernor()
    const d = g.evaluate({ deviceId: DEV, motionInZone: false, now: 0 })
    expect(d.run).toBe(true)
    expect(d.reason).toBe('poll')
  })

  it('does NOT run every frame while motion is sustained (packages are stationary)', () => {
    const g = makeGovernor()
    g.evaluate({ deviceId: DEV, motionInZone: true, now: 0 }) // baseline poll consumes lastRunAt
    // Motion persists frame after frame, well within the poll interval.
    for (let t = 1_000; t <= 40_000; t += 1_000) {
      const d = g.evaluate({ deviceId: DEV, motionInZone: true, now: t })
      expect(d.run).toBe(false)
    }
  })

  it('fires a settle edge once motion has been absent for settleMs after motion', () => {
    const g = makeGovernor()
    g.evaluate({ deviceId: DEV, motionInZone: false, now: 0 }) // baseline
    // Motion arrives (someone approaches / sets a parcel down).
    g.evaluate({ deviceId: DEV, motionInZone: true, now: 1_000 })
    g.evaluate({ deviceId: DEV, motionInZone: true, now: 2_000 })
    // Motion stops at t=2000. Before settleMs elapses → no run.
    expect(g.evaluate({ deviceId: DEV, motionInZone: false, now: 3_000 }).run).toBe(false)
    expect(g.evaluate({ deviceId: DEV, motionInZone: false, now: 4_500 }).run).toBe(false)
    // settleMs (3000) after last motion (t=2000) → t>=5000 fires 'settle'.
    const settled = g.evaluate({
      deviceId: DEV,
      motionInZone: false,
      now: 5_000,
    })
    expect(settled.run).toBe(true)
    expect(settled.reason).toBe('settle')
  })

  it('fires the settle edge only ONCE per motion episode', () => {
    const g = makeGovernor()
    g.evaluate({ deviceId: DEV, motionInZone: false, now: 0 })
    g.evaluate({ deviceId: DEV, motionInZone: true, now: 1_000 })
    g.evaluate({ deviceId: DEV, motionInZone: false, now: 2_000 })
    const first = g.evaluate({
      deviceId: DEV,
      motionInZone: false,
      now: 5_000,
    })
    expect(first.run).toBe(true)
    expect(first.reason).toBe('settle')
    // Further still-no-motion frames must not re-fire settle.
    expect(g.evaluate({ deviceId: DEV, motionInZone: false, now: 6_000 }).run).toBe(false)
    expect(g.evaluate({ deviceId: DEV, motionInZone: false, now: 7_000 }).run).toBe(false)
  })

  it('re-arms and fires settle again on a NEW motion episode', () => {
    const g = makeGovernor()
    g.evaluate({ deviceId: DEV, motionInZone: false, now: 0 })
    // Episode 1.
    g.evaluate({ deviceId: DEV, motionInZone: true, now: 1_000 })
    g.evaluate({ deviceId: DEV, motionInZone: false, now: 2_000 })
    expect(g.evaluate({ deviceId: DEV, motionInZone: false, now: 5_000 }).reason).toBe('settle')
    // Episode 2 (later, still within poll interval so it can't be a poll).
    g.evaluate({ deviceId: DEV, motionInZone: true, now: 10_000 })
    g.evaluate({ deviceId: DEV, motionInZone: false, now: 11_000 })
    const second = g.evaluate({
      deviceId: DEV,
      motionInZone: false,
      now: 14_000,
    })
    expect(second.run).toBe(true)
    expect(second.reason).toBe('settle')
  })

  it('fires the low-cadence safety poll when idle with no motion edges', () => {
    const g = makeGovernor()
    g.evaluate({ deviceId: DEV, motionInZone: false, now: 0 }) // baseline poll at t=0
    // No motion at all; nothing until the poll interval elapses.
    expect(g.evaluate({ deviceId: DEV, motionInZone: false, now: 30_000 }).run).toBe(false)
    const poll = g.evaluate({
      deviceId: DEV,
      motionInZone: false,
      now: 45_000,
    })
    expect(poll.run).toBe(true)
    expect(poll.reason).toBe('poll')
  })

  it('tracks devices independently', () => {
    const g = makeGovernor()
    g.evaluate({ deviceId: 1, motionInZone: false, now: 0 })
    g.evaluate({ deviceId: 2, motionInZone: false, now: 0 })
    // Device 1 sees a settle; device 2 stays quiet and must not fire.
    g.evaluate({ deviceId: 1, motionInZone: true, now: 1_000 })
    g.evaluate({ deviceId: 1, motionInZone: false, now: 2_000 })
    expect(g.evaluate({ deviceId: 1, motionInZone: false, now: 5_000 }).reason).toBe('settle')
    expect(g.evaluate({ deviceId: 2, motionInZone: false, now: 5_000 }).run).toBe(false)
  })

  it('forget() resets a device to its cold-start baseline', () => {
    const g = makeGovernor()
    g.evaluate({ deviceId: DEV, motionInZone: false, now: 0 })
    expect(g.evaluate({ deviceId: DEV, motionInZone: false, now: 1_000 }).run).toBe(false)
    g.forget(DEV)
    // After forget, the next evaluation is a fresh baseline run again.
    expect(g.evaluate({ deviceId: DEV, motionInZone: false, now: 2_000 }).run).toBe(true)
  })

  it('exposes sane defaults and the package step id', () => {
    expect(PACKAGE_DETECTION_STEP_ID).toBe('package-detection')
    expect(DEFAULT_MOTION_SETTLE_CONFIG.settleMs).toBeGreaterThan(0)
    expect(DEFAULT_MOTION_SETTLE_CONFIG.pollIntervalMs).toBeGreaterThanOrEqual(30_000)
    expect(DEFAULT_MOTION_SETTLE_CONFIG.pollIntervalMs).toBeLessThanOrEqual(60_000)
  })
})

// ── The burst ────────────────────────────────────────────────────────────
//
// A parcel appears at the END of a motion episode. The settle edge is that
// moment, and it opens a burst so the downstream promotion criterion is met in
// ~20s instead of minutes. The poll is now only the safety net.

describe('MotionSettleGovernor — the settle burst', () => {
  /** Walk a device through one motion episode and settle it at `settleAt`. */
  function settleAt(g: MotionSettleGovernor, at: number): void {
    g.evaluate({ deviceId: DEV, motionInZone: false, now: 0 }) // cold-start poll
    g.evaluate({ deviceId: DEV, motionInZone: true, now: at - 3_000 })
  }

  it('fires burstCount runs, burstIntervalMs apart, after the settle edge', () => {
    const g = makeGovernor()
    settleAt(g, 4_000)
    // Settle edge at t=4000 (motion last seen 1000, absent 3000ms).
    expect(g.evaluate({ deviceId: DEV, motionInZone: false, now: 4_000 }).reason).toBe('settle')
    const fired: number[] = []
    // Poll every 500ms for 30s and record the burst runs.
    for (let t = 4_500; t <= 34_000; t += 500) {
      const d = g.evaluate({ deviceId: DEV, motionInZone: false, now: t })
      if (d.run && d.reason === 'burst') fired.push(t)
    }
    expect(fired).toEqual([9_000, 14_000, 19_000, 24_000])
  })

  it('the burst SPAN still clears a raised 15s dwell (default dwell is 0)', () => {
    // Promotion counts frames; dwell 0 means a single settle session is
    // enough. The burst remains the safety net if the operator raises dwell.
    const span =
      (DEFAULT_MOTION_SETTLE_CONFIG.burstCount - 1) * DEFAULT_MOTION_SETTLE_CONFIG.burstIntervalMs
    expect(span).toBeGreaterThan(15_000)
  })

  it('burst runs stay at least one pickup-slack window apart', () => {
    // Pickup slack is 5 000ms — mirrored here rather than imported across
    // the addon boundary; the GUARD is what pins the two together.
    expect(DEFAULT_MOTION_SETTLE_CONFIG.burstIntervalMs).toBeGreaterThanOrEqual(5_000)
  })

  it('the burst outranks the poll — a burst run resets the poll clock', () => {
    const g = makeGovernor()
    settleAt(g, 4_000)
    g.evaluate({ deviceId: DEV, motionInZone: false, now: 4_000 })
    const reasons: (string | null)[] = []
    for (let t = 5_000; t <= 30_000; t += 1_000) {
      const d = g.evaluate({ deviceId: DEV, motionInZone: false, now: t })
      if (d.run) reasons.push(d.reason)
    }
    expect(reasons).toEqual(['burst', 'burst', 'burst', 'burst'])
  })

  it('new motion RESTARTS the burst — evidence from before the movement is stale', () => {
    const g = makeGovernor()
    settleAt(g, 4_000)
    g.evaluate({ deviceId: DEV, motionInZone: false, now: 4_000 })
    expect(g.evaluate({ deviceId: DEV, motionInZone: false, now: 9_000 }).reason).toBe('burst')
    // The courier comes back.
    g.evaluate({ deviceId: DEV, motionInZone: true, now: 10_000 })
    expect(g.evaluate({ deviceId: DEV, motionInZone: false, now: 13_000 }).reason).toBe('settle')
    const fired: number[] = []
    for (let t = 13_500; t <= 40_000; t += 500) {
      const d = g.evaluate({ deviceId: DEV, motionInZone: false, now: t })
      if (d.run && d.reason === 'burst') fired.push(t)
    }
    expect(fired).toEqual([18_000, 23_000, 28_000, 33_000])
  })

  it('the safety poll still fires on a camera that never saw motion', () => {
    const g = makeGovernor()
    g.evaluate({ deviceId: DEV, motionInZone: false, now: 0 })
    const fired: number[] = []
    for (let t = 1_000; t <= 140_000; t += 1_000) {
      const d = g.evaluate({ deviceId: DEV, motionInZone: false, now: t })
      if (d.run) fired.push(t)
    }
    expect(fired).toEqual([45_000, 90_000, 135_000])
  })

  it('a burst-free governor behaves exactly as before (settle then poll)', () => {
    const g = makeGovernorNoBurst()
    settleAt(g, 4_000)
    expect(g.evaluate({ deviceId: DEV, motionInZone: false, now: 4_000 }).reason).toBe('settle')
    const fired: (string | null)[] = []
    for (let t = 5_000; t <= 60_000; t += 1_000) {
      const d = g.evaluate({ deviceId: DEV, motionInZone: false, now: t })
      if (d.run) fired.push(d.reason)
    }
    expect(fired).toEqual(['poll'])
  })

  it('forget() drops a pending burst with the rest of the device state', () => {
    const g = makeGovernor()
    settleAt(g, 4_000)
    g.evaluate({ deviceId: DEV, motionInZone: false, now: 4_000 })
    g.forget(DEV)
    // A fresh device is poll-due, not burst-due.
    expect(g.evaluate({ deviceId: DEV, motionInZone: false, now: 5_000 }).reason).toBe('poll')
  })
})
