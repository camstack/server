import {
  builtinRemoteComponent,
  insertComponent,
  type RemoteLayoutComponent,
  type RemoteLayoutPayload,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  arrowStep,
  cellAt,
  dropOrigin,
  itemRect,
  moveItem,
  nudgeItem,
  previewMove,
} from '../layout-drag'
import { clampToGrid, frameClass, shapeClass, toneClass } from '../remote-look'
import {
  canFillWidth,
  componentName,
  componentPreview,
  filterComponents,
  mergeComponents,
  placeComponent,
} from '../layout-components'

function layoutWith(...ids: readonly [string, number, number][]): RemoteLayoutPayload {
  let layout: RemoteLayoutPayload = { columns: 6, rows: 8, buttons: [] }
  for (const [id, row, col] of ids) {
    const placed = insertComponent(layout, builtinRemoteComponent(id), { row, col })
    if (!placed.ok) throw new Error(placed.reason)
    layout = placed.layout
  }
  return layout
}

const BOUNDS = { left: 100, top: 50, width: 600, height: 800 }

describe('drag geometry', () => {
  it('maps a point to a grid cell, including cells outside the grid', () => {
    const grid = { columns: 6, rows: 8 }
    expect(cellAt(BOUNDS, grid, 100, 50)).toEqual({ row: 0, col: 0 })
    expect(cellAt(BOUNDS, grid, 699, 849)).toEqual({ row: 7, col: 5 })
    expect(cellAt(BOUNDS, grid, 250, 260)).toEqual({ row: 2, col: 1 })
    expect(cellAt(BOUNDS, grid, 40, -10)).toEqual({ row: -1, col: -1 })
    expect(cellAt({ ...BOUNDS, width: 0 }, grid, 1, 1)).toEqual({ row: 0, col: 0 })
  })

  it('keeps the grab point inside the dragged item', () => {
    const rect = { row: 2, col: 3, rowSpan: 3, colSpan: 3 }
    // Grabbed at the item's second row and first column.
    expect(dropOrigin(rect, { row: 3, col: 3 }, { row: 5, col: 1 })).toEqual({ row: 4, col: 1 })
  })

  it('previews a valid and an invalid landing for a button', () => {
    const layout = layoutWith(['core:dpad', 0, 0], ['core:power', 0, 5])
    const free = previewMove(layout, { kind: 'button', id: 'power-power' }, { row: 5, col: 5 })
    expect(free).toMatchObject({ valid: true, reason: null })
    const clash = previewMove(layout, { kind: 'button', id: 'power-power' }, { row: 1, col: 1 })
    expect(clash).toMatchObject({ valid: false })
    const out = previewMove(layout, { kind: 'button', id: 'power-power' }, { row: 0, col: 9 })
    expect(out).toMatchObject({ valid: false, reason: 'outside' })
    expect(previewMove(layout, { kind: 'button', id: 'ghost' }, { row: 0, col: 0 })).toBeNull()
  })

  it('moves a group as one through the same check', () => {
    const layout = layoutWith(['core:dpad', 0, 0], ['core:power', 5, 0])
    const item = { kind: 'group', id: 'dpad' } as const
    expect(previewMove(layout, item, { row: 5, col: 0 })?.valid).toBe(false)
    const moved = moveItem(layout, item, { row: 0, col: 3 })
    expect(moved.status).toBe('ok')
    if (moved.status === 'ok') {
      expect(itemRect(moved.grid, item)).toMatchObject({ row: 0, col: 3 })
    }
  })

  it('nudges by one cell and refuses past the edge', () => {
    const layout = layoutWith(['core:power', 0, 0])
    const item = { kind: 'button', id: 'power-power' } as const
    expect(nudgeItem(layout, item, 0, 1).status).toBe('ok')
    expect(nudgeItem(layout, item, -1, 0)).toEqual({ status: 'refused', reason: 'outside' })
    expect(arrowStep('ArrowLeft')).toEqual({ dRow: 0, dCol: -1 })
    expect(arrowStep('Enter')).toBeNull()
  })
})

describe('component palette helpers', () => {
  const custom: RemoteLayoutComponent = {
    ...builtinRemoteComponent('core:power'),
    id: 'vendor:power',
    name: 'Vendor power',
    nameI18n: undefined,
  }

  it('merges lists once per id with core first', () => {
    const power = builtinRemoteComponent('core:power')
    const merged = mergeComponents([
      [custom, power],
      [power, builtinRemoteComponent('core:dpad')],
    ])
    expect(merged.map((c) => c.id)).toEqual(['core:power', 'core:dpad', 'vendor:power'])
  })

  it('names a component in the UI language, falling back to its name', () => {
    const dpad = builtinRemoteComponent('core:dpad')
    expect(componentName(dpad, 'it-IT')).toBe('Croce direzionale con OK')
    expect(componentName(dpad, 'en')).toBe('D-pad with OK')
    expect(componentName(custom, 'it')).toBe('Vendor power')
  })

  it('filters by name or category', () => {
    const all = [builtinRemoteComponent('core:power'), builtinRemoteComponent('core:keypad')]
    const label = (c: string): string => (c === 'numbers' ? 'Numbers' : c)
    expect(filterComponents(all, 'pad', 'en', label).map((c) => c.id)).toEqual(['core:keypad'])
    expect(filterComponents(all, 'NUMB', 'en', label).map((c) => c.id)).toEqual(['core:keypad'])
    expect(filterComponents(all, ' ', 'en', label)).toHaveLength(2)
  })

  it('places a component at the first free spot, then the next', () => {
    const dpad = builtinRemoteComponent('core:dpad')
    const first = placeComponent({ columns: 6, rows: 3, buttons: [] }, dpad)
    expect(first.ok && first.groupId).toBe('dpad')
    if (!first.ok) return
    const second = placeComponent(first.layout, dpad)
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.layout.groups?.map((g) => [g.id, g.col])).toEqual([
      ['dpad', 0],
      ['dpad-2', 3],
    ])
    expect(placeComponent(second.layout, dpad)).toEqual({ ok: false, reason: 'overlap' })
  })

  it('says outside when the component is larger than the grid', () => {
    const keypad = builtinRemoteComponent('core:keypad')
    expect(placeComponent({ columns: 2, rows: 2, buttons: [] }, keypad)).toEqual({
      ok: false,
      reason: 'outside',
    })
  })

  it('drops where asked, and stretches to the full width on request', () => {
    const divider = builtinRemoteComponent('core:section-divider')
    const layout: RemoteLayoutPayload = { columns: 6, rows: 4, buttons: [] }
    expect(canFillWidth(layout, divider)).toBe(true)
    const stretched = placeComponent(layout, divider, { at: { row: 2, col: 0 }, fillWidth: true })
    expect(stretched.ok && stretched.layout.groups?.[0]).toMatchObject({
      row: 2,
      colSpan: 6,
      frame: 'divider',
    })
    const plain = placeComponent(layout, divider, { at: { row: 2, col: 0 } })
    expect(plain.ok && plain.layout.groups?.[0]?.colSpan).toBe(1)
  })

  it('builds a thumbnail of a component on a grid of its own size', () => {
    const preview = componentPreview(builtinRemoteComponent('core:dpad'))
    expect(preview).toMatchObject({ columns: 3, rows: 3 })
    expect(preview?.buttons).toHaveLength(5)
  })
})

describe('how a layout is drawn', () => {
  it('maps known shapes, tones and frames to a look, and unknown ones to the plain look', () => {
    expect(shapeClass('pill')).toContain('rounded-full')
    expect(shapeClass('round')).toContain('aspect-square')
    expect(toneClass('accent')).toContain('bg-primary')
    expect(toneClass('green')).toContain('success')
    expect(frameClass('dpad')).toContain('border')
    expect(shapeClass('hexagon')).toBe('')
    expect(toneClass('purple')).toBe('')
    expect(toneClass(undefined)).toBe('')
    expect(frameClass('hologram')).toBe('')
    expect(frameClass('none')).toBe('')
  })

  it('uses theme tokens only', () => {
    const classes = ['rect', 'rounded', 'round', 'pill']
      .map(shapeClass)
      .concat(['neutral', 'accent', 'danger', 'red', 'green', 'yellow', 'blue'].map(toneClass))
      .concat(['panel', 'dpad', 'rocker-v', 'rocker-h', 'keypad'].map(frameClass))
      .join(' ')
    expect(classes).not.toMatch(
      /#[0-9a-f]{3,6}|rgb\(|-(red|green|blue|yellow|emerald|zinc)-\d{2,3}/i,
    )
  })

  it('clips a footprint that sticks out of the grid to the part inside', () => {
    const grid = { columns: 6, rows: 8 }
    expect(clampToGrid(grid, { row: -1, col: -2, rowSpan: 3, colSpan: 3 })).toEqual({
      row: 0,
      col: 0,
      rowSpan: 2,
      colSpan: 1,
    })
    expect(clampToGrid(grid, { row: 7, col: 5, rowSpan: 3, colSpan: 3 })).toEqual({
      row: 7,
      col: 5,
      rowSpan: 1,
      colSpan: 1,
    })
    expect(clampToGrid(grid, { row: 9, col: 9, rowSpan: 1, colSpan: 1 })).toEqual({
      row: 7,
      col: 5,
      rowSpan: 1,
      colSpan: 1,
    })
  })
})
