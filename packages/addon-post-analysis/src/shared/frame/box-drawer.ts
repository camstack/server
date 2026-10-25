import sharp from 'sharp'
import { DEFAULT_EVENT_COLOR } from '@camstack/types'

/** A bounding box in PIXEL space, with an optional colour + caption. */
export interface FrameBox {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
  /** Stroke/label colour (any CSS colour). Defaults to a bright green. */
  readonly color?: string
  /** Optional caption drawn above the box (e.g. `person 92%`). */
  readonly label?: string
}

export interface DrawBoxedFrameOptions {
  /** Downscale the output to at most this width (aspect preserved). */
  readonly maxWidth?: number
  /** JPEG quality (1-100). */
  readonly quality?: number
}

// Single source of truth — the taxonomy's global default event color.
const DEFAULT_COLOR = DEFAULT_EVENT_COLOR
const DEFAULT_QUALITY = 80
const STROKE_WIDTH = 3

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

/** Clamp a pixel box to the frame so the rect always stays inside [0,W]×[0,H]. */
function clampBox(
  b: FrameBox,
  frameWidth: number,
  frameHeight: number,
): { x: number; y: number; w: number; h: number } {
  const x = Math.max(0, Math.min(Math.round(b.x), frameWidth - 1))
  const y = Math.max(0, Math.min(Math.round(b.y), frameHeight - 1))
  const w = Math.max(1, Math.min(Math.round(b.w), frameWidth - x))
  const h = Math.max(1, Math.min(Math.round(b.h), frameHeight - y))
  return { x, y, w, h }
}

/** The SVG overlay: one `<rect>` per box plus an optional caption. */
function buildBoxOverlaySvg(
  boxes: readonly FrameBox[],
  frameWidth: number,
  frameHeight: number,
): string {
  const fontSize = Math.max(12, Math.round(frameHeight / 30))
  const parts = boxes.map((b) => {
    const c = clampBox(b, frameWidth, frameHeight)
    const color = b.color ?? DEFAULT_COLOR
    const rect = `<rect x="${c.x}" y="${c.y}" width="${c.w}" height="${c.h}" fill="none" stroke="${color}" stroke-width="${STROKE_WIDTH}"/>`
    if (!b.label) return rect
    const ty = Math.max(fontSize, c.y - 4)
    const text = `<text x="${c.x}" y="${ty}" font-family="sans-serif" font-size="${fontSize}" fill="${color}" stroke="black" stroke-width="0.5">${escapeXml(b.label)}</text>`
    return rect + text
  })
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${frameWidth}" height="${frameHeight}">${parts.join('')}</svg>`
}

/**
 * Draw bounding boxes over a frame that is still a JPEG and re-encode it in ONE
 * libvips pipeline (decode, composite, encode). The raw RGB surface never
 * exists in the JS process: {@link drawBoxedFrame} needs it handed in, which for
 * a consumer that only re-encodes meant a 1-6 MB V8-external buffer per tile
 * (D867). Same overlay and quality contract; no `maxWidth` — the caller asked
 * the owning runner for the size it wants.
 */
export async function drawBoxedJpeg(
  jpeg: Uint8Array,
  frameWidth: number,
  frameHeight: number,
  boxes: readonly FrameBox[],
  opts: { readonly quality?: number } = {},
): Promise<Buffer> {
  const quality = opts.quality ?? DEFAULT_QUALITY
  let pipeline = sharp(jpeg)
  if (boxes.length > 0) {
    const svg = buildBoxOverlaySvg(boxes, frameWidth, frameHeight)
    pipeline = pipeline.composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
  }
  return pipeline.jpeg({ quality }).toBuffer()
}

/**
 * Draw bounding boxes over a raw RGB frame and JPEG-encode it.
 *
 * The frame is composited with an SVG overlay (one `<rect>` per box, plus an
 * optional caption) at full resolution, then optionally downscaled — so the
 * box stays crisp relative to the scene. Boxes are clamped to frame bounds to
 * avoid sharp `extract`/region errors on slightly-out-of-range detections.
 */
export async function drawBoxedFrame(
  frameData: Buffer,
  frameWidth: number,
  frameHeight: number,
  boxes: readonly FrameBox[],
  opts: DrawBoxedFrameOptions = {},
): Promise<Buffer> {
  const quality = opts.quality ?? DEFAULT_QUALITY

  // sharp applies resize BEFORE composite within a single pipeline, so a
  // full-resolution SVG overlay can't be composited onto an already-resized
  // base. Composite at native resolution first (lossless PNG), then resize +
  // JPEG-encode in a second pass. Boxes are sparse (one per event/track), so
  // the extra encode is negligible.
  let base = frameData
  let baseIsRaw = true
  if (boxes.length > 0) {
    const svg = buildBoxOverlaySvg(boxes, frameWidth, frameHeight)
    base = await sharp(frameData, {
      raw: { width: frameWidth, height: frameHeight, channels: 3 },
    })
      .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
      .png()
      .toBuffer()
    baseIsRaw = false
  }

  let pipeline = baseIsRaw
    ? sharp(base, { raw: { width: frameWidth, height: frameHeight, channels: 3 } })
    : sharp(base)

  if (opts.maxWidth !== undefined) {
    pipeline = pipeline.resize({ width: opts.maxWidth, withoutEnlargement: true })
  }

  return pipeline.jpeg({ quality }).toBuffer()
}
