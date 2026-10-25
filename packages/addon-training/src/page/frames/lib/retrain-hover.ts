/**
 * Hover sync between the canvas and the subject list — pure.
 *
 * Hovering a list row emphasises its box on the canvas (thicker stroke, the
 * others dimmed); hovering a box on the canvas emphasises its row (and scrolls
 * it into view). The hovered key is UI state, not an edit: it lives outside the
 * undo history and never reaches the save.
 *
 * The canvas hit-test is the same rule as selection — the SMALLEST box that
 * contains the point (`boxAtPoint`), so a package held by a person is
 * reachable.
 */

import { boxAtPoint, type NormBox } from './retrain-boxes.js'

/** Who raised the hover — a row scrolls into view only for the canvas's. */
export type HoverSource = 'canvas' | 'list'

export interface Hover {
  readonly key: string
  readonly source: HoverSource
}

export type Emphasis = 'hovered' | 'dimmed' | 'normal'

/** The box under a canvas point, or `null`. */
export function hoverFromCanvas(
  boxes: readonly { readonly key: string; readonly bbox: NormBox }[],
  point: { readonly x: number; readonly y: number },
): Hover | null {
  const index = boxAtPoint(
    boxes.map((b) => b.bbox),
    point,
  )
  const box = boxes[index]
  return box === undefined ? null : { key: box.key, source: 'canvas' }
}

/** How a box is drawn given the current hover. Nothing hovered → everything normal. */
export function emphasisOf(key: string, hover: Hover | null): Emphasis {
  if (hover === null) return 'normal'
  return hover.key === key ? 'hovered' : 'dimmed'
}

/** The same hover (so a pointer move over one box does not re-render). */
export function sameHover(a: Hover | null, b: Hover | null): boolean {
  if (a === null || b === null) return a === b
  return a.key === b.key && a.source === b.source
}

/** The hover to keep after boxes changed: dropped when its box is gone. */
export function hoverAfterBoxesChange(hover: Hover | null, keys: readonly string[]): Hover | null {
  return hover !== null && keys.includes(hover.key) ? hover : null
}
