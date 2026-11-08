import { describe, expect, it } from 'vitest'
import { planSourceSelectRow } from '../source-select-row.js'

const layout = {
  columns: 3,
  rows: 2,
  buttons: [
    { id: 'a', row: 0, col: 0, rowSpan: 1, colSpan: 1, role: 'power' },
    { id: 'b', row: 1, col: 1, rowSpan: 1, colSpan: 2, role: 'ok', groupId: 'g' },
  ],
  groups: [{ id: 'g', componentId: 'c', frame: 'panel', row: 1, col: 0, rowSpan: 1, colSpan: 3 }],
}

describe('planSourceSelectRow', () => {
  it('inserts a full-width key at row 0 and shifts buttons and groups down', () => {
    const plan = planSourceSelectRow(layout)
    if (plan.status !== 'insert') throw new Error(plan.status)
    expect(plan.layout.rows).toBe(3)
    expect(plan.layout.buttons[0]).toMatchObject({
      role: 'source_select',
      row: 0,
      col: 0,
      rowSpan: 1,
      colSpan: 3,
    })
    expect(plan.layout.buttons.slice(1).map((b) => [b.id, b.row])).toEqual([
      ['a', 1],
      ['b', 2],
    ])
    expect(plan.layout.groups?.[0]?.row).toBe(2)
  })

  it('is idempotent: its own output is already present', () => {
    const plan = planSourceSelectRow(layout)
    if (plan.status !== 'insert') throw new Error(plan.status)
    expect(planSourceSelectRow(plan.layout)).toEqual({ status: 'already-present' })
  })

  it('does not touch the input and adds no groups when there are none', () => {
    const copy = structuredClone(layout)
    planSourceSelectRow(layout)
    expect(layout).toEqual(copy)
    const plan = planSourceSelectRow({
      ...layout,
      groups: undefined,
      buttons: layout.buttons.map(({ groupId: _g, ...b }) => b),
    })
    if (plan.status !== 'insert') throw new Error(plan.status)
    expect(plan.layout.groups).toBeUndefined()
  })

  it('picks a free id when "source_select" is taken by another key', () => {
    const plan = planSourceSelectRow({
      ...layout,
      buttons: [{ ...layout.buttons[0], id: 'source_select' }, layout.buttons[1]],
    })
    if (plan.status !== 'insert') throw new Error(plan.status)
    expect(plan.layout.buttons[0]?.id).toBe('source_select_2')
  })

  it('refuses a grid with no room for another row and a non-layout payload', () => {
    expect(planSourceSelectRow({ ...layout, rows: 24 }).status).toBe('refused')
    expect(planSourceSelectRow({ nope: true }).status).toBe('refused')
  })
})
