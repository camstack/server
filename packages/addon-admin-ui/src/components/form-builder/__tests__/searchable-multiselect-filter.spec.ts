import { describe, it, expect } from 'vitest'
import type { ConfigOption } from '@camstack/types'
import {
  SEARCHABLE_MULTISELECT_MIN_OPTIONS,
  filterOptions,
  optionSearchText,
  partitionSelected,
  shouldUseSearchableMultiSelect,
} from '../searchable-multiselect-filter'

/**
 * Pure filter/partition helpers for the searchable multi-select — exercised
 * without rendering. The fixtures are a device list (the shape the retired
 * "Linked devices" section had): option `value` is the numeric device id (as
 * a string) and `label` folds name + location as `Name (Location)`.
 */

const options: readonly ConfigOption[] = [
  { value: '10', label: 'Hall Cam (Hall)' },
  { value: '11', label: 'Kitchen Doorbell (Kitchen)' },
  { value: '12', label: 'Garden PTZ (Garden)' },
  { value: '13', label: 'Garage Plug' }, // no location
  { value: '14', label: 'Hall Speaker (Hall)' },
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

  it('skips missing description without leaking "undefined"', () => {
    const text = optionSearchText({ value: '13', label: 'Garage Plug' })
    expect(text).toBe('13 garage plug')
    expect(text).not.toContain('undefined')
  })
})

describe('filterOptions', () => {
  it('returns every option (identity) for an empty / whitespace query', () => {
    expect(filterOptions(options, '')).toBe(options)
    expect(filterOptions(options, '   ')).toBe(options)
  })

  it('matches by device name (case-insensitive)', () => {
    const res = filterOptions(options, 'kitchen')
    expect(res.map((o) => o.value)).toEqual(['11'])
  })

  it('matches by location', () => {
    const res = filterOptions(options, 'hall')
    expect(res.map((o) => o.value)).toEqual(['10', '14'])
  })

  it('matches by option value (device id)', () => {
    const res = filterOptions(options, '12')
    expect(res.map((o) => o.value)).toEqual(['12'])
  })

  it('AND-matches every whitespace-separated token', () => {
    const res = filterOptions(options, 'hall speaker')
    expect(res.map((o) => o.value)).toEqual(['14'])
  })

  it('returns empty when no option matches', () => {
    expect(filterOptions(options, 'zzz')).toEqual([])
  })

  it('preserves the original option order', () => {
    const res = filterOptions(options, 'a') // matches several
    const idx = res.map((o) => options.indexOf(o))
    expect(idx).toEqual([...idx].sort((a, b) => a - b))
  })
})

describe('partitionSelected', () => {
  it('returns selected options in selection order + the unselected rest', () => {
    const { selectedOptions, unselected } = partitionSelected(options, ['14', '10'])
    expect(selectedOptions.map((o) => o.value)).toEqual(['14', '10'])
    expect(selectedOptions.map((o) => o.label)).toEqual(['Hall Speaker (Hall)', 'Hall Cam (Hall)'])
    expect(unselected.map((o) => o.value)).toEqual(['11', '12', '13'])
  })

  it('surfaces a stale selected id as a synthetic option (label falls back to the value)', () => {
    const { selectedOptions, unselected } = partitionSelected(options, ['99'])
    expect(selectedOptions).toEqual([{ value: '99', label: '99' }])
    expect(unselected.map((o) => o.value)).toEqual(['10', '11', '12', '13', '14'])
  })

  it('handles an empty selection', () => {
    const { selectedOptions, unselected } = partitionSelected(options, [])
    expect(selectedOptions).toEqual([])
    expect(unselected).toHaveLength(options.length)
  })
})

describe('shouldUseSearchableMultiSelect', () => {
  it('is true at/above the threshold', () => {
    expect(shouldUseSearchableMultiSelect(SEARCHABLE_MULTISELECT_MIN_OPTIONS)).toBe(true)
    expect(shouldUseSearchableMultiSelect(SEARCHABLE_MULTISELECT_MIN_OPTIONS + 20)).toBe(true)
  })

  it('is false below the threshold (small sets keep the compact chip toggle)', () => {
    expect(shouldUseSearchableMultiSelect(SEARCHABLE_MULTISELECT_MIN_OPTIONS - 1)).toBe(false)
    expect(shouldUseSearchableMultiSelect(0)).toBe(false)
    expect(shouldUseSearchableMultiSelect(2)).toBe(false)
  })
})
