/**
 * `withinStillSpan` is never looser than the rule it replaced for a box that
 * is not flat.
 *
 * The old rule: the centroid span's hypot within `fraction` of the short side.
 * The flat exception (median width > median height) adds room sideways only,
 * for the Retro (1441) parked car whose width the detector flips. For every
 * other box the predicate must answer EXACTLY what the old one did — a person
 * wandering diagonally, or fidgeting up and down, gets no extra room.
 *
 * Disarm: drop the flatness condition (apply the per-axis branch to every
 * box) and the grid below finds a tall box the old rule rejected.
 */
import { describe, expect, it } from 'vitest'

import { DEFAULT_STILL_SPAN_FRACTION, withinStillSpan } from '../state-analyzer.js'

const F = DEFAULT_STILL_SPAN_FRACTION

function oldRule(spanX: number, spanY: number, shortSide: number): boolean {
  return Math.hypot(spanX, spanY) <= shortSide * F
}

const SPANS = [0, 1, 5, 10, 12, 15, 17, 17.5, 18, 20, 25, 30, 40, 52, 60, 80, 120, 200]
const SIDES = [10, 20, 40, 50, 53, 100, 150, 300, 461]

describe('withinStillSpan — exactly the old rule for a box that is not flat', () => {
  it('agrees with the old circle over a grid of spans and sizes (width <= height)', () => {
    const disagreements: string[] = []
    for (const w of SIDES) {
      for (const h of SIDES) {
        if (w > h) continue
        // The short side as the old code sized it may differ from the
        // medians (a breathing box): cover both.
        for (const shortSide of [Math.min(w, h), Math.min(w, h) * 0.8, Math.min(w, h) * 1.2]) {
          for (const spanX of SPANS) {
            for (const spanY of SPANS) {
              const got = withinStillSpan(
                spanX,
                spanY,
                { shortSide, medianWidth: w, medianHeight: h },
                F,
              )
              if (got !== oldRule(spanX, spanY, shortSide)) {
                disagreements.push(`${w}x${h} short ${shortSide} span ${spanX},${spanY}`)
              }
            }
          }
        }
      }
    }
    expect(disagreements).toEqual([])
  })

  it('a flat box gets more room sideways only, never vertically', () => {
    const car = { shortSide: 53, medianWidth: 150, medianHeight: 53 }
    // 20 px sideways: outside the old 18.55 px circle, inside 0.35 x 150.
    expect(oldRule(20, 2, 53)).toBe(false)
    expect(withinStillSpan(20, 2, car, F)).toBe(true)
    // Vertically the short side is still the bar.
    expect(withinStillSpan(0, 19, car, F)).toBe(false)
    // And sideways the width is the bar.
    expect(withinStillSpan(53, 0, car, F)).toBe(false)
  })
})
