import { describe, expect, it } from 'vitest'
import {
  MAX_TOTAL_RESULTS,
  filterSearchItems,
  flattenSearchResults,
  type SearchItem,
} from '../global-search'

function item(
  over: Partial<SearchItem> & Pick<SearchItem, 'key' | 'domain' | 'label'>,
): SearchItem {
  return {
    path: `/${over.domain}/${over.key}`,
    ...over,
  }
}

describe('filterSearchItems', () => {
  it('returns nothing for a blank or whitespace-only query', () => {
    const items = [item({ key: 'd:1', domain: 'device', label: 'Hall' })]
    expect(filterSearchItems(items, '').groups).toEqual([])
    expect(filterSearchItems(items, '   ').groups).toEqual([])
  })

  it('returns no groups (not an error) when nothing matches, even fuzzily', () => {
    const items = [item({ key: 'd:1', domain: 'device', label: 'Hall' })]
    const result = filterSearchItems(items, 'zzz-no-match-at-all-qqqq')
    expect(result.groups).toEqual([])
    expect(result.totalMatched).toBe(0)
    expect(result.truncated).toBe(false)
  })

  it('is case- and diacritic-insensitive (reuses normalizeSearchText)', () => {
    const items = [item({ key: 'd:1', domain: 'device', label: 'Front door' })]
    expect(filterSearchItems(items, 'FRONT DOOR').groups).toHaveLength(1)
    expect(filterSearchItems(items, 'Frönt door').groups).toHaveLength(1)
  })

  it('groups results by domain in fixed order: device, page, integration', () => {
    const items = [
      item({ key: 'i:1', domain: 'integration', label: 'camera-hub' }),
      item({ key: 'p:1', domain: 'page', label: 'Camera settings' }),
      item({ key: 'd:1', domain: 'device', label: 'Camera hall' }),
    ]
    const { groups } = filterSearchItems(items, 'camera')
    expect(groups.map((g) => g.domain)).toEqual(['device', 'page', 'integration'])
  })

  it('omits a domain entirely when it has zero matches', () => {
    const items = [item({ key: 'd:1', domain: 'device', label: 'Hall camera' })]
    const { groups } = filterSearchItems(items, 'hall')
    expect(groups).toHaveLength(1)
    expect(groups[0]?.domain).toBe('device')
  })

  it('ranks an exact match above a prefix match above a substring match', () => {
    const items = [
      item({ key: 'd:1', domain: 'device', label: 'Retro-hall garage' }), // substring only (mid-word)
      item({ key: 'd:2', domain: 'device', label: 'Hall' }), // exact
      item({ key: 'd:3', domain: 'device', label: 'Hall est' }), // prefix
    ]
    const { groups } = filterSearchItems(items, 'Hall')
    expect(groups[0]?.items.map((i) => i.key)).toEqual(['d:2', 'd:3', 'd:1'])
  })

  it('ranks a whole-word-boundary match above a mid-word substring match', () => {
    const items = [
      item({ key: 'd:1', domain: 'device', label: 'Retrocamera garage' }), // "camera" mid-word only
      item({ key: 'd:2', domain: 'device', label: 'Garage camera' }), // "camera" starts a word
    ]
    const { groups } = filterSearchItems(items, 'camera')
    expect(groups[0]?.items.map((i) => i.key)).toEqual(['d:2', 'd:1'])
  })

  it('matches via keywords when the label itself does not contain the query, ranked last', () => {
    const items = [
      item({
        key: 'd:1',
        domain: 'device',
        label: 'Hall',
        keywords: ['stable-abc-123'],
      }),
      item({ key: 'd:2', domain: 'device', label: 'Kitchen abc' }), // substring match on label
    ]
    const { groups } = filterSearchItems(items, 'abc')
    expect(groups[0]?.items.map((i) => i.key)).toEqual(['d:2', 'd:1'])
  })

  it('ranks an exact identifier above EVERY label match, including an exact label', () => {
    const items = [
      item({ key: 'd:1', domain: 'device', label: '102' }), // exact LABEL
      item({ key: 'd:2', domain: 'device', label: '102 Cortile' }), // label prefix
      item({ key: 'd:3', domain: 'device', label: 'Garage 102' }), // word boundary
      item({ key: 'd:4', domain: 'device', label: 'Front door', identifiers: ['102'] }),
    ]
    const { groups } = filterSearchItems(items, '102')
    expect(groups[0]?.items.map((i) => i.key)).toEqual(['d:4', 'd:1', 'd:2', 'd:3'])
  })

  it('matches identifiers on EQUALITY only — never as a substring', () => {
    const items = [
      item({ key: 'd:1', domain: 'device', label: 'Front door', identifiers: ['102'] }),
    ]
    expect(filterSearchItems(items, '61').groups).toEqual([])
    expect(filterSearchItems(items, '6170').groups).toEqual([])
    expect(filterSearchItems(items, '102').groups).toHaveLength(1)
  })

  it('never fuzzy-matches an identifier — a near-miss id is a different device', () => {
    const items = [
      item({ key: 'd:1', domain: 'device', label: 'Front door', identifiers: ['102'] }),
    ]
    expect(filterSearchItems(items, '618').groups).toEqual([])
  })

  it('leaves an item with no identifiers ranked exactly as before', () => {
    const items = [
      item({ key: 'd:1', domain: 'device', label: 'Retro-hall garage' }), // substring
      item({ key: 'd:2', domain: 'device', label: 'Hall' }), // exact
      item({ key: 'd:3', domain: 'device', label: 'Hall est' }), // prefix
    ]
    const { groups } = filterSearchItems(items, 'Hall')
    expect(groups[0]?.items.map((i) => i.key)).toEqual(['d:2', 'd:3', 'd:1'])
  })

  it('breaks ties within the same rank alphabetically by label', () => {
    const items = [
      item({ key: 'd:1', domain: 'device', label: 'Zona hall' }),
      item({ key: 'd:2', domain: 'device', label: 'Area hall' }),
    ]
    const { groups } = filterSearchItems(items, 'hall')
    expect(groups[0]?.items.map((i) => i.label)).toEqual(['Area hall', 'Zona hall'])
  })

  it('does not cap results per domain — every exact match across a large domain comes back', () => {
    const items = Array.from({ length: 30 }, (_, i) =>
      item({
        key: `d:${String(i)}`,
        domain: 'device',
        label: `Camera ${String(i)}`,
      }),
    )
    const { groups, truncated } = filterSearchItems(items, 'camera')
    expect(groups[0]?.items).toHaveLength(30)
    expect(truncated).toBe(false)
  })
})

describe('fuzzy matching (levels 5-6, below every exact level)', () => {
  it('an exact match always beats a fuzzy match for the same query', () => {
    const items = [
      // "vdc" is a subsequence of "Video camera" (fuzzy level 5) — but not
      // when there's an exact-label item competing for the same query.
      item({ key: 'd:fuzzy', domain: 'device', label: 'Video camera front door' }),
      item({ key: 'd:exact', domain: 'device', label: 'vdc' }),
    ]
    const { groups } = filterSearchItems(items, 'vdc')
    expect(groups[0]?.items.map((i) => i.key)).toEqual(['d:exact', 'd:fuzzy'])
  })

  it('a prefix match always beats a fuzzy match', () => {
    const items = [
      // "vdc" is a subsequence of "video camera" (fuzzy level 5) but never a
      // literal substring of it, so this can only be reached via fuzzy.
      item({ key: 'd:fuzzy', domain: 'device', label: 'Front door video camera' }),
      item({ key: 'd:prefix', domain: 'device', label: 'vdc hall' }), // label starts with "vdc"
    ]
    const { groups } = filterSearchItems(items, 'vdc')
    expect(groups[0]?.items.map((i) => i.key)).toEqual(['d:prefix', 'd:fuzzy'])
  })

  it('level 5 — subsequence: "vdc" matches "Video camera"', () => {
    const items = [item({ key: 'd:1', domain: 'device', label: 'Video camera' })]
    const { groups } = filterSearchItems(items, 'vdc')
    expect(groups[0]?.items.map((i) => i.key)).toEqual(['d:1'])
  })

  it('level 5 — subsequence: "frtdr" matches "Front door"', () => {
    const items = [item({ key: 'd:1', domain: 'device', label: 'Front door' })]
    const { groups } = filterSearchItems(items, 'frtdr')
    expect(groups[0]?.items.map((i) => i.key)).toEqual(['d:1'])
  })

  it('level 5 — subsequence spans words: "vdc front door" matches "Video camera front door"', () => {
    const items = [item({ key: 'd:1', domain: 'device', label: 'Video camera front door' })]
    const { groups } = filterSearchItems(items, 'vdc front door')
    expect(groups[0]?.items.map((i) => i.key)).toEqual(['d:1'])
  })

  it('level 6 — bounded OSA distance: a transposition typo costs 1, not 2', () => {
    // "caemra" vs "camera" is a single adjacent transposition
    // ("ae" <-> "ea"), and it is not a subsequence of "camera",
    // so this can only be reached through OSA distance 1 <= threshold(2).
    const items = [item({ key: 'd:1', domain: 'device', label: 'camera' })]
    const { groups } = filterSearchItems(items, 'caemra')
    expect(groups[0]?.items.map((i) => i.key)).toEqual(['d:1'])
  })

  it('level 6 threshold is proportional to query length — a short query gets threshold 0', () => {
    // "abc" (3 chars, < 4) has threshold 0, so a 1-edit-away word ("abx")
    // must NOT match. A fixed threshold of 2 would match almost anything
    // this short, which is exactly the bug this proportionality avoids.
    const items = [item({ key: 'd:1', domain: 'device', label: 'Abx' })]
    const { groups } = filterSearchItems(items, 'abc')
    expect(groups).toEqual([])
  })

  it('fuzzy matching does not produce false positives on an obviously unrelated query', () => {
    const items = [
      item({ key: 'd:1', domain: 'device', label: 'Hall' }),
      item({ key: 'd:2', domain: 'device', label: 'Front door' }),
      item({ key: 'd:3', domain: 'device', label: 'Camera garage' }),
    ]
    const { groups, totalMatched } = filterSearchItems(items, 'qwxyz9876')
    expect(groups).toEqual([])
    expect(totalMatched).toBe(0)
  })
})

describe('total result cap and truncation', () => {
  it('honors a custom maxTotalResults override', () => {
    const items = Array.from({ length: 5 }, (_, i) =>
      item({
        key: `d:${String(i)}`,
        domain: 'device',
        label: `Camera ${String(i)}`,
      }),
    )
    const { groups, truncated } = filterSearchItems(items, 'camera', 2)
    expect(groups[0]?.items).toHaveLength(2)
    expect(truncated).toBe(true)
  })

  it('caps the TOTAL result count at MAX_TOTAL_RESULTS, not per domain', () => {
    const items = Array.from({ length: MAX_TOTAL_RESULTS + 20 }, (_, i) =>
      item({
        key: `d:${String(i)}`,
        domain: 'device',
        label: `Camera ${String(i)}`,
      }),
    )
    const { groups, totalMatched, truncated } = filterSearchItems(items, 'camera')
    const shown = groups.reduce((sum, g) => sum + g.items.length, 0)
    expect(shown).toBe(MAX_TOTAL_RESULTS)
    expect(totalMatched).toBe(MAX_TOTAL_RESULTS + 20)
    expect(truncated).toBe(true)
  })

  it('truncated is false when total matches are within the cap', () => {
    const items = Array.from({ length: 10 }, (_, i) =>
      item({
        key: `d:${String(i)}`,
        domain: 'device',
        label: `Camera ${String(i)}`,
      }),
    )
    const { totalMatched, truncated } = filterSearchItems(items, 'camera')
    expect(totalMatched).toBe(10)
    expect(truncated).toBe(false)
  })

  it('the cap is spent across domains in DOMAIN_ORDER, not split evenly', () => {
    const items = [
      ...Array.from({ length: MAX_TOTAL_RESULTS }, (_, i) =>
        item({ key: `d:${String(i)}`, domain: 'device', label: `Camera ${String(i)}` }),
      ),
      item({ key: 'p:1', domain: 'page', label: 'Camera settings' }),
    ]
    const { groups, truncated } = filterSearchItems(items, 'camera')
    expect(groups.map((g) => g.domain)).toEqual(['device'])
    expect(groups[0]?.items).toHaveLength(MAX_TOTAL_RESULTS)
    expect(truncated).toBe(true)
  })
})

describe('flattenSearchResults', () => {
  it('concatenates group items in domain order for keyboard navigation', () => {
    const items = [
      item({ key: 'd:1', domain: 'device', label: 'Camera device' }),
      item({ key: 'p:1', domain: 'page', label: 'Camera page' }),
    ]
    const { groups } = filterSearchItems(items, 'camera')
    expect(flattenSearchResults(groups).map((i) => i.key)).toEqual(['d:1', 'p:1'])
  })

  it('returns an empty array for empty groups', () => {
    expect(flattenSearchResults([])).toEqual([])
  })
})
