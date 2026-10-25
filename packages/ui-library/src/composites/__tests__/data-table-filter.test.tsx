// @vitest-environment jsdom
/**
 * The per-instance table filter: the pure rules, and the bar the operator
 * touches.
 *
 * The rule most likely to be "simplified" away is the last one: a selected
 * facet that no row carries is IGNORED. Its chip is not drawn (chips are
 * derived from the rows), and a filter the operator cannot see or undo is a
 * table that looks empty for no reason.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import {
  dataTableFacets,
  EMPTY_DATA_TABLE_FILTER,
  filterDataTableRows,
  isDataTableFilterActive,
  toggleDataTableFacet,
  type DataTableFilterConfig,
} from '../data-table-filter'
import { DataTableFilterBar } from '../data-table-filter-bar'
import { useDataTableFilter } from '../use-data-table-filter'

interface Row {
  readonly id: number
  readonly name: string
  readonly type: string
  readonly children: readonly string[]
}

const ROWS: readonly Row[] = [
  { id: 1, name: 'Camera Hall', type: 'camera', children: ['Sirena hall'] },
  { id: 2, name: 'Serratura', type: 'lock', children: [] },
  { id: 3, name: 'Camera Kitchen', type: 'camera', children: [] },
  { id: 4, name: 'Contatto porta', type: 'container', children: ['Batteria'] },
]

const CONFIG: DataTableFilterConfig<Row> = {
  searchText: (row) => [row.name, ...row.children],
  facetValue: (row) => row.type,
}

const ids = (rows: readonly Row[]): number[] => rows.map((r) => r.id)

describe('dataTableFacets', () => {
  it('derives the chips from the rows, most common first, ties by value', () => {
    expect(dataTableFacets(ROWS, CONFIG.facetValue)).toEqual([
      { value: 'camera', count: 2 },
      { value: 'container', count: 1 },
      { value: 'lock', count: 1 },
    ])
  })

  it('has no chips for a table with no facet', () => {
    expect(dataTableFacets(ROWS, undefined)).toEqual([])
  })
})

describe('filterDataTableRows', () => {
  it('leaves the rows intact for the empty filter', () => {
    expect(filterDataTableRows(ROWS, EMPTY_DATA_TABLE_FILTER, CONFIG)).toEqual(ROWS)
    expect(isDataTableFilterActive(EMPTY_DATA_TABLE_FILTER)).toBe(false)
  })

  it('matches the search against EVERY text the row offers — a nested name finds its parent', () => {
    const state = { ...EMPTY_DATA_TABLE_FILTER, search: 'batteria' }
    expect(ids(filterDataTableRows(ROWS, state, CONFIG))).toEqual([4])
    expect(isDataTableFilterActive(state)).toBe(true)
  })

  it('search is case- and separator-insensitive', () => {
    const state = { ...EMPTY_DATA_TABLE_FILTER, search: 'CAMERA-kit' }
    expect(ids(filterDataTableRows(ROWS, state, CONFIG))).toEqual([3])
  })

  it('a selected facet keeps only its rows, and combines with the search', () => {
    const facets = toggleDataTableFacet(EMPTY_DATA_TABLE_FILTER, 'camera')
    expect(ids(filterDataTableRows(ROWS, facets, CONFIG))).toEqual([1, 3])
    expect(ids(filterDataTableRows(ROWS, { ...facets, search: 'hall' }, CONFIG))).toEqual([1])
  })

  it('toggling a facet twice clears it', () => {
    const on = toggleDataTableFacet(EMPTY_DATA_TABLE_FILTER, 'lock')
    expect(on.facets).toEqual(['lock'])
    expect(toggleDataTableFacet(on, 'lock').facets).toEqual([])
  })

  it('IGNORES a selected facet that no row carries — an invisible chip never filters', () => {
    const state = toggleDataTableFacet(EMPTY_DATA_TABLE_FILTER, 'vacuum')
    expect(filterDataTableRows(ROWS, state, CONFIG)).toEqual(ROWS)
  })
})

const LABELS = {
  searchPlaceholder: 'Search…',
  searchLabel: 'Search the table',
  facetsLabel: 'Filter by type',
  clearLabel: 'Clear',
}

function Harness({ rows }: { readonly rows: readonly Row[] }) {
  const filter = useDataTableFilter(rows, CONFIG)
  return (
    <div>
      <DataTableFilterBar
        state={filter.state}
        facets={filter.facets}
        labels={LABELS}
        onSearch={filter.setSearch}
        onToggleFacet={filter.toggleFacet}
        onClear={filter.clear}
      />
      <ul>
        {filter.rows.map((row) => (
          <li key={row.id}>{row.name}</li>
        ))}
      </ul>
      <output data-testid="active">{String(filter.active)}</output>
    </div>
  )
}

describe('DataTableFilterBar + useDataTableFilter', () => {
  it('typing narrows the rows; a chip narrows them further; clear restores everything', () => {
    render(<Harness rows={ROWS} />)
    expect(screen.getAllByRole('listitem').length).toBe(4)

    fireEvent.change(screen.getByLabelText('Search the table'), { target: { value: 'camera' } })
    expect(screen.getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'Camera Hall',
      'Camera Kitchen',
    ])

    // Chips are derived from the UNFILTERED rows: the lock is still offered.
    const chips = screen.getByRole('group', { name: 'Filter by type' })
    fireEvent.click(screen.getByRole('button', { name: /^lock/ }))
    expect(chips).toBeTruthy()
    expect(screen.queryAllByRole('listitem').length).toBe(0)
    expect(screen.getByTestId('active').textContent).toBe('true')

    fireEvent.click(screen.getByRole('button', { name: 'Clear' }))
    expect(screen.getAllByRole('listitem').length).toBe(4)
    expect(screen.getByTestId('active').textContent).toBe('false')
  })

  it('draws the chip group only when it can narrow something', () => {
    render(<Harness rows={ROWS.filter((r) => r.type === 'camera')} />)
    expect(screen.queryByRole('group', { name: 'Filter by type' })).toBeNull()
  })

  it('two bars on one page do not share a state', () => {
    render(
      <>
        <Harness rows={ROWS} />
        <Harness rows={ROWS} />
      </>,
    )
    const [first] = screen.getAllByLabelText('Search the table')
    fireEvent.change(first!, { target: { value: 'serratura' } })
    // 1 row in the first list, 4 in the second.
    expect(screen.getAllByRole('listitem').length).toBe(5)
  })
})
