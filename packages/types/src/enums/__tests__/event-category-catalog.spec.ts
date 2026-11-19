import { describe, it, expect } from 'vitest'
import type { KnownEventCategory } from '../../interfaces/event-bus.js'
import { EventCategory, isOwnerOnlyEventCategory } from '../event-category.js'
import {
  EVENT_CATEGORY_CATALOG,
  EVENT_CATEGORY_GROUPS,
  catalogedEventCategories,
  noiseEventCategories,
  offerableEventCategories,
} from '../event-category-catalog.js'

/**
 * `EventCatalog` keys that are not enum members and nothing emits: only
 * listeners (`useLiveEvent`) still name them. A RATCHET: a new key outside the
 * enum fails the type check below; removing one of these is free.
 */
type StrayCatalogKey = 'alert.created' | 'alert.updated' | 'device.streams-unregistered'
type CatalogKeyOutsideEnum = Exclude<KnownEventCategory, `${EventCategory}` | StrayCatalogKey>
const NO_NEW_STRAY_KEYS: readonly CatalogKeyOutsideEnum[] = []

describe('EVENT_CATEGORY_CATALOG', () => {
  const all = catalogedEventCategories()

  it('has no new EventCatalog key outside the enum (type-level ratchet)', () => {
    expect(NO_NEW_STRAY_KEYS).toHaveLength(0)
  })

  it('has exactly one entry per enum value — none missing, none extra', () => {
    expect(Object.keys(EVENT_CATEGORY_CATALOG).toSorted()).toEqual([...all].toSorted())
  })

  it('labels every category in English and Italian', () => {
    for (const c of all) {
      const { label } = EVENT_CATEGORY_CATALOG[c]
      expect(label.en.trim(), `${c} en`).not.toBe('')
      expect(label.it.trim(), `${c} it`).not.toBe('')
    }
  })

  it('puts every category in a group the picker orders', () => {
    for (const c of all) expect(EVENT_CATEGORY_GROUPS, c).toContain(EVENT_CATEGORY_CATALOG[c].group)
    expect(new Set(EVENT_CATEGORY_GROUPS).size).toBe(EVENT_CATEGORY_GROUPS.length)
  })

  it('marks the two superseded track aliases deprecated and offers neither', () => {
    expect(EVENT_CATEGORY_CATALOG[EventCategory.PipelineAnalyticsTrackStarted].deprecated).toBe(
      true,
    )
    expect(EVENT_CATEGORY_CATALOG[EventCategory.PipelineAnalyticsTrackEnded].deprecated).toBe(true)
    const offered = offerableEventCategories()
    expect(offered).not.toContain(EventCategory.PipelineAnalyticsTrackStarted)
    expect(offered).toContain(EventCategory.PipelineAnalyticsTrackLifecycle)
  })

  it('never offers an owner-only category', () => {
    for (const c of offerableEventCategories()) expect(isOwnerOnlyEventCategory(c)).toBe(false)
  })

  it('never lets a deprecated or owner-only category hide the live ones: noise is a subset of the enum', () => {
    const values = new Set<string>(all)
    for (const c of noiseEventCategories()) expect(values.has(c)).toBe(true)
  })
})
