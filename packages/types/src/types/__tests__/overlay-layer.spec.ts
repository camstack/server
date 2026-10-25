/**
 * The census treatment is a CONTRACT, not a style choice made in one renderer.
 *
 * The viewer is React Native and the admin UI is React DOM: no component can be
 * shared, so the only way the two can look alike on purpose — rather than by a
 * hand-copied constant that the next edit desyncs in silence — is for the
 * treatment itself to be data both of them read.
 */
import { describe, expect, it } from 'vitest'

import { formatParkedFor, STATIONARY_OVERLAY_STYLE } from '../overlay-layer.js'

describe('formatParkedFor', () => {
  it('is coarse, because nobody reads a parked car to the second', () => {
    expect(formatParkedFor(45_000)).toBe('45 s')
    expect(formatParkedFor(12 * 60_000)).toBe('12 min')
    expect(formatParkedFor(3 * 3_600_000)).toBe('3 h')
  })

  // A hub stamp and a browser clock disagree. Garbage must not reach the screen.
  it('never prints NaN or a negative age', () => {
    expect(formatParkedFor(-5_000)).toBe('0 s')
    expect(formatParkedFor(Number.NaN)).toBe('0 s')
    expect(formatParkedFor(Number.POSITIVE_INFINITY)).toBe('0 s')
  })
})

describe('STATIONARY_OVERLAY_STYLE', () => {
  // The dash is the signal. Opacity is NOT: dimming a class hue makes it read
  // as a different hue, and the palette is shared precisely so that a vehicle
  // is the same blue on every surface.
  it('says "censused" with the dash, and never by altering the hue', () => {
    expect(STATIONARY_OVERLAY_STYLE.dashed).toBe(true)
    expect(STATIONARY_OVERLAY_STYLE.opacity).toBe(1)
  })

  // React Native cannot express `border-dashed` without explicit lengths, so a
  // contract that omits them is one the viewer cannot honour.
  it('carries what a NON-DOM renderer needs to draw the same dash', () => {
    expect(STATIONARY_OVERLAY_STYLE.dashPattern).toHaveLength(2)
    expect(STATIONARY_OVERLAY_STYLE.borderWidth).toBeGreaterThan(0)
  })
})
