/**
 * Per-instance filtering for a `DataTable` (or any row list): a search box
 * and a set of facet chips, both DERIVED from the rows the instance renders.
 *
 * Pure — no React. The state lives with the caller (`useDataTableFilter`), so
 * two tables on one page each carry their own filter, and the caller keeps the
 * FILTERED set it renders: a table whose selection acts on "what is on
 * screen" has to know what that is, which a filter hidden inside the table
 * could not tell it.
 *
 * Two rules, both load-bearing:
 *   - **Facets are derived from the rows present**, most common first. A
 *     hand-listed set goes stale the day a provider adds a type and offers
 *     chips that match nothing.
 *   - **A selected facet no row carries is ignored**, not applied. The chip is
 *     not drawn (there is no row to derive it from), and an invisible filter
 *     that empties the table is a table that looks broken.
 */
import { fuzzyMatch } from './device-list/fuzzy-match'

export interface DataTableFilterState {
  /** Case- and separator-insensitive substring, see `fuzzyMatch`. */
  readonly search: string
  /** Selected facet values. Empty = every row. */
  readonly facets: readonly string[]
  /**
   * Selected chips per facet GROUP (`facetGroups[].id` → values). OR inside a
   * group, AND across groups. Absent or empty = the group does not filter.
   */
  readonly groups?: Readonly<Record<string, readonly string[]>>
}

export const EMPTY_DATA_TABLE_FILTER: DataTableFilterState = {
  search: '',
  facets: [],
}

/** One independent chip row — status, owner, kind… */
export interface DataTableFacetGroupConfig<T> {
  /** Stable id; the key of `DataTableFilterState.groups`. */
  readonly id: string
  /** The value this row contributes to THIS group's chips. */
  readonly value: (row: T) => string
}

/** A group's chips, derived from the rows. */
export interface DataTableFacetGroup {
  readonly id: string
  readonly facets: readonly DataTableFacet[]
}

/** One facet chip, with how many of the rows carry it. */
export interface DataTableFacet {
  readonly value: string
  readonly count: number
}

export interface DataTableFilterConfig<T> {
  /** Every text the search is matched against for this row — a name, and
   *  whatever else an operator would type to find it (a nested accessory's
   *  name, an id). */
  readonly searchText: (row: T) => readonly string[]
  /** The value this row contributes to the facet chips. Omit for a table
   *  with a search box only. */
  readonly facetValue?: (row: T) => string
  /** Further chip rows, each filtering on its own dimension. */
  readonly facetGroups?: readonly DataTableFacetGroupConfig<T>[]
}

/**
 * The facet chips for these rows: one per distinct value, most common first,
 * ties by value.
 */
export function dataTableFacets<T>(
  rows: readonly T[],
  facetValue: ((row: T) => string) | undefined,
): readonly DataTableFacet[] {
  if (facetValue === undefined) return []
  const counts = new Map<string, number>()
  for (const row of rows) {
    const value = facetValue(row)
    counts.set(value, (counts.get(value) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .toSorted((a, b) => b.count - a.count || a.value.localeCompare(b.value))
}

/** One chip row per configured group, each derived like {@link dataTableFacets}. */
export function dataTableFacetGroups<T>(
  rows: readonly T[],
  groups: readonly DataTableFacetGroupConfig<T>[] | undefined,
): readonly DataTableFacetGroup[] {
  return (groups ?? []).map((group) => ({
    id: group.id,
    facets: dataTableFacets(rows, group.value),
  }))
}

export function isDataTableFilterActive(state: DataTableFilterState): boolean {
  const anyGroup = Object.values(state.groups ?? {}).some((values) => values.length > 0)
  return state.search.trim() !== '' || state.facets.length > 0 || anyGroup
}

/** A new state with `value` added to, or removed from, group `groupId`. */
export function toggleDataTableGroupFacet(
  state: DataTableFilterState,
  groupId: string,
  value: string,
): DataTableFilterState {
  const current = state.groups?.[groupId] ?? []
  const next = current.includes(value) ? current.filter((v) => v !== value) : [...current, value]
  return { ...state, groups: { ...state.groups, [groupId]: next } }
}

/** A new state with `value` added to, or removed from, the selected facets. */
export function toggleDataTableFacet(
  state: DataTableFilterState,
  value: string,
): DataTableFilterState {
  return {
    ...state,
    facets: state.facets.includes(value)
      ? state.facets.filter((v) => v !== value)
      : [...state.facets, value],
  }
}

/**
 * The rows that survive the filter, in their incoming order.
 *
 * A selected facet that none of `rows` carries is dropped from the effective
 * selection (see the header), so a chip that is not on screen never filters.
 */
export function filterDataTableRows<T>(
  rows: readonly T[],
  state: DataTableFilterState,
  config: DataTableFilterConfig<T>,
): readonly T[] {
  const needle = state.search.trim()
  const facetValue = config.facetValue
  const present = new Set(dataTableFacets(rows, facetValue).map((f) => f.value))
  const selected = new Set(state.facets.filter((v) => present.has(v)))
  // Same "a chip nobody carries is ignored" rule, per group.
  const groupGates = (config.facetGroups ?? []).flatMap((group) => {
    const presentInGroup = new Set(dataTableFacets(rows, group.value).map((f) => f.value))
    const chosen = new Set((state.groups?.[group.id] ?? []).filter((v) => presentInGroup.has(v)))
    return chosen.size === 0 ? [] : [{ value: group.value, chosen }]
  })
  return rows.filter((row) => {
    if (selected.size > 0 && facetValue !== undefined && !selected.has(facetValue(row))) {
      return false
    }
    if (groupGates.some((gate) => !gate.chosen.has(gate.value(row)))) return false
    if (needle !== '' && !config.searchText(row).some((text) => fuzzyMatch(needle, text))) {
      return false
    }
    return true
  })
}
