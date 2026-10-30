/**
 * The pure geometry behind dragging on the remote grid (D973): which cell the
 * pointer is over, where the dragged item would land, and whether the layout
 * accepts it. The target of a drag is judged by the same edits the inspector's
 * arrows use (`moveButton`, `moveGroup`), so a drop the preview shows as valid
 * is always a payload the template store accepts.
 */
import type { LayoutRect, RemoteLayoutPayload } from '@camstack/types'
import {
  groupById,
  type LayoutRefusal,
  type LayoutResult,
  moveButton,
  moveGroup,
} from './layout-model'

export interface DragItem {
  readonly kind: 'button' | 'group'
  readonly id: string
}

export interface DragPreview {
  /** The footprint the item would occupy, drawn while dragging. */
  readonly rect: LayoutRect
  readonly valid: boolean
  readonly reason: LayoutRefusal | null
}

export interface GridBounds {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
}

export interface Cell {
  readonly row: number
  readonly col: number
}

/** The rectangle of the dragged item, or undefined when it is not on the layout. */
export function itemRect(grid: RemoteLayoutPayload, item: DragItem): LayoutRect | undefined {
  const source =
    item.kind === 'group' ? groupById(grid, item.id) : grid.buttons.find((b) => b.id === item.id)
  return source === undefined
    ? undefined
    : { row: source.row, col: source.col, rowSpan: source.rowSpan, colSpan: source.colSpan }
}

/** The cell under a point; it may lie outside the grid (negative, or past the last row). */
export function cellAt(
  bounds: GridBounds,
  grid: Pick<RemoteLayoutPayload, 'columns' | 'rows'>,
  x: number,
  y: number,
): Cell {
  if (bounds.width <= 0 || bounds.height <= 0) return { row: 0, col: 0 }
  return {
    col: Math.floor(((x - bounds.left) / bounds.width) * grid.columns),
    row: Math.floor(((y - bounds.top) / bounds.height) * grid.rows),
  }
}

/** Where the item's top-left lands when the pointer is over `pointer` and grabbed it at `grabbed`. */
export function dropOrigin(rect: LayoutRect, grabbed: Cell, pointer: Cell): Cell {
  return {
    row: pointer.row - (grabbed.row - rect.row),
    col: pointer.col - (grabbed.col - rect.col),
  }
}

/** Try the move; the layout when it is accepted, the reason when it is not. */
export function moveItem(grid: RemoteLayoutPayload, item: DragItem, to: Cell): LayoutResult {
  return item.kind === 'group'
    ? moveGroup(grid, item.id, to.row, to.col)
    : moveButton(grid, item.id, to.row, to.col)
}

export function previewMove(
  grid: RemoteLayoutPayload,
  item: DragItem,
  to: Cell,
): DragPreview | null {
  const rect = itemRect(grid, item)
  if (rect === undefined) return null
  const result = moveItem(grid, item, to)
  return {
    rect: { ...rect, row: to.row, col: to.col },
    valid: result.status === 'ok',
    reason: result.status === 'ok' ? null : result.reason,
  }
}

/** The row / column step an arrow key means; null for any other key. */
export function arrowStep(key: string): { dRow: number; dCol: number } | null {
  switch (key) {
    case 'ArrowUp':
      return { dRow: -1, dCol: 0 }
    case 'ArrowDown':
      return { dRow: 1, dCol: 0 }
    case 'ArrowLeft':
      return { dRow: 0, dCol: -1 }
    case 'ArrowRight':
      return { dRow: 0, dCol: 1 }
    default:
      return null
  }
}

/** Nudge an item one step; a refusal leaves the layout alone. */
export function nudgeItem(
  grid: RemoteLayoutPayload,
  item: DragItem,
  dRow: number,
  dCol: number,
): LayoutResult {
  const rect = itemRect(grid, item)
  if (rect === undefined) return { status: 'refused', reason: 'unknown-button' }
  return moveItem(grid, item, { row: rect.row + dRow, col: rect.col + dCol })
}
