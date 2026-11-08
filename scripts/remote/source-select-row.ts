/**
 * The pure step behind `add-source-select-row.ts`: put a `source_select` key on
 * its own first row of a remote layout. Every button and group moves down one
 * row, the grid gains a row, and the key spans every column. A layout that
 * already has the key is returned untouched (idempotent); one that cannot take
 * another row, or is not a valid layout, is refused with a reason.
 */
import {
  MAX_LAYOUT_SPAN,
  type RemoteLayoutPayload,
  RemoteLayoutPayloadSchema,
} from '../../packages/types/src/remote/remote-config.js'

export const SOURCE_SELECT_ROLE = 'source_select'

export type SourceSelectRowPlan =
  | { readonly status: 'already-present' }
  | { readonly status: 'refused'; readonly reason: string }
  | { readonly status: 'insert'; readonly layout: RemoteLayoutPayload }

function freeId(taken: ReadonlySet<string>): string {
  if (!taken.has(SOURCE_SELECT_ROLE)) return SOURCE_SELECT_ROLE
  for (let n = 2; ; n += 1) {
    const id = `${SOURCE_SELECT_ROLE}_${n}`
    if (!taken.has(id)) return id
  }
}

export function planSourceSelectRow(payload: unknown): SourceSelectRowPlan {
  const parsed = RemoteLayoutPayloadSchema.safeParse(payload)
  if (!parsed.success) return { status: 'refused', reason: 'not a valid remote layout' }
  const grid = parsed.data
  if (grid.buttons.some((b) => b.role === SOURCE_SELECT_ROLE)) return { status: 'already-present' }
  if (grid.rows + 1 > MAX_LAYOUT_SPAN) {
    return { status: 'refused', reason: `no room for another row (max ${MAX_LAYOUT_SPAN})` }
  }
  const ids = new Set(grid.buttons.map((b) => b.id))
  const shifted: RemoteLayoutPayload = {
    ...grid,
    rows: grid.rows + 1,
    buttons: [
      {
        id: freeId(ids),
        row: 0,
        col: 0,
        rowSpan: 1,
        colSpan: grid.columns,
        role: SOURCE_SELECT_ROLE,
      },
      ...grid.buttons.map((b) => ({ ...b, row: b.row + 1 })),
    ],
    ...(grid.groups === undefined
      ? {}
      : { groups: grid.groups.map((g) => ({ ...g, row: g.row + 1 })) }),
  }
  const check = RemoteLayoutPayloadSchema.safeParse(shifted)
  return check.success
    ? { status: 'insert', layout: check.data }
    : { status: 'refused', reason: 'the shifted layout is not valid' }
}
