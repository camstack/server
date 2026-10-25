/**
 * Zoom and pan on the annotation canvas, as a normalised VIEWPORT.
 *
 * A small subject (a cat at 40 m, a plate) is a few dozen pixels on a frame
 * shown at pane size, and a box drawn around it at that scale is off by more
 * than the subject. So the canvas zooms — and every conversion between a
 * screen point and a frame point has to account for two things at once: the
 * letterbox (`displayedImageRect`, the image does not fill its pane) and the
 * viewport (which part of the frame is on screen). Both live here, in one
 * pair of functions, so a box drawn at 6x lands exactly where it was drawn.
 *
 * The viewport is the visible part of the frame in normalised `[0,1]`
 * coordinates. It keeps the frame's aspect ratio (`w === h` always), so the
 * zoom level is `1 / w`.
 */
import type { NormBox, PixelRect } from './retrain-boxes.js'

/** The whole frame — no zoom. */
export const FULL_VIEWPORT: NormBox = { x: 0, y: 0, w: 1, h: 1 }

/** Deepest zoom. Past this a frame pixel is a screen block, not detail. */
export const MAX_ZOOM = 16

/** One step of the +/- keys and the toolbar buttons. */
export const ZOOM_STEP = 1.5

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

export function zoomLevel(vp: NormBox): number {
  return 1 / vp.w
}

/** A pixel inside the canvas container → a normalised frame point. */
export function pixelToNorm(
  px: number,
  py: number,
  image: PixelRect,
  vp: NormBox,
): { x: number; y: number } {
  return {
    x: clamp(vp.x + ((px - image.left) / image.width) * vp.w, 0, 1),
    y: clamp(vp.y + ((py - image.top) / image.height) * vp.h, 0, 1),
  }
}

/** A normalised frame point → a pixel inside the canvas container. */
export function normToPixel(
  p: { readonly x: number; readonly y: number },
  image: PixelRect,
  vp: NormBox,
): { x: number; y: number } {
  return {
    x: image.left + ((p.x - vp.x) / vp.w) * image.width,
    y: image.top + ((p.y - vp.y) / vp.h) * image.height,
  }
}

/** A normalised box → its CSS rectangle in the container. */
export function boxToPixelRect(box: NormBox, image: PixelRect, vp: NormBox): PixelRect {
  const tl = normToPixel(box, image, vp)
  return {
    left: tl.x,
    top: tl.y,
    width: (box.w / vp.w) * image.width,
    height: (box.h / vp.h) * image.height,
  }
}

/** Where the WHOLE image is drawn so that the viewport fills the letterboxed rect. */
export function viewportImageRect(image: PixelRect, vp: NormBox): PixelRect {
  return {
    left: image.left - (vp.x / vp.w) * image.width,
    top: image.top - (vp.y / vp.h) * image.height,
    width: image.width / vp.w,
    height: image.height / vp.h,
  }
}

/**
 * Zoom by `factor` about a frame point — the point under the pointer stays
 * under the pointer. Clamped between the whole frame and {@link MAX_ZOOM}, and
 * kept inside the frame.
 */
export function zoomAt(
  vp: NormBox,
  anchor: { readonly x: number; readonly y: number },
  factor: number,
): NormBox {
  const w = clamp(vp.w / factor, 1 / MAX_ZOOM, 1)
  const ratio = w / vp.w
  const x = clamp(anchor.x - (anchor.x - vp.x) * ratio, 0, 1 - w)
  const y = clamp(anchor.y - (anchor.y - vp.y) * ratio, 0, 1 - w)
  return { x, y, w, h: w }
}

/** Move the viewport by a normalised delta, staying inside the frame. */
export function panBy(vp: NormBox, dx: number, dy: number): NormBox {
  return {
    x: clamp(vp.x + dx, 0, 1 - vp.w),
    y: clamp(vp.y + dy, 0, 1 - vp.h),
    w: vp.w,
    h: vp.h,
  }
}

/** The viewport centre — the anchor for a keyboard or toolbar zoom. */
export function viewportCentre(vp: NormBox): { x: number; y: number } {
  return { x: vp.x + vp.w / 2, y: vp.y + vp.h / 2 }
}
