import { describe, expect, it } from 'vitest'
import {
  isShortMotionlessTrack,
  MOTIONLESS_MAX_PX,
  netDisplacementPx,
  SHORT_TRACK_MAX_MS,
} from '../short-motionless.js'

describe('isShortMotionlessTrack — Events hide for scenery re-fires', () => {
  it('matches the six live 102/3829 flashes (2–13 s, net ≈ 0)', () => {
    expect(isShortMotionlessTrack(3_800, 0, 'person')).toBe(true)
    expect(isShortMotionlessTrack(12_800, 0, 'person')).toBe(true)
    expect(isShortMotionlessTrack(1_600, 0, 'person')).toBe(true)
    expect(isShortMotionlessTrack(6_560, 0.52, 'person')).toBe(true)
  })

  it('lets a real passage through — lived past the window, or went somewhere', () => {
    expect(isShortMotionlessTrack(SHORT_TRACK_MAX_MS + 1, 0, 'person')).toBe(false)
    expect(isShortMotionlessTrack(4_000, MOTIONLESS_MAX_PX + 1, 'person')).toBe(false)
  })

  it('hides a short idle person whose net walk is bbox jitter (9310d1ff: 9.7s, 30 px)', () => {
    expect(isShortMotionlessTrack(9_700, 30, 'person')).toBe(true)
  })

  it('keeps a door-stander past the short window (0e343f86: 28.8s)', () => {
    expect(isShortMotionlessTrack(28_800, 109, 'person')).toBe(false)
  })

  it('does not hide a short vehicle whose net is bbox jitter on a real car (86918072: 10.9s, 15 px)', () => {
    // Walk 435 / net 15 — the Events path and crop were the car. 40 px was
    // tuned for a standing person and would stamp this vehicle as scenery.
    expect(isShortMotionlessTrack(10_900, 15, 'vehicle')).toBe(false)
    expect(isShortMotionlessTrack(10_900, 15, 'car')).toBe(false)
  })

  it('still hides a parked-plate flash (vehicle, net ≈ 0)', () => {
    expect(isShortMotionlessTrack(6_560, 0.52, 'vehicle')).toBe(true)
  })
})

describe('netDisplacementPx — walk is not "moved"', () => {
  it('1e073359: jitter walk exceeds the original 8 px while net does not', () => {
    const path = [
      { x: 100, y: 40 },
      { x: 102, y: 41 },
      { x: 99, y: 39 },
      { x: 100.4, y: 40.2 },
    ]
    let walk = 0
    for (let i = 1; i < path.length; i++) {
      walk += Math.hypot(path[i]!.x - path[i - 1]!.x, path[i]!.y - path[i - 1]!.y)
    }
    expect(walk).toBeGreaterThan(6)
    expect(netDisplacementPx(path)).toBeLessThan(1)
    expect(isShortMotionlessTrack(6_560, netDisplacementPx(path), 'person')).toBe(true)
  })
})
