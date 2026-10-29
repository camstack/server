import { RemoteLayoutPayloadSchema, type RemoteLayoutPayload } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  addButton,
  checkedLayout,
  emptyLayout,
  knownRolesOfGroup,
  layoutOf,
  moveButton,
  placementRefusal,
  removeButton,
  resizeButton,
  resizeGrid,
  roleGroup,
  setButtonFace,
  shiftButton,
} from '../layout-model'

function must(result: ReturnType<typeof addButton>): RemoteLayoutPayload {
  if (result.status !== 'ok') throw new Error(`refused: ${result.reason}`)
  return result.grid
}

function grid2x2(): RemoteLayoutPayload {
  let g: RemoteLayoutPayload = { columns: 2, rows: 2, buttons: [] }
  g = must(addButton(g, 'power'))
  g = must(addButton(g, 'mute'))
  return g
}

describe('layout-model: place', () => {
  it('puts a new button on the first free cell, left to right then down', () => {
    const g = grid2x2()
    expect(g.buttons.map((b) => [b.id, b.row, b.col])).toEqual([
      ['b1', 0, 0],
      ['b2', 0, 1],
    ])
    const third = must(addButton(g, 'ok'))
    expect(third.buttons[2]).toMatchObject({ row: 1, col: 0 })
  })

  it('refuses a button when the grid is full', () => {
    let g = grid2x2()
    g = must(addButton(g, 'up'))
    g = must(addButton(g, 'down'))
    expect(addButton(g, 'ok')).toEqual({
      status: 'refused',
      reason: 'outside',
    })
  })

  it('every accepted grid satisfies the server schema', () => {
    const g = must(addButton(grid2x2(), 'ok'))
    expect(RemoteLayoutPayloadSchema.safeParse(g).success).toBe(true)
    expect(checkedLayout(g)).not.toBeNull()
  })
})

describe('layout-model: move', () => {
  it('moves a button onto a free cell', () => {
    const g = grid2x2()
    const moved = must(moveButton(g, 'b1', 1, 1))
    expect(moved.buttons[0]).toMatchObject({ row: 1, col: 1 })
  })

  it('refuses a move onto another button and leaves the grid untouched', () => {
    const g = grid2x2()
    expect(moveButton(g, 'b1', 0, 1)).toEqual({
      status: 'refused',
      reason: 'overlap',
    })
    expect(g.buttons[0]).toMatchObject({ row: 0, col: 0 })
  })

  it('refuses a move that leaves the grid', () => {
    const g = grid2x2()
    expect(shiftButton(g, 'b2', 0, 1)).toEqual({
      status: 'refused',
      reason: 'outside',
    })
    expect(shiftButton(g, 'b1', -1, 0)).toEqual({
      status: 'refused',
      reason: 'outside',
    })
  })

  it('refuses an unknown button', () => {
    expect(moveButton(grid2x2(), 'nope', 0, 0)).toEqual({
      status: 'refused',
      reason: 'unknown-button',
    })
  })
})

describe('layout-model: resize', () => {
  it('grows a button over free cells', () => {
    const g: RemoteLayoutPayload = { columns: 3, rows: 3, buttons: [] }
    const one = must(addButton(g, 'volume_up'))
    const tall = must(resizeButton(one, 'b1', 2, 1))
    expect(tall.buttons[0]).toMatchObject({ rowSpan: 2, colSpan: 1 })
  })

  it('refuses growth over a neighbour and past the edge', () => {
    const g = grid2x2()
    expect(resizeButton(g, 'b1', 1, 2)).toEqual({
      status: 'refused',
      reason: 'overlap',
    })
    expect(resizeButton(g, 'b2', 1, 2)).toEqual({
      status: 'refused',
      reason: 'outside',
    })
    expect(resizeButton(g, 'b1', 0, 1)).toEqual({
      status: 'refused',
      reason: 'invalid-size',
    })
  })

  it('a button never overlaps itself when it is resized in place', () => {
    const g: RemoteLayoutPayload = { columns: 2, rows: 2, buttons: [] }
    const one = must(addButton(g, 'ok'))
    expect(resizeButton(one, 'b1', 2, 2).status).toBe('ok')
  })

  it('refuses shrinking the grid under a button, and accepts it once the button is gone', () => {
    const g = grid2x2()
    expect(resizeGrid(g, 1, 2)).toEqual({
      status: 'refused',
      reason: 'would-drop-buttons',
    })
    const slim = must(resizeGrid(removeButton(g, 'b2'), 1, 2))
    expect(slim.columns).toBe(1)
  })

  it('refuses a grid size outside the schema range', () => {
    expect(resizeGrid(emptyLayout(), 0, 3).status).toBe('refused')
    expect(resizeGrid(emptyLayout(), 3, 99).status).toBe('refused')
  })
})

describe('layout-model: face and helpers', () => {
  it('sets and clears icon and label without moving the button', () => {
    const g = grid2x2()
    const face = must(setButtonFace(g, 'b1', { icon: 'power', label: 'On', role: 'power_on' }))
    expect(face.buttons[0]).toMatchObject({
      icon: 'power',
      label: 'On',
      role: 'power_on',
      row: 0,
    })
    const cleared = must(setButtonFace(face, 'b1', { icon: null, label: '  ' }))
    expect(cleared.buttons[0]).not.toHaveProperty('icon')
    expect(cleared.buttons[0]).not.toHaveProperty('label')
  })

  it('placementRefusal ignores the moving button itself', () => {
    const g = grid2x2()
    const self = g.buttons[0]
    if (self === undefined) throw new Error('fixture')
    expect(placementRefusal(g, self, 'b1')).toBeNull()
    expect(placementRefusal(g, self, null)).toBe('overlap')
  })

  it('layoutOf falls back to an empty grid for a payload that is not a layout', () => {
    expect(layoutOf({ nope: 1 })).toEqual(emptyLayout())
  })

  it('groups every known role', () => {
    expect(roleGroup('volume_up')).toBe('volume')
    expect(roleGroup('mute')).toBe('volume')
    expect(roleGroup('digit_3')).toBe('digits')
    expect(knownRolesOfGroup('digits')).toHaveLength(10)
  })
})
