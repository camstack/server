/**
 * The geometry of a crop camera (#611), shared by the editor and the engine so
 * both agree on what a rectangle means.
 *
 * Every rectangle is normalized against the SOURCE frame (D519), so a ratio is
 * a statement about PIXELS only once the source's own aspect is known:
 * `pixelAspect = (width / height) * sourceAspect`. A preset names the pixel
 * aspect of the crop, and a lock keeps it while the handles move.
 */
import type { CropAspect, GridRect } from './spec.js'

/** The smallest side a crop may shrink to, as a fraction of the source. */
export const CROP_MIN_SIDE: number = 0.05

/** A seeded crop covers this fraction of the largest rectangle that fits, so it is a visible crop. */
export const CROP_SEED_SCALE: number = 0.6

export type CropHandle = 'nw' | 'ne' | 'sw' | 'se'

/** A point in the source's normalized space. */
export interface CropPoint {
  readonly x: number
  readonly y: number
}

/** The pixel aspect (width / height) a preset locks to; `null` for `free`. */
export function cropAspectRatio(aspect: CropAspect): number | null {
  switch (aspect) {
    case '16:9':
      return 16 / 9
    case '4:3':
      return 4 / 3
    case '1:1':
      return 1
    case 'free':
      return null
  }
}

/** The pixel aspect of the canvas a crop produces: crop aspect times source aspect. */
export function cropCanvasAspect(rect: GridRect, sourceAspect: number): number {
  return (rect.width / rect.height) * sourceAspect
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/**
 * The rectangle a new crop starts from: centred, the preset's pixel aspect on
 * a source of `sourceAspect`. `free` starts as the middle quarter.
 */
export function seedCropRect(aspect: CropAspect, sourceAspect: number): GridRect {
  const ratio = cropAspectRatio(aspect)
  if (ratio === null) return { x: 0.25, y: 0.25, width: 0.5, height: 0.5 }
  // Normalized height for a given normalized width: h = w * sourceAspect / ratio.
  const heightPerWidth = sourceAspect / ratio
  const fullWidth = heightPerWidth <= 1 ? 1 : 1 / heightPerWidth
  const width = fullWidth * CROP_SEED_SCALE
  const height = width * heightPerWidth
  return { x: (1 - width) / 2, y: (1 - height) / 2, width, height }
}

/** The same rectangle moved by (dx, dy), held inside the source. Its size never changes. */
export function moveCropRect(rect: GridRect, dx: number, dy: number): GridRect {
  return {
    ...rect,
    x: clamp(rect.x + dx, 0, 1 - rect.width),
    y: clamp(rect.y + dy, 0, 1 - rect.height),
  }
}

export interface ResizeCropInput {
  readonly rect: GridRect
  /** The corner being dragged; the opposite corner stays where it is. */
  readonly handle: CropHandle
  /** Where the pointer is, in the source's normalized space. */
  readonly point: CropPoint
  readonly aspect: CropAspect
  /** The source frame's width / height. */
  readonly sourceAspect: number
}

/**
 * Drag one corner. The opposite corner is the anchor. A preset keeps the pixel
 * aspect exactly (the larger of the two pointer distances leads), `free` follows
 * the pointer on both axes. Either way the result stays inside the source and
 * never shrinks below `CROP_MIN_SIDE`.
 */
export function resizeCropRect(input: ResizeCropInput): GridRect {
  const { rect, handle, point, aspect, sourceAspect } = input
  const west = handle === 'nw' || handle === 'sw'
  const north = handle === 'nw' || handle === 'ne'
  const anchorX = west ? rect.x + rect.width : rect.x
  const anchorY = north ? rect.y + rect.height : rect.y
  const signX = west ? -1 : 1
  const signY = north ? -1 : 1
  const roomX = signX > 0 ? 1 - anchorX : anchorX
  const roomY = signY > 0 ? 1 - anchorY : anchorY
  const wantX = (point.x - anchorX) * signX
  const wantY = (point.y - anchorY) * signY

  const ratio = cropAspectRatio(aspect)
  let width: number
  let height: number
  if (ratio === null) {
    width = clamp(wantX, Math.min(CROP_MIN_SIDE, roomX), roomX)
    height = clamp(wantY, Math.min(CROP_MIN_SIDE, roomY), roomY)
  } else {
    // width = height * k, with k = ratio / sourceAspect.
    const k = ratio / sourceAspect
    const maxWidth = Math.min(roomX, roomY * k)
    const minWidth = Math.min(Math.max(CROP_MIN_SIDE, CROP_MIN_SIDE * k), maxWidth)
    width = clamp(Math.max(wantX, wantY * k), minWidth, maxWidth)
    height = width / k
  }
  return {
    x: signX > 0 ? anchorX : anchorX - width,
    y: signY > 0 ? anchorY : anchorY - height,
    width,
    height,
  }
}
