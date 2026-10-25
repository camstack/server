import { describe, expect, it } from 'vitest'
import type { ResolvedRegion } from '../crop-geometry.js'
import {
  estimateTileBytes,
  NATIVE_TILE_PADDING_RATIO,
  rectWithinTile,
  resolveNativeTileRegion,
  selectTileForRect,
  tileContains,
} from '../native-tile-geometry.js'

const FRAME_W = 3840
const FRAME_H = 2160

const region = (left: number, top: number, width: number, height: number): ResolvedRegion => ({
  left,
  top,
  width,
  height,
})

describe('resolveNativeTileRegion', () => {
  it('pads the detection box on every side and stays even-aligned', () => {
    // A 384x432 box at (960, 540) in a 4K frame.
    const { region: tile } = resolveNativeTileRegion(
      FRAME_W,
      FRAME_H,
      { x: 0.25, y: 0.25, w: 0.1, h: 0.2 },
      0.5,
    )
    // pad = 192 x, 216 y → [768, 324] .. [1536, 1188]
    expect(tile.left).toBe(768)
    expect(tile.top).toBe(324)
    expect(tile.width).toBe(768)
    expect(tile.height).toBe(864)
    for (const v of [tile.left, tile.top, tile.width, tile.height]) expect(v % 2).toBe(0)
  })

  it('contains the unpadded detection box it was built from', () => {
    const bbox = { x: 0.4, y: 0.3, w: 0.08, h: 0.25 }
    const { region: tile } = resolveNativeTileRegion(FRAME_W, FRAME_H, bbox)
    const box = region(
      Math.round(bbox.x * FRAME_W),
      Math.round(bbox.y * FRAME_H),
      Math.round(bbox.w * FRAME_W),
      Math.round(bbox.h * FRAME_H),
    )
    expect(tileContains(tile, box)).toBe(true)
  })

  it('clamps at the frame edges instead of reading past the plane', () => {
    const { region: tile } = resolveNativeTileRegion(
      FRAME_W,
      FRAME_H,
      { x: 0, y: 0, w: 0.1, h: 0.1 },
      1,
    )
    expect(tile.left).toBe(0)
    expect(tile.top).toBe(0)
    expect(tile.left + tile.width).toBeLessThanOrEqual(FRAME_W)
    expect(tile.top + tile.height).toBeLessThanOrEqual(FRAME_H)
  })

  it('clamps a box overflowing the bottom-right corner', () => {
    const { region: tile } = resolveNativeTileRegion(
      FRAME_W,
      FRAME_H,
      { x: 0.95, y: 0.95, w: 0.1, h: 0.1 },
      0.5,
    )
    expect(tile.left + tile.width).toBeLessThanOrEqual(FRAME_W)
    expect(tile.top + tile.height).toBeLessThanOrEqual(FRAME_H)
    expect(tile.width).toBeGreaterThanOrEqual(2)
    expect(tile.height).toBeGreaterThanOrEqual(2)
  })

  it('widens a degenerate box to the chroma minimum rather than producing a zero-area tile', () => {
    const { region: tile } = resolveNativeTileRegion(
      FRAME_W,
      FRAME_H,
      { x: 0.5, y: 0.5, w: 0, h: 0 },
      0,
    )
    expect(tile.width).toBeGreaterThanOrEqual(2)
    expect(tile.height).toBeGreaterThanOrEqual(2)
  })

  it('treats a negative or non-finite padding as no padding, never as a shrink', () => {
    const bbox = { x: 0.4, y: 0.4, w: 0.1, h: 0.1 }
    const negative = resolveNativeTileRegion(FRAME_W, FRAME_H, bbox, -0.5)
    const nan = resolveNativeTileRegion(FRAME_W, FRAME_H, bbox, Number.NaN)
    expect(negative.paddingRatio).toBe(0)
    expect(nan.paddingRatio).toBe(0)
    // Still covers the box itself.
    const box = region(0.4 * FRAME_W, 0.4 * FRAME_H, 0.1 * FRAME_W, 0.1 * FRAME_H)
    expect(tileContains(negative.region, box)).toBe(true)
  })

  it('ships a padding default comfortably above the detail-crop convention (0.15)', () => {
    expect(NATIVE_TILE_PADDING_RATIO).toBeGreaterThan(0.15)
  })
})

describe('tileContains — the serve gate', () => {
  const tile = region(1000, 500, 400, 400)

  it('accepts a rectangle strictly inside', () => {
    expect(tileContains(tile, region(1100, 600, 100, 100))).toBe(true)
  })

  it('accepts a rectangle flush with the tile edges', () => {
    expect(tileContains(tile, region(1000, 500, 400, 400))).toBe(true)
  })

  it('REFUSES a rectangle one pixel past the right edge', () => {
    expect(tileContains(tile, region(1000, 500, 401, 400))).toBe(false)
  })

  it('REFUSES a rectangle starting before the tile', () => {
    expect(tileContains(tile, region(998, 500, 100, 100))).toBe(false)
  })

  it('REFUSES a degenerate rectangle', () => {
    expect(tileContains(tile, region(1100, 600, 0, 100))).toBe(false)
  })

  it('REFUSES a drifted track box the tile no longer covers', () => {
    // The subject walked out of the padded neighbourhood: this MUST be a miss,
    // not a clamp — a clamped rectangle enriches a different part of the scene
    // and lands in the same vector index (D52).
    expect(tileContains(tile, region(1350, 500, 200, 200))).toBe(false)
  })
})

describe('rectWithinTile', () => {
  const tile = region(1000, 500, 400, 400)

  it('translates a contained rectangle into tile-local coordinates', () => {
    expect(rectWithinTile(tile, region(1100, 620, 120, 80))).toEqual(region(100, 120, 120, 80))
  })

  it('does not scale or re-align — the same pixels either way', () => {
    const rect = region(1001, 503, 137, 91)
    const local = rectWithinTile(tile, rect)
    expect(local).not.toBeNull()
    expect(local?.width).toBe(rect.width)
    expect(local?.height).toBe(rect.height)
  })

  it('returns null (a MISS) rather than clamping a non-contained rectangle', () => {
    expect(rectWithinTile(tile, region(1350, 500, 200, 200))).toBeNull()
  })

  it('round-trips: local + tile origin is the original frame rectangle', () => {
    const rect = region(1234, 678, 90, 90)
    const local = rectWithinTile(tile, rect)
    expect(local).not.toBeNull()
    expect((local?.left ?? 0) + tile.left).toBe(rect.left)
    expect((local?.top ?? 0) + tile.top).toBe(rect.top)
  })
})

describe('selectTileForRect — the D52 boundary', () => {
  const tiles = [
    { region: region(1000, 500, 400, 400), id: 'big' },
    { region: region(1050, 550, 200, 200), id: 'small' },
    { region: region(3000, 100, 300, 300), id: 'elsewhere' },
  ]

  it('picks the SMALLEST tile that contains the rectangle', () => {
    const served = selectTileForRect(tiles, region(1100, 600, 50, 50))
    expect(served?.tile.id).toBe('small')
    expect(served?.local).toEqual(region(50, 50, 50, 50))
  })

  it('falls to a larger tile when the small one does not contain the rectangle', () => {
    const served = selectTileForRect(tiles, region(1010, 510, 100, 100))
    expect(served?.tile.id).toBe('big')
  })

  // The failure this whole module exists to prevent: a rectangle the tiles do
  // not cover must MISS. Clamping it inside the nearest tile would enrich a
  // different part of the scene, land in the same vector index as correctly-cut
  // neighbours, and error nowhere.
  it('REFUSES a rectangle no tile contains — never clamps into the nearest', () => {
    expect(selectTileForRect(tiles, region(1350, 500, 200, 200))).toBeNull()
    expect(selectTileForRect(tiles, region(0, 0, 4000, 3000))).toBeNull()
  })

  it('an empty tile set is a miss, not a throw', () => {
    expect(selectTileForRect([], region(0, 0, 10, 10))).toBeNull()
  })
})

describe('estimateTileBytes', () => {
  it('is orders of magnitude below the native frame it replaces', () => {
    // A 4K pinned-RGB24 frame is ~24.9 MB; a person-sized tile must not be
    // anywhere near it, or the redesign buys nothing.
    const { region: tile } = resolveNativeTileRegion(FRAME_W, FRAME_H, {
      x: 0.4,
      y: 0.3,
      w: 0.08,
      h: 0.25,
    })
    const bytes = estimateTileBytes(tile)
    expect(bytes).toBeLessThan(FRAME_W * FRAME_H * 3 * 0.02)
  })

  it('scales with area', () => {
    expect(estimateTileBytes(region(0, 0, 200, 200))).toBeCloseTo(
      estimateTileBytes(region(0, 0, 100, 100)) * 4,
      -1,
    )
  })

  it('never returns a negative tally for a degenerate region', () => {
    expect(estimateTileBytes(region(0, 0, 0, 0))).toBe(0)
    expect(estimateTileBytes(region(0, 0, -10, 10))).toBe(0)
  })
})
