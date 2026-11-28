/**
 * useTagFilter — one section's tag filter (D1054), built on the shared table
 * filter (`useDataTableFilter`): the search matches the row text and its tag
 * names, the tags are one multi-valued facet group, and the flat | by-tag view
 * is remembered per section in `localStorage`. The selection follows the
 * registry's writes: a renamed tag stays selected, a removed one leaves.
 */
import { normalizeTags } from '@dominevo/types'
import { useCallback, useMemo, useState } from 'react'
import type { DataTableFacet, DataTableFilterConfig } from '../data-table-filter'
import { type DataTableFilter, useDataTableFilter } from '../use-data-table-filter'
import {
  type TagGroup,
  type TagViewMode,
  followTagRename,
  groupByTag,
  readTagViewMode,
  tagViewStorageKey,
  writeTagViewMode,
} from './tag-model'

/** The facet group id the tags occupy in the table filter. */
export const TAG_FACET_GROUP = 'tags'

export interface UseTagFilterOptions<T> {
  /** Names the remembered view (`automations`, `devices`, …). */
  readonly section: string
  readonly rows: readonly T[]
  /** Stable (memoised) accessors: they key the filter's memos. */
  readonly getTags: (row: T) => readonly string[] | undefined
  /** The texts the search matches besides the tags (the row's name, …). */
  readonly searchText: (row: T) => readonly string[]
}

export interface TagFilter<T> {
  /** The shared table filter: search, the tags group, clear. */
  readonly filter: DataTableFilter<T>
  /** The tags the rows carry, with counts (derived from the unfiltered rows). */
  readonly tagFacets: readonly DataTableFacet[]
  readonly selected: readonly string[]
  readonly setSelected: (next: readonly string[]) => void
  /** After a rename (`to`) or a remove (`to: null`) of a tag. */
  readonly followRename: (from: string, to: string | null) => void
  readonly mode: TagViewMode
  readonly setMode: (mode: TagViewMode) => void
  /** Rows passing the search and the tag filter, in the given order. */
  readonly visible: readonly T[]
  /** `visible` grouped by tag; meaningful when `mode` is `grouped`. */
  readonly groups: readonly TagGroup<T>[]
}

export function useTagFilter<T>({
  section,
  rows,
  getTags,
  searchText,
}: UseTagFilterOptions<T>): TagFilter<T> {
  const storageKey = tagViewStorageKey(section)
  const [mode, setModeState] = useState<TagViewMode>(() => readTagViewMode(storageKey))

  const config: DataTableFilterConfig<T> = useMemo(
    () => ({
      searchText: (row: T) => [...searchText(row), ...(getTags(row) ?? [])],
      facetGroups: [{ id: TAG_FACET_GROUP, values: (row: T) => normalizeTags(getTags(row) ?? []) }],
    }),
    [searchText, getTags],
  )
  const filter = useDataTableFilter(rows, config)
  const selected = filter.state.groups?.[TAG_FACET_GROUP] ?? []
  const tagFacets = filter.groups.find((g) => g.id === TAG_FACET_GROUP)?.facets ?? []
  const groups = useMemo(() => groupByTag(filter.rows, getTags), [filter.rows, getTags])

  const { setGroupFacets } = filter
  const setSelected = useCallback(
    (next: readonly string[]): void => setGroupFacets(TAG_FACET_GROUP, next),
    [setGroupFacets],
  )
  const followRename = useCallback(
    (from: string, to: string | null): void =>
      setGroupFacets(TAG_FACET_GROUP, followTagRename(selected, from, to)),
    [setGroupFacets, selected],
  )
  const setMode = (next: TagViewMode): void => {
    setModeState(next)
    writeTagViewMode(storageKey, next)
  }

  return {
    filter,
    tagFacets,
    selected,
    setSelected,
    followRename,
    mode,
    setMode,
    visible: filter.rows,
    groups,
  }
}
