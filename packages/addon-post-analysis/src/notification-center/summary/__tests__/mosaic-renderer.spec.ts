import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import {
  makeLogRecorder,
  makeSilentLogger,
} from '../../../pipeline-analytics/__tests__/test-helpers.js'
import {
  fitLine,
  MOSAIC_BACKGROUND,
  mosaicGrid,
  mosaicLayout,
  mosaicRowCounts,
  mosaicTextPlan,
  renderMosaic,
} from '../mosaic-renderer.js'

async function solidJpeg(width: number, height: number, r: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r, g: 40, b: 60 } },
  })
    .jpeg()
    .toBuffer()
}

/**
 * The mean channel value of a horizontal strip of the FINISHED mosaic.
 *
 * The only way to assert "nothing wrote text" that a future refactor cannot
 * fool: every text this renderer draws sits on an opaque or half-opaque band,
 * so a strip that carries one is measurably darker than the solid tile around
 * it. Asserting on the SVG strings instead would pass the day somebody draws a
 * label some other way.
 */
async function stripMean(jpeg: Buffer, top: number, height: number): Promise<number> {
  const meta = await sharp(jpeg).metadata()
  const { data } = await sharp(jpeg)
    .extract({ left: 0, top, width: meta.width ?? 1, height })
    .raw()
    .toBuffer({ resolveWithObject: true })
  let sum = 0
  for (const value of data) sum += value
  return sum / data.length
}

/**
 * The fraction of the finished mosaic that is still the CANVAS — i.e. a cell
 * the composite never wrote.
 *
 * Measured in pixels rather than by reading the layout back, because the layout
 * is the thing under test: an assertion that re-derives the grid would agree
 * with a renderer that reserved a cell and left it empty. The tolerance covers
 * JPEG ringing along the tile seams, which is a line of pixels, never a cell.
 */
async function backgroundFraction(jpeg: Buffer): Promise<number> {
  const { data, info } = await sharp(jpeg).raw().toBuffer({ resolveWithObject: true })
  const { r, g, b } = MOSAIC_BACKGROUND
  let background = 0
  for (let i = 0; i + 2 < data.length; i += info.channels) {
    if (
      Math.abs((data[i] ?? 0) - r) <= 12 &&
      Math.abs((data[i + 1] ?? 0) - g) <= 12 &&
      Math.abs((data[i + 2] ?? 0) - b) <= 12
    ) {
      background += 1
    }
  }
  return background / (info.width * info.height)
}

describe('mosaicGrid', () => {
  it('is as square as possible', () => {
    expect(mosaicGrid(1)).toEqual({ cols: 1, rows: 1 })
    expect(mosaicGrid(4)).toEqual({ cols: 2, rows: 2 })
    expect(mosaicGrid(5)).toEqual({ cols: 3, rows: 2 })
    expect(mosaicGrid(9)).toEqual({ cols: 3, rows: 3 })
    expect(mosaicGrid(10)).toEqual({ cols: 4, rows: 3 })
  })
  it('never produces a strip', () => {
    expect(mosaicGrid(0)).toEqual({ cols: 1, rows: 1 })
  })
})

/**
 * The operator's report, verbatim: *"se ci sono 3 elementi non dovrebbe
 * renderizzare buchi neri"*.
 *
 * A grid of `cols × rows` cells holds MORE cells than tiles for every count
 * that is not a perfect fit — 3 into a 2×2, 5 into a 3×2, 7 and 8 into a 3×3 —
 * and the composite only ever wrote the tiles. The remainder stayed the canvas
 * background, which is `MOSAIC_BACKGROUND` (rgb 17) and reads on a phone as a
 * dead camera. Rows are counted instead: every row spans the FULL width, so a
 * row is full by construction and there is no such thing as a spare cell.
 */
describe('mosaicRowCounts', () => {
  it('gives the operator the shapes he asked for', () => {
    expect(mosaicRowCounts(1)).toEqual([1]) // one, full
    expect(mosaicRowCounts(2)).toEqual([2]) // two, side by side
    expect(mosaicRowCounts(3)).toEqual([1, 2]) // one BIG, two small
    expect(mosaicRowCounts(4)).toEqual([2, 2]) // 2×2
  })

  it('puts the fewer-tiled row FIRST, so the best tile is the big one', () => {
    // Tiles arrive in the selection's order, so row 0 is the head of the
    // ranking. A remainder pushed to the top would make the WORST tile the
    // hero.
    expect(mosaicRowCounts(5)).toEqual([2, 3])
    expect(mosaicRowCounts(7)).toEqual([2, 2, 3])
    expect(mosaicRowCounts(8)).toEqual([2, 3, 3])
  })

  it('never leaves a cell over, for any count a rule can produce', () => {
    // `maxTiles` is bounded at 24 by the rule schema.
    for (let n = 1; n <= 24; n += 1) {
      const counts = mosaicRowCounts(n)
      expect(counts.reduce((s, c) => s + c, 0)).toBe(n)
      expect(counts.every((c) => c >= 1)).toBe(true)
      // Agrees with the grid it replaces: widest row = cols, rows = rows.
      expect({ cols: Math.max(...counts), rows: counts.length }).toEqual(mosaicGrid(n))
    }
  })
})

describe('mosaicLayout', () => {
  it('tiles a 3x3 grid with no gaps and no overlap', () => {
    const layout = mosaicLayout({ tileCount: 9, maxWidth: 1920 })
    expect(layout.cols).toBe(3)
    expect(layout.tileWidth).toBe(640)
    expect(layout.width).toBe(1920)
    expect(layout.titleHeight).toBe(0)
    expect(layout.tiles).toHaveLength(9)
    expect(layout.tiles[0]).toEqual({ index: 0, x: 0, y: 0, w: 640, h: 360 })
    expect(layout.tiles[4]).toEqual({
      index: 4,
      x: 640,
      y: 360,
      w: 640,
      h: 360,
    })
    expect(layout.height).toBe(1080)
  })

  it('pushes every tile below the title band when there is a caption', () => {
    const layout = mosaicLayout({
      tileCount: 4,
      maxWidth: 1280,
      withTitle: true,
    })
    expect(layout.titleHeight).toBeGreaterThan(0)
    expect(layout.tiles.every((t) => t.y >= layout.titleHeight)).toBe(true)
    expect(layout.height).toBe(layout.titleHeight + layout.rows * layout.tileHeight)
  })

  it('lays 3 tiles out as one BIG over two small — no fourth cell exists', () => {
    const layout = mosaicLayout({ tileCount: 3, maxWidth: 1920 })
    expect(layout.tiles).toHaveLength(3)
    expect(layout.tiles[0]).toEqual({ index: 0, x: 0, y: 0, w: 1920, h: 1080 })
    expect(layout.tiles[1]).toEqual({
      index: 1,
      x: 0,
      y: 1080,
      w: 960,
      h: 540,
    })
    expect(layout.tiles[2]).toEqual({
      index: 2,
      x: 960,
      y: 1080,
      w: 960,
      h: 540,
    })
    expect(layout.width).toBe(1920)
    expect(layout.height).toBe(1620)
  })

  /**
   * The property that IS the bug: the rectangles must cover the picture area
   * exactly. Under the old `cols × rows` grid the covered area for 3 tiles was
   * 3/4 of the canvas and the missing quarter was painted background.
   */
  it('covers the whole canvas with no gap and no overlap, for every count', () => {
    for (let n = 1; n <= 24; n += 1) {
      for (const withTitle of [false, true]) {
        const layout = mosaicLayout({
          tileCount: n,
          maxWidth: 1920,
          withTitle,
        })
        expect(layout.tiles).toHaveLength(n)
        const area = layout.tiles.reduce((s, t) => s + t.w * t.h, 0)
        expect(area).toBe(layout.width * (layout.height - layout.titleHeight))
        // Every tile inside the canvas, below the band.
        for (const t of layout.tiles) {
          expect(t.x).toBeGreaterThanOrEqual(0)
          expect(t.y).toBeGreaterThanOrEqual(layout.titleHeight)
          expect(t.x + t.w).toBeLessThanOrEqual(layout.width)
          expect(t.y + t.h).toBeLessThanOrEqual(layout.height)
        }
        // No two tiles overlap.
        for (let i = 0; i < layout.tiles.length; i += 1) {
          for (let j = i + 1; j < layout.tiles.length; j += 1) {
            const a = layout.tiles[i]
            const b = layout.tiles[j]
            if (a === undefined || b === undefined) throw new Error('missing tile')
            const disjoint =
              a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y
            expect(disjoint).toBe(true)
          }
        }
      }
    }
  })

  it('a row always spans the FULL width, whatever the remainder', () => {
    // 1920/7 does not divide: the last tile of the row absorbs the remainder
    // rather than leaving a background stripe down the right-hand edge.
    for (let n = 1; n <= 24; n += 1) {
      const layout = mosaicLayout({ tileCount: n, maxWidth: 1920 })
      const byRow = new Map<number, number>()
      for (const t of layout.tiles) byRow.set(t.y, (byRow.get(t.y) ?? 0) + t.w)
      for (const total of byRow.values()) expect(total).toBe(layout.width)
    }
  })
})

describe('renderMosaic', () => {
  it('produces one decodable JPEG at the laid-out size', async () => {
    const tiles = await Promise.all(
      [0, 1, 2, 3].map(async (i) => ({
        jpeg: await solidJpeg(320, 180, i * 60),
        label: `camera ${i} · 07:0${i} · person`,
        deviceId: 600 + i,
        sourceId: `t-${i}`,
      })),
    )
    const out = await renderMosaic({ purpose: 'summary', tiles, maxWidth: 640 }, makeSilentLogger())
    expect(out.droppedTiles).toBe(0)
    const meta = await sharp(out.jpeg).metadata()
    expect(meta.width).toBe(out.layout.width)
    expect(meta.height).toBe(out.layout.height)
    expect(out.layout.cols).toBe(2)
  })

  /**
   * The operator's defect, end to end and in PIXELS. Three 16:9 tiles, none of
   * them dark: if any part of the finished image is the canvas background then
   * a cell was reserved and never filled.
   */
  it('leaves NO black hole with three tiles', async () => {
    const tiles = await Promise.all(
      [0, 1, 2].map(async (i) => ({
        jpeg: await solidJpeg(320, 180, 180 + i * 20),
        deviceId: 600 + i,
        sourceId: `t-${i}`,
      })),
    )
    const out = await renderMosaic({ purpose: 'summary', tiles, maxWidth: 640 }, makeSilentLogger())
    expect(out.droppedTiles).toBe(0)
    expect(await backgroundFraction(out.jpeg)).toBeLessThan(0.005)
  })

  it('leaves no black hole for ANY tile count', async () => {
    for (const n of [1, 2, 3, 5, 6, 7, 8]) {
      const tiles = await Promise.all(
        Array.from({ length: n }, async (_, i) => ({
          jpeg: await solidJpeg(320, 180, 150 + i * 10),
          deviceId: 600 + i,
          sourceId: `t-${i}`,
        })),
      )
      const out = await renderMosaic(
        { purpose: 'summary', tiles, maxWidth: 640 },
        makeSilentLogger(),
      )
      expect(out.layout.tiles).toHaveLength(n)
      expect(await backgroundFraction(out.jpeg)).toBeLessThan(0.005)
    }
  })

  it('re-shapes around DROPPED tiles instead of leaving their cells empty', async () => {
    // Four sources, one of them unreadable ⇒ a 3-tile mosaic, not a 2×2 with a
    // hole where the corrupt one would have gone.
    const good = await Promise.all(
      [0, 1, 2].map(async (i) => ({
        jpeg: await solidJpeg(320, 180, 170 + i * 20),
        deviceId: 600 + i,
        sourceId: `t-${i}`,
      })),
    )
    const out = await renderMosaic(
      {
        purpose: 'summary',
        tiles: [...good, { jpeg: Buffer.from('not a jpeg'), deviceId: 604, sourceId: 'bad' }],
        maxWidth: 640,
      },
      makeSilentLogger(),
    )
    expect(out.droppedTiles).toBe(1)
    expect(out.layout.tiles).toHaveLength(3)
    expect(await backgroundFraction(out.jpeg)).toBeLessThan(0.005)
  })

  it("a digest's undecodable tile is logged with its TRACK id, under the field saved queries use", async () => {
    const rec = makeLogRecorder()
    const good = { jpeg: await solidJpeg(320, 180, 170), deviceId: 600, sourceId: 't-ok' }
    await renderMosaic(
      {
        purpose: 'summary',
        tiles: [good, { jpeg: Buffer.from('not a jpeg'), deviceId: 604, sourceId: 'trk-bad' }],
        maxWidth: 640,
      },
      rec.logger,
    )
    const line = rec.entries.find((e) => e.message.includes('could not be decoded'))
    expect(line?.extras?.tags).toEqual({ deviceId: 604 })
    expect(line?.extras?.meta).toMatchObject({ trackId: 'trk-bad' })
  })

  it('refuses to compose an all-black mosaic when EVERY tile was dropped', async () => {
    // The caller (`renderAndPublish`) treats a throw as "no mosaic, ship the
    // counts". A 1920×1080 rectangle of `MOSAIC_BACKGROUND` filed as the
    // night's digest is worse than no picture: it reads as "the cameras saw
    // nothing", which is the opposite of what happened.
    await expect(
      renderMosaic(
        {
          purpose: 'summary',
          tiles: [{ jpeg: Buffer.from('nope'), deviceId: 102, sourceId: 'bad' }],
        },
        makeSilentLogger(),
      ),
    ).rejects.toThrow(/no tile/i)
  })

  it('drops an undecodable tile and reshapes the grid rather than leaving a hole', async () => {
    const good = await solidJpeg(320, 180, 200)
    const out = await renderMosaic(
      {
        purpose: 'summary',
        tiles: [
          { jpeg: good, label: 'a', deviceId: 636, sourceId: 'a' },
          {
            jpeg: Buffer.from('not a jpeg'),
            label: 'b',
            deviceId: 637,
            sourceId: 'b',
          },
        ],
        maxWidth: 640,
      },
      makeSilentLogger(),
    )
    expect(out.droppedTiles).toBe(1)
    // One survivor ⇒ a 1×1 grid, not a 2×1 with a black cell.
    expect(out.layout.cols).toBe(1)
    expect(out.layout.tiles).toHaveLength(1)
  })

  it('adds the title band only when a caption is given AND captions are on', async () => {
    const tiles = [
      {
        jpeg: await solidJpeg(320, 180, 10),
        label: 'a',
        deviceId: 636,
        sourceId: 'a',
      },
    ]
    const bare = await renderMosaic(
      { purpose: 'summary', tiles, maxWidth: 640, captions: 'all' },
      makeSilentLogger(),
    )
    const titled = await renderMosaic(
      { purpose: 'summary', tiles, maxWidth: 640, caption: 'Notte 21:00→07:00', captions: 'all' },
      makeSilentLogger(),
    )
    expect(bare.layout.titleHeight).toBe(0)
    expect(titled.layout.titleHeight).toBeGreaterThan(0)
    expect(titled.layout.height).toBeGreaterThan(bare.layout.height)
  })

  it('survives a label carrying XML metacharacters', async () => {
    const tiles = [
      {
        jpeg: await solidJpeg(320, 180, 10),
        label: 'Garden <"&\'> · 07:00',
        deviceId: 636,
        sourceId: 'a',
      },
    ]
    const out = await renderMosaic(
      { purpose: 'summary', tiles, maxWidth: 640, captions: 'all' },
      makeSilentLogger(),
    )
    expect(out.droppedTiles).toBe(0)
  })
})

/**
 * ONLY IMAGES, unless the operator asked otherwise.
 *
 * The operator's words: the digest is a wall of pictures and every burnt-in
 * word is a word he cannot remove afterwards. A caption is permanent in exactly
 * the way a detection box is (see the module docblock), it is the one thing in
 * the artefact that cannot be corrected, and it costs the tile the pixels it
 * covers. So `captions` defaults to `none` and an ABSENT field is `none` too —
 * a rule authored before this option existed gets the pictures, not the text.
 *
 * The AI pass is unaffected by design: `summary-producer.ts#analyse` hands the
 * model the RAW per-track JPEGs, never the mosaic, and the facts that place
 * them (camera name, class, time) travel as prompt text through
 * `buildSummaryAiPrompt`. Nothing the judge reads is drawn.
 */
describe('mosaicTextPlan', () => {
  it('draws NOTHING when the rule does not say — the migration is silent', () => {
    expect(mosaicTextPlan(undefined)).toEqual({ tileLabels: false, titleBand: false })
  })

  it('draws nothing for an explicit none', () => {
    expect(mosaicTextPlan('none')).toEqual({ tileLabels: false, titleBand: false })
  })

  it('tiles labels the cells and leaves the canvas alone', () => {
    expect(mosaicTextPlan('tiles')).toEqual({ tileLabels: true, titleBand: false })
  })

  it('all is the pre-existing behaviour, kept reachable', () => {
    expect(mosaicTextPlan('all')).toEqual({ tileLabels: true, titleBand: true })
  })
})

describe('renderMosaic captions', () => {
  const TILE = { deviceId: 636, sourceId: 'a', label: 'Cortile · 07:49 · person' }

  async function oneTile(
    captions: 'none' | 'tiles' | 'all' | undefined,
  ): Promise<Awaited<ReturnType<typeof renderMosaic>>> {
    return renderMosaic(
      {
        purpose: 'summary',
        tiles: [{ ...TILE, jpeg: await solidJpeg(640, 360, 200) }],
        maxWidth: 640,
        caption: 'Notte 21:00→07:00',
        ...(captions !== undefined ? { captions } : {}),
      },
      makeSilentLogger(),
    )
  }

  it('a defaulted mosaic carries NO title band, whatever the caption says', async () => {
    const out = await oneTile(undefined)
    expect(out.layout.titleHeight).toBe(0)
    expect(out.layout.height).toBe(out.layout.tileHeight)
  })

  it('the bottom of a defaulted tile is the PICTURE — no label strip was drawn', async () => {
    const out = await oneTile(undefined)
    const band = Math.max(18, Math.round(out.layout.tileHeight * 0.14))
    const bottom = await stripMean(out.jpeg, out.layout.height - band, band)
    const middle = await stripMean(out.jpeg, Math.round(out.layout.tileHeight * 0.4), band)
    // A solid tile: every strip of it is the same colour. A label strip is a
    // 55%-opaque black band with white glyphs on it and cannot be within 3.
    expect(Math.abs(bottom - middle)).toBeLessThan(3)
  })

  it('an explicit none is the same as no field at all', async () => {
    const out = await oneTile('none')
    const band = Math.max(18, Math.round(out.layout.tileHeight * 0.14))
    const bottom = await stripMean(out.jpeg, out.layout.height - band, band)
    const middle = await stripMean(out.jpeg, Math.round(out.layout.tileHeight * 0.4), band)
    expect(out.layout.titleHeight).toBe(0)
    expect(Math.abs(bottom - middle)).toBeLessThan(3)
  })

  // The negative control. Remove the `captions` gate in the renderer and the
  // two tests above go green off this one's behaviour — which is the whole
  // reason it is here.
  it('captions=tiles DOES darken the bottom strip, and still adds no band', async () => {
    const out = await oneTile('tiles')
    const band = Math.max(18, Math.round(out.layout.tileHeight * 0.14))
    const bottom = await stripMean(out.jpeg, out.layout.height - band, band)
    const middle = await stripMean(out.jpeg, Math.round(out.layout.tileHeight * 0.4), band)
    expect(out.layout.titleHeight).toBe(0)
    expect(middle - bottom).toBeGreaterThan(10)
  })

  it('captions=all restores the title band as well', async () => {
    const out = await oneTile('all')
    expect(out.layout.titleHeight).toBeGreaterThan(0)
  })

  it('a tile with no label draws no strip even when captions are on', async () => {
    const out = await renderMosaic(
      {
        purpose: 'summary',
        tiles: [{ deviceId: 636, sourceId: 'a', jpeg: await solidJpeg(106, 360, 200) }],
        maxWidth: 640,
        captions: 'tiles',
      },
      makeSilentLogger(),
    )
    const band = Math.max(18, Math.round(out.layout.tileHeight * 0.14))
    const bottom = await stripMean(out.jpeg, out.layout.height - band, band)
    const middle = await stripMean(out.jpeg, Math.round(out.layout.tileHeight * 0.4), band)
    expect(Math.abs(bottom - middle)).toBeLessThan(3)
  })
})

describe('fitLine', () => {
  it('leaves a line that already fits untouched', () => {
    const out = fitLine('Cortile · 07:49 · animal', 600, 30, 11)
    expect(out.text).toBe('Cortile · 07:49 · animal')
    expect(out.fontPx).toBe(30)
  })

  it('SHRINKS before it cuts — the whole label still says everything', () => {
    const out = fitLine('Camera cortile · 07:49 · animal', 300, 30, 11)
    expect(out.fontPx).toBeLessThan(30)
    expect(out.text).toBe('Camera cortile · 07:49 · animal')
  })

  it('elides with an ellipsis once shrinking has bottomed out', () => {
    // The live defect: SVG clips at the viewport, so an overlong label lost its
    // last word mid-glyph and read as a rendering bug rather than a truncation.
    const out = fitLine('Camera cortile · 07:49 · animal', 60, 30, 11)
    expect(out.fontPx).toBe(11)
    expect(out.text.endsWith('…')).toBe(true)
    expect(out.text.length).toBeLessThan('Camera cortile · 07:49 · animal'.length)
  })

  it('never answers an empty string, however narrow the box', () => {
    const out = fitLine('Camera cortile', 1, 30, 11)
    expect(out.text.length).toBeGreaterThan(0)
  })

  it('collapses runs of whitespace so the estimate matches what is drawn', () => {
    expect(fitLine('  a   b  ', 600, 20, 11).text).toBe('a b')
  })
})
