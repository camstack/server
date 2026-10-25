/**
 * The React half of `data-table-filter.ts`: one filter state per call site,
 * so every table on a page filters on its own.
 *
 * The caller renders `rows` (the filtered set) and hands `state` + the two
 * setters to a `DataTableFilterBar`. It keeps the filtered set because
 * anything that acts on "the rows on screen" — a select-all, a bulk action —
 * must act on exactly these and nothing the filter hid.
 */
import { useCallback, useMemo, useState } from 'react'
import {
  dataTableFacetGroups,
  dataTableFacets,
  EMPTY_DATA_TABLE_FILTER,
  filterDataTableRows,
  isDataTableFilterActive,
  toggleDataTableFacet,
  toggleDataTableGroupFacet,
  type DataTableFacet,
  type DataTableFilterConfig,
  type DataTableFilterState,
} from './data-table-filter'

/** A facet group as the bar renders it: its chips and what is selected. */
export interface DataTableFilterGroupView {
  readonly id: string
  readonly facets: readonly DataTableFacet[]
  readonly selected: readonly string[]
}

export interface DataTableFilter<T> {
  readonly state: DataTableFilterState
  readonly setSearch: (search: string) => void
  readonly toggleFacet: (value: string) => void
  readonly toggleGroupFacet: (groupId: string, value: string) => void
  /** One entry per `facetGroups` config, chips derived from the UNFILTERED rows. */
  readonly groups: readonly DataTableFilterGroupView[]
  readonly clear: () => void
  /** Chips derived from the UNFILTERED rows — a chip never disappears because
   *  it was the one just pressed. */
  readonly facets: readonly DataTableFacet[]
  /** The rows that survive the filter. */
  readonly rows: readonly T[]
  /** True when the filter is narrowing anything — what an empty state should
   *  read before it says "there is nothing here". */
  readonly active: boolean
}

export function useDataTableFilter<T>(
  rows: readonly T[],
  config: DataTableFilterConfig<T>,
  /** Mount-time filter (e.g. Status = active). Clear resets to empty, not this. */
  initialState: DataTableFilterState = EMPTY_DATA_TABLE_FILTER,
): DataTableFilter<T> {
  const [state, setState] = useState<DataTableFilterState>(initialState)
  const setSearch = useCallback((search: string): void => {
    setState((prev) => ({ ...prev, search }))
  }, [])
  const toggleFacet = useCallback((value: string): void => {
    setState((prev) => toggleDataTableFacet(prev, value))
  }, [])
  const toggleGroupFacet = useCallback((groupId: string, value: string): void => {
    setState((prev) => toggleDataTableGroupFacet(prev, groupId, value))
  }, [])
  const clear = useCallback((): void => setState(EMPTY_DATA_TABLE_FILTER), [])

  const { searchText, facetValue, facetGroups } = config
  const facets = useMemo(() => dataTableFacets(rows, facetValue), [rows, facetValue])
  const groups = useMemo(
    () =>
      dataTableFacetGroups(rows, facetGroups).map((group) => ({
        ...group,
        selected: state.groups?.[group.id] ?? [],
      })),
    [rows, facetGroups, state.groups],
  )
  const filtered = useMemo(
    () => filterDataTableRows(rows, state, { searchText, facetValue, facetGroups }),
    [rows, state, searchText, facetValue, facetGroups],
  )

  return {
    state,
    setSearch,
    toggleFacet,
    toggleGroupFacet,
    groups,
    clear,
    facets,
    rows: filtered,
    active: isDataTableFilterActive(state),
  }
}
