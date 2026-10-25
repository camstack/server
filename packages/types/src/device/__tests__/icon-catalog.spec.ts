import { describe, expect, it } from 'vitest'
import {
  ICON_CATEGORIES,
  ICON_ENTRIES,
  ICON_KEYS,
  IconKeySchema,
  canonicalIconKey,
  iconCategoryLabel,
  iconEntry,
  iconsInCategory,
  isIconKey,
  resolveIconKey,
  searchIcons,
} from '../icon-catalog.js'
import { ICON_ALIASES, ICON_CATEGORY_IDS } from '../icon-catalog.generated.js'
import { ICON_SYNONYMS, LEGACY_ICON_ALIASES } from '../icon-synonyms.js'
import { LocationIconAssignmentSchema } from '../location-icon.js'
import { SiteZoneSchema } from '../site-zone.js'
import {
  PERSISTED_DEVICE_ICON_VALUES,
  PERSISTED_LOCATION_ICON_VALUES,
} from './legacy-icon-values.js'

describe('the catalog itself', () => {
  it('has no duplicate key and every key is a lucide-shaped kebab-case id', () => {
    expect(new Set(ICON_KEYS).size).toBe(ICON_KEYS.length)
    for (const key of ICON_KEYS) {
      expect(key, `${key} is not kebab-case`).toMatch(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/)
    }
  })

  it('is the whole lucide intersection, not a curated subset', () => {
    expect(ICON_KEYS.length).toBeGreaterThan(1500)
  })

  it('every entry has a primary category that exists, and every category is used', () => {
    for (const entry of ICON_ENTRIES) {
      expect(ICON_CATEGORY_IDS, entry.key).toContain(entry.primaryCategory)
    }
    // Sections partition the catalog: nothing shown twice, nothing unreachable.
    const grouped = ICON_CATEGORIES.flatMap((c) => iconsInCategory(c))
    expect(grouped.length).toBe(ICON_KEYS.length)
    expect(new Set(grouped.map((e) => e.key)).size).toBe(ICON_KEYS.length)
    for (const c of ICON_CATEGORIES) {
      expect(iconsInCategory(c).length, `category ${c} is empty`).toBeGreaterThan(0)
    }
  })

  it('orders the sections with generated category ids, none twice', () => {
    expect(new Set(ICON_CATEGORIES).size).toBe(ICON_CATEGORIES.length)
    for (const c of ICON_CATEGORIES) expect(ICON_CATEGORY_IDS).toContain(c)
  })

  it('every overlay key is a catalog key', () => {
    for (const key of Object.keys(ICON_SYNONYMS)) {
      expect(isIconKey(key), `synonyms for the unknown ${key}`).toBe(true)
    }
  })

  it('an alias points at a key that exists and is not itself a key', () => {
    for (const [alias, target] of [
      ...Object.entries(ICON_ALIASES),
      ...Object.entries(LEGACY_ICON_ALIASES),
    ]) {
      expect(isIconKey(target), `${alias} aliases the unknown ${target}`).toBe(true)
      expect(isIconKey(alias), `${alias} is both a key and an alias`).toBe(false)
    }
  })

  it('derives a readable label from a category id', () => {
    expect(iconCategoryLabel('food-beverage')).toBe('Food beverage')
    expect(iconCategoryLabel('devices')).toBe('Devices')
  })
})

describe('every value that could be persisted before the catalog still resolves (no migration)', () => {
  it('every retired display-icon key resolves to a catalog key', () => {
    expect(PERSISTED_DEVICE_ICON_VALUES.length).toBe(157)
    for (const value of PERSISTED_DEVICE_ICON_VALUES) {
      expect(canonicalIconKey(value), `${value} no longer resolves`).toBeDefined()
    }
  })

  it('every retired location id is a canonical key, so the wire schemas keep accepting it', () => {
    expect(PERSISTED_LOCATION_ICON_VALUES.length).toBe(20)
    for (const value of PERSISTED_LOCATION_ICON_VALUES) {
      expect(isIconKey(value), `${value} is no longer a key`).toBe(true)
      expect(IconKeySchema.safeParse(value).success).toBe(true)
      expect(
        LocationIconAssignmentSchema.safeParse({ locationKey: 'x', icon: value }).success,
      ).toBe(true)
      expect(
        SiteZoneSchema.safeParse({ zoneKey: 'z', label: 'Z', icon: value, locationKeys: [] })
          .success,
      ).toBe(true)
    }
  })

  it('the legacy spelling gauge2 resolves to gauge but is never a key', () => {
    expect(canonicalIconKey('gauge2')).toBe('gauge')
    expect(isIconKey('gauge2')).toBe(false)
  })
})

describe('lookup', () => {
  it('an unknown key is undefined, never a guess', () => {
    expect(isIconKey('not-a-glyph')).toBe(false)
    expect(iconEntry('not-a-glyph')).toBeUndefined()
    expect(canonicalIconKey('not-a-glyph')).toBeUndefined()
    // Not free text, and not reachable through the prototype either.
    for (const v of ['constructor', 'toString', '__proto__', '', null, undefined, 42]) {
      expect(isIconKey(v)).toBe(false)
      expect(canonicalIconKey(v)).toBeUndefined()
    }
  })

  it('a still-accepted lucide spelling resolves to the canonical key but is not a key', () => {
    expect(canonicalIconKey('home')).toBe('house')
    expect(isIconKey('home')).toBe(false)
    expect(IconKeySchema.safeParse('home').success).toBe(false)
  })

  it('resolveIconKey keeps a key, canonicalises an alias, falls back otherwise (D780)', () => {
    expect(resolveIconKey('key', 'shield-check')).toBe('key')
    expect(resolveIconKey('home', 'shield-check')).toBe('house')
    for (const stored of ['not-an-icon', '', null, undefined, 42]) {
      expect(resolveIconKey(stored, 'shield-check')).toBe('shield-check')
    }
  })

  it('IconKeySchema rejects what is not a key', () => {
    expect(IconKeySchema.safeParse('camera').success).toBe(true)
    expect(IconKeySchema.safeParse('Camera').success).toBe(false)
    expect(IconKeySchema.safeParse(3).success).toBe(false)
  })
})

describe('search', () => {
  const keysFor = (q: string): readonly string[] => searchIcons(q).map((h) => h.entry.key)

  it('an empty query is the WHOLE catalog, in key order', () => {
    expect(keysFor('')).toEqual(ICON_KEYS)
    expect(keysFor('   ')).toEqual(ICON_KEYS)
  })

  it('finds an icon by its ITALIAN word', () => {
    expect(keysFor('tapparella')[0]).toBe('blinds')
    expect(keysFor('serranda')[0]).toBe('blinds')
    expect(keysFor('serratura')[0]).toBe('lock')
    expect(keysFor('allagamento')).toContain('droplets')
    expect(keysFor('campanello')[0]).toBe('bell')
  })

  it('strips accents, because an Italian keyboard produces them', () => {
    expect(keysFor('umidità')).toContain('droplets')
    expect(keysFor('umidita')).toContain('droplets')
  })

  it('finds an icon by an English room word the admin suggests', () => {
    expect(keysFor('kitchen')[0]).toBe('utensils')
    expect(keysFor('bedroom')[0]).toBe('bed-double')
  })

  it("reaches icons nobody curated through lucide's own English tags", () => {
    // `telescope` is in no overlay entry; its tags are lucide's.
    const entry = iconEntry('telescope')
    expect(entry?.tags.length).toBeGreaterThan(0)
    const tag = entry?.tags[0] ?? ''
    expect(keysFor(tag)).toContain('telescope')
  })

  it('ranks an exact KEY above an equally exact synonym', () => {
    const extra = new Map([['bath', ['store']]])
    expect(searchIcons('store', extra)[0]?.entry.key).toBe('store')
  })

  it('a prefix finds it before it is fully typed', () => {
    expect(keysFor('tapp')[0]).toBe('blinds')
    expect(keysFor('light')).toContain('lightbulb')
  })

  it('ignores case, and treats a hyphen like a space', () => {
    expect(keysFor('DOOR OPEN')).toContain('door-open')
    expect(keysFor('door-open')[0]).toBe('door-open')
  })

  it('never OFFERS a legacy or still-accepted spelling, though it resolves', () => {
    expect(keysFor('')).not.toContain('gauge2')
    expect(keysFor('gauge2')).not.toContain('gauge2')
    expect(keysFor('home')).not.toContain('home')
    // And the surviving spelling is still findable by the words the alias had.
    expect(keysFor('misura')).toContain('gauge')
    expect(keysFor('home')).toContain('house')
  })

  it('a query nothing answers returns nothing', () => {
    expect(keysFor('zzzzqqqq')).toEqual([])
  })

  it('extra words score like a synonym, so a caller can add its own locale', () => {
    const extra = new Map([['radar', ['bewegungsmelder']]])
    expect(searchIcons('bewegungsmelder', extra).map((h) => h.entry.key)).toEqual(['radar'])
    expect(searchIcons('bewegungsmelder').map((h) => h.entry.key)).toEqual([])
  })

  it('keeps key order between equally good matches', () => {
    const hits = searchIcons('lamp')
    const tied = hits.filter((h) => h.score === hits[0]?.score).map((h) => h.entry.key)
    expect(tied).toEqual(ICON_KEYS.filter((k) => tied.includes(k)))
  })
})
