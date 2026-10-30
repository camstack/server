/**
 * How a remote layout is DRAWN (D973): the closed vocabularies a layout names
 * (button shape, button tone, group frame) mapped to theme-token classes. This
 * is the one place those names turn into a look; the editor and the control
 * modal both render through it. A value this table does not know — a newer
 * layout read by an older UI — draws as the plain look every layout had before
 * shapes existed, never as an error.
 */
import type { RemoteLayoutPayload } from '@camstack/types'

/** Classes for a button's shape; unknown or absent → '' (the button's own rounding). */
export function shapeClass(shape: string | undefined): string {
  switch (shape) {
    case 'rect':
      return 'rounded-sm'
    case 'rounded':
      return 'rounded-xl'
    case 'round':
      // A circle as tall as its cell, centred in the cells it spans.
      return 'aspect-square h-full w-auto justify-self-center rounded-full'
    case 'pill':
      return 'rounded-full'
    default:
      return ''
  }
}

/** Classes for a button's tone; unknown, absent or `neutral` → '' (the secondary look). */
export function toneClass(tone: string | undefined): string {
  switch (tone) {
    case 'accent':
      return 'border-primary bg-primary text-primary-foreground hover:bg-primary/90'
    case 'danger':
      return 'border-danger bg-danger-fill text-danger-on hover:bg-danger-fill/90'
    case 'red':
      return 'border-danger/40 bg-danger/15 text-danger hover:bg-danger/25'
    case 'green':
      return 'border-success/40 bg-success/15 text-success hover:bg-success/25'
    case 'yellow':
      return 'border-warning/40 bg-warning/15 text-warning hover:bg-warning/25'
    case 'blue':
      return 'border-info/40 bg-info/15 text-info hover:bg-info/25'
    default:
      return ''
  }
}

/** Classes for the box drawn behind a group; `none`, `divider` and unknown frames draw no box. */
export function frameClass(frame: string): string {
  switch (frame) {
    case 'panel':
      return 'rounded-lg border border-border bg-surface/40'
    case 'dpad':
      return 'rounded-3xl border border-border bg-surface'
    case 'rocker-v':
    case 'rocker-h':
      return 'rounded-full border border-border bg-surface'
    case 'keypad':
      return 'rounded-lg border border-border-subtle bg-surface/60'
    default:
      return ''
  }
}

/** Whether the frame is a rule across the grid with a title, not a box. */
export function isDividerFrame(frame: string): boolean {
  return frame === 'divider'
}

/** A rectangle clipped to the grid, so a footprint that sticks out is still drawn inside it. */
export function clampToGrid(
  grid: Pick<RemoteLayoutPayload, 'columns' | 'rows'>,
  rect: {
    readonly row: number
    readonly col: number
    readonly rowSpan: number
    readonly colSpan: number
  },
): { row: number; col: number; rowSpan: number; colSpan: number } {
  const row = Math.min(Math.max(rect.row, 0), grid.rows - 1)
  const col = Math.min(Math.max(rect.col, 0), grid.columns - 1)
  const endRow = Math.min(Math.max(rect.row + rect.rowSpan, row + 1), grid.rows)
  const endCol = Math.min(Math.max(rect.col + rect.colSpan, col + 1), grid.columns)
  return { row, col, rowSpan: endRow - row, colSpan: endCol - col }
}
