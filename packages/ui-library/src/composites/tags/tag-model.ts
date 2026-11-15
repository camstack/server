/**
 * The pure half of the tag UI (D1054). A tag lives on the record it labels; the
 * `tags` cap only registers its style. Everything here is shared by every
 * section that shows tags (the BYS sections, the devices list) so the rules —
 * how a tag looks unstyled, what search matches, how a list groups — exist once.
 */
import {
  DEFAULT_TAG_ICON,
  defaultTagColorId,
  type IconKey,
  normalizeTags,
  sameTag,
  type TagColorId,
  type TagEntry,
  tagKey,
} from '@camstack/types'

/** How one tag is drawn. */
export interface TagStyleView {
  readonly name: string
  readonly color: TagColorId
  readonly icon: IconKey
  /** `false`: the operator never chose a style; colour and icon are derived. */
  readonly styled: boolean
}

/**
 * The style a tag is drawn with. A registered style wins; otherwise the colour
 * derived from its name and the default icon. While the registry has not
 * answered (`entries` undefined) every tag is drawn with its derived style — the
 * name itself comes from the record, which is answered.
 */
export function tagStyleFor(name: string, entries: readonly TagEntry[] | undefined): TagStyleView {
  const entry = entries?.find((e) => sameTag(e.name, name))
  if (entry !== undefined && entry.styled) {
    return { name, color: entry.color, icon: entry.icon, styled: true }
  }
  return { name, color: defaultTagColorId(name), icon: DEFAULT_TAG_ICON, styled: false }
}

/** Rows carrying ANY of the selected tags; every row when none is selected. */
export function filterByTags<T>(
  rows: readonly T[],
  getTags: (row: T) => readonly string[] | undefined,
  selected: readonly string[],
): T[] {
  if (selected.length === 0) return [...rows]
  const wanted = new Set(selected.map(tagKey))
  return rows.filter((row) => (getTags(row) ?? []).some((tag) => wanted.has(tagKey(tag))))
}

/** One group of a list grouped by tag. `tag: null` is the untagged group. */
export interface TagGroup<T> {
  readonly key: string
  readonly tag: string | null
  readonly rows: readonly T[]
}

export const UNTAGGED_GROUP_KEY = '__untagged'

function compareTagNames(a: string, b: string): number {
  return tagKey(a).localeCompare(tagKey(b))
}

/**
 * Group rows by tag: a row with two tags appears in both groups. Groups sort by
 * tag name (first spelling seen wins); the untagged group comes last and is
 * absent when every row carries a tag. Row order inside a group is kept.
 */
export function groupByTag<T>(
  rows: readonly T[],
  getTags: (row: T) => readonly string[] | undefined,
): TagGroup<T>[] {
  const groups = new Map<string, { tag: string; rows: T[] }>()
  const untagged: T[] = []
  for (const row of rows) {
    const tags = normalizeTags(getTags(row) ?? [])
    if (tags.length === 0) {
      untagged.push(row)
      continue
    }
    for (const tag of tags) {
      const key = tagKey(tag)
      const group = groups.get(key)
      if (group === undefined) groups.set(key, { tag, rows: [row] })
      else group.rows.push(row)
    }
  }
  const tagged: TagGroup<T>[] = [...groups.entries()]
    .sort(([, a], [, b]) => compareTagNames(a.tag, b.tag))
    .map(([key, group]) => ({ key, tag: group.tag, rows: group.rows }))
  return untagged.length === 0
    ? tagged
    : [...tagged, { key: UNTAGGED_GROUP_KEY, tag: null, rows: untagged }]
}

/** A group of one page of a by-tag list: `total` is the whole group's size. */
export interface PagedTagGroup<T> extends TagGroup<T> {
  readonly total: number
}

/** How many rows a by-tag list shows: a row in two groups counts twice. */
export function tagGroupRowCount<T>(groups: readonly TagGroup<T>[]): number {
  return groups.reduce((sum, group) => sum + group.rows.length, 0)
}

/**
 * One page of a by-tag list: the window `[start, start + size)` over the groups'
 * rows laid end to end, so a page never shows more rows than the page size.
 * A group the window touches keeps its header and its whole-group `total`.
 */
export function pageTagGroups<T>(
  groups: readonly TagGroup<T>[],
  start: number,
  size: number,
): PagedTagGroup<T>[] {
  const end = start + size
  const page: PagedTagGroup<T>[] = []
  let offset = 0
  for (const group of groups) {
    const from = Math.max(start - offset, 0)
    const to = Math.min(end - offset, group.rows.length)
    if (from < to)
      page.push({ ...group, rows: group.rows.slice(from, to), total: group.rows.length })
    offset += group.rows.length
    if (offset >= end) break
  }
  return page
}

/**
 * A tag filter's selection after a rename (`to`) or a remove (`to: null`): the
 * renamed tag stays selected under its new name, a removed one leaves.
 */
export function followTagRename(
  selected: readonly string[],
  from: string,
  to: string | null,
): string[] {
  const next = selected.flatMap((name) =>
    sameTag(name, from) ? (to === null ? [] : [to]) : [name],
  )
  return normalizeTags(next)
}

/** One tag in use in a list, with how many rows carry it. */
export interface TagCount {
  readonly name: string
  readonly count: number
}

/** The tags the rows carry, sorted by name, each counted once per row. */
export function tagsInRows<T>(
  rows: readonly T[],
  getTags: (row: T) => readonly string[] | undefined,
): TagCount[] {
  return groupByTag(rows, getTags)
    .filter((group): group is TagGroup<T> & { tag: string } => group.tag !== null)
    .map((group) => ({ name: group.tag, count: group.rows.length }))
}

export const TAG_SUGGESTION_LIMIT = 8

/**
 * Autocomplete: known tags not already on the record, prefix matches first,
 * then substring matches, each alphabetical.
 */
export function suggestTags(
  query: string,
  known: readonly string[],
  current: readonly string[],
  limit: number = TAG_SUGGESTION_LIMIT,
): string[] {
  const q = query.trim().toLowerCase()
  const taken = new Set(current.map(tagKey))
  const candidates = normalizeTags(known).filter((name) => !taken.has(tagKey(name)))
  const prefix: string[] = []
  const inner: string[] = []
  for (const name of candidates) {
    const key = tagKey(name)
    if (q.length === 0 || key.startsWith(q)) prefix.push(name)
    else if (key.includes(q)) inner.push(name)
  }
  return [...prefix.sort(compareTagNames), ...inner.sort(compareTagNames)].slice(0, limit)
}

/** `current` plus `raw`, trimmed; unchanged when `raw` is empty or already there. */
export function addTag(current: readonly string[], raw: string): string[] {
  return normalizeTags([...current, raw])
}

/** How a section shows its list. */
export type TagViewMode = 'flat' | 'grouped'

/** The `localStorage` key of one section's view mode. */
export function tagViewStorageKey(section: string): string {
  return `camstack.tags.view.${section}`
}

/** The remembered view mode; `flat` when nothing (readable) is stored. */
export function readTagViewMode(key: string): TagViewMode {
  try {
    const raw = globalThis.localStorage?.getItem(key) ?? null
    return raw === 'grouped' ? 'grouped' : 'flat'
  } catch {
    return 'flat'
  }
}

/** Remember a view mode; a storage that refuses only loses the memory. */
export function writeTagViewMode(key: string, mode: TagViewMode): void {
  try {
    globalThis.localStorage?.setItem(key, mode)
  } catch {
    // Private window or blocked storage: the choice still applies to this visit.
  }
}
