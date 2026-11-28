/**
 * The event-category selection the Events pickers share: what a selection
 * entry may look like (an exact id, or `prefix.*`), how it matches an event,
 * and the catalogued categories grouped for a picker.
 */
import {
  EVENT_CATEGORY_CATALOG,
  EVENT_CATEGORY_GROUPS,
  offerableEventCategories,
  type EventCategory,
  type EventCategoryEntry,
  type EventCategoryGroup,
} from '@dominevo/types'

const CATEGORY_PATTERN = /^[a-z0-9][a-z0-9_-]*(\.[a-z0-9_-]+)*(\.\*)?$/i

/** A trimmed exact id or `prefix.*`, or `null` when the text is neither. */
export function parseCategoryPattern(raw: string): string | null {
  const text = raw.trim()
  return CATEGORY_PATTERN.test(text) ? text : null
}

export type CategoryMatcher = (category: string) => boolean

/** A matcher for a selection: exact ids by set lookup, `prefix.*` entries by prefix. */
export function createCategoryMatcher(selection: Iterable<string>): CategoryMatcher {
  const exact = new Set<string>()
  const prefixes: string[] = []
  for (const entry of selection) {
    if (entry.endsWith('.*')) prefixes.push(entry.slice(0, -1))
    else exact.add(entry)
  }
  return (category) => exact.has(category) || prefixes.some((p) => category.startsWith(p))
}

/** True when `category` is one of the selection's exact ids or under one of its `prefix.*`. */
export function matchesCategorySelection(selection: Iterable<string>, category: string): boolean {
  return createCategoryMatcher(selection)(category)
}

/** The catalogue label in the admin language; any language but Italian reads English. */
export function eventCategoryLabel(entry: EventCategoryEntry, lang: string): string {
  return lang.toLowerCase().startsWith('it') ? entry.label.it : entry.label.en
}

export interface EventCategoryOption {
  readonly id: EventCategory
  readonly label: string
  readonly noise: boolean
}

export interface EventCategoryOptionGroup {
  readonly group: EventCategoryGroup
  readonly entries: readonly EventCategoryOption[]
}

/** Offerable categories, grouped in the catalogue's display order, each group sorted by label. */
export function eventCategoryGroups(lang: string): readonly EventCategoryOptionGroup[] {
  const offerable = offerableEventCategories()
  return EVENT_CATEGORY_GROUPS.map((group) => ({
    group,
    entries: offerable
      .filter((id) => EVENT_CATEGORY_CATALOG[id].group === group)
      .map((id) => ({
        id,
        label: eventCategoryLabel(EVENT_CATEGORY_CATALOG[id], lang),
        noise: EVENT_CATEGORY_CATALOG[id].noise,
      }))
      .toSorted((a, b) => a.label.localeCompare(b.label)),
  })).filter((g) => g.entries.length > 0)
}
