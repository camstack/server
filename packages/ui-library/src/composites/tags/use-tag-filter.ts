/**
 * useTagFilter — one section's tag filter state (D1054): the search (row text
 * and tag names), the chosen tags (any of), and the flat | by-tag view, which is
 * remembered per section in `localStorage`. Works over any row type; the
 * section says where a row's tags and text are.
 */
import { useMemo, useState } from 'react'
import {
  filterByTags,
  groupByTag,
  matchesTagSearch,
  readTagViewMode,
  type TagCount,
  type TagGroup,
  type TagViewMode,
  tagsInRows,
  tagViewStorageKey,
  writeTagViewMode,
} from './tag-model'

export interface UseTagFilterOptions<T> {
  /** Names the remembered view (`automations`, `devices`, …). */
  readonly section: string
  readonly rows: readonly T[]
  readonly getTags: (row: T) => readonly string[] | undefined
  /** The texts the search matches besides the tags (the row's name, …). */
  readonly searchText: (row: T) => readonly string[]
}

export interface TagFilter<T> {
  readonly search: string
  readonly setSearch: (search: string) => void
  readonly selected: readonly string[]
  readonly setSelected: (next: readonly string[]) => void
  readonly mode: TagViewMode
  readonly setMode: (mode: TagViewMode) => void
  /** The tags all rows carry (the menu does not shrink as the filter narrows). */
  readonly tags: readonly TagCount[]
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
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<readonly string[]>([])
  const [mode, setModeState] = useState<TagViewMode>(() => readTagViewMode(storageKey))

  const tags = useMemo(() => tagsInRows(rows, getTags), [rows, getTags])
  const visible = useMemo(
    () =>
      filterByTags(rows, getTags, selected).filter((row) =>
        matchesTagSearch(search, searchText(row), getTags(row)),
      ),
    [rows, getTags, selected, search, searchText],
  )
  const groups = useMemo(() => groupByTag(visible, getTags), [visible, getTags])

  const setMode = (next: TagViewMode): void => {
    setModeState(next)
    writeTagViewMode(storageKey, next)
  }

  return { search, setSearch, selected, setSelected, mode, setMode, tags, visible, groups }
}
