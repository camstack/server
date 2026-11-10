import type { DeviceSearchItem, DeviceSearchResult } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  capabilityLabel,
  capabilityListLabel,
  humanizeIdentifier,
} from '../../../lib/capability-label'
import {
  buildSections,
  derivePickerState,
  describePicked,
  deviceIdStrings,
  facetSummary,
  indexResolved,
  NO_FACETS,
  pickedFromDeviceIdString,
  pickFromRow,
  pushRecent,
  rowMode,
  splitChips,
  toggleFacet,
  toggleValue,
  toSearchFilters,
} from '../device-value-picker-model'

function item(
  id: number,
  name: string,
  values: DeviceSearchItem['values'],
  over: Partial<DeviceSearchItem> = {},
): DeviceSearchItem {
  return {
    id,
    name,
    type: 'sensor',
    location: null,
    integrationId: null,
    integrationLabel: null,
    online: true,
    disabled: false,
    compatible: true,
    values,
    ...over,
  } as DeviceSearchItem
}
const temp = {
  cap: 'temperature-sensor',
  path: 'temperature',
  label: 'Temperature',
  reading: '22.3 °C',
}
const hum = { cap: 'humidity-sensor', path: 'humidity', label: 'Humidity', reading: '41 %' }

describe('rows', () => {
  it('one value picks the value with the row; several drill', () => {
    const one = item(1, 'Cucina', [temp])
    const many = item(2, 'Stazione', [temp, hum])
    expect(rowMode(one, 'value')).toBe('pick')
    expect(pickFromRow(one, 'value')).toEqual({
      deviceId: 1,
      cap: 'temperature-sensor',
      path: 'temperature',
    })
    expect(rowMode(many, 'value')).toBe('drill')
    expect(rowMode(many, 'device')).toBe('pick')
    expect(pickFromRow(many, 'device')).toEqual({ deviceId: 2 })
  })
})

describe('selection', () => {
  it('toggles without mutating and honours maxItems', () => {
    const a = { deviceId: 1, cap: 'c', path: 'p' }
    const b = { deviceId: 2 }
    const start = [a] as const
    expect(toggleValue(start, b)).toEqual([a, b])
    expect(start).toEqual([a])
    expect(toggleValue([a, b], a)).toEqual([b])
    expect(toggleValue([a], b, 1)).toEqual([a])
  })
  it('collapses chips after the limit', () => {
    expect(splitChips([1, 2, 3, 4, 5, 6, 7])).toEqual({ shown: [1, 2, 3, 4, 5], hidden: 2 })
    expect(splitChips([1, 2]).hidden).toBe(0)
  })
  it('keeps the device-id string shape of a schema form', () => {
    expect(pickedFromDeviceIdString('42')).toEqual({ deviceId: 42 })
    expect(pickedFromDeviceIdString('')).toBeNull()
    expect(pickedFromDeviceIdString(undefined)).toBeNull()
    expect(
      deviceIdStrings([{ deviceId: 7, cap: 'a' }, { deviceId: 7, cap: 'b' }, { deviceId: 8 }]),
    ).toEqual(['7', '8'])
  })
  it('remembers recents once each, newest first, capped', () => {
    expect(pushRecent([1, 2, 3], 2)).toEqual([2, 1, 3])
    expect(pushRecent([1, 2, 3, 4, 5], 9)).toEqual([9, 1, 2, 3, 4])
  })
})

describe('describePicked', () => {
  const many = item(2, 'Stazione', [temp, hum])
  it('names the value only when the device has several', () => {
    const picked = { deviceId: 2, cap: 'humidity-sensor', path: 'humidity' }
    expect(describePicked(picked, many, new Set())).toMatchObject({
      deviceName: 'Stazione',
      valueName: 'Humidity',
      reading: '41 %',
      status: 'ok',
    })
    const one = item(1, 'Cucina', [temp])
    expect(
      describePicked(
        { deviceId: 1, cap: 'temperature-sensor', path: 'temperature' },
        one,
        new Set(),
      ),
    ).toMatchObject({ valueName: null, reading: '22.3 °C' })
  })
  it('says gone only when the answered resolve listed the id as missing', () => {
    const pending = indexResolved(undefined)
    expect(describePicked({ deviceId: 9 }, undefined, pending.missing).status).toBe('ok')
    const answered = indexResolved({ items: [], missingIds: [9] } as unknown as DeviceSearchResult)
    expect(describePicked({ deviceId: 9 }, undefined, answered.missing).status).toBe('gone')
  })
  it('keeps an offline device with its last reading', () => {
    const off = item(1, 'Cucina', [temp], { online: false })
    expect(describePicked({ deviceId: 1 }, off, new Set())).toMatchObject({
      status: 'offline',
      reading: '22.3 °C',
    })
  })
})

describe('facets', () => {
  it('summarises a collapsed facet', () => {
    expect(facetSummary([], 'any')).toBe('any')
    expect(facetSummary(['Kitchen'], 'any')).toBe('Kitchen')
    expect(facetSummary(['Kitchen', 'Hall', 'Attic'], 'any')).toBe('Kitchen +2')
  })
  it('turns the selection into the server filter, narrowing the fixed types', () => {
    expect(toSearchFilters(NO_FACETS)).toBeUndefined()
    const sel = toggleFacet(NO_FACETS, 'locations', 'Hall')
    expect(toSearchFilters(sel, ['camera'])).toEqual({ locations: ['Hall'], types: ['camera'] })
    const typed = toggleFacet(toggleFacet(NO_FACETS, 'types', 'camera'), 'types', 'sensor')
    expect(toSearchFilters(typed, ['camera'])).toEqual({ types: ['camera'] })
  })
})

describe('sections', () => {
  it('lists a device once: suggestions, recents, then by type; a search drops the shortlist', () => {
    const a = item(1, 'A', [temp])
    const b = item(2, 'B', [temp])
    const c = item(3, 'C', [temp], { type: 'plug' })
    const input = { items: [a, b, c], suggested: [b], recent: [a], shortlist: true }
    const sections = buildSections(input)
    expect(sections.map((s) => [s.kind, s.items.map((i) => i.id)])).toEqual([
      ['suggested', [2]],
      ['recent', [1]],
      ['type', [3]],
    ])
    expect(
      buildSections({ ...input, shortlist: false }).flatMap((s) => s.items.map((i) => i.id)),
    ).toEqual([1, 2, 3])
  })
})

describe('states (D315)', () => {
  const answered = { items: [], compatibleTotal: 0 } as unknown as DeviceSearchResult
  it('keeps loading, failed, empty and search-miss apart', () => {
    expect(
      derivePickerState({
        isPending: true,
        isError: false,
        result: undefined,
        itemCount: 0,
        narrowed: false,
      }).kind,
    ).toBe('loading')
    expect(
      derivePickerState({
        isPending: false,
        isError: true,
        result: undefined,
        itemCount: 0,
        narrowed: false,
      }).kind,
    ).toBe('failed')
    expect(
      derivePickerState({
        isPending: false,
        isError: false,
        result: answered,
        itemCount: 0,
        narrowed: false,
      }).kind,
    ).toBe('empty')
    expect(
      derivePickerState({
        isPending: false,
        isError: false,
        result: answered,
        itemCount: 0,
        narrowed: true,
      }).kind,
    ).toBe('search-miss')
    expect(
      derivePickerState({
        isPending: false,
        isError: false,
        result: answered,
        itemCount: 2,
        narrowed: false,
      }).kind,
    ).toBe('ready')
  })
})

describe('capability label', () => {
  it('humanizes the name, one message for every capability', () => {
    expect(humanizeIdentifier('temperature-sensor')).toBe('Temperature sensor')
    expect(humanizeIdentifier('motionDetector')).toBe('Motion detector')
    expect(capabilityLabel('power_meter')).toBe('Power meter')
  })
  it('prefers the catalogue key when the host has one', () => {
    const t = (key: string, fallback: unknown) =>
      key === 'uiLibrary.capability.power-meter' ? 'Contatore' : String(fallback)
    expect(capabilityLabel('power-meter', t)).toBe('Contatore')
    expect(capabilityListLabel(['a-b', 'power-meter', 'c'], t)).toBe('A b, Contatore or C')
  })
})
