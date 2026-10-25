import { describe, it, expect } from 'vitest'
import {
  centroidMovedFraction,
  evaluatePeriodicSnapshot,
  type SnapshotBox,
  type SnapshotGateInput,
} from '../snapshot-movement-gate.js'

const FRAME_W = 1920
const FRAME_H = 1080
// Frame diagonal ≈ hypot(1920,1080) = 2202.9 px.
const box = (x: number, y: number, w = 100, h = 100): SnapshotBox => ({ x, y, w, h })

const base = (over: Partial<SnapshotGateInput> = {}): SnapshotGateInput => ({
  lastSnapshotAt: 1_000,
  lastSnapshotBbox: box(500, 500),
  currentBbox: box(500, 500),
  now: 1_000 + 5_000, // exactly one 5s interval later
  frameWidth: FRAME_W,
  frameHeight: FRAME_H,
  intervalMs: 5_000,
  movementThreshold: 0.03, // ~66px on this frame
  maxIdleMs: 30_000,
  ...over,
})

describe('centroidMovedFraction', () => {
  it('is 0 for identical boxes', () => {
    expect(centroidMovedFraction(box(500, 500), box(500, 500), FRAME_W, FRAME_H)).toBe(0)
  })

  it('normalizes displacement to the frame diagonal', () => {
    // Move centroid by +2202.9 px along x ⇒ fraction ≈ 1.0.
    const f = centroidMovedFraction(box(0, 0), box(2202.9, 0), FRAME_W, FRAME_H)
    expect(f).toBeCloseTo(1, 2)
  })

  it('returns 0 for a degenerate (zero) frame diagonal instead of dividing by zero', () => {
    expect(centroidMovedFraction(box(0, 0), box(100, 100), 0, 0)).toBe(0)
  })
})

describe('evaluatePeriodicSnapshot', () => {
  it('does not capture before the interval elapses', () => {
    const d = evaluatePeriodicSnapshot(base({ now: 1_000 + 4_999 }))
    expect(d.capture).toBe(false)
    expect(d.reason).toBe('interval-not-elapsed')
  })

  it('does not capture when the clock is unseeded (lastSnapshotAt <= 0)', () => {
    const d = evaluatePeriodicSnapshot(base({ lastSnapshotAt: 0 }))
    expect(d.capture).toBe(false)
    expect(d.reason).toBe('interval-not-elapsed')
  })

  it('captures when there is no reference bbox yet', () => {
    const d = evaluatePeriodicSnapshot(base({ lastSnapshotBbox: undefined }))
    expect(d.capture).toBe(true)
    expect(d.reason).toBe('no-reference')
  })

  it('MOVED enough → captures', () => {
    // Shift centroid by 200px (> 3% of 2203px ≈ 66px).
    const d = evaluatePeriodicSnapshot(base({ currentBbox: box(700, 500) }))
    expect(d.capture).toBe(true)
    expect(d.reason).toBe('moved')
    expect(d.movedFraction).toBeGreaterThan(0.03)
  })

  it('barely MOVED → skips the near-identical frame', () => {
    // Shift centroid by only 20px (< 66px threshold), interval just elapsed.
    const d = evaluatePeriodicSnapshot(base({ currentBbox: box(520, 500) }))
    expect(d.capture).toBe(false)
    expect(d.reason).toBe('stationary-skip')
    expect(d.movedFraction).toBeLessThan(0.03)
  })

  it('stationary but IDLE too long → force-captures (loiterer fallback)', () => {
    // No movement, but 30s+ since the last snapshot.
    const d = evaluatePeriodicSnapshot(base({ currentBbox: box(500, 500), now: 1_000 + 30_000 }))
    expect(d.capture).toBe(true)
    expect(d.reason).toBe('idle-forced')
  })

  it('maxIdleMs is clamped to at least intervalMs', () => {
    // maxIdleMs below interval must not force before the interval itself elapsed.
    const d = evaluatePeriodicSnapshot(
      base({ maxIdleMs: 1_000, currentBbox: box(500, 500), now: 1_000 + 5_000 }),
    )
    // Interval just elapsed, no movement, idle limit = max(1000, 5000) = 5000,
    // now - last = 5000 ≥ 5000 ⇒ force.
    expect(d.capture).toBe(true)
    expect(d.reason).toBe('idle-forced')
  })

  it('threshold 0 disables the gate (any elapsed interval captures)', () => {
    const d = evaluatePeriodicSnapshot(base({ movementThreshold: 0, currentBbox: box(500, 500) }))
    // movedFraction 0 >= 0 ⇒ moved.
    expect(d.capture).toBe(true)
    expect(d.reason).toBe('moved')
  })

  describe('fast-mover early capture (inside the interval)', () => {
    it('captures BEFORE intervalMs once movement ≥ FAST_MOVER_FRACTION', () => {
      // 2s after the last snapshot (interval 5s NOT elapsed), moved ~300px
      // ≈ 13.6% of the diagonal (> 8%).
      const d = evaluatePeriodicSnapshot(base({ now: 1_000 + 2_000, currentBbox: box(800, 500) }))
      expect(d.capture).toBe(true)
      expect(d.reason).toBe('fast-mover')
      expect(d.movedFraction).toBeGreaterThan(0.08)
    })

    it('respects the hard floor: no early capture within FAST_MOVER_MIN_GAP_MS', () => {
      const d = evaluatePeriodicSnapshot(base({ now: 1_000 + 1_000, currentBbox: box(800, 500) }))
      expect(d.capture).toBe(false)
      expect(d.reason).toBe('interval-not-elapsed')
    })

    it('sub-fast movement inside the interval still waits', () => {
      // ~66px ≈ 3% < 8% ⇒ wait for the normal cadence.
      const d = evaluatePeriodicSnapshot(base({ now: 1_000 + 2_000, currentBbox: box(566, 500) }))
      expect(d.capture).toBe(false)
      expect(d.reason).toBe('interval-not-elapsed')
    })

    it('unseeded clock never fast-captures', () => {
      const d = evaluatePeriodicSnapshot(
        base({ lastSnapshotAt: 0, now: 2_000, currentBbox: box(800, 500) }),
      )
      expect(d.capture).toBe(false)
      expect(d.reason).toBe('interval-not-elapsed')
    })
  })
})
