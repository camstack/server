/**
 * Where a box's name tag sits so it stays inside the displayed frame.
 *
 * The tag is anchored to the box's top-left, above the box. On a phone a box
 * near the right edge pushed its tag past the canvas, where the container clips
 * it. The tag's width is not known before it is laid out, so it is estimated
 * from its text (deliberately a little generous): the estimate only decides
 * which side to anchor, it never sizes anything.
 */
import type { PixelRect } from './retrain-boxes.js'

/** Tag height: `leading-4` (16 px) plus the 1 px border. */
export const LABEL_HEIGHT_PX = 18
/** Icon, gap, horizontal padding and border around the text. */
const LABEL_CHROME_PX = 26
/** Average advance of the 11 px medium-weight tag text, rounded up. */
const LABEL_CHAR_PX = 6.6

export interface LabelPlacement {
  /** Which box edge the tag lines up with: `left` grows rightwards, `right` leftwards. */
  readonly anchor: 'left' | 'right'
  /** Above the box, or inside its top edge when there is no room above. */
  readonly row: 'above' | 'inside'
}

export function estimateLabelWidth(text: string): number {
  return LABEL_CHROME_PX + text.length * LABEL_CHAR_PX
}

/** `bounds` is the displayed frame rect; `box` the box's rect in the same space. */
export function placeLabel(box: PixelRect, labelWidth: number, bounds: PixelRect): LabelPlacement {
  const row = box.top - LABEL_HEIGHT_PX >= bounds.top ? 'above' : 'inside'
  const rightOverflow = box.left + labelWidth - (bounds.left + bounds.width)
  if (rightOverflow <= 0) return { anchor: 'left', row }
  // Flipped, the tag ends at the box's right edge and grows leftwards.
  const leftOverflow = bounds.left - (box.left + box.width - labelWidth)
  return { anchor: leftOverflow < rightOverflow ? 'right' : 'left', row }
}
