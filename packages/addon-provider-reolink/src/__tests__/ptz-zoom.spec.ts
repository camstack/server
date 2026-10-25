import { describe, expect, it } from 'vitest'
import {
  resolveZoomStep,
  ZOOM_FACTOR_SCALE,
  ZOOM_STEP_FRACTION,
  type ZoomTravel,
} from '../ptz-zoom.js'

const travel = (minPos: number, curPos: number, maxPos: number): ZoomTravel => ({
  minPos,
  curPos,
  maxPos,
})

describe('resolveZoomStep', () => {
  it('steps a fixed slice of the travel towards max on a positive press', () => {
    const out = resolveZoomStep(travel(1000, 1000, 3000), 0.2)
    expect(out).toEqual({
      kind: 'move',
      target: 1000 + (3000 - 1000) * ZOOM_STEP_FRACTION,
    })
  })

  it('steps towards min on a negative press', () => {
    const out = resolveZoomStep(travel(1000, 2000, 3000), -1)
    expect(out).toEqual({
      kind: 'move',
      target: 2000 - (3000 - 1000) * ZOOM_STEP_FRACTION,
    })
  })

  it('ignores magnitude — the viewer (0.2) and ui-library (1) must travel the same distance', () => {
    const fromViewer = resolveZoomStep(travel(1000, 1500, 3000), 0.2)
    const fromUiLibrary = resolveZoomStep(travel(1000, 1500, 3000), 1)
    expect(fromViewer).toEqual(fromUiLibrary)
  })

  it('clamps to the travel limits rather than overshooting', () => {
    expect(resolveZoomStep(travel(1000, 2900, 3000), 1)).toEqual({
      kind: 'move',
      target: 3000,
    })
    expect(resolveZoomStep(travel(1000, 1100, 3000), -1)).toEqual({
      kind: 'move',
      target: 1000,
    })
  })

  it('refuses at the limit instead of pretending to move', () => {
    expect(resolveZoomStep(travel(1000, 3000, 3000), 1)).toEqual({
      kind: 'refused',
      reason: 'at-limit',
    })
    expect(resolveZoomStep(travel(1000, 1000, 3000), -1)).toEqual({
      kind: 'refused',
      reason: 'at-limit',
    })
  })

  it('refuses a camera with no zoom travel — a pan-tilt-only head must not be driven', () => {
    expect(resolveZoomStep(travel(0, 0, 0), 1)).toEqual({
      kind: 'refused',
      reason: 'no-travel',
    })
    expect(resolveZoomStep(travel(3000, 3000, 1000), 1)).toEqual({
      kind: 'refused',
      reason: 'no-travel',
    })
  })

  it('refuses a non-finite travel readout rather than sending NaN to the camera', () => {
    expect(resolveZoomStep(travel(Number.NaN, 1000, 3000), 1)).toEqual({
      kind: 'refused',
      reason: 'no-travel',
    })
  })

  it('rounds to an integer position — movePos is an integer on the wire', () => {
    const out = resolveZoomStep(travel(0, 0, 1111), 1)
    expect(out.kind).toBe('move')
    if (out.kind !== 'move') return
    expect(Number.isInteger(out.target)).toBe(true)
  })

  it('keeps the factor scale that zoomToFactor multiplies back out', () => {
    // zoomToFactor does round(factor * 1000) => a raw position must go
    // back in divided by exactly this scale or the lens lands elsewhere.
    expect(ZOOM_FACTOR_SCALE).toBe(1000)
    const out = resolveZoomStep(travel(1000, 1000, 3000), 1)
    if (out.kind !== 'move') throw new Error('expected a move')
    expect(Math.round((out.target / ZOOM_FACTOR_SCALE) * 1000)).toBe(out.target)
  })
})
