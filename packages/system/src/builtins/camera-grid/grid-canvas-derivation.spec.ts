/**
 * The canvas is a RESULT, not a field.
 *
 * The operator draws two rectangles per camera — which part of the source to
 * take, and where it lands — and both are fractions, so nothing is pixels yet.
 * Exactly one number is missing: how many pixels the whole canvas is worth.
 * That number is derivable, and typing it in was the mistake: it silently
 * decided how much the composite cost and how sharp it was, and nothing in the
 * editor said so.
 *
 * A cell has `sourceResolution x crop` REAL pixels behind it. Showing them 1:1
 * neither invents nor discards anything, so the cell should be exactly that
 * many pixels — and since the cell is a fraction `f` of the canvas, the canvas
 * it implies is `real / f`. Each cell proposes one; the LARGEST wins, so the
 * hungriest cell is served 1:1 and the others scale down by a hair. Never up.
 *
 * And it is per PROFILE, because the sources have a different size at each:
 * a grid's `low` composes its sources' `low` onto the canvas their `low`
 * implies.
 */
import { describe, expect, it } from 'vitest'
import { deriveGridCanvas } from './grid-canvas-derivation.js'

const FULL = { x: 0, y: 0, width: 1, height: 1 }

describe('deriveGridCanvas', () => {
  it('gives a full-frame cell exactly its source, when the cell IS the canvas', () => {
    expect(
      deriveGridCanvas([{ source: FULL, cell: FULL, sourceSize: { width: 640, height: 360 } }]),
    ).toEqual({ width: 640, height: 360 })
  })

  it('scales the canvas up by the cell fraction — half a canvas implies twice the pixels', () => {
    expect(
      deriveGridCanvas([
        {
          source: FULL,
          cell: { x: 0, y: 0, width: 0.5, height: 1 },
          sourceSize: { width: 640, height: 360 },
        },
      ]),
    ).toEqual({ width: 1280, height: 360 })
  })

  it('lets the CROP shrink what a source contributes', () => {
    // Half the width of a 3840 source, in half the canvas: 1920 real pixels
    // for a half-width cell → a 3840-wide canvas.
    expect(
      deriveGridCanvas([
        {
          source: { x: 0, y: 0, width: 0.5, height: 1 },
          cell: { x: 0, y: 0, width: 0.5, height: 1 },
          sourceSize: { width: 3840, height: 2160 },
        },
      ]),
    ).toEqual({ width: 3840, height: 2160 })
  })

  it('takes the LARGEST proposal, so the hungriest cell is served 1:1', () => {
    expect(
      deriveGridCanvas([
        {
          source: { x: 0, y: 0, width: 0.495, height: 1 },
          cell: { x: 0, y: 0, width: 0.5, height: 1 },
          sourceSize: { width: 3840, height: 2160 },
        },
        {
          source: { x: 0, y: 0, width: 0.5, height: 1 },
          cell: { x: 0.5, y: 0, width: 0.5, height: 1 },
          sourceSize: { width: 3840, height: 2160 },
        },
      ]),
    ).toEqual({ width: 3840, height: 2160 })
  })

  it('ignores the GAPS — cells need not cover the canvas', () => {
    // One small cell in the corner still sets the scale for the whole picture.
    expect(
      deriveGridCanvas([
        {
          source: FULL,
          cell: { x: 0, y: 0, width: 0.25, height: 0.25 },
          sourceSize: { width: 640, height: 360 },
        },
      ]),
    ).toEqual({ width: 2560, height: 1440 })
  })

  it('always yields EVEN dimensions — libx264 refuses an odd one', () => {
    const canvas = deriveGridCanvas([
      {
        source: FULL,
        cell: { x: 0, y: 0, width: 0.3, height: 0.7 },
        sourceSize: { width: 641, height: 361 },
      },
    ])!
    expect(canvas.width % 2).toBe(0)
    expect(canvas.height % 2).toBe(0)
  })

  it('refuses to exceed what an encoder will take, rather than failing at spawn', () => {
    // A whole 4K source shown in a sliver of the canvas asks for an enormous
    // one: 3840 / 0.05 = 76800 wide.
    const canvas = deriveGridCanvas([
      {
        source: FULL,
        cell: { x: 0, y: 0, width: 0.05, height: 0.05 },
        sourceSize: { width: 3840, height: 2160 },
      },
    ])!
    expect(canvas.width).toBeLessThanOrEqual(7680)
    expect(canvas.height).toBeLessThanOrEqual(4320)
    // Still 16:9 — clamping must not distort the picture the operator drew.
    expect(canvas.width / canvas.height).toBeCloseTo(16 / 9, 1)
  })

  it('grows a tiny layout to something legible WITHOUT squaring it off', () => {
    // 0.01 of a 4K source at full canvas is 38x22 — below anything usable.
    // Scaling both axes by one factor keeps it 16:9 instead of 160x160.
    const canvas = deriveGridCanvas([
      {
        source: { x: 0, y: 0, width: 0.01, height: 0.01 },
        cell: FULL,
        sourceSize: { width: 3840, height: 2160 },
      },
    ])!
    expect(canvas.width).toBeGreaterThanOrEqual(160)
    expect(canvas.width / canvas.height).toBeCloseTo(16 / 9, 1)
  })

  it('is null for a grid with no cells — there is no picture to size', () => {
    expect(deriveGridCanvas([])).toBeNull()
  })

  it('survives a degenerate rectangle instead of dividing by zero', () => {
    expect(
      deriveGridCanvas([
        {
          source: FULL,
          cell: { x: 0, y: 0, width: 0, height: 1 },
          sourceSize: { width: 640, height: 360 },
        },
      ]),
    ).toBeNull()
  })
})
