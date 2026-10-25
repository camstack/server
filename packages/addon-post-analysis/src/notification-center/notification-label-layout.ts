/**
 * Where each box's caption goes on a notification picture — pure geometry,
 * rects in, placements out (D897 follow-up, 2026-10-22).
 *
 * A caption drawn INSIDE its box used to cover the subject whole on a small
 * box, and a caption next to a crowd landed on a neighbour's box. The rule:
 *
 *  1. Try, in order: OUTSIDE above the box (inside the picture), OUTSIDE below
 *     it, then INSIDE its top edge — the last only when the box is big enough
 *     that the plate is a thin band of it: plate height ≤
 *     {@link NC_LABEL_INSIDE_MAX_HEIGHT_FRACTION} of the box height and plate
 *     width ≤ the box width. A fifth of the height leaves the head and torso of
 *     an upright person, or most of a vehicle, visible; anything taller is the
 *     caption hiding what it names.
 *  2. A candidate is refused when its plate intersects ANY other box drawn on
 *     the picture, or a plate already placed.
 *  3. The subject is placed first; the other tracks follow by score, highest
 *     first, so a crowd never costs the subject its caption.
 *  4. The font never shrinks to make a plate fit: no fitting candidate means
 *     no caption for that box. A box without its caption still carries its
 *     outline and colour.
 *
 * Coordinates are the picture's own pixels, whatever it is (a scene or a crop).
 */

/** The inside placement is allowed only when the plate is at most this fraction of the box height. */
export const NC_LABEL_INSIDE_MAX_HEIGHT_FRACTION = 0.2
/** A caption is never drawn smaller than this, in output pixels. */
export const NC_LABEL_MIN_FONT_PX = 14

/** One box to caption, in output pixels. */
export interface NcLabelBox {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
  readonly role: 'subject' | 'other'
  readonly label: string
  /** The track's confidence; orders the non-subject captions (highest first). */
  readonly score?: number
}

export type NcLabelWhere = 'above' | 'below' | 'inside'

/** Where a caption's plate goes. */
export interface NcLabelPlacement {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
  readonly where: NcLabelWhere
}

export interface NcLabelLayoutInput {
  readonly width: number
  readonly height: number
  readonly fontSize: number
  readonly boxes: readonly NcLabelBox[]
}

export interface NcLabelLayout {
  /** Index-aligned with the input boxes; null = no caption for that box. */
  readonly placements: ReadonlyArray<NcLabelPlacement | null>
  /** Captions placed. */
  readonly placed: number
  /** Non-empty captions with nowhere to go. */
  readonly dropped: number
}

export interface NcPlateSize {
  readonly w: number
  readonly h: number
}

interface Rect {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

/** The dark plate a caption sits on, for this text at this font size. */
export function labelPlateSize(label: string, fontSize: number): NcPlateSize {
  return {
    w: Math.round(label.length * fontSize * 0.62 + fontSize * 0.8),
    h: Math.round(fontSize * 1.35),
  }
}

/** Positive-area overlap; rectangles that only touch do not intersect. */
function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

function captionOrder(boxes: readonly NcLabelBox[]): readonly number[] {
  const rank = (b: NcLabelBox): number => (b.role === 'subject' ? 0 : 1)
  return boxes
    .map((_, i) => i)
    .sort((i, j) => {
      const a = boxes[i]
      const b = boxes[j]
      if (a === undefined || b === undefined) return 0
      return rank(a) - rank(b) || (b.score ?? 0) - (a.score ?? 0) || i - j
    })
}

function candidates(
  box: NcLabelBox,
  plate: NcPlateSize,
  width: number,
  height: number,
): NcLabelPlacement[] {
  if (plate.w > width) return []
  const x = Math.min(box.x, Math.max(0, width - plate.w))
  const out: NcLabelPlacement[] = []
  if (box.y - plate.h >= 0) out.push({ x, y: box.y - plate.h, ...plate, where: 'above' })
  if (box.y + box.h + plate.h <= height) out.push({ x, y: box.y + box.h, ...plate, where: 'below' })
  if (plate.h <= box.h * NC_LABEL_INSIDE_MAX_HEIGHT_FRACTION && plate.w <= box.w) {
    out.push({ x, y: box.y, ...plate, where: 'inside' })
  }
  return out
}

/** Place every caption by the rule above. */
export function layoutBoxLabels(input: NcLabelLayoutInput): NcLabelLayout {
  const { width, height, boxes } = input
  const fontSize = Math.max(NC_LABEL_MIN_FONT_PX, input.fontSize)
  const placements = new Map<number, NcLabelPlacement>()
  let dropped = 0
  for (const i of captionOrder(boxes)) {
    const box = boxes[i]
    if (box === undefined || box.label.length === 0) continue
    const plate = labelPlateSize(box.label, fontSize)
    const chosen = candidates(box, plate, width, height).find(
      (c) =>
        !boxes.some((other, j) => j !== i && intersects(c, other)) &&
        ![...placements.values()].some((p) => intersects(c, p)),
    )
    if (chosen === undefined) dropped += 1
    else placements.set(i, chosen)
  }
  return {
    placements: boxes.map((_, i) => placements.get(i) ?? null),
    placed: placements.size,
    dropped,
  }
}
