import { describe, expect, it } from 'vitest'
import {
  AUTOMATION_LEAF_CATALOG,
  AUTOMATION_LEAF_CATEGORIES,
  AUTOMATION_LEAF_KINDS,
  leafCatalogEntry,
  leafKindsFor,
  seedLeaf,
} from '../leaf-catalog.js'
import { AutomationWhenSchema, isEventLeaf } from '../when.js'

describe('AUTOMATION_LEAF_CATALOG', () => {
  it('lists every kind once, events before states', () => {
    expect(new Set(AUTOMATION_LEAF_KINDS).size).toBe(AUTOMATION_LEAF_KINDS.length)
    expect([...AUTOMATION_LEAF_KINDS].sort()).toEqual(Object.keys(AUTOMATION_LEAF_CATALOG).sort())
    const roles = AUTOMATION_LEAF_KINDS.map((kind) => leafCatalogEntry(kind).role)
    expect(roles.lastIndexOf('event')).toBeLessThan(roles.indexOf('state'))
  })

  it('files each kind under a known category, under its own key', () => {
    for (const kind of AUTOMATION_LEAF_KINDS) {
      const entry = leafCatalogEntry(kind)
      expect(entry.kind).toBe(kind)
      expect(AUTOMATION_LEAF_CATEGORIES).toContain(entry.category)
      expect(entry.i18nKey).toBe(`automation.leafCatalog.${kind}`)
      expect(entry.keywords.length).toBeGreaterThan(0)
    }
  })

  it('seeds a leaf of its own kind whose role is the one the engine reads', () => {
    for (const kind of AUTOMATION_LEAF_KINDS) {
      const leaf = seedLeaf(kind)
      expect(leaf.kind).toBe(kind)
      expect(isEventLeaf(leaf)).toBe(leafCatalogEntry(kind).role === 'event')
    }
  })

  it('seeds a fresh object each time: editing one row never edits the next', () => {
    const first = seedLeaf('detection')
    const second = seedLeaf('detection')
    expect(first).toEqual(second)
    expect(first).not.toBe(second)
    if (first.kind === 'detection' && second.kind === 'detection') {
      expect(first.subjects).not.toBe(second.subjects)
    }
  })

  it('seeds that need no operator choice already parse', () => {
    for (const kind of ['manual', 'schedule', 'interval'] as const) {
      expect(AutomationWhenSchema.safeParse(seedLeaf(kind)).success).toBe(true)
    }
  })

  it('offers a guard only what holds: no event kind in a step condition', () => {
    const guard = leafKindsFor('guard')
    expect(guard.length).toBeGreaterThan(0)
    for (const kind of guard) expect(leafCatalogEntry(kind).role).toBe('state')
    expect(leafKindsFor('trigger')).toEqual(AUTOMATION_LEAF_KINDS)
    expect(leafKindsFor('any')).toEqual(AUTOMATION_LEAF_KINDS)
  })

  it('marks the kinds whose next step is picking a device value', () => {
    const needing = AUTOMATION_LEAF_KINDS.filter((k) => leafCatalogEntry(k).needsDeviceValue)
    expect(needing).toEqual(['device-becomes', 'device-is'])
  })
})
