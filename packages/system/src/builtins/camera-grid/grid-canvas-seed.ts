/**
 * What the canvas SAYS before a single camera has delivered a frame.
 *
 * ## Why black was not good enough
 *
 * The compositor emits from its very first tick (`grid-compositor.ts`) — that
 * is the whole point of a canvas, and it is what removed the ~9 s cold start.
 * But what it emitted until now was black, and black is the same picture for
 * four different situations: a grid with no cells, a grid whose sources are all
 * broken, a grid whose sources are merely slow, and a viewer that connected to
 * the wrong camera. An operator cannot tell them apart, and the one they
 * actually hit — sources still opening — is the one that fixes itself.
 *
 * The seed paints the LAYOUT instead: one card per cell, at the cell's own
 * rectangle, carrying the camera's name and the word `Waiting`. Three states
 * become three pictures — "no cards" is an empty grid, "a card still there" is
 * a tile that has not arrived, and "a picture" is a tile that has.
 *
 * It is honest about what it is. It is not a stand-in picture of the camera,
 * and it never carries a state it has not been told (a tile whose source is
 * genuinely broken is a matter for the tile's own decoder and its logs — this
 * says only "nothing has arrived here yet", which is true of both).
 *
 * ## Drawn ONCE, before the tick exists
 *
 * The seed is a full-canvas frame blitted in at the compositor's construction,
 * so the first tick already carries it and the tick never waits on anything.
 * Rendering it is the only asynchronous part, and it happens BEFORE the
 * compositor is built — never on the tick, which serves every cell.
 *
 * ## Why SVG → sharp, and why the conversion is here
 *
 * `snapshot-courtesy.ts` already renders text this way and states the reason:
 * shelling out to ffmpeg's `drawtext` was 52 ms against sharp's 4.8 ms, and an
 * SVG names a font FAMILY that fontconfig resolves instead of a font PATH that
 * has to be probed. This is that pattern, not a second one.
 *
 * What is different is the output. The canvas is yuv420p — that is what makes a
 * blit a strided memcpy — and sharp has no yuv output, so the raster is
 * converted once, here, by `rgbToYuv420p`. Once per composition start, over a
 * frame that is already being allocated; never per tick.
 *
 * ## Even, like everything else that touches the canvas
 *
 * The cards are the TILES' own rectangles, which `buildGridTilePlan` has
 * already snapped to even pixels — yuv420p subsamples chroma 2×2, and an odd
 * rectangle tints a tile rather than breaking it. Nothing here re-derives a
 * rectangle; it copies the one the decoder was sized against, so a card cannot
 * land anywhere other than exactly where its picture will.
 */
import { yuv420pSize, type PixelOrigin, type PixelSize } from './grid-canvas.js'
import type { GridTilePlan } from './grid-tile-plan.js'

/**
 * The word a card carries. Deliberately not a fault: nothing has arrived YET,
 * which is true of a camera that is slow and of one that is broken, and this
 * placeholder knows which it is for neither.
 */
export const GRID_SEED_WAITING_LABEL = 'Waiting'

/**
 * Family names, not paths — librsvg resolves them through fontconfig, and the
 * trailing generics keep a host without DejaVu rendering something legible
 * rather than nothing. Same stack as the courtesy frame, for the same reason.
 */
const SEED_FONT_STACK = 'DejaVu Sans,DejaVu Sans Mono,Helvetica,Arial,sans-serif'

/** The card. Dark enough to read as "empty", lit enough to read as "a cell". */
const CARD_FILL = '#1b1b21'
const CARD_BORDER = '#3f3f4c'
const CARD_NAME = '#e8e8ee'
const CARD_STATE = '#8f8f9e'

export interface GridSeedCell {
  readonly origin: PixelOrigin
  readonly size: PixelSize
  /** What the card is labelled with — a camera name, or its id. */
  readonly name: string
}

export interface GridSeedSpec {
  readonly canvas: PixelSize
  readonly cells: readonly GridSeedCell[]
}

/**
 * The label for one source.
 *
 * A name we could not read is not a reason to paint an anonymous rectangle: the
 * DEVICE ID is what every log line about that tile carries, so it is the one
 * label an operator can act on. A blank or whitespace name is treated as no
 * name for the same reason.
 */
export function gridSeedName(names: ReadonlyMap<number, string>, deviceId: number): string {
  const name = names.get(deviceId)?.trim()
  return name === undefined || name.length === 0 ? `Camera ${String(deviceId)}` : name
}

/**
 * The seed a tile plan implies — pure, and the plan is the ONLY input to the
 * geometry. A card is its tile's rectangle, never a recomputed one.
 */
export function buildGridSeedSpec(
  plan: GridTilePlan,
  names: ReadonlyMap<number, string>,
): GridSeedSpec {
  return {
    canvas: plan.canvas,
    cells: plan.tiles.map((tile) => ({
      origin: tile.origin,
      size: tile.size,
      name: gridSeedName(names, tile.deviceId),
    })),
  }
}

/** XML escaping for text placed inside an SVG `<text>` node. */
function escapeSeedText(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

/**
 * The document the seed is rasterized from.
 *
 * No full-bleed background: the uncovered part of a canvas is NOT a cell — the
 * cells need not cover it (`grid-canvas-derivation.ts`) — and painting a card's
 * treatment over it would say "waiting" about a tile that does not exist. It
 * stays the canvas' own black.
 *
 * Each card clips its own text. A camera named for a whole street would
 * otherwise spill across the cell next to it, and a label on the wrong tile is
 * worse than a truncated one.
 */
export function buildGridSeedSvg(spec: GridSeedSpec): string {
  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${String(spec.canvas.width)}" height="${String(spec.canvas.height)}">`,
  ]
  for (const [index, cell] of spec.cells.entries()) {
    const { width, height } = cell.size
    // Sized off the SMALLER edge so a wide, short strip does not ask for text
    // taller than the card it sits in.
    const nameSize = Math.max(9, Math.min(Math.round(width / 12), Math.round(height / 8)))
    const stateSize = Math.max(8, Math.round(nameSize * 0.62))
    // The stroke is inset by half its width: a stroke is centred on the edge,
    // and the half outside the card would land on the neighbouring cell.
    const stroke = Math.max(2, Math.round(Math.min(width, height) / 100))
    const inset = stroke / 2
    const centreX = cell.origin.x + width / 2
    const centreY = cell.origin.y + height / 2
    const clipId = `seed-cell-${String(index)}`
    parts.push(
      `<clipPath id="${clipId}"><rect x="${String(cell.origin.x)}" y="${String(cell.origin.y)}" width="${String(width)}" height="${String(height)}"/></clipPath>`,
      `<rect x="${String(cell.origin.x + inset)}" y="${String(cell.origin.y + inset)}" width="${String(width - stroke)}" height="${String(height - stroke)}" fill="${CARD_FILL}" stroke="${CARD_BORDER}" stroke-width="${String(stroke)}"/>`,
      `<g clip-path="url(#${clipId})" font-family="${SEED_FONT_STACK}" text-anchor="middle">`,
      `<text x="${String(centreX)}" y="${String(Math.round(centreY))}" font-size="${String(nameSize)}" fill="${CARD_NAME}">${escapeSeedText(cell.name)}</text>`,
      `<text x="${String(centreX)}" y="${String(Math.round(centreY + nameSize * 1.15))}" font-size="${String(stateSize)}" fill="${CARD_STATE}">${GRID_SEED_WAITING_LABEL}</text>`,
      `</g>`,
    )
  }
  parts.push('</svg>')
  return parts.join('')
}

/** Limited-range BT.601, which is what a raw yuv420p stream handed to x264 is read as. */
const Y_OFFSET = 16
const CHROMA_OFFSET = 128

function clampByte(value: number): number {
  return Math.min(255, Math.max(0, Math.round(value)))
}

function luma(r: number, g: number, b: number): number {
  return Y_OFFSET + (65.481 * r + 128.553 * g + 24.966 * b) / 255
}

function chromaU(r: number, g: number, b: number): number {
  return CHROMA_OFFSET + (-37.797 * r - 74.203 * g + 112.0 * b) / 255
}

function chromaV(r: number, g: number, b: number): number {
  return CHROMA_OFFSET + (112.0 * r - 93.786 * g - 18.214 * b) / 255
}

/**
 * Packed RGB → yuv420p, once.
 *
 * Chroma is the average of each 2×2 block's colour, converted once per block —
 * which is what 4:2:0 means, and what keeps a card's border from fringing.
 * Sizes must be even; the canvas refuses anything else, so a caller that got
 * here with an odd size has a bug the blit would hide.
 */
export function rgbToYuv420p(rgb: Buffer, size: PixelSize): Buffer {
  const { width, height } = size
  const out = Buffer.alloc(yuv420pSize(width, height))
  const lumaBytes = width * height
  const chromaBytes = (width / 2) * (height / 2)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = (y * width + x) * 3
      out[y * width + x] = clampByte(luma(rgb[at] ?? 0, rgb[at + 1] ?? 0, rgb[at + 2] ?? 0))
    }
  }
  const halfW = width / 2
  for (let y = 0; y < height / 2; y += 1) {
    for (let x = 0; x < halfW; x += 1) {
      let r = 0
      let g = 0
      let b = 0
      for (let dy = 0; dy < 2; dy += 1) {
        for (let dx = 0; dx < 2; dx += 1) {
          const at = ((y * 2 + dy) * width + (x * 2 + dx)) * 3
          r += rgb[at] ?? 0
          g += rgb[at + 1] ?? 0
          b += rgb[at + 2] ?? 0
        }
      }
      const at = y * halfW + x
      out[lumaBytes + at] = clampByte(chromaU(r / 4, g / 4, b / 4))
      out[lumaBytes + chromaBytes + at] = clampByte(chromaV(r / 4, g / 4, b / 4))
    }
  }
  return out
}

/**
 * Render the seed as one yuv420p frame the canvas can take whole.
 *
 * Rejects on failure rather than answering black: the caller decides, and it
 * decides to carry on without a seed — a grid that would not start because its
 * placeholder would not draw is a worse grid than one that starts black.
 */
export async function renderGridSeed(spec: GridSeedSpec): Promise<Buffer> {
  // Imported HERE and not at the top of the file. This addon is `isolate: true`
  // — its own runner — and sharp is a native module that maps libvips the
  // moment it is required. A grid that is declared but never watched would pay
  // that for the life of the process, to draw nothing; loading it on the first
  // composition means the runner pays it when there is a picture to seed.
  const { default: sharp } = await import('sharp')
  const rgb = await sharp(Buffer.from(buildGridSeedSvg(spec)))
    // The document has no background, so the gaps flatten onto the canvas' own
    // black instead of arriving as transparency the raw output has no room for.
    .flatten({ background: { r: 0, g: 0, b: 0 } })
    .raw()
    .toBuffer()
  const expected = spec.canvas.width * spec.canvas.height * 3
  if (rgb.length !== expected) {
    throw new Error(
      `camera-grid: the seed rasterized to ${String(rgb.length)} bytes, expected ${String(expected)}`,
    )
  }
  return rgbToYuv420p(rgb, spec.canvas)
}
