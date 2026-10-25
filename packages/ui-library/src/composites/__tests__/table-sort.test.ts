/**
 * The three rules `DataTable` column sorting inherited from the device list —
 * each one asserted on the ordering it protects, not on "it sorted".
 */
import { describe, expect, it } from 'vitest'
import {
  ariaSortForColumn,
  nextSortDirection,
  nextTableSort,
  sortRowsByColumn,
  type TableSortValue,
} from '../table-sort'

interface Row {
  readonly id: string
  readonly cpu: number | null
  readonly name: string
}

const cpuOf = (r: Row): TableSortValue => r.cpu
const nameOf = (r: Row): TableSortValue => r.name

describe('nextSortDirection — the toggle rule, one copy', () => {
  it('walks none → asc → desc → none on the same column', () => {
    expect(nextSortDirection(true, null)).toBe('asc')
    expect(nextSortDirection(true, 'asc')).toBe('desc')
    expect(nextSortDirection(true, 'desc')).toBeNull()
  })

  it('restarts at asc when a different column is clicked, whatever the old direction', () => {
    expect(nextSortDirection(false, 'asc')).toBe('asc')
    expect(nextSortDirection(false, 'desc')).toBe('asc')
  })
})

describe('nextTableSort', () => {
  it('cycles the active column and re-keys on a new one', () => {
    const a = nextTableSort(null, 'cpu')
    expect(a).toEqual({ columnKey: 'cpu', dir: 'asc' })
    const b = nextTableSort(a, 'cpu')
    expect(b).toEqual({ columnKey: 'cpu', dir: 'desc' })
    expect(nextTableSort(b, 'cpu')).toBeNull()
    expect(nextTableSort(b, 'name')).toEqual({ columnKey: 'name', dir: 'asc' })
  })
})

describe('sortRowsByColumn', () => {
  const rows: readonly Row[] = [
    { id: 'b', cpu: 9, name: 'beta' },
    { id: 'a', cpu: 100, name: 'alpha' },
    { id: 'c', cpu: null, name: 'gamma' },
  ]

  it('orders a numeric column NUMERICALLY — 9 before 100, never as text', () => {
    const asc = sortRowsByColumn(rows, { columnKey: 'cpu', dir: 'asc' }, cpuOf)
    expect(asc.map((r) => r.id)).toEqual(['b', 'a', 'c'])
  })

  it('keeps a null value LAST in both directions — unknown is not a value to reverse', () => {
    const asc = sortRowsByColumn(rows, { columnKey: 'cpu', dir: 'asc' }, cpuOf)
    const desc = sortRowsByColumn(rows, { columnKey: 'cpu', dir: 'desc' }, cpuOf)
    expect(asc.at(-1)?.id).toBe('c')
    expect(desc.at(-1)?.id).toBe('c')
    // …and the rows that DO have a value are genuinely reversed between them.
    expect(desc.map((r) => r.id)).toEqual(['a', 'b', 'c'])
  })

  it('is stable — equal keys keep the order they arrived in', () => {
    const tied: readonly Row[] = [
      { id: 'first', cpu: 5, name: 'x' },
      { id: 'second', cpu: 5, name: 'x' },
      { id: 'third', cpu: 5, name: 'x' },
    ]
    const out = sortRowsByColumn(tied, { columnKey: 'cpu', dir: 'desc' }, cpuOf)
    expect(out.map((r) => r.id)).toEqual(['first', 'second', 'third'])
  })

  it('never mutates the input, and a null sort returns a fresh copy in the incoming order', () => {
    const input = [...rows]
    const snapshot = input.map((r) => r.id)
    const out = sortRowsByColumn(input, null, cpuOf)
    expect(input.map((r) => r.id)).toEqual(snapshot)
    expect(out.map((r) => r.id)).toEqual(snapshot)
    expect(out).not.toBe(input)

    sortRowsByColumn(input, { columnKey: 'cpu', dir: 'desc' }, cpuOf)
    expect(input.map((r) => r.id)).toEqual(snapshot)
  })

  it('orders a text column by collation', () => {
    const out = sortRowsByColumn(rows, { columnKey: 'name', dir: 'asc' }, nameOf)
    expect(out.map((r) => r.name)).toEqual(['alpha', 'beta', 'gamma'])
  })
})

describe('ariaSortForColumn', () => {
  it('announces the direction on the sorted column only', () => {
    const sort = { columnKey: 'cpu', dir: 'desc' } as const
    expect(ariaSortForColumn(sort, 'cpu')).toBe('descending')
    expect(ariaSortForColumn(sort, 'name')).toBe('none')
    expect(ariaSortForColumn(null, 'cpu')).toBe('none')
  })
})
