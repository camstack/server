/**
 * The composite's geometry, turned into the `-filter_complex` the extended
 * ffmpeg primitive carries.
 *
 * Coordinates are NORMALIZED [0,1] on BOTH sides -- the crop taken out of each
 * source and the cell each lands in. A source camera CAN change resolution (a
 * profile switch, a firmware update, a substream that comes back different),
 * and a rectangle stored in pixels would quietly start cutting the wrong part
 * of the picture with nothing to say so.
 */
import { describe, expect, it } from 'vitest'
import { buildGridFilterGraph, type GridCell } from '../grid-filter-graph.js'

const FULL = { x: 0, y: 0, width: 1, height: 1 } as const

describe('buildGridFilterGraph', () => {
  it('refuses a grid with no cells — an empty composite has nothing to emit', () => {
    expect(() => buildGridFilterGraph({ width: 1920, height: 1080, cells: [] })).toThrowError(
      /at least one cell/i,
    )
  })

  it('places one full-frame cell at the whole canvas', () => {
    const cells: GridCell[] = [{ inputIndex: 0, source: FULL, cell: FULL }]
    const graph = buildGridFilterGraph({ width: 1280, height: 720, cells })
    expect(graph.videoOutLabel).toBe('grid')
    // A full-frame source needs no crop, only a scale onto its cell.
    expect(graph.graph).toContain('[0:v]scale=1280:720')
    expect(graph.graph).not.toContain('crop=')
  })

  it('crops before scaling when the cell takes only part of its source', () => {
    const cells: GridCell[] = [
      { inputIndex: 0, source: { x: 0.25, y: 0, width: 0.5, height: 1 }, cell: FULL },
    ]
    const graph = buildGridFilterGraph({ width: 1080, height: 1080, cells })
    // Normalized crop resolved against the SOURCE's own size at runtime, via
    // ffmpeg's iw/ih — never against a resolution we guessed here.
    expect(graph.graph).toContain('crop=iw*0.5:ih*1:iw*0.25:ih*0')
    expect(graph.graph.indexOf('crop=')).toBeLessThan(graph.graph.indexOf('scale='))
  })

  it('lays a 2x2 out on one canvas with each quadrant at a quarter', () => {
    const q = (x: number, y: number) => ({ x, y, width: 0.5, height: 0.5 })
    const cells: GridCell[] = [
      { inputIndex: 0, source: FULL, cell: q(0, 0) },
      { inputIndex: 1, source: FULL, cell: q(0.5, 0) },
      { inputIndex: 2, source: FULL, cell: q(0, 0.5) },
      { inputIndex: 3, source: FULL, cell: q(0.5, 0.5) },
    ]
    const graph = buildGridFilterGraph({ width: 1920, height: 1080, cells })
    // Each quadrant is scaled to half the canvas on each axis.
    expect(graph.graph).toContain('[0:v]scale=960:540')
    expect(graph.graph).toContain('[3:v]scale=960:540')
    // One base canvas, then each cell overlaid at its own normalized origin.
    expect(graph.graph).toContain('color=c=black:s=1920x1080')
    expect(graph.graph).toContain('overlay=960:540')
    expect(graph.graph).toContain('[grid]')
  })

  /**
   * A cell that would land outside the canvas is a layout bug that ffmpeg
   * renders as a silently clipped picture. Refuse it where it can be named.
   */
  it('refuses a cell that falls outside the canvas', () => {
    const cells: GridCell[] = [
      { inputIndex: 0, source: FULL, cell: { x: 0.8, y: 0, width: 0.5, height: 1 } },
    ]
    expect(() => buildGridFilterGraph({ width: 1920, height: 1080, cells })).toThrowError(
      /outside the canvas/i,
    )
  })

  it('refuses a crop that falls outside its source', () => {
    const cells: GridCell[] = [
      { inputIndex: 0, source: { x: 0.9, y: 0, width: 0.5, height: 1 }, cell: FULL },
    ]
    expect(() => buildGridFilterGraph({ width: 1920, height: 1080, cells })).toThrowError(
      /outside its source/i,
    )
  })

  /**
   * Odd pixel dimensions break yuv420p encoders. A cell landing on an odd
   * width must be rounded here, where the reason can be stated, rather than
   * failing inside the child.
   */
  it('rounds cell pixel sizes to even values', () => {
    const cells: GridCell[] = [
      { inputIndex: 0, source: FULL, cell: { x: 0, y: 0, width: 1 / 3, height: 1 } },
    ]
    const graph = buildGridFilterGraph({ width: 1920, height: 1080, cells })
    const m = graph.graph.match(/scale=(\d+):(\d+)/)
    expect(m).not.toBeNull()
    expect(Number(m?.[1]) % 2).toBe(0)
    expect(Number(m?.[2]) % 2).toBe(0)
  })
})
