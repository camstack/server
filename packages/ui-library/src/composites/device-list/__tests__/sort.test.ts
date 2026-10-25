import { describe, it, expect } from 'vitest'
import type { DeviceItemDevice } from '../../device-item/helpers'
import { nextSort, sortRows, type DeviceSort } from '../sort'

function device(
  id: number,
  name: string,
  type: string,
  metadata?: Record<string, unknown> | null,
): DeviceItemDevice {
  return {
    id,
    stableId: `s-${String(id)}`,
    addonId: 'a',
    type,
    name,
    online: true,
    disabled: false,
    parentDeviceId: null,
    features: [],
    metadata: metadata ?? undefined,
  }
}

const rows: readonly DeviceItemDevice[] = [
  device(1, 'Charlie', 'camera', { manufacturer: 'Reolink', model: 'RLC-810A' }),
  device(2, 'alpha', 'light', { manufacturer: 'Dreame', model: 'X40' }),
  device(3, 'Bravo', 'sensor', null),
]

describe('sortRows — immutability + default order', () => {
  it('null sort returns a fresh copy in original order (no mutation)', () => {
    const out = sortRows(rows, null)
    expect(out).not.toBe(rows)
    expect(out.map((r) => r.id)).toEqual([1, 2, 3])
  })

  it('never mutates the input array', () => {
    const input = [...rows]
    const snapshot = input.map((r) => r.id)
    sortRows(input, { columnId: 'name', dir: 'asc' })
    expect(input.map((r) => r.id)).toEqual(snapshot)
  })
})

describe('sortRows — name (case-insensitive localeCompare)', () => {
  it('asc orders by name ignoring case', () => {
    const out = sortRows(rows, { columnId: 'name', dir: 'asc' })
    expect(out.map((r) => r.name)).toEqual(['alpha', 'Bravo', 'Charlie'])
  })

  it('desc reverses the name order', () => {
    const out = sortRows(rows, { columnId: 'name', dir: 'desc' })
    expect(out.map((r) => r.name)).toEqual(['Charlie', 'Bravo', 'alpha'])
  })
})

describe('sortRows — type label', () => {
  it('asc orders by the type label (Camera < Light < Sensor)', () => {
    const out = sortRows(rows, { columnId: 'type', dir: 'asc' })
    expect(out.map((r) => r.type)).toEqual(['camera', 'light', 'sensor'])
  })
})

describe('sortRows — manufacturer (missing sorts last)', () => {
  it('asc orders by manufacturer; device with no metadata sorts LAST', () => {
    const out = sortRows(rows, { columnId: 'manufacturer', dir: 'asc' })
    // Dreame < Reolink, the null-metadata device (id 3) is last.
    expect(out.map((r) => r.id)).toEqual([2, 1, 3])
  })

  it('desc reverses present manufacturers but keeps the missing one LAST', () => {
    const out = sortRows(rows, { columnId: 'manufacturer', dir: 'desc' })
    // Full order: present values descend (Reolink > Dreame), then the
    // null-metadata device (id 3) is pinned last regardless of direction.
    expect(out.map((r) => r.id)).toEqual([1, 2, 3])
  })
})

describe('sortRows — children-stay-grouped contract', () => {
  // By construction `sortRows` only ever receives the TOP-LEVEL rows: accessory
  // children are keyed per-parent in `accessoriesByParent` and never appear in
  // this list. These tests pin that contract — sorting reorders only the rows it
  // is given and never reaches into a parent's children to hoist one up.
  it('only reorders the provided top-level rows; row identity/count is preserved', () => {
    const out = sortRows(rows, { columnId: 'name', dir: 'asc' })
    // Same set of ids, just reordered — nothing added (no child hoisted in) and
    // nothing dropped.
    expect([...out].map((r) => r.id).toSorted()).toEqual([1, 2, 3])
    expect(out).toHaveLength(rows.length)
  })

  it('a row with a parentDeviceId follows its parent, never its own sort key', () => {
    // Contract flipped 2026-08-15 on the operator's report: a hub's adopted
    // rows are top-level by design, but a family scattered across the table
    // reads as a bug ("Baby monitor" wedged between a hub and its children).
    // A column sort places the PARENT by its key and the child rides along —
    // even when the child's own key ('aardvark') would win the sort.
    const child: DeviceItemDevice = {
      ...device(4, 'aardvark', 'camera', { manufacturer: 'Reolink', model: 'RLC-810A' }),
      parentDeviceId: 1,
    }
    const out = sortRows([...rows, child], { columnId: 'name', dir: 'asc' })
    const parentName = rows.find((r) => r.id === 1)?.name
    const parentIdx = out.findIndex((r) => r.id === 1)
    expect(parentName).toBeDefined()
    expect(out[parentIdx + 1]?.name).toBe('aardvark')
    expect(out).toHaveLength(rows.length + 1)
  })
})

describe('nextSort — none → asc → desc → none toggle', () => {
  it('starts asc on first click', () => {
    expect(nextSort(null, 'name')).toEqual<DeviceSort>({ columnId: 'name', dir: 'asc' })
  })

  it('asc → desc on the same column', () => {
    expect(nextSort({ columnId: 'name', dir: 'asc' }, 'name')).toEqual<DeviceSort>({
      columnId: 'name',
      dir: 'desc',
    })
  })

  it('desc → none (null) on the same column', () => {
    expect(nextSort({ columnId: 'name', dir: 'desc' }, 'name')).toBeNull()
  })

  it('switching columns starts the new column at asc', () => {
    expect(nextSort({ columnId: 'name', dir: 'desc' }, 'type')).toEqual<DeviceSort>({
      columnId: 'type',
      dir: 'asc',
    })
  })
})

describe('sortRows keeps adopted rows attached to their parent', () => {
  it('a name sort places the family together at the parent sorted position', () => {
    const mk = (id: number, name: string, parentDeviceId: number | null = null, type = 'camera') =>
      ({
        id,
        stableId: `stable-${id}`,
        addonId: 'provider-test',
        type,
        name,
        online: true,
        disabled: false,
        parentDeviceId,
        role: null,
      }) as const
    const rows = [
      mk(1, 'Zulu hub', null, 'hub'),
      mk(2, 'Alpha standalone'),
      mk(3, 'Beta child', 1),
      mk(4, 'Alpha child', 1),
    ]
    const sorted = sortRows(rows, { columnId: 'name', dir: 'asc' })
    // Alphabetical would scatter: Alpha child, Alpha standalone, Beta child, Zulu hub.
    // The family follows the hub instead, children sorted among themselves.
    expect(sorted.map((d) => d.id)).toEqual([2, 1, 4, 3])
  })
})
