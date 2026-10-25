/**
 * Turning the operator's layout into one decoder per CELL.
 *
 * Per cell and not per source, unlike the single-ffmpeg plan it replaces: this
 * repo has one argv builder and it expresses one output per process, so a
 * camera feeding two differently cropped tiles needs two children. Since D528
 * every source is read at its cheapest stream, so that duplicate is a second
 * 640x360 decode rather than a second 4 MP one.
 *
 * Every rectangle is snapped to EVEN pixels: yuv420p subsamples chroma 2x2, and
 * an odd origin tints a tile rather than breaking it.
 */
import { describe, expect, it } from 'vitest'
import { buildGridTilePlan } from './grid-tile-plan.js'

const FULL = { x: 0, y: 0, width: 1, height: 1 }
const CANVAS = { width: 1920, height: 1080 }

describe('buildGridTilePlan', () => {
  it('gives a camera in two cells two tiles, each with its own crop', () => {
    const plan = buildGridTilePlan({
      canvas: CANVAS,
      cells: [
        { deviceId: 107, source: FULL, cell: { x: 0, y: 0, width: 0.5, height: 1 } },
        {
          deviceId: 107,
          source: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 },
          cell: { x: 0.5, y: 0, width: 0.5, height: 1 },
        },
      ],
    })
    expect(plan.tiles).toHaveLength(2)
    expect(plan.tiles.every((t) => t.deviceId === 107)).toBe(true)
    expect(new Set(plan.tiles.map((t) => t.id)).size).toBe(2)
    expect(plan.tiles[0]?.filter).not.toContain('crop=')
    expect(plan.tiles[1]?.filter).toContain('crop=iw*0.5:ih*0.5:iw*0.25:ih*0.25')
  })

  it('sizes each tile to its cell, snapped DOWN to even pixels', () => {
    const plan = buildGridTilePlan({
      canvas: CANVAS,
      cells: [{ deviceId: 1, source: FULL, cell: { x: 0, y: 0, width: 0.5, height: 0.5 } }],
    })
    expect(plan.tiles[0]?.size).toEqual({ width: 960, height: 540 })
    expect(plan.tiles[0]?.origin).toEqual({ x: 0, y: 0 })
    expect(plan.tiles[0]?.filter).toContain('scale=960:540')
  })

  it('snaps an origin that lands odd, and keeps the tile inside the canvas', () => {
    const plan = buildGridTilePlan({
      canvas: { width: 100, height: 100 },
      cells: [{ deviceId: 1, source: FULL, cell: { x: 0.333, y: 0.333, width: 0.5, height: 0.5 } }],
    })
    const tile = plan.tiles[0]
    expect(tile?.origin.x).toBe(32)
    expect((tile?.origin.x ?? 1) % 2).toBe(0)
    expect((tile?.origin.x ?? 0) + (tile?.size.width ?? 0)).toBeLessThanOrEqual(100)
  })

  it('keeps a tile dragged to the right edge inside the canvas', () => {
    const plan = buildGridTilePlan({
      canvas: { width: 100, height: 100 },
      cells: [{ deviceId: 1, source: FULL, cell: { x: 0.99, y: 0, width: 0.5, height: 1 } }],
    })
    const tile = plan.tiles[0]
    expect((tile?.origin.x ?? 0) + (tile?.size.width ?? 0)).toBeLessThanOrEqual(100)
  })

  it('drops a cell too small to be a picture rather than emitting a zero-size tile', () => {
    const plan = buildGridTilePlan({
      canvas: { width: 100, height: 100 },
      cells: [{ deviceId: 1, source: FULL, cell: { x: 0, y: 0, width: 0.001, height: 0.5 } }],
    })
    expect(plan.tiles).toEqual([])
  })

  it('states the pixel format on every tile — the canvas copy is a memcpy only if it matches', () => {
    const plan = buildGridTilePlan({
      canvas: CANVAS,
      cells: [{ deviceId: 1, source: FULL, cell: FULL }],
    })
    expect(plan.tiles[0]?.filter.endsWith('format=yuv420p')).toBe(true)
  })

  it('sizes the frame buffer as yuv420p, which is what the feed cuts frames on', () => {
    const plan = buildGridTilePlan({
      canvas: CANVAS,
      cells: [{ deviceId: 1, source: FULL, cell: { x: 0, y: 0, width: 0.5, height: 0.5 } }],
    })
    expect(plan.tiles[0]?.frameBytes).toBe((960 * 540 * 3) / 2)
  })
})
