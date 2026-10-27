/**
 * The mosaic: N stored best-shots laid out as one image.
 *
 * ## The mosaic is ALWAYS CLEAN
 *
 * No detection boxes. Not "boxes off by default" — the media ladder in
 * `summary-selection.ts` refuses `fullFrameBoxed` outright and nothing here
 * draws a rectangle. The operator asked for it in those words, and there are
 * two further reasons worth writing down so nobody adds them back as a
 * convenience:
 *
 *  - a burnt-in box is permanent. A tile is a durable artefact and a mosaic is
 *    a thing an operator re-reads days later; a box drawn from a detection that
 *    was wrong cannot be un-drawn;
 *  - for P2 it is an attack surface. Anything rendered INTO the pixels is text
 *    the model reads as scene content, and D121 is this repo's record of a
 *    model treating in-frame text as instruction. Boxes stay DATA — the
 *    artefact can carry them, the picture never does.
 *
 * ## …and by default it carries NO TEXT EITHER
 *
 * {@link mosaicTextPlan} is the ONE place that decides whether a word is drawn,
 * and with no `captions` on the rule the answer is "none": tile labels off,
 * title band off. Same argument as the boxes, one step further — the operator
 * asked for a wall of pictures, a burnt-in caption cannot be un-drawn, and the
 * label strip covers 14% of every tile with the part of the frame nearest the
 * ground, which is where feet, wheels and parcels are.
 *
 * Nothing is lost by it. The AI pass never sees this image:
 * `summary-producer.ts#analyse` hands the model the RAW per-track JPEGs and
 * `summary-ai.ts#buildSummaryAiPrompt` supplies camera name, class and time as
 * PROMPT TEXT. The tile rectangles stay exported (see {@link mosaicLayout}) so
 * a viewer can still say what a tile is without a word being burnt into it.
 *
 * ## sharp, and never ffmpeg `drawtext`
 *
 * Labels, WHEN ASKED FOR, are composited as SVG through sharp. D118 forbids `drawtext` because
 * the hub carries two ffmpeg builds that disagree about libfreetype, so a
 * caption would appear or vanish depending on which node rendered it. sharp is
 * a direct dependency of this addon and its text path is librsvg, which is the
 * same one the timelapse preview already uses.
 *
 * The geometry helpers are pure and exported: {@link mosaicGrid} and
 * {@link mosaicLayout} answer the tile rectangles WITHOUT touching a pixel,
 * which is what lets the layout be tested and what a future clickable-tile
 * viewer will read.
 */

import { eventKindLabel, type EventKindLabelLocale, type IScopedLogger } from '@camstack/types'
import sharp from 'sharp'

/** Widest mosaic produced. 1920 keeps a 3×3 grid at 640 px a tile — readable
 *  on a phone, and a ~200 KB JPEG that every notifier accepts. */
const MOSAIC_MAX_WIDTH = 1920
const MOSAIC_QUALITY = 82
/** The canvas behind a tile whose aspect does not fill its cell. */
export const MOSAIC_BACKGROUND = { r: 17, g: 17, b: 17 }
/** Tile aspect — cameras are 16:9 and a square cell would letterbox every one. */
const TILE_ASPECT = 9 / 16
/** Height of the per-tile label strip, as a fraction of the tile height. */
const LABEL_BAND_FRACTION = 0.14
const LABEL_MIN_PX = 11
/** Height of the mosaic's own title band, as a fraction of a tile's height. */
const TITLE_BAND_FRACTION = 0.22
const TITLE_MIN_PX = 16

/**
 * Average glyph width as a fraction of the font size, for bold sans-serif.
 *
 * An ESTIMATE, and it has to be: librsvg lays the text out long after this
 * string is written, so there are no metrics to measure against. The same
 * number and the same reasoning as `preview-frame.ts#fitTitle` — deliberately
 * GENEROUS, because a label that shrank slightly more than it had to is
 * invisible and one that overflowed runs into the tile beside it. The first
 * live mosaic did exactly that: `Camera cortile · 07:49 · animal` was cut
 * to `…· anima` at the tile edge, mid-word.
 */
const GLYPH_ADVANCE = 0.56
/** Fraction of the band a label may occupy, leaving the padding either side. */
const LABEL_USABLE_FRACTION = 0.94

/** `<`, `>`, `&`, `'`, `"` in a camera name or an operator caption would each
 *  turn the overlay into a document librsvg refuses. */
function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (ch) => {
    switch (ch) {
      case '<':
        return '&lt;'
      case '>':
        return '&gt;'
      case '&':
        return '&amp;'
      case "'":
        return '&apos;'
      default:
        return '&quot;'
    }
  })
}

/**
 * How much TEXT the mosaic carries.
 *
 *  - `none` — pictures only. Every word this file can draw is suppressed: the
 *    per-tile label strip AND the title band, whatever `caption` says.
 *  - `tiles` — the per-tile `camera · HH:MM · class` strip, no title band.
 *  - `all` — both.
 */
export type MosaicCaptions = 'none' | 'tiles' | 'all'

/** Which of this renderer's two text layers are drawn. */
export interface MosaicTextPlan {
  readonly tileLabels: boolean
  readonly titleBand: boolean
}

/**
 * The single decision about drawn text — and the home of the DEFAULT.
 *
 * `undefined` means `none`, not `all`: a rule stored before this option existed
 * has no `captions` key, and the operator's request is that such a rule deliver
 * pictures. The schema materialises the same default on read
 * (`NcSummaryRuleInputSchema`), so this arm only fires for a caller that never
 * had a rule — the test bridge and the spec. Both agreeing is the point.
 */
export function mosaicTextPlan(captions: MosaicCaptions | undefined): MosaicTextPlan {
  if (captions === 'all') return { tileLabels: true, titleBand: true }
  if (captions === 'tiles') return { tileLabels: true, titleBand: false }
  return { tileLabels: false, titleBand: false }
}

/** Grid shape for `n` tiles: as square as possible, rows never exceeding cols
 *  by more than one — a 3×3 for nine, a 3×2 for five, never a 1×9 strip.
 *
 *  `rows` is the load-bearing half — it is how many rows {@link mosaicRowCounts}
 *  distributes into. `cols` describes the WIDEST row, and is no longer a cell
 *  count: see {@link mosaicRowCounts} for why a `cols × rows` grid was the bug. */
export function mosaicGrid(n: number): {
  readonly cols: number
  readonly rows: number
} {
  const count = Math.max(1, Math.floor(n))
  const cols = Math.ceil(Math.sqrt(count))
  return { cols, rows: Math.ceil(count / cols) }
}

/**
 * How many tiles each ROW carries, top to bottom — and the reason the mosaic
 * can no longer have a hole in it.
 *
 * The layout used to be a `cols × rows` GRID, and a grid holds more cells than
 * tiles for every count that is not a perfect fit: 3 into a 2×2, 5 into a 3×2,
 * 7 and 8 into a 3×3. The composite only ever wrote the tiles, so the spare
 * cells stayed the canvas — `MOSAIC_BACKGROUND`, rgb 17 — and the operator's
 * three-tile digest was a quarter black. Measured on the shipped renderer:
 * 24.8% of a three-tile mosaic was background. His words: *"se ci sono 3
 * elementi non dovrebbe renderizzare buchi neri"*.
 *
 * Counting ROWS instead removes the failure by construction rather than by
 * patching it. Every row spans the full width and divides it among the tiles it
 * actually has, so a row is full whatever the remainder and there is no such
 * thing as a spare cell. The shapes fall out of it, and they are the ones asked
 * for: 1 ⇒ full frame, 2 ⇒ side by side, 3 ⇒ one big over two small, 4 ⇒ 2×2.
 *
 * **The fewer-tiled row comes FIRST.** Tiles arrive in the selection's order,
 * so row 0 is the head of the ranking; putting the remainder at the top would
 * make the WORST tile the big one.
 *
 * Every cell keeps {@link TILE_ASPECT}, so rows differ in height — which is
 * also what stops the letterbox: a full-width hero tile is 16:9 exactly, not a
 * 16:9 picture centred in a double-height cell with bars over and under it.
 */
export function mosaicRowCounts(n: number): readonly number[] {
  const count = Math.max(1, Math.floor(n))
  const { rows } = mosaicGrid(count)
  const base = Math.floor(count / rows)
  const remainder = count % rows
  const counts: number[] = []
  for (let row = 0; row < rows; row += 1) {
    counts.push(row < rows - remainder ? base : base + 1)
  }
  return counts
}

/** One tile's rectangle inside the finished mosaic, in mosaic pixels. */
export interface MosaicTileRect {
  readonly index: number
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

export interface MosaicLayout {
  readonly width: number
  readonly height: number
  /** The WIDEST row's tile count. Not a cell count — see {@link mosaicRowCounts}. */
  readonly cols: number
  readonly rows: number
  /** How many tiles each row carries, top to bottom. Sums to the tile count. */
  readonly rowCounts: readonly number[]
  /** Row 0's cell size. Rows differ in height whenever they differ in count, so
   *  these describe the FIRST row and are exact only for a uniform layout; the
   *  per-tile rectangles in {@link tiles} are the authority. */
  readonly tileWidth: number
  readonly tileHeight: number
  /** 0 when the mosaic carries no caption. */
  readonly titleHeight: number
  readonly tiles: readonly MosaicTileRect[]
}

/**
 * Where every tile lands. Pure — no bytes, no sharp, no clock.
 *
 * Exported because the rectangles are DATA the artefact should carry: a viewer
 * that wants a tappable mosaic reads these rather than re-deriving a layout
 * that could drift from the one actually rendered.
 *
 * The rectangles COVER the picture area exactly — that is the property the
 * spec asserts, and it is the one the old grid broke.
 */
export function mosaicLayout(input: {
  readonly tileCount: number
  readonly maxWidth?: number
  readonly withTitle?: boolean
}): MosaicLayout {
  const rowCounts = mosaicRowCounts(input.tileCount)
  // The mosaic is exactly `maxWidth` wide: every row divides that width among
  // its own tiles, so no rounding can leave a background stripe down the edge.
  const width = Math.max(1, Math.floor(input.maxWidth ?? MOSAIC_MAX_WIDTH))
  const firstRowCount = rowCounts[0] ?? 1
  const tileWidth = Math.floor(width / firstRowCount)
  const tileHeight = Math.round(tileWidth * TILE_ASPECT)
  const titleHeight = input.withTitle === true ? Math.round(tileHeight * TITLE_BAND_FRACTION) : 0

  const tiles: MosaicTileRect[] = []
  let y = titleHeight
  let index = 0
  for (const count of rowCounts) {
    const nominalWidth = Math.floor(width / count)
    // Row height comes from the NOMINAL cell, so every tile in a row is the
    // same height even when the last one absorbs a stray pixel or two.
    const rowHeight = Math.round(nominalWidth * TILE_ASPECT)
    let x = 0
    for (let inRow = 0; inRow < count; inRow += 1) {
      // The last tile of the row takes whatever the division left over.
      const w = inRow === count - 1 ? width - x : nominalWidth
      tiles.push({ index, x, y, w, h: rowHeight })
      x += w
      index += 1
    }
    y += rowHeight
  }

  return {
    width,
    height: y,
    cols: Math.max(...rowCounts),
    rows: rowCounts.length,
    rowCounts,
    tileWidth,
    tileHeight,
    titleHeight,
    tiles,
  }
}

/** One tile's source: the stored JPEG, and the words drawn UNDER it. */
export interface MosaicTileInput {
  readonly jpeg: Buffer
  /** `camera · HH:MM · class` — composed by the caller, escaped here. Absent
   *  or `''` ⇒ no strip on this tile, whatever {@link MosaicCaptions} says. */
  readonly label?: string
  /** Tag for the log line when this tile cannot be decoded. */
  readonly deviceId: number
  /** Tag for the log line — a track id for a digest tile, a camera id for a
   *  sensor tile. */
  readonly sourceId: string
}

/** Which notification the mosaic belongs to — names it in every log line. `grouped` is
 *  the one message of a grouped immediate window (D692 §6.2), one tile per subject. */
export type MosaicPurpose = 'summary' | 'sensor' | 'grouped'

export interface MosaicRenderRequest {
  readonly purpose: MosaicPurpose
  readonly tiles: readonly MosaicTileInput[]
  /** Burned onto the top band. `''`, absent, or `captions` short of `all`
   *  ⇒ no band at all. */
  readonly caption?: string
  /** Absent ⇒ `none`. See {@link mosaicTextPlan}. */
  readonly captions?: MosaicCaptions
  readonly maxWidth?: number
}

export interface MosaicRenderResult {
  readonly jpeg: Buffer
  readonly layout: MosaicLayout
  /** Tiles whose source bytes sharp could not read — dropped, never blank. */
  readonly droppedTiles: number
  /** The `sourceId` of every tile that IS in the picture, in the order offered. A caller
   *  that judges the tiles (grouped confirm, D692) judges exactly these. */
  readonly composedSourceIds: readonly string[]
}

/** A single line of text laid out for the box it must fit inside. */
export interface FittedLine {
  readonly text: string
  readonly fontPx: number
}

/**
 * Shrink, then ELIDE, until the line fits `usablePx`.
 *
 * Shrinking is tried first because a slightly smaller label still says
 * everything; only past `minPx` is the tail cut, and then with an ellipsis so
 * the reader can SEE that something was cut. The failure this replaces was
 * silent: SVG simply clips at the viewport, so an overlong label lost its last
 * word mid-glyph and looked like a rendering bug rather than a truncation.
 *
 * Pure and exported so the arithmetic is testable without rendering a pixel.
 */
export function fitLine(text: string, usablePx: number, basePx: number, minPx: number): FittedLine {
  const flat = text.trim().replace(/\s+/g, ' ')
  const fits = (s: string, fontPx: number): boolean => s.length * fontPx * GLYPH_ADVANCE <= usablePx
  let fontPx = Math.max(minPx, Math.round(basePx))
  while (fontPx > minPx && !fits(flat, fontPx)) {
    fontPx = Math.max(minPx, fontPx - 1)
  }
  if (fits(flat, fontPx)) return { text: flat, fontPx }
  const budget = Math.max(1, Math.floor(usablePx / (fontPx * GLYPH_ADVANCE)))
  return { text: `${flat.slice(0, Math.max(1, budget - 1)).trimEnd()}…`, fontPx }
}

/**
 * The words drawn on a summary tile: camera, clock, and the class vocabulary
 * in the hub language. A class the vocabulary does not know stays the wire id.
 */
export function summaryTileCaption(
  camera: string,
  clock: string,
  className: string,
  locale: EventKindLabelLocale,
): string {
  return `${camera} · ${clock} · ${eventKindLabel(className, locale)}`
}

/** The label strip drawn across the bottom of one tile. */
function tileLabelSvg(width: number, height: number, label: string): Buffer<ArrayBuffer> {
  const bandHeight = Math.max(18, Math.round(height * LABEL_BAND_FRACTION))
  const basePx = Math.round(bandHeight * 0.62)
  const padding = Math.round(basePx * 0.6)
  const fitted = fitLine(label, width * LABEL_USABLE_FRACTION - padding, basePx, LABEL_MIN_PX)
  const baseline =
    height - Math.round((bandHeight - fitted.fontPx) / 2) - Math.round(fitted.fontPx * 0.18)
  return Buffer.from(
    `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
  <rect x="0" y="${height - bandHeight}" width="${width}" height="${bandHeight}" fill="black" fill-opacity="0.55"/>
  <text x="${padding}" y="${baseline}" font-size="${fitted.fontPx}" font-family="sans-serif" font-weight="bold" fill="white">${escapeXml(fitted.text)}</text>
</svg>`,
  )
}

/** The mosaic's own title band. */
function titleSvg(width: number, height: number, caption: string): Buffer<ArrayBuffer> {
  const fitted = fitLine(
    caption,
    width * LABEL_USABLE_FRACTION,
    Math.round(height * 0.5),
    TITLE_MIN_PX,
  )
  const baseline = Math.round(height / 2 + fitted.fontPx * 0.36)
  return Buffer.from(
    `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
  <rect x="0" y="0" width="${width}" height="${height}" fill="#111111"/>
  <text x="${Math.round(width / 2)}" y="${baseline}" font-size="${fitted.fontPx}" font-family="sans-serif" font-weight="bold" text-anchor="middle" fill="white">${escapeXml(fitted.text)}</text>
</svg>`,
  )
}

/**
 * Compose the mosaic.
 *
 * Every tile is fitted with `contain` onto the cell background rather than
 * cropped: a `cover` fit would silently cut the subject out of a portrait crop,
 * and a tile that does not show what it is about is worse than a letterboxed
 * one.
 *
 * A tile sharp cannot read is DROPPED and counted, never composited as a blank
 * cell — a black square in a digest reads as "the camera saw nothing", which is
 * the opposite of what happened. The layout is computed from the SURVIVORS, and
 * because {@link mosaicRowCounts} counts rows rather than grid cells there is no
 * remainder to leave empty either.
 *
 * @throws when every tile was dropped, and when sharp cannot produce the final
 *         canvas at all; the caller treats both as "no mosaic" and still
 *         delivers the counts.
 */
export async function renderMosaic(
  request: MosaicRenderRequest,
  logger: IScopedLogger,
): Promise<MosaicRenderResult> {
  const plan = mosaicTextPlan(request.captions)
  // Which sources sharp can actually READ, decided BEFORE any rectangle is
  // computed. The layout is a function of the survivors, so a dropped tile
  // changes the shape of the mosaic instead of leaving its cell empty.
  const usable: MosaicTileInput[] = []
  for (const tile of request.tiles) {
    try {
      await sharp(tile.jpeg).metadata()
      usable.push(tile)
    } catch (err: unknown) {
      // Named per camera: a digest that quietly lost a tile is a digest whose
      // counts and picture disagree, and nothing would say which was right.
      logger.warn(`${request.purpose} mosaic: a tile could not be decoded and was dropped`, {
        tags: { deviceId: tile.deviceId },
        // A digest's or a grouped message's tile is a TRACK and keeps the field
        // its saved queries read (`meta.trackId`); a sensor tile is a camera,
        // already the tag.
        meta: {
          ...(request.purpose === 'summary' || request.purpose === 'grouped'
            ? { trackId: tile.sourceId }
            : { sourceId: tile.sourceId }),
          error: String(err),
        },
      })
    }
  }

  const droppedTiles = request.tiles.length - usable.length
  if (usable.length === 0) {
    // Never a canvas on its own. `mosaicLayout` would happily answer with one
    // empty cell, and that renders as a 1920×1080 rectangle of
    // `MOSAIC_BACKGROUND` — a picture that says "the cameras saw nothing" on a
    // window that was not quiet at all. The caller catches this and ships the
    // digest with its counts, which is the honest outcome.
    throw new Error(
      `${request.purpose} mosaic: no tile could be decoded (${request.tiles.length} offered)`,
    )
  }

  // The gate is here and not at the composite below, so the LAYOUT never
  // reserves a band it will not fill: a reserved-but-empty title band is a
  // black stripe across the top of the digest, which is worse than the words.
  const caption = plan.titleBand ? (request.caption?.trim() ?? '') : ''
  const layout = mosaicLayout({
    tileCount: usable.length,
    ...(request.maxWidth !== undefined ? { maxWidth: request.maxWidth } : {}),
    withTitle: caption.length > 0,
  })

  // ONE resize per tile, straight onto its OWN rectangle. Rows differ in cell
  // size, so there is no single "tile size" to fit against — the rectangle is
  // the only thing that describes where a tile is going, and re-fitting through
  // a nominal size would letterbox every row but the first.
  const composites = await Promise.all(
    usable.map(async (tile, index) => {
      const rect = layout.tiles[index]
      if (rect === undefined) throw new Error(`${request.purpose} mosaic: layout lost a tile`)
      const label = plan.tileLabels ? (tile.label?.trim() ?? '') : ''
      const fitted = sharp(tile.jpeg).resize({
        width: rect.w,
        height: rect.h,
        fit: 'contain',
        background: MOSAIC_BACKGROUND,
      })
      // No `.composite([])` on the pictures-only path: an empty composite is
      // still a composite, and the point of `none` is that the tile is the
      // stored frame and nothing else.
      const input = await (label.length === 0
        ? fitted
        : fitted.composite([{ input: tileLabelSvg(rect.w, rect.h, label), top: 0, left: 0 }])
      )
        .jpeg({ quality: MOSAIC_QUALITY })
        .toBuffer()
      return { input, top: rect.y, left: rect.x }
    }),
  )

  if (caption.length > 0 && layout.titleHeight > 0) {
    composites.unshift({
      input: titleSvg(layout.width, layout.titleHeight, caption),
      top: 0,
      left: 0,
    })
  }

  const jpeg = await sharp({
    create: {
      width: layout.width,
      height: layout.height,
      channels: 3,
      background: MOSAIC_BACKGROUND,
    },
  })
    .composite(composites)
    .jpeg({ quality: MOSAIC_QUALITY })
    .toBuffer()

  return { jpeg, layout, droppedTiles, composedSourceIds: usable.map((t) => t.sourceId) }
}
