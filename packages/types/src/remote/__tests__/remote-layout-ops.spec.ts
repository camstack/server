import { describe, expect, it } from 'vitest'
import { builtinRemoteComponent } from '../remote-builtin-components.js'
import { type RemoteLayoutPayload, RemoteLayoutPayloadSchema } from '../remote-config.js'
import {
  fillWidthScale,
  type InsertedComponent,
  insertComponent,
  moveGroup,
  removeGroup,
  ungroup,
} from '../remote-layout-ops.js'

const empty = (columns = 8, rows = 8): RemoteLayoutPayload => ({ columns, rows, buttons: [] })
const dpad = builtinRemoteComponent('core:dpad')

function inserted(
  layout: RemoteLayoutPayload,
  id: string,
  row: number,
  col: number,
): InsertedComponent {
  const result = insertComponent(layout, builtinRemoteComponent(id), { row, col })
  if (!result.ok) throw new Error(`insert ${id}: ${result.reason}`)
  expect(RemoteLayoutPayloadSchema.safeParse(result.layout).success).toBe(true)
  return result
}

describe('insertComponent', () => {
  it('offsets buttons and the group to the insertion point and groups the members', () => {
    const { layout, groupId, buttonIds } = inserted(empty(), 'core:dpad', 2, 3)
    expect(groupId).toBe('dpad')
    expect(layout.groups).toEqual([
      {
        id: 'dpad',
        componentId: 'core:dpad',
        frame: 'dpad',
        row: 2,
        col: 3,
        rowSpan: 3,
        colSpan: 3,
      },
    ])
    expect(layout.buttons.find((b) => b.id === 'dpad-ok')).toMatchObject({
      row: 3,
      col: 4,
      role: 'ok',
      shape: 'round',
      groupId: 'dpad',
    })
    expect(buttonIds).toHaveLength(5)
  })

  it('allocates unique ids for a second instance', () => {
    const first = inserted(empty(), 'core:dpad', 0, 0)
    const second = inserted(first.layout, 'core:dpad', 4, 0)
    expect(second.groupId).toBe('dpad-2')
    expect(new Set(second.layout.buttons.map((b) => b.id)).size).toBe(10)
  })

  it('inserts a groupless component as loose buttons with unique ids', () => {
    const a = inserted(empty(), 'core:colour-keys', 0, 0)
    const b = inserted(a.layout, 'core:colour-keys', 1, 0)
    expect(a.groupId).toBeNull()
    expect(b.layout.groups).toBeUndefined()
    expect(b.layout.buttons.filter((x) => x.tone === 'red')).toHaveLength(2)
  })

  it('refuses outside the grid with the typed reason and leaves the layout alone', () => {
    const layout = empty(4, 4)
    expect(insertComponent(layout, dpad, { row: 2, col: 0 })).toEqual({
      ok: false,
      reason: 'outside',
    })
    expect(insertComponent(layout, dpad, { row: 0, col: 2 })).toEqual({
      ok: false,
      reason: 'outside',
    })
    expect(layout.buttons).toEqual([])
  })

  it('refuses an overlap with a key and with a group', () => {
    const { layout } = inserted(empty(), 'core:dpad', 0, 0)
    const power = builtinRemoteComponent('core:power')
    const colours = builtinRemoteComponent('core:colour-keys')
    expect(insertComponent(layout, dpad, { row: 1, col: 1 })).toEqual({
      ok: false,
      reason: 'overlap',
    })
    expect(insertComponent(layout, power, { row: 0, col: 0 })).toEqual({
      ok: false,
      reason: 'overlap',
    })
    expect(insertComponent(layout, colours, { row: 2, col: 0 })).toEqual({
      ok: false,
      reason: 'overlap',
    })
  })

  it('scales a component, and a divider can fill the grid width', () => {
    const grid = empty(12, 6)
    const divider = builtinRemoteComponent('core:section-divider')
    const scale = fillWidthScale(grid, divider)
    expect(scale).toBe(12)
    const r = insertComponent(grid, divider, { row: 0, col: 0 }, { scale: { cols: scale ?? 1 } })
    if (!r.ok) throw new Error(r.reason)
    expect(r.layout.groups?.[0]).toMatchObject({ frame: 'divider', colSpan: 12, title: 'Section' })
    expect(fillWidthScale(empty(5, 5), builtinRemoteComponent('core:keypad'))).toBeNull()
    const pad = insertComponent(grid, dpad, { row: 1, col: 0 }, { scale: { cols: 4 } })
    expect(pad.ok && pad.layout.buttons.find((b) => b.id === 'dpad-ok')).toMatchObject({
      col: 4,
      colSpan: 4,
    })
  })

  it('adds extras as members of the instance', () => {
    const r = insertComponent(
      empty(),
      builtinRemoteComponent('core:keypad'),
      { row: 0, col: 0 },
      {
        extras: [
          { idSuffix: 'ttx', row: 3, col: 0, rowSpan: 1, colSpan: 1, role: 'custom:ttx_mix' },
        ],
      },
    )
    if (!r.ok) throw new Error(r.reason)
    expect(r.layout.buttons.find((b) => b.role === 'custom:ttx_mix')?.groupId).toBe('keypad')
    expect(RemoteLayoutPayloadSchema.safeParse(r.layout).success).toBe(true)
  })
})

describe('moveGroup', () => {
  it('moves the group and every member by the same offset', () => {
    const { layout } = inserted(empty(), 'core:dpad', 0, 0)
    const moved = moveGroup(layout, 'dpad', { row: 4, col: 2 })
    if (!moved.ok) throw new Error(moved.reason)
    expect(moved.layout.groups?.[0]).toMatchObject({ row: 4, col: 2 })
    expect(moved.layout.buttons.find((b) => b.id === 'dpad-up')).toMatchObject({ row: 4, col: 3 })
    expect(moved.layout.buttons.find((b) => b.id === 'dpad-down')).toMatchObject({ row: 6, col: 3 })
    expect(RemoteLayoutPayloadSchema.safeParse(moved.layout).success).toBe(true)
  })

  it('refuses outside, overlap and an unknown group, leaving every member in place', () => {
    const a = inserted(empty(), 'core:dpad', 0, 0)
    const b = inserted(a.layout, 'core:power', 0, 5)
    expect(moveGroup(b.layout, 'dpad', { row: 6, col: 0 })).toEqual({
      ok: false,
      reason: 'outside',
    })
    expect(moveGroup(b.layout, 'dpad', { row: 0, col: 4 })).toEqual({
      ok: false,
      reason: 'overlap',
    })
    expect(moveGroup(b.layout, 'missing', { row: 0, col: 0 })).toEqual({
      ok: false,
      reason: 'unknown-group',
    })
    const c = inserted(b.layout, 'core:panel', 4, 0)
    expect(moveGroup(c.layout, 'panel', { row: 2, col: 0 })).toEqual({
      ok: false,
      reason: 'overlap',
    })
    expect(c.layout.buttons.find((x) => x.id === 'dpad-up')).toMatchObject({ row: 0, col: 1 })
  })
})

describe('removeGroup / ungroup', () => {
  it('removes the members with the group, or keeps them as loose keys', () => {
    const { layout } = inserted(empty(), 'core:dpad', 0, 0)
    const gone = removeGroup(layout, 'dpad', { keepButtons: false })
    if (!gone.ok) throw new Error(gone.reason)
    expect(gone.layout.buttons).toEqual([])
    expect(gone.layout.groups).toBeUndefined()
    const kept = removeGroup(layout, 'dpad', { keepButtons: true })
    if (!kept.ok) throw new Error(kept.reason)
    expect(kept.layout.buttons).toHaveLength(5)
    expect(kept.layout.buttons.every((b) => b.groupId === undefined)).toBe(true)
    expect(RemoteLayoutPayloadSchema.safeParse(kept.layout).success).toBe(true)
    expect(removeGroup(layout, 'x', { keepButtons: true })).toEqual({
      ok: false,
      reason: 'unknown-group',
    })
  })

  it('ungroup keeps the buttons in place', () => {
    const { layout } = inserted(empty(), 'core:keypad', 0, 0)
    const result = ungroup(layout, 'keypad')
    if (!result.ok) throw new Error(result.reason)
    expect(result.layout.buttons).toHaveLength(10)
    expect(result.layout.groups).toBeUndefined()
  })
})
