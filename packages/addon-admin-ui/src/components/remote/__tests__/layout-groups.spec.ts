import {
  builtinRemoteComponent,
  insertComponent,
  type RemoteLayoutGroup,
  type RemoteLayoutPayload,
  RemoteLayoutPayloadSchema,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  addButton,
  deleteGroup,
  groupById,
  type LayoutResult,
  membersOf,
  moveButton,
  moveGroup,
  resizeButton,
  resizeGrid,
  setButtonFace,
  setButtonLook,
  setGroupTitle,
  setSeparatorOptions,
  slimRowsOf,
} from '../layout-model'

function must(result: LayoutResult): RemoteLayoutPayload {
  if (result.status !== 'ok') throw new Error(`refused: ${result.reason}`)
  return result.grid
}

function put(
  layout: RemoteLayoutPayload,
  id: string,
  row: number,
  col: number,
  scale?: { cols: number },
): RemoteLayoutPayload {
  const placed = insertComponent(
    layout,
    builtinRemoteComponent(id),
    { row, col },
    scale ? { scale } : {},
  )
  if (!placed.ok) throw new Error(`insert ${id}: ${placed.reason}`)
  return placed.layout
}

/** 6 × 8: a D-pad (3 × 3) at the top left, a divider across row 4, a loose power key at the right. */
function composed(): RemoteLayoutPayload {
  let layout: RemoteLayoutPayload = { columns: 6, rows: 8, buttons: [] }
  layout = put(layout, 'core:dpad', 0, 0)
  layout = put(layout, 'core:section-divider', 4, 0, { cols: 6 })
  layout = put(layout, 'core:power', 0, 5)
  return layout
}

const accepted = (layout: RemoteLayoutPayload): boolean =>
  RemoteLayoutPayloadSchema.safeParse(layout).success

describe('group-aware layout edits', () => {
  it('starts from a layout the schema accepts', () => {
    expect(accepted(composed())).toBe(true)
  })

  it('a loose button dropped wholly inside a group joins it', () => {
    let layout = must(addButton(composed(), 'mute')) // first free cell outside the D-pad: (0, 3)
    const id = layout.buttons.at(-1)?.id ?? ''
    expect(layout.buttons.find((b) => b.id === id)?.groupId).toBeUndefined()
    // (0,0) is the D-pad's empty top-left corner.
    layout = must(moveButton(layout, id, 0, 0))
    expect(layout.buttons.find((b) => b.id === id)?.groupId).toBe('dpad')
    expect(accepted(layout)).toBe(true)
  })

  it('refuses a button that straddles a group edge, and one dropped on a divider', () => {
    const layout = must(addButton(composed(), 'mute'))
    const id = layout.buttons.at(-1)?.id ?? ''
    const wide = must(resizeButton(layout, id, 1, 2))
    // Columns 2-3: the D-pad's last column plus one outside it.
    expect(moveButton(wide, id, 0, 2)).toEqual({
      status: 'refused',
      reason: 'overlap',
    })
    // The divider's row holds no keys at all.
    expect(moveButton(layout, id, 4, 2)).toEqual({
      status: 'refused',
      reason: 'overlap',
    })
  })

  it('a member moved out of its group becomes a loose button', () => {
    const layout = composed()
    const out = must(moveButton(layout, 'dpad-left', 6, 0))
    expect(out.buttons.find((b) => b.id === 'dpad-left')?.groupId).toBeUndefined()
    expect(accepted(out)).toBe(true)
  })

  it('resizing a member past its group edge is refused', () => {
    expect(resizeButton(composed(), 'dpad-up', 1, 4)).toEqual({
      status: 'refused',
      reason: 'overlap',
    })
  })

  it('a face edit keeps the button group, shape and tone', () => {
    const edited = must(setButtonFace(composed(), 'dpad-ok', { label: 'Select' }))
    const ok = edited.buttons.find((b) => b.id === 'dpad-ok')
    expect(ok).toMatchObject({
      label: 'Select',
      groupId: 'dpad',
      shape: 'round',
      tone: 'accent',
    })
  })

  it('a look edit sets and clears shape and tone, nothing else', () => {
    const set = must(setButtonLook(composed(), 'dpad-up', { shape: 'pill', tone: 'green' }))
    expect(set.buttons.find((b) => b.id === 'dpad-up')).toMatchObject({
      shape: 'pill',
      tone: 'green',
      groupId: 'dpad',
    })
    const cleared = must(setButtonLook(set, 'dpad-up', { shape: null, tone: null }))
    const up = cleared.buttons.find((b) => b.id === 'dpad-up')
    expect(up?.shape).toBeUndefined()
    expect(up?.tone).toBeUndefined()
    expect(up?.groupId).toBe('dpad')
  })

  it('"add a button" never lands inside a group frame', () => {
    let layout: RemoteLayoutPayload = { columns: 3, rows: 3, buttons: [] }
    layout = put(layout, 'core:dpad', 0, 0)
    // Every cell is inside the D-pad rectangle: nothing is free.
    expect(addButton(layout, 'mute')).toEqual({
      status: 'refused',
      reason: 'outside',
    })
  })

  it('the grid cannot shrink under a group', () => {
    expect(resizeGrid(composed(), 6, 2).status).toBe('refused')
    expect(resizeGrid(composed(), 6, 7).status).toBe('ok')
  })

  it('moves a group with every member as one, and refuses an overlap', () => {
    const moved = must(moveGroup(composed(), 'dpad', 5, 0))
    const dpad = groupById(moved, 'dpad')
    expect(dpad).toMatchObject({ row: 5, col: 0 })
    expect(membersOf(moved, 'dpad').map((b) => b.row)).toEqual([5, 6, 6, 6, 7])
    expect(accepted(moved)).toBe(true)
    // Onto the divider row.
    expect(moveGroup(composed(), 'dpad', 3, 0)).toEqual({
      status: 'refused',
      reason: 'overlap',
    })
    expect(moveGroup(composed(), 'dpad', 7, 0)).toEqual({
      status: 'refused',
      reason: 'outside',
    })
    expect(moveGroup(composed(), 'nope', 0, 0)).toEqual({
      status: 'refused',
      reason: 'unknown-group',
    })
  })

  it('removes a group keeping its keys, or dropping them', () => {
    const kept = must(deleteGroup(composed(), 'dpad', true))
    expect(groupById(kept, 'dpad')).toBeUndefined()
    expect(kept.buttons.filter((b) => b.id.startsWith('dpad-'))).toHaveLength(5)
    expect(kept.buttons.some((b) => b.groupId === 'dpad')).toBe(false)
    expect(accepted(kept)).toBe(true)
    const dropped = must(deleteGroup(composed(), 'dpad', false))
    expect(dropped.buttons.some((b) => b.id.startsWith('dpad-'))).toBe(false)
    expect(accepted(dropped)).toBe(true)
  })

  it('edits and clears a group title', () => {
    const titled = must(setGroupTitle(composed(), 'dpad', 'Navigation'))
    expect(groupById(titled, 'dpad')?.title).toBe('Navigation')
    const cleared = must(setGroupTitle(titled, 'dpad', '  '))
    expect(groupById(cleared, 'dpad')?.title).toBeUndefined()
  })

  it('every move the model accepts is a payload the schema accepts', () => {
    const start = composed()
    const items = start.buttons.map((b) => b.id)
    let accepts = 0
    for (const id of items) {
      for (let row = -1; row <= 8; row += 1) {
        for (let col = -1; col <= 6; col += 1) {
          const result = moveButton(start, id, row, col)
          if (result.status === 'ok') {
            accepts += 1
            expect(accepted(result.grid)).toBe(true)
          }
        }
      }
    }
    expect(accepts).toBeGreaterThan(0)
  })
})

describe('separators', () => {
  const grid = (group: Partial<RemoteLayoutGroup> = {}): RemoteLayoutPayload => ({
    columns: 4,
    rows: 3,
    buttons: [{ id: 'b', row: 2, col: 0, rowSpan: 1, colSpan: 1, role: 'ok' }],
    groups: [
      {
        id: 'sep',
        componentId: 'core:section-divider',
        frame: 'divider',
        row: 0,
        col: 0,
        rowSpan: 1,
        colSpan: 4,
        title: 'Numbers',
        ...group,
      },
    ],
  })

  it('a labelled divider row that holds nothing else is slim by default', () => {
    expect(slimRowsOf(grid())).toEqual(new Set([0]))
  })

  it('a divider set to normal keeps a full row', () => {
    expect(slimRowsOf(grid({ size: 'normal' })).size).toBe(0)
  })

  it('a divider sharing its row with a key is not slim', () => {
    const shared = grid()
    expect(
      slimRowsOf({
        ...shared,
        buttons: [{ id: 'b', row: 0, col: 0, rowSpan: 1, colSpan: 1, role: 'ok' }],
      }).size,
    ).toBe(0)
  })

  it('stores only non-default options and keeps the title', () => {
    const normal = setSeparatorOptions(grid(), 'sep', {
      size: 'normal',
      hideTitle: true,
    })
    expect(normal.status).toBe('ok')
    if (normal.status !== 'ok') return
    expect(normal.grid.groups?.[0]).toMatchObject({
      size: 'normal',
      hideTitle: true,
      title: 'Numbers',
    })
    const back = setSeparatorOptions(normal.grid, 'sep', {
      size: 'compact',
      hideTitle: false,
    })
    if (back.status !== 'ok') throw new Error('refused')
    expect(back.grid.groups?.[0]).not.toHaveProperty('size')
    expect(back.grid.groups?.[0]).not.toHaveProperty('hideTitle')
  })
})
