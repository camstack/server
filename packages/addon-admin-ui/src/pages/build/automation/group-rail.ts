/**
 * The coloured rail down the left of a WHEN block's rows: one colour per
 * group, so sibling and nested blocks are told apart at a glance.
 *
 * The colours are the theme's categorical series slots (never a status
 * colour: the trace already paints pass / fail on the block's border). A
 * nested block never takes its parent's colour, and sibling blocks rotate
 * through the other slots, so up to `GROUP_RAIL_CLASSES.length - 1` sibling
 * blocks all differ before a colour repeats. The colour follows the position:
 * moving a block moves it to its new slot.
 */
import type { AutomationWhen } from '@camstack/types'
import { isLeaf } from '@camstack/types'

/** Full class strings, so the Tailwind scan sees every one. */
export const GROUP_RAIL_CLASSES = [
  'border-chart-series-a',
  'border-chart-series-f',
  'border-chart-series-b',
  'border-chart-series-d',
] as const

/** The root block's rail. */
export const ROOT_RAIL = 0

/** The rail of the `ordinal`-th nested block (0-based, rows not counted) of a block whose rail is `parent`. */
export function childRail(parent: number, ordinal: number): number {
  const slots = GROUP_RAIL_CLASSES.length
  return (parent + 1 + (ordinal % (slots - 1))) % slots
}

/**
 * The rail of each child of a block whose rail is `parent`: a nested block or
 * NOT takes the next slot in turn, a row has none (it sits on its parent's rail).
 */
export function childRails(
  children: readonly AutomationWhen[],
  parent: number,
): readonly (number | null)[] {
  let ordinal = 0
  return children.map((child) => (isLeaf(child) ? null : childRail(parent, ordinal++)))
}

export function railClass(rail: number): string {
  return GROUP_RAIL_CLASSES[rail % GROUP_RAIL_CLASSES.length] ?? GROUP_RAIL_CLASSES[0]
}
