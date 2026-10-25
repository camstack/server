// @vitest-environment jsdom
/**
 * Facet GROUPS — several independent chip rows (status, owner, kind) over one
 * table. OR inside a group, AND across groups: "active OR expired" AND
 * "owned by alice". A selected chip no row carries is ignored, exactly like
 * the single-facet rule, so an invisible filter never empties the table.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import {
  dataTableFacetGroups,
  EMPTY_DATA_TABLE_FILTER,
  filterDataTableRows,
  isDataTableFilterActive,
  toggleDataTableGroupFacet,
  type DataTableFilterConfig,
} from '../data-table-filter'
import { DataTableFilterBar } from '../data-table-filter-bar'
import { useDataTableFilter } from '../use-data-table-filter'

interface Row {
  readonly id: string
  readonly status: 'active' | 'expired'
  readonly owner: string
}

const ROWS: readonly Row[] = [
  { id: 'a', status: 'active', owner: 'alice' },
  { id: 'b', status: 'expired', owner: 'alice' },
  { id: 'c', status: 'active', owner: 'bob' },
  { id: 'd', status: 'active', owner: 'alice' },
]

const CONFIG: DataTableFilterConfig<Row> = {
  searchText: (r) => [r.id],
  facetGroups: [
    { id: 'status', value: (r) => r.status },
    { id: 'owner', value: (r) => r.owner },
  ],
}

const ids = (rows: readonly Row[]): string[] => rows.map((r) => r.id)

describe('facet groups — pure rules', () => {
  it('derives one chip row per group, most common first', () => {
    expect(dataTableFacetGroups(ROWS, CONFIG.facetGroups)).toEqual([
      {
        id: 'status',
        facets: [
          { value: 'active', count: 3 },
          { value: 'expired', count: 1 },
        ],
      },
      {
        id: 'owner',
        facets: [
          { value: 'alice', count: 3 },
          { value: 'bob', count: 1 },
        ],
      },
    ])
  })

  it('ANDs across groups and ORs within one', () => {
    let state = toggleDataTableGroupFacet(EMPTY_DATA_TABLE_FILTER, 'owner', 'alice')
    expect(ids(filterDataTableRows(ROWS, state, CONFIG))).toEqual(['a', 'b', 'd'])
    state = toggleDataTableGroupFacet(state, 'status', 'active')
    expect(ids(filterDataTableRows(ROWS, state, CONFIG))).toEqual(['a', 'd'])
    state = toggleDataTableGroupFacet(state, 'status', 'expired')
    expect(ids(filterDataTableRows(ROWS, state, CONFIG))).toEqual(['a', 'b', 'd'])
    expect(isDataTableFilterActive(state)).toBe(true)
  })

  it('a second toggle removes the chip, and an empty group stops filtering', () => {
    const on = toggleDataTableGroupFacet(EMPTY_DATA_TABLE_FILTER, 'owner', 'bob')
    const off = toggleDataTableGroupFacet(on, 'owner', 'bob')
    expect(ids(filterDataTableRows(ROWS, off, CONFIG))).toEqual(['a', 'b', 'c', 'd'])
    expect(isDataTableFilterActive(off)).toBe(false)
  })

  it('ignores a selected chip that no row carries', () => {
    const state = toggleDataTableGroupFacet(EMPTY_DATA_TABLE_FILTER, 'owner', 'carol')
    expect(ids(filterDataTableRows(ROWS, state, CONFIG))).toEqual(['a', 'b', 'c', 'd'])
  })
})

function Harness() {
  const filter = useDataTableFilter(ROWS, CONFIG)
  return (
    <div>
      <DataTableFilterBar
        state={filter.state}
        facets={filter.facets}
        groups={filter.groups.map((g) => ({
          ...g,
          label: g.id === 'status' ? 'Status' : 'Owner',
        }))}
        labels={{
          searchPlaceholder: 'Search',
          searchLabel: 'Search rows',
          facetsLabel: 'Filter',
          clearLabel: 'Clear',
        }}
        onSearch={filter.setSearch}
        onToggleFacet={filter.toggleFacet}
        onToggleGroupFacet={filter.toggleGroupFacet}
        onClear={filter.clear}
      />
      <ul>
        {filter.rows.map((r) => (
          <li key={r.id}>{r.id}</li>
        ))}
      </ul>
    </div>
  )
}

describe('facet groups — the bar', () => {
  it('renders a named chip group per facet group and filters on click', () => {
    render(<Harness />)
    const owner = screen.getByRole('group', { name: 'Owner' })
    fireEvent.click(owner.querySelector('button[aria-pressed]') as HTMLElement)
    expect(screen.getAllByRole('listitem').map((li) => li.textContent)).toEqual(['a', 'b', 'd'])
    fireEvent.click(screen.getByRole('button', { name: /Clear/ }))
    expect(screen.getAllByRole('listitem')).toHaveLength(4)
  })
})
