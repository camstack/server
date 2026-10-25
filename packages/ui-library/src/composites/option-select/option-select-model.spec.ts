import { describe, it, expect } from 'vitest'
import type { OptionSelectOption } from './option-select-model'
import {
  OPTION_SELECT_SEARCH_MIN_OPTIONS,
  catalogHasDraft,
  draftFromQuery,
  filterOptions,
  optionSearchText,
  partitionSelected,
  resolveSearchable,
  shouldShowAddNewFooter,
  shouldShowUseQueryRow,
} from './option-select-model'

const options: readonly OptionSelectOption[] = [
  { value: '10', label: 'Hall Cam (Hall)' },
  { value: '11', label: 'Kitchen Doorbell (Kitchen)' },
  { value: '12', label: 'Garden PTZ (Garden)' },
  { value: 'rai1', label: 'Rai 1' },
]

describe('optionSearchText', () => {
  it('folds value + label + description into one lower-cased haystack', () => {
    const text = optionSearchText({
      value: '10',
      label: 'Hall Cam (Hall)',
      description: 'RTSP',
    })
    expect(text).toBe('10 hall cam (hall) rtsp')
  })
})

describe('filterOptions', () => {
  it('returns every option (identity) for an empty query', () => {
    expect(filterOptions(options, '')).toBe(options)
    expect(filterOptions(options, '   ')).toBe(options)
  })

  it('matches by label and value', () => {
    expect(filterOptions(options, 'kitchen').map((o) => o.value)).toEqual(['11'])
    expect(filterOptions(options, 'rai').map((o) => o.value)).toEqual(['rai1'])
  })
})

describe('partitionSelected', () => {
  it('returns selected options in selection order + unselected rest', () => {
    const { selectedOptions, unselected } = partitionSelected(options, ['rai1', '10'])
    expect(selectedOptions.map((o) => o.value)).toEqual(['rai1', '10'])
    expect(unselected.map((o) => o.value)).toEqual(['11', '12'])
  })

  it('surfaces a stale selected id as a synthetic option', () => {
    const { selectedOptions } = partitionSelected(options, ['99'])
    expect(selectedOptions).toEqual([{ value: '99', label: '99' }])
  })
})

describe('resolveSearchable', () => {
  it('defaults to threshold or creatable', () => {
    expect(resolveSearchable(OPTION_SELECT_SEARCH_MIN_OPTIONS, false, undefined)).toBe(true)
    expect(resolveSearchable(2, false, undefined)).toBe(false)
    expect(resolveSearchable(2, true, undefined)).toBe(true)
  })

  it('honours an explicit searchable override', () => {
    expect(resolveSearchable(100, false, false)).toBe(false)
    expect(resolveSearchable(0, false, true)).toBe(true)
  })
})

describe('creatable rows', () => {
  it('draftFromQuery trims and rejects empty', () => {
    expect(draftFromQuery('  foo  ')).toBe('foo')
    expect(draftFromQuery('   ')).toBeNull()
  })

  it('catalogHasDraft matches value or label case-insensitively', () => {
    expect(catalogHasDraft(options, 'RAI 1')).toBe(true)
    expect(catalogHasDraft(options, 'rai1')).toBe(true)
    expect(catalogHasDraft(options, 'Canale X')).toBe(false)
  })

  it('shouldShowAddNewFooter only when creatable AND onCreateRequest is wired', () => {
    expect(shouldShowAddNewFooter(true, true)).toBe(true)
    expect(shouldShowAddNewFooter(true, false)).toBe(false)
    expect(shouldShowAddNewFooter(false, true)).toBe(false)
  })

  it('shouldShowUseQueryRow when draft is not in catalog', () => {
    expect(shouldShowUseQueryRow(true, 'Canale X', options)).toBe(true)
    expect(shouldShowUseQueryRow(true, 'Rai 1', options)).toBe(false)
    expect(shouldShowUseQueryRow(false, 'Canale X', options)).toBe(false)
    expect(shouldShowUseQueryRow(true, '   ', options)).toBe(false)
  })
})
