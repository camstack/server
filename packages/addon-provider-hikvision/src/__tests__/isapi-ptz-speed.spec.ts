/**
 * The cap's `move` takes a normalized DIRECTION (`pan`/`tilt` in -1..1) and a
 * separate normalized magnitude (`speed` in 0..1) — that is how the reolink and
 * amcrest providers read it, and how `usePTZ` sends it (`pan: ±1, speed: 0.5`).
 *
 * The hikvision provider passed the DIRECTION straight into ISAPI's
 * `/continuous`, whose `<pan>` is a speed percentage in -100..100, and dropped
 * `speed` on the floor entirely. So the dispensa camera was commanded at 1 out
 * of 100: it moved at one percent of its speed, and a half-magnitude request
 * rounded to zero and did not move at all.
 */
import { describe, expect, it } from 'vitest'
import { isapiSpeedFor } from '../isapi-ptz-speed.js'

describe('isapiSpeedFor', () => {
  it('turns what the UI actually sends into a usable speed', () => {
    // usePTZ: DIRECTION_VECTORS right = { pan: 1 }, defaultSpeed = 0.5
    expect(isapiSpeedFor(1, 0.5)).toBe(50)
    expect(isapiSpeedFor(-1, 0.5)).toBe(-50)
  })

  it('keeps full magnitude at full speed', () => {
    expect(isapiSpeedFor(1, 1)).toBe(100)
    expect(isapiSpeedFor(-1, 1)).toBe(-100)
  })

  /** No axis requested means no motion on that axis. */
  it('is zero for an unrequested axis', () => {
    expect(isapiSpeedFor(0, 0.5)).toBe(0)
    expect(isapiSpeedFor(undefined, 0.5)).toBe(0)
  })

  /**
   * An omitted speed must not mean "stopped". Reolink defaults to 32/63 and
   * amcrest to the direction's own magnitude; a missing magnitude here takes
   * the same middle of the range rather than collapsing to zero.
   */
  it('treats an absent speed as mid-scale, never as zero', () => {
    expect(isapiSpeedFor(1, undefined)).toBe(50)
  })

  /**
   * The regression itself: a direction with no magnitude applied used to reach
   * the camera as 1, and a half direction as 0.
   */
  it('never produces the 1-percent crawl the raw direction produced', () => {
    expect(isapiSpeedFor(1, 0.5)).not.toBe(1)
    expect(isapiSpeedFor(0.5, 1)).toBe(50)
  })

  it('clamps out-of-range input rather than trusting it', () => {
    expect(isapiSpeedFor(5, 5)).toBe(100)
    expect(isapiSpeedFor(-5, 5)).toBe(-100)
  })
})
