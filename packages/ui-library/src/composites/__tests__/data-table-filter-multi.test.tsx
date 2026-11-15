// @vitest-environment jsdom
/**
 * A MULTI-valued facet group (a row's tags): a row counts toward every value it
 * carries and passes when ANY of them is chosen. Such a group is worth drawing
 * with one value (it still splits tagged from untagged rows) — `minFacets: 1`.
 * `setGroupFacets` replaces a group's selection (a renamed tag follows).
 */
import { act, render, renderHook, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import {
  dataTableFacetGroups,
  EMPTY_DATA_TABLE_FILTER,
  filterDataTableRows,
  type DataTableFilterConfig,
} from '../data-table-filter'
import { DataTableFilterBar } from '../data-table-filter-bar'
import { useDataTableFilter } from '../use-data-table-filter'

interface Row {
  readonly id: string
  readonly tags: readonly string[]
}

const ROWS: readonly Row[] = [
  { id: 'a', tags: ['Garden', 'Night'] },
  { id: 'b', tags: [] },
  { id: 'c', tags: ['Garden'] },
]

const CONFIG: DataTableFilterConfig<Row> = {
  searchText: (r) => [r.id, ...r.tags],
  facetGroups: [{ id: 'tags', values: (r) => r.tags }],
}

describe('multi-valued facet group', () => {
  it('counts a row toward every value it carries', () => {
    expect(dataTableFacetGroups(ROWS, CONFIG.facetGroups)).toEqual([
      {
        id: 'tags',
        facets: [
          { value: 'Garden', count: 2 },
          { value: 'Night', count: 1 },
        ],
      },
    ])
  })

  it('keeps a row carrying ANY chosen value', () => {
    const state = { ...EMPTY_DATA_TABLE_FILTER, groups: { tags: ['Night'] } }
    expect(filterDataTableRows(ROWS, state, CONFIG).map((r) => r.id)).toEqual(['a'])
  })

  it('setGroupFacets replaces the selection of one group', () => {
    const { result } = renderHook(() => useDataTableFilter(ROWS, CONFIG))
    act(() => result.current.setGroupFacets('tags', ['Garden']))
    expect(result.current.rows.map((r) => r.id)).toEqual(['a', 'c'])
    act(() => result.current.setGroupFacets('tags', []))
    expect(result.current.rows).toHaveLength(3)
  })

  it('draws a one-value group with minFacets 1, plus the trailing slot', () => {
    render(
      <DataTableFilterBar
        state={EMPTY_DATA_TABLE_FILTER}
        facets={[]}
        labels={{
          searchPlaceholder: 's',
          searchLabel: 'Search',
          facetsLabel: 'f',
          clearLabel: 'c',
        }}
        onSearch={() => {}}
        onToggleFacet={() => {}}
        onClear={() => {}}
        groups={[
          {
            id: 'tags',
            label: 'Tags',
            facets: [{ value: 'Garden', count: 2 }],
            selected: [],
            display: 'menu',
            minFacets: 1,
          },
        ]}
        trailing={<span data-testid="trailing" />}
      />,
    )
    expect(screen.getByRole('button', { name: /Tags/ })).toBeTruthy()
    expect(screen.getByTestId('trailing')).toBeTruthy()
  })
})
