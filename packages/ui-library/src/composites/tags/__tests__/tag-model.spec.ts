/**
 * The pure half of the tag UI (D1054): style fallback, search, filter,
 * grouping, suggestions and the remembered view mode.
 */
import type { TagEntry } from '@camstack/types'
import { defaultTagColorId } from '@camstack/types'
import { afterEach, describe, expect, it } from 'vitest'
import {
  addTag,
  filterByTags,
  groupByTag,
  matchesTagSearch,
  readTagViewMode,
  suggestTags,
  tagStyleFor,
  tagsInRows,
  tagViewStorageKey,
  writeTagViewMode,
} from '../tag-model'

const COUNTS = { coreBlocks: 1, schedulers: 0, templates: 0, actions: 0, devices: 0 }

const STYLED: TagEntry = {
  name: 'Garden',
  color: 'tag-e',
  icon: 'flower',
  styled: true,
  counts: COUNTS,
}

interface Row {
  readonly name: string
  readonly tags?: readonly string[]
}
const tagsOf = (row: Row): readonly string[] | undefined => row.tags

const ROWS: readonly Row[] = [
  { name: 'Water lawn', tags: ['Garden', 'night'] },
  { name: 'Porch light', tags: ['outside'] },
  { name: 'Coffee', tags: [] },
  { name: 'Alarm' },
  { name: 'Sprinkler', tags: ['garden'] },
]

describe('tagStyleFor', () => {
  it('uses the registered style, matched case-insensitively', () => {
    expect(tagStyleFor(' garden ', [STYLED])).toEqual({
      name: ' garden ',
      color: 'tag-e',
      icon: 'flower',
      styled: true,
    })
  })

  it('derives the colour from the name and the default icon when unstyled', () => {
    const style = tagStyleFor('Kitchen', [STYLED])
    expect(style.styled).toBe(false)
    expect(style.icon).toBe('tag')
    expect(style.color).toBe(defaultTagColorId('Kitchen'))
  })

  it('falls back the same way while the registry has not answered', () => {
    expect(tagStyleFor('Garden', undefined)).toMatchObject({
      color: defaultTagColorId('Garden'),
      styled: false,
    })
  })
})

describe('matchesTagSearch', () => {
  it('matches every row on an empty query', () => {
    expect(matchesTagSearch('  ', ['x'], undefined)).toBe(true)
  })
  it('matches the row text', () => {
    expect(matchesTagSearch('lawn', ['Water lawn'], ['night'])).toBe(true)
  })
  it('matches a tag name the text does not contain', () => {
    expect(matchesTagSearch('NIGHT', ['Water lawn'], ['night'])).toBe(true)
  })
  it('refuses a row neither text nor tags contain', () => {
    expect(matchesTagSearch('porch', ['Water lawn'], ['night'])).toBe(false)
  })
})

describe('filterByTags', () => {
  it('keeps every row when no tag is selected', () => {
    expect(filterByTags(ROWS, tagsOf, [])).toHaveLength(ROWS.length)
  })
  it('keeps a row carrying ANY selected tag, case-insensitively', () => {
    expect(filterByTags(ROWS, tagsOf, ['GARDEN', 'outside']).map((r) => r.name)).toEqual([
      'Water lawn',
      'Porch light',
      'Sprinkler',
    ])
  })
})

describe('groupByTag', () => {
  const groups = groupByTag(ROWS, tagsOf)

  it('puts a row with two tags in both groups, sorted by tag, untagged last', () => {
    expect(groups.map((g) => [g.tag, g.rows.map((r) => r.name)])).toEqual([
      ['Garden', ['Water lawn', 'Sprinkler']],
      ['night', ['Water lawn']],
      ['outside', ['Porch light']],
      [null, ['Coffee', 'Alarm']],
    ])
  })

  it('has no untagged group when every row is tagged', () => {
    const tagged = groupByTag(
      ROWS.filter((r) => (r.tags ?? []).length > 0),
      tagsOf,
    )
    expect(tagged.some((g) => g.tag === null)).toBe(false)
  })

  it('gives each group a stable key', () => {
    expect(groups.map((g) => g.key)).toEqual(['garden', 'night', 'outside', '__untagged'])
  })
})

describe('tagsInRows', () => {
  it('counts each tag once per row, first spelling wins', () => {
    expect(tagsInRows(ROWS, tagsOf)).toEqual([
      { name: 'Garden', count: 2 },
      { name: 'night', count: 1 },
      { name: 'outside', count: 1 },
    ])
  })
})

describe('suggestTags', () => {
  const known = ['Garden', 'Night', 'Outside', 'Garage', 'Kitchen garden']
  it('offers prefix matches before substring matches, without the current tags', () => {
    expect(suggestTags('gar', known, ['garage'])).toEqual(['Garden', 'Kitchen garden'])
  })
  it('offers every known tag on an empty query, minus the current ones', () => {
    expect(suggestTags('', known, ['night'])).toEqual([
      'Garage',
      'Garden',
      'Kitchen garden',
      'Outside',
    ])
  })
  it('respects the limit', () => {
    expect(suggestTags('', known, [], 2)).toHaveLength(2)
  })
})

describe('addTag', () => {
  it('trims, refuses an empty name and a duplicate spelling', () => {
    expect(addTag(['Garden'], '  night ')).toEqual(['Garden', 'night'])
    expect(addTag(['Garden'], ' ')).toEqual(['Garden'])
    expect(addTag(['Garden'], 'GARDEN')).toEqual(['Garden'])
  })
})

describe('tag view mode', () => {
  afterEach(() => {
    globalThis.localStorage?.clear()
  })
  it('defaults to flat and remembers the choice per section', () => {
    expect(readTagViewMode(tagViewStorageKey('automations'))).toBe('flat')
    writeTagViewMode(tagViewStorageKey('automations'), 'grouped')
    expect(readTagViewMode(tagViewStorageKey('automations'))).toBe('grouped')
    expect(readTagViewMode(tagViewStorageKey('actions'))).toBe('flat')
  })
  it('reads an unknown stored value as flat', () => {
    globalThis.localStorage?.setItem(tagViewStorageKey('x'), 'sideways')
    expect(readTagViewMode(tagViewStorageKey('x'))).toBe('flat')
  })
})
