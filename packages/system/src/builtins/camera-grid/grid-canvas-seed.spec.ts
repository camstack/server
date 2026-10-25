/**
 * The seed: what the canvas SAYS before any camera has delivered a frame.
 *
 * A composition appears on the first tick by design (`grid-compositor.ts`), and
 * until 2026-09-18 what it appeared as was black — indistinguishable from a
 * grid with no cells, from a grid whose sources are all broken, and from a
 * viewer that connected to nothing. The seed paints the LAYOUT instead: one
 * card per cell, carrying the camera's name and the word the state deserves.
 *
 * It is a pure function of the tile plan, which is what these tests hold it to:
 * the rendering is the last step and everything before it is testable without
 * rasterizing anything.
 */
import { describe, expect, it } from 'vitest'
import { GridCanvas, yuv420pSize } from './grid-canvas.js'
import {
  GRID_SEED_WAITING_LABEL,
  buildGridSeedSpec,
  buildGridSeedSvg,
  gridSeedName,
  renderGridSeed,
  rgbToYuv420p,
} from './grid-canvas-seed.js'
import { GridCompositor } from './grid-compositor.js'
import { buildGridTilePlan } from './grid-tile-plan.js'

const FULL = { x: 0, y: 0, width: 1, height: 1 }

const TWO_CELLS = buildGridTilePlan({
  canvas: { width: 640, height: 360 },
  cells: [
    { deviceId: 101, source: FULL, cell: { x: 0, y: 0, width: 0.5, height: 1 } },
    { deviceId: 102, source: FULL, cell: { x: 0.5, y: 0, width: 0.5, height: 1 } },
  ],
})

describe('gridSeedName', () => {
  it('falls back to the DEVICE ID, never to a blank card', () => {
    // A name we could not read is not a reason to paint an anonymous
    // rectangle: the id is what every log line about that tile carries, so it
    // is the one label an operator can act on.
    expect(gridSeedName(new Map(), 102)).toBe('Camera 102')
    expect(gridSeedName(new Map([[102, 'Cortile']]), 102)).toBe('Cortile')
    expect(gridSeedName(new Map([[102, '   ']]), 102)).toBe('Camera 102')
  })
})

describe('buildGridSeedSpec', () => {
  it('gives every tile its own card, at the tile’s own rectangle', () => {
    const spec = buildGridSeedSpec(TWO_CELLS, new Map([[101, 'Cortile']]))
    expect(spec.canvas).toEqual({ width: 640, height: 360 })
    expect(spec.cells).toHaveLength(2)
    expect(spec.cells[0]?.origin).toEqual(TWO_CELLS.tiles[0]?.origin)
    expect(spec.cells[0]?.size).toEqual(TWO_CELLS.tiles[0]?.size)
    expect(spec.cells[0]?.name).toBe('Cortile')
    // The second source has no name we could read — it still gets a card.
    expect(spec.cells[1]?.name).toBe('Camera 102')
  })

  it('labels BOTH cells of a camera shown twice', () => {
    const plan = buildGridTilePlan({
      canvas: { width: 640, height: 360 },
      cells: [
        { deviceId: 101, source: FULL, cell: { x: 0, y: 0, width: 0.5, height: 1 } },
        {
          deviceId: 101,
          source: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 },
          cell: { x: 0.5, y: 0, width: 0.5, height: 1 },
        },
      ],
    })
    const spec = buildGridSeedSpec(plan, new Map([[101, 'Cortile']]))
    expect(spec.cells.map((cell) => cell.name)).toEqual(['Cortile', 'Cortile'])
    expect(spec.cells[0]?.origin.x).not.toBe(spec.cells[1]?.origin.x)
  })

  it('keeps every rectangle EVEN — the canvas refuses anything else', () => {
    const spec = buildGridSeedSpec(
      buildGridTilePlan({
        canvas: { width: 100, height: 100 },
        cells: [
          { deviceId: 1, source: FULL, cell: { x: 0.333, y: 0.333, width: 0.5, height: 0.5 } },
        ],
      }),
      new Map(),
    )
    for (const cell of spec.cells) {
      expect(cell.origin.x % 2).toBe(0)
      expect(cell.origin.y % 2).toBe(0)
      expect(cell.size.width % 2).toBe(0)
      expect(cell.size.height % 2).toBe(0)
    }
  })
})

describe('buildGridSeedSvg', () => {
  it('says what the card IS — the camera, and that nothing has arrived yet', () => {
    const svg = buildGridSeedSvg(buildGridSeedSpec(TWO_CELLS, new Map([[101, 'Cortile']])))
    expect(svg).toContain('Cortile')
    expect(svg).toContain('Camera 102')
    // Honest, not a fake picture: the card must not read as a working tile.
    expect(svg.split(GRID_SEED_WAITING_LABEL).length - 1).toBe(2)
  })

  it('escapes a camera name that would otherwise break the document', () => {
    const svg = buildGridSeedSvg(
      buildGridSeedSpec(TWO_CELLS, new Map([[101, 'Cortile <A> & "B"']])),
    )
    expect(svg).toContain('Cortile &lt;A&gt; &amp; &quot;B&quot;')
    expect(svg).not.toContain('Cortile <A>')
  })

  it('draws the canvas it was given, and one card per cell', () => {
    const svg = buildGridSeedSvg(buildGridSeedSpec(TWO_CELLS, new Map()))
    expect(svg).toContain('width="640"')
    expect(svg).toContain('height="360"')
    expect(svg.split('<rect').length - 1).toBeGreaterThanOrEqual(2)
  })

  it('is a canvas of cards and nothing else — the gaps stay the canvas’ own black', () => {
    // A full-bleed background would paint the uncovered part of the canvas too,
    // and the uncovered part is not a cell: it is background, and saying
    // "waiting" about it would be a lie about a tile that does not exist.
    const svg = buildGridSeedSvg(buildGridSeedSpec(TWO_CELLS, new Map()))
    expect(svg).not.toContain('width="100%"')
  })
})

describe('rgbToYuv420p', () => {
  it('produces exactly one yuv420p frame', () => {
    const rgb = Buffer.alloc(4 * 2 * 3)
    expect(rgbToYuv420p(rgb, { width: 4, height: 2 })).toHaveLength(yuv420pSize(4, 2))
  })

  it('maps black and white to the range the encoder is fed', () => {
    const black = rgbToYuv420p(Buffer.alloc(2 * 2 * 3, 0), { width: 2, height: 2 })
    expect(black[0]).toBe(16)
    expect(black[2 * 2]).toBe(128)
    const white = rgbToYuv420p(Buffer.alloc(2 * 2 * 3, 255), { width: 2, height: 2 })
    expect(white[0]).toBe(235)
    expect(white[2 * 2]).toBe(128)
  })

  it('keeps a neutral grey neutral in BOTH chroma planes', () => {
    // Zeroed chroma is GREEN, not grey — the whole reason `GridCanvas.clear`
    // writes 128. A conversion that drifted here would tint every card.
    const grey = rgbToYuv420p(Buffer.alloc(2 * 2 * 3, 27), { width: 2, height: 2 })
    expect(grey[2 * 2]).toBe(128)
    expect(grey[2 * 2 + 1]).toBe(128)
  })
})

describe('renderGridSeed', () => {
  it('renders one frame the canvas accepts, whole', async () => {
    const seed = await renderGridSeed(buildGridSeedSpec(TWO_CELLS, new Map([[101, 'Cortile']])))
    expect(seed).toHaveLength(yuv420pSize(640, 360))
    const canvas = new GridCanvas(640, 360)
    expect(canvas.blit(seed, { width: 640, height: 360 }, { x: 0, y: 0 })).toBe(true)
  })

  it('paints the cells and leaves the gap between them dark', async () => {
    const plan = buildGridTilePlan({
      canvas: { width: 640, height: 360 },
      cells: [{ deviceId: 101, source: FULL, cell: { x: 0, y: 0, width: 0.5, height: 0.5 } }],
    })
    const seed = await renderGridSeed(buildGridSeedSpec(plan, new Map([[101, 'Cortile']])))
    const luma = (x: number, y: number): number => seed[y * 640 + x] ?? -1
    // Inside the card: lit. Outside it: the background nobody drew a cell on.
    expect(luma(160, 90)).toBeGreaterThan(20)
    expect(luma(600, 340)).toBeLessThanOrEqual(16)
  })
})

describe('GridCompositor with a seed', () => {
  it('carries the seed on the VERY FIRST tick, before any tile has arrived', async () => {
    const seed = await renderGridSeed(buildGridSeedSpec(TWO_CELLS, new Map([[101, 'Cortile']])))
    const frames: Buffer[] = []
    const compositor = new GridCompositor({
      plan: TWO_CELLS,
      seed,
      write: (frame) => {
        frames.push(Buffer.from(frame))
        return true
      },
    })
    compositor.tick()
    // `equals`, not `toEqual`: these buffers are 345 KB, and a failed
    // structural comparison of two of them spends minutes building a diff
    // nobody can read. A boolean fails in a millisecond and says the same.
    expect(frames[0]?.equals(seed)).toBe(true)
  })

  it('still ticks when there is no seed to paint', () => {
    const frames: Buffer[] = []
    const compositor = new GridCompositor({
      plan: TWO_CELLS,
      seed: null,
      write: (frame) => {
        frames.push(Buffer.from(frame))
        return true
      },
    })
    compositor.tick()
    expect(frames[0]).toHaveLength(yuv420pSize(640, 360))
    expect(frames[0]?.[0]).toBe(0)
  })

  it('lets a tile that DOES arrive overwrite its card', async () => {
    const seed = await renderGridSeed(buildGridSeedSpec(TWO_CELLS, new Map([[101, 'Cortile']])))
    const frames: Buffer[] = []
    const compositor = new GridCompositor({
      plan: TWO_CELLS,
      seed,
      write: (frame) => {
        frames.push(Buffer.from(frame))
        return true
      },
    })
    const tile = TWO_CELLS.tiles[0]
    if (!tile) throw new Error('the fixture must have a tile')
    compositor.onTile(tile.id, Buffer.alloc(tile.frameBytes, 90))
    compositor.tick()
    const frame = frames[0]
    if (!frame) throw new Error('the tick must have emitted a frame')
    // The arrived tile's own pixels, and the other cell still on its card.
    expect(frame[0]).toBe(90)
    expect(frame[TWO_CELLS.canvas.width - 2]).toBe(seed[TWO_CELLS.canvas.width - 2])
  })
})
