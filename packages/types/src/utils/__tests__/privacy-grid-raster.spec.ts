/**
 * privacy-grid-raster — unit tests.
 *
 * Tests for rectsToCells and cellsToRects, covering:
 * - Full-frame rect → all cells true
 * - Single cell → one ~cell-sized rect
 * - Empty inputs → empty outputs
 * - Round-trip a simple contiguous block
 * - maxRegions cap
 * - Out-of-bounds and degenerate edge cases
 */
import { describe, it, expect } from 'vitest'
import { rectsToCells, cellsToRects, type NormRect } from '../privacy-grid-raster.js'

// ── Helpers ───────────────────────────────────────────────────────────────

/** Build a row-major boolean array of length gw*gh. */
function grid(gw: number, gh: number, values: readonly boolean[]): boolean[] {
  const out = Array.from<boolean>({ length: gw * gh }).fill(false)
  for (let i = 0; i < Math.min(values.length, out.length); i++) {
    out[i] = values[i] === true
  }
  return out
}

// ── rectsToCells ─────────────────────────────────────────────────────────

describe('rectsToCells', () => {
  it('returns all-false when rects list is empty', () => {
    const cells = rectsToCells([], 4, 3)
    expect(cells).toHaveLength(12)
    expect(cells.every((c) => c === false)).toBe(true)
  })

  it('returns empty array when grid dimensions are 0', () => {
    const full: NormRect = { x: 0, y: 0, w: 1, h: 1 }
    expect(rectsToCells([full], 0, 0)).toHaveLength(0)
    expect(rectsToCells([full], 0, 4)).toHaveLength(0)
    expect(rectsToCells([full], 4, 0)).toHaveLength(0)
  })

  it('full-frame rect activates all cells (4×3 grid)', () => {
    const full: NormRect = { x: 0, y: 0, w: 1, h: 1 }
    const cells = rectsToCells([full], 4, 3)
    expect(cells).toHaveLength(12)
    expect(cells.every((c) => c === true)).toBe(true)
  })

  it('full-frame rect activates all cells (8×8 grid)', () => {
    const full: NormRect = { x: 0, y: 0, w: 1, h: 1 }
    const cells = rectsToCells([full], 8, 8)
    expect(cells).toHaveLength(64)
    expect(cells.every((c) => c === true)).toBe(true)
  })

  it('rect covering only top-left quarter activates the expected cells (4×4)', () => {
    // Top-left quarter: columns 0-1, rows 0-1
    const rect: NormRect = { x: 0, y: 0, w: 0.5, h: 0.5 }
    const cells = rectsToCells([rect], 4, 4)
    expect(cells).toHaveLength(16)
    // Each cell centre: col=0→cx=0.125, col=1→cx=0.375, col=2→cx=0.625, col=3→cx=0.875
    // row=0→cy=0.125, row=1→cy=0.375, row=2→cy=0.625, row=3→cy=0.875
    // Only (col<2 && row<2) centres are inside [0,0.5]×[0,0.5].
    const expected = grid(4, 4, [
      true,
      true,
      false,
      false,
      true,
      true,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
    ])
    expect(cells).toEqual(expected)
  })

  it('small rect activating exactly one cell (2×2 grid)', () => {
    // Grid 2×2: cell centres at (0.25,0.25), (0.75,0.25), (0.25,0.75), (0.75,0.75)
    // A rect that only covers the bottom-right cell:
    const rect: NormRect = { x: 0.6, y: 0.6, w: 0.3, h: 0.3 }
    const cells = rectsToCells([rect], 2, 2)
    expect(cells).toEqual([false, false, false, true])
  })

  it('union of two rects marks both regions', () => {
    const left: NormRect = { x: 0, y: 0, w: 0.5, h: 1 }
    const right: NormRect = { x: 0.75, y: 0, w: 0.25, h: 1 }
    // 4×1 grid, cell centres at 0.125, 0.375, 0.625, 0.875
    const cells = rectsToCells([left, right], 4, 1)
    // cells 0,1 inside left; cell 3 inside right; cell 2 (cx=0.625) outside both
    expect(cells).toEqual([true, true, false, true])
  })
})

// ── cellsToRects ─────────────────────────────────────────────────────────

describe('cellsToRects', () => {
  it('returns empty when grid is 0×0', () => {
    expect(cellsToRects([true], 0, 0, 4)).toHaveLength(0)
  })

  it('returns empty when all cells are false', () => {
    const cells = Array.from<boolean>({ length: 12 }).fill(false)
    expect(cellsToRects(cells, 4, 3, 4)).toHaveLength(0)
  })

  it('returns empty when maxRegions is 0', () => {
    const cells = Array.from<boolean>({ length: 12 }).fill(true)
    expect(cellsToRects(cells, 4, 3, 0)).toHaveLength(0)
  })

  it('full-frame all-true → single full-frame rect', () => {
    const cells = Array.from<boolean>({ length: 16 }).fill(true)
    const rects = cellsToRects(cells, 4, 4, 4)
    expect(rects).toHaveLength(1)
    const r = rects[0]!
    expect(r.x).toBe(0)
    expect(r.y).toBe(0)
    expect(r.w).toBe(1)
    expect(r.h).toBe(1)
  })

  it('single active cell in a 4×4 grid → one cell-sized rect', () => {
    // Activate cell at (col=2, row=1) in a 4×4 grid.
    const cells = Array.from<boolean>({ length: 16 }).fill(false)
    cells[1 * 4 + 2] = true
    const rects = cellsToRects(cells, 4, 4, 4)
    expect(rects).toHaveLength(1)
    const r = rects[0]!
    // Expected: x=2/4=0.5, y=1/4=0.25, w=1/4=0.25, h=1/4=0.25
    expect(r.x).toBeCloseTo(0.5)
    expect(r.y).toBeCloseTo(0.25)
    expect(r.w).toBeCloseTo(0.25)
    expect(r.h).toBeCloseTo(0.25)
  })

  it('top-left quarter block → single rect covering top-left quarter (4×4)', () => {
    const cells = grid(4, 4, [
      true,
      true,
      false,
      false,
      true,
      true,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
    ])
    const rects = cellsToRects(cells, 4, 4, 4)
    expect(rects).toHaveLength(1)
    const r = rects[0]!
    expect(r.x).toBeCloseTo(0)
    expect(r.y).toBeCloseTo(0)
    expect(r.w).toBeCloseTo(0.5)
    expect(r.h).toBeCloseTo(0.5)
  })

  it('two disjoint columns → two rects', () => {
    // 4×1 grid: cells 0 and 3 active, cells 1 and 2 inactive.
    const cells = [true, false, false, true]
    const rects = cellsToRects(cells, 4, 1, 4)
    expect(rects).toHaveLength(2)
    const xs = rects.map((r) => r.x).toSorted((a, b) => a - b)
    expect(xs[0]).toBeCloseTo(0)
    expect(xs[1]).toBeCloseTo(0.75)
  })

  it('caps output at maxRegions keeping largest blocks', () => {
    // 4×1 grid: cells 0 and 3 active (two regions of size 1 each).
    // With maxRegions=1, only one rect returned.
    const cells = [true, false, false, true]
    const rects = cellsToRects(cells, 4, 1, 1)
    expect(rects).toHaveLength(1)
  })
})

// ── Round-trip ────────────────────────────────────────────────────────────

describe('round-trip (rectsToCells → cellsToRects)', () => {
  it('full-frame round-trip stays full-frame', () => {
    const full: NormRect = { x: 0, y: 0, w: 1, h: 1 }
    const cells = rectsToCells([full], 8, 6)
    const back = cellsToRects(cells, 8, 6, 4)
    expect(back).toHaveLength(1)
    const r = back[0]!
    expect(r.x).toBeCloseTo(0)
    expect(r.y).toBeCloseTo(0)
    expect(r.w).toBeCloseTo(1)
    expect(r.h).toBeCloseTo(1)
  })

  it('block round-trip recovers the original block (grid-aligned rect)', () => {
    // A rect aligned to the 4×4 grid's cell boundaries.
    const src: NormRect = { x: 0, y: 0, w: 0.5, h: 0.5 } // top-left 2×2 block
    const cells = rectsToCells([src], 4, 4)
    const rects = cellsToRects(cells, 4, 4, 4)
    expect(rects).toHaveLength(1)
    const r = rects[0]!
    expect(r.x).toBeCloseTo(0)
    expect(r.y).toBeCloseTo(0)
    expect(r.w).toBeCloseTo(0.5)
    expect(r.h).toBeCloseTo(0.5)
  })

  it('empty → empty round-trip', () => {
    const cells = rectsToCells([], 4, 4)
    const rects = cellsToRects(cells, 4, 4, 4)
    expect(rects).toHaveLength(0)
  })
})
