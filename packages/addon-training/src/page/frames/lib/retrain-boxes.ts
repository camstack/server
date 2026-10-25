/**
 * Box arithmetic for the retrain annotation canvas.
 *
 * Pure, so the part of a drawing surface that is actually decidable can be
 * tested without a DOM. Every rectangle here is NORMALISED `[0,1]` against the
 * full frame — the same canonical form the server stores, so nothing between
 * the drag and the row ever converts coordinates twice.
 *
 * The canvas renders the frame with `object-contain`, which means the image
 * does NOT fill its box: there are letterbox bars on one axis. Converting a
 * pointer position with the element's own rectangle instead of the image's
 * displayed rectangle is the classic way every box on a non-matching aspect
 * ratio ends up offset — {@link displayedImageRect} exists to make that
 * conversion have one implementation.
 */

/** A normalised rectangle: `[0,1]` against the full frame. */
export interface NormBox {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

/** A rectangle in CSS pixels inside the canvas element. */
export interface PixelRect {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

/**
 * Where the image ACTUALLY sits inside a container that renders it
 * `object-contain`.
 *
 * The container is `containerW × containerH`; the image has its own aspect
 * ratio and is scaled to fit, centred, with bars on the axis that has room
 * left over. Returns `null` when anything is zero — a division by a zero
 * dimension produces `Infinity` and a box drawn from it lands nowhere.
 */
export function displayedImageRect(
  containerW: number,
  containerH: number,
  imageW: number,
  imageH: number,
): PixelRect | null {
  if (!(containerW > 0) || !(containerH > 0) || !(imageW > 0) || !(imageH > 0)) return null
  const scale = Math.min(containerW / imageW, containerH / imageH)
  const width = imageW * scale
  const height = imageH * scale
  return {
    left: (containerW - width) / 2,
    top: (containerH - height) / 2,
    width,
    height,
  }
}

/** A pointer position inside the container, as a normalised frame coordinate. */
export function pointerToNorm(
  pointerX: number,
  pointerY: number,
  image: PixelRect,
): { x: number; y: number } {
  return {
    x: clamp01((pointerX - image.left) / image.width),
    y: clamp01((pointerY - image.top) / image.height),
  }
}

/**
 * The rectangle a drag from `start` to `end` describes.
 *
 * Direction-agnostic: dragging up-left is as valid as down-right, and a UI that
 * only accepted one produces negative widths that render as nothing and store
 * as a box no derivation can use.
 */
export function dragToBox(start: { x: number; y: number }, end: { x: number; y: number }): NormBox {
  const x = Math.min(start.x, end.x)
  const y = Math.min(start.y, end.y)
  return { x, y, w: Math.abs(end.x - start.x), h: Math.abs(end.y - start.y) }
}

/** Minimum box a drag may produce, as a fraction of the frame's short side.
 *  Below this it is a click, not a rectangle — and a 3-pixel box in a dataset
 *  is a label nobody can see and nothing can learn. */
export const MIN_BOX_SIDE = 0.01

export function isDrawnBox(box: NormBox): boolean {
  return box.w >= MIN_BOX_SIDE && box.h >= MIN_BOX_SIDE
}

/** CSS `style` for drawing a normalised box over the displayed image. */
export function boxStyle(
  box: NormBox,
  image: PixelRect,
): { left: number; top: number; width: number; height: number } {
  return {
    left: image.left + box.x * image.width,
    top: image.top + box.y * image.height,
    width: box.w * image.width,
    height: box.h * image.height,
  }
}

/**
 * The topmost box under a normalised point, by index — SMALLEST first.
 *
 * Smallest-first because a big box almost always contains the small ones (a
 * person holding a package), and picking the outer one would make the inner
 * ones unselectable exactly where the annotation matters most.
 */
export function boxAtPoint(boxes: readonly NormBox[], point: { x: number; y: number }): number {
  let best = -1
  let bestArea = Number.POSITIVE_INFINITY
  boxes.forEach((box, index) => {
    const inside =
      point.x >= box.x && point.x <= box.x + box.w && point.y >= box.y && point.y <= box.y + box.h
    if (!inside) return
    const area = box.w * box.h
    if (area < bestArea) {
      best = index
      bestArea = area
    }
  })
  return best
}

// ── Editing: move, resize, hit-test the handles ────────────────────────────

/** The eight resize handles, by compass point. */
export type ResizeHandle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

export const RESIZE_HANDLES: readonly ResizeHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']

/**
 * Translate a box, stopping at the frame edge. The size never changes: a box
 * dragged against the border slides along it rather than being squashed.
 */
export function moveBox(box: NormBox, dx: number, dy: number): NormBox {
  const x = Math.min(Math.max(0, box.x + dx), Math.max(0, 1 - box.w))
  const y = Math.min(Math.max(0, box.y + dy), Math.max(0, 1 - box.h))
  return { x, y, w: box.w, h: box.h }
}

/**
 * One axis of a resize: `lo`/`hi` are the box's edges, `moveLo` says which one
 * the handle drags. The dragged edge follows the pointer, clamped to the frame
 * and to at least {@link MIN_BOX_SIDE} away from the edge that stays — so a
 * box never inverts and never collapses into a label nothing can learn.
 */
function resizeAxis(
  lo: number,
  hi: number,
  moveLo: boolean,
  pointer: number,
): { readonly start: number; readonly size: number } {
  if (moveLo) {
    const next = Math.min(Math.max(0, pointer), hi - MIN_BOX_SIDE)
    return { start: next, size: hi - next }
  }
  const next = Math.max(Math.min(1, pointer), lo + MIN_BOX_SIDE)
  return { start: lo, size: next - lo }
}

/** Drag one handle of a box to a normalised point. */
export function resizeBox(
  box: NormBox,
  handle: ResizeHandle,
  point: { readonly x: number; readonly y: number },
): NormBox {
  const x =
    handle.includes('w') || handle.includes('e')
      ? resizeAxis(box.x, box.x + box.w, handle.includes('w'), point.x)
      : { start: box.x, size: box.w }
  const y =
    handle.includes('n') || handle.includes('s')
      ? resizeAxis(box.y, box.y + box.h, handle.includes('n'), point.y)
      : { start: box.y, size: box.h }
  return { x: x.start, y: y.start, w: x.size, h: y.size }
}

/** Where each handle sits, normalised. */
export function handlePoint(box: NormBox, handle: ResizeHandle): { x: number; y: number } {
  const x = handle.includes('w') ? box.x : handle.includes('e') ? box.x + box.w : box.x + box.w / 2
  const y = handle.includes('n') ? box.y : handle.includes('s') ? box.y + box.h : box.y + box.h / 2
  return { x, y }
}

/**
 * What a pointer at `point` grabs on `box`: a handle, the body, or nothing.
 *
 * `tolerance` is per axis and normalised, because the caller converts a fixed
 * PIXEL hit area (big enough for a finger) through the current zoom — a
 * handle that is 12 px wide on screen is a different fraction of the frame at
 * every zoom level. Corners win over edges, edges over the body.
 */
export function handleAtPoint(
  box: NormBox,
  point: { readonly x: number; readonly y: number },
  tolerance: { readonly x: number; readonly y: number },
): ResizeHandle | 'body' | null {
  const near = (a: number, b: number, t: number): boolean => Math.abs(a - b) <= t
  const left = near(point.x, box.x, tolerance.x)
  const right = near(point.x, box.x + box.w, tolerance.x)
  const top = near(point.y, box.y, tolerance.y)
  const bottom = near(point.y, box.y + box.h, tolerance.y)
  const withinX = point.x >= box.x - tolerance.x && point.x <= box.x + box.w + tolerance.x
  const withinY = point.y >= box.y - tolerance.y && point.y <= box.y + box.h + tolerance.y
  if (!withinX || !withinY) return null
  if (top && left) return 'nw'
  if (top && right) return 'ne'
  if (bottom && left) return 'sw'
  if (bottom && right) return 'se'
  if (top) return 'n'
  if (bottom) return 's'
  if (left) return 'w'
  if (right) return 'e'
  const inside =
    point.x >= box.x && point.x <= box.x + box.w && point.y >= box.y && point.y <= box.y + box.h
  return inside ? 'body' : null
}
