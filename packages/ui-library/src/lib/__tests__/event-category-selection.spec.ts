import { EventCategory, EVENT_CATEGORY_CATALOG, offerableEventCategories } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  eventCategoryGroups,
  eventCategoryLabel,
  matchesCategorySelection,
  parseCategoryPattern,
} from '../event-category-selection'

describe('parseCategoryPattern', () => {
  it('accepts an exact id and a prefix pattern', () => {
    expect(parseCategoryPattern(' motion.on-motion-changed ')).toBe('motion.on-motion-changed')
    expect(parseCategoryPattern('addon.*')).toBe('addon.*')
  })

  it('refuses empty text, a bare wildcard and characters no category has', () => {
    expect(parseCategoryPattern('')).toBeNull()
    expect(parseCategoryPattern('*')).toBeNull()
    expect(parseCategoryPattern('a b')).toBeNull()
    expect(parseCategoryPattern('addon.*.x')).toBeNull()
    expect(parseCategoryPattern('.*')).toBeNull()
  })
})

describe('matchesCategorySelection', () => {
  it('matches an exact id only against itself', () => {
    expect(matchesCategorySelection(['addon.started'], 'addon.started')).toBe(true)
    expect(matchesCategorySelection(['addon.started'], 'addon.started-late')).toBe(false)
  })

  it('matches a prefix pattern on the dot boundary', () => {
    expect(matchesCategorySelection(['addon.*'], 'addon.crashed')).toBe(true)
    expect(matchesCategorySelection(['addon.*'], 'addon.a.b')).toBe(true)
    expect(matchesCategorySelection(['addon.*'], 'addons.crashed')).toBe(false)
  })

  it('matches nothing for an empty selection', () => {
    expect(matchesCategorySelection([], 'addon.started')).toBe(false)
  })
})

describe('eventCategoryGroups', () => {
  it('offers every offerable category once, grouped as the catalogue groups it', () => {
    const groups = eventCategoryGroups('en')
    const ids = groups.flatMap((g) => g.entries.map((e) => e.id))
    expect(new Set(ids).size).toBe(ids.length)
    expect([...ids].toSorted()).toEqual([...offerableEventCategories()])
    for (const g of groups) {
      for (const e of g.entries) expect(EVENT_CATEGORY_CATALOG[e.id].group).toBe(g.group)
    }
  })

  it('never lists an empty group and orders entries by label', () => {
    for (const g of eventCategoryGroups('en')) {
      expect(g.entries.length).toBeGreaterThan(0)
      const labels = g.entries.map((e) => e.label)
      expect(labels).toEqual([...labels].toSorted((a, b) => a.localeCompare(b)))
    }
  })
})

describe('eventCategoryLabel', () => {
  it('follows the language and falls back to English', () => {
    const entry = EVENT_CATEGORY_CATALOG[EventCategory.AddonStarted]
    expect(eventCategoryLabel(entry, 'it')).toBe(entry.label.it)
    expect(eventCategoryLabel(entry, 'it-IT')).toBe(entry.label.it)
    expect(eventCategoryLabel(entry, 'fr')).toBe(entry.label.en)
  })
})
