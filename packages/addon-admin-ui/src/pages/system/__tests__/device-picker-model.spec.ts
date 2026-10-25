/**
 * The smart picker's decisions at the size it has to survive: HUNDREDS of
 * devices of ONE type. Byte-identical to the viewer's copy of this spec
 * (`scripts/check-device-selection-in-sync.ts`).
 */
import { describe, expect, it } from 'vitest'
import {
  applyPickerFilters,
  chipOverflow,
  clearPickerGroup,
  filterPickerDevices,
  flattenPickerGrouping,
  flattenPickerRows,
  groupPickerDevices,
  groupPickerDevicesBy,
  isGroupExpanded,
  PICKER_CHIP_LIMIT,
  PICKER_DEFAULT_GROUP_BY,
  PICKER_GROUP_COLLAPSE_AT,
  PICKER_NO_FILTERS,
  PICKER_NONE_KEY,
  PICKER_PAGE_SIZE,
  type PickerDevice,
  type PickerZonesRead,
  pageRows,
  parsePickerGroupBy,
  pickerFacetFilterShown,
  pickerFacetOptions,
  pickerFiltersActive,
  pickerHiddenSelectedCount,
  pickerRowFacts,
  pickerZoneFilterSuspended,
  resetPickerFilters,
  selectPickerGroup,
  togglePickerDevice,
  togglePickerKey,
} from '../device-picker-model'

/** 500 sensors in 5 rooms — 100 per room, every one called "Temperatura". */
function fleetOfSensors(): readonly PickerDevice[] {
  const rooms = ['Hall', 'Kitchen', 'Camera', 'Bathroom', 'Studio']
  return Array.from({ length: 500 }, (_, i) => ({
    id: 1000 + i,
    name: 'Temperatura',
    type: 'sensor',
    location: rooms[i % rooms.length] ?? null,
    detail: `Container ${String(i)}`,
  }))
}

const NO_TOGGLES: ReadonlyMap<string, boolean> = new Map()

describe('device picker model — 500 devices of one type', () => {
  it('groups them by (type, room): five groups of 100, each COLLAPSED at rest', () => {
    const groups = groupPickerDevices(fleetOfSensors(), [])
    expect(groups.map((g) => [g.type, g.location, g.devices.length])).toEqual([
      ['sensor', 'Bathroom', 100],
      ['sensor', 'Camera', 100],
      ['sensor', 'Hall', 100],
      ['sensor', 'Kitchen', 100],
      ['sensor', 'Studio', 100],
    ])
    for (const group of groups) expect(isGroupExpanded(group, NO_TOGGLES, false)).toBe(false)
    // At rest the list is FIVE header rows, not 505.
    const rows = flattenPickerRows(groups, [], NO_TOGGLES, false)
    expect(rows).toHaveLength(5)
  })

  it('a capped render draws at most one page, and says how many are left', () => {
    const groups = groupPickerDevices(fleetOfSensors(), [])
    const everyGroupOpen = new Map(groups.map((g) => [g.key, true]))
    const rows = flattenPickerRows(groups, [], everyGroupOpen, false)
    expect(rows).toHaveLength(505)
    const page = pageRows(rows, PICKER_PAGE_SIZE)
    expect(page.rows).toHaveLength(PICKER_PAGE_SIZE)
    expect(page.remaining).toBe(505 - PICKER_PAGE_SIZE)
  })

  it('search is an AND over name, room, container and id', () => {
    const devices = fleetOfSensors()
    expect(filterPickerDevices(devices, 'temperatura hall')).toHaveLength(100)
    expect(filterPickerDevices(devices, 'container 42').map((d) => d.id)).toContain(1042)
    expect(filterPickerDevices(devices, '1499').map((d) => d.id)).toEqual([1499])
    expect(filterPickerDevices(devices, 'sensor kitchen')).toHaveLength(100)
    expect(filterPickerDevices(devices, '   ')).toHaveLength(500)
    expect(filterPickerDevices(devices, 'garage')).toHaveLength(0)
  })

  it('a search result is expanded even when the group is big', () => {
    const matches = filterPickerDevices(fleetOfSensors(), 'hall')
    const [group] = groupPickerDevices(matches, [])
    expect(group?.devices.length).toBeGreaterThan(PICKER_GROUP_COLLAPSE_AT)
    expect(group !== undefined && isGroupExpanded(group, NO_TOGGLES, true)).toBe(true)
  })

  it('a group holding a selected device is open; the operator toggle wins', () => {
    const [group] = groupPickerDevices(fleetOfSensors(), [1000])
    expect(group).toBeDefined()
    if (group === undefined) return
    expect(group.selectedCount).toBe(0)
    const [hall] = groupPickerDevices(fleetOfSensors(), [1000]).filter((g) => g.location === 'Hall')
    expect(hall?.selectedCount).toBe(1)
    expect(hall !== undefined && isGroupExpanded(hall, NO_TOGGLES, false)).toBe(true)
    const closed = new Map([[hall?.key ?? '', false]])
    expect(hall !== undefined && isGroupExpanded(hall, closed, false)).toBe(false)
  })

  it('select all / clear act on ONE group and keep everything else', () => {
    const groups = groupPickerDevices(fleetOfSensors(), [])
    const hall = groups.find((g) => g.location === 'Hall')
    expect(hall).toBeDefined()
    if (hall === undefined) return
    // 7 is not in the fleet, 1001 is in Kitchen, 1005 is in Hall.
    const kept = [7, 1001, 1005]
    const all = selectPickerGroup(kept, hall)
    expect(all).toHaveLength(102)
    expect(all.slice(0, 3)).toEqual([7, 1001, 1005])
    // Idempotent: the ones already there are not added twice.
    expect(selectPickerGroup(all, hall)).toEqual(all)
    const cleared = clearPickerGroup(all, hall)
    expect(cleared).toEqual([7, 1001])
  })

  it('select all under a search adds only what the search shows', () => {
    const matches = filterPickerDevices(fleetOfSensors(), 'hall container 45')
    const [group] = groupPickerDevices(matches, [])
    expect(group).toBeDefined()
    if (group === undefined) return
    const picked = selectPickerGroup([], group)
    expect(picked.length).toBe(matches.length)
    expect(picked.length).toBeGreaterThan(0)
    expect(picked.length).toBeLessThan(100)
  })

  it('toggle adds and removes one id, keeping the order of the rest', () => {
    expect(togglePickerDevice([3, 1], 2)).toEqual([3, 1, 2])
    expect(togglePickerDevice([3, 1, 2], 1)).toEqual([3, 2])
  })

  it('the chips stop at the limit and count the rest', () => {
    const ids = Array.from({ length: 40 }, (_, i) => i)
    const folded = chipOverflow(ids, false)
    expect(folded.shown).toHaveLength(PICKER_CHIP_LIMIT)
    expect(folded.hidden).toBe(40 - PICKER_CHIP_LIMIT)
    expect(chipOverflow(ids, true).shown).toHaveLength(40)
    expect(chipOverflow([1, 2], false)).toEqual({ shown: [1, 2], hidden: 0 })
  })

  it('a device with no type or room is grouped last, never dropped', () => {
    const groups = groupPickerDevices(
      [
        { id: 1, name: 'B' },
        { id: 2, name: 'A', type: 'camera', location: 'Hall' },
        { id: 3, name: 'C', type: 'camera', location: '' },
      ],
      [],
    )
    expect(groups.map((g) => [g.type, g.location])).toEqual([
      ['camera', 'Hall'],
      ['camera', null],
      [null, null],
    ])
  })
})

describe('string ids — node and package pickers (D637)', () => {
  const nodes = [
    { id: 'agent-b', name: 'Mac mini', type: 'agent', location: 'online' },
    { id: 'hub', name: 'Hub', type: 'hub', location: 'online' },
  ]
  it('groups, toggles and clears string ids exactly as numeric ones', () => {
    const groups = groupPickerDevices(nodes, ['hub'])
    expect(groups.map((g) => g.type)).toEqual(['agent', 'hub'])
    expect(togglePickerDevice(['hub'], 'agent-b')).toEqual(['hub', 'agent-b'])
    expect(clearPickerGroup(['hub', 'agent-b'], groups[0]!)).toEqual(['hub'])
  })
  it('breaks a name tie on the id for strings too', () => {
    const tied = groupPickerDevices(
      [
        { id: 'b', name: 'X' },
        { id: 'a', name: 'X' },
      ],
      [],
    )
    expect(tied[0]!.devices.map((d) => d.id)).toEqual(['a', 'b'])
  })
})

/**
 * "Group by" — Zone (default) / Location / None, the DEVICE picker only. A
 * site zone is a named set of locations; a device reaches one through its
 * location's folded key. A zone read that has not ANSWERED never produces a
 * "No zone" group (D315): Zone mode then groups by location and says why.
 */
describe('group by — zone, location, none', () => {
  const HOUSE: readonly PickerDevice[] = [
    { id: 1, name: 'Bedroom cam', type: 'camera', location: 'Camera Carol' },
    { id: 2, name: 'Kitchen cam', type: 'camera', location: 'Kitchen' },
    { id: 3, name: 'Hall temp', type: 'sensor', location: 'hall ' },
    { id: 4, name: 'Cantina', type: 'sensor', location: 'Cantina' },
    { id: 5, name: 'Garden', type: 'camera', location: null },
    { id: 6, name: 'Bathroom', type: 'sensor', location: '  ' },
    { id: 7, name: 'Ospiti cam', type: 'camera', location: 'Guest room' },
  ]
  const ZONES: PickerZonesRead = {
    state: 'answered',
    zones: [
      {
        zoneKey: 'night zone',
        label: 'Night zone',
        locationKeys: ['camera carol', 'guest room'],
      },
      { zoneKey: 'zona giorno', label: 'Zona giorno', locationKeys: ['kitchen', 'Hall'] },
      { zoneKey: 'soffitta', label: 'Soffitta', locationKeys: ['soffitta'] },
    ],
  }

  function titles(groups: ReturnType<typeof groupPickerDevicesBy>['groups']): readonly string[] {
    return groups.map((g) => {
      const h = g.heading
      if (h === undefined) return '?'
      if (h.kind === 'zone' || h.kind === 'location') return `${h.kind}:${h.label}`
      return h.kind
    })
  }

  it('the default is Zone, and anything unreadable parses back to it', () => {
    expect(PICKER_DEFAULT_GROUP_BY).toBe('zone')
    expect(parsePickerGroupBy('location')).toBe('location')
    expect(parsePickerGroupBy('none')).toBe('none')
    expect(parsePickerGroupBy('type')).toBe('zone')
    expect(parsePickerGroupBy(null)).toBe('zone')
    expect(parsePickerGroupBy(undefined)).toBe('zone')
  })

  it('Zone: one group per zone by label, then "No zone", then "No location"', () => {
    const grouping = groupPickerDevicesBy(HOUSE, [2], 'zone', ZONES)
    expect(grouping.groupBy).toBe('zone')
    expect(grouping.fallback).toBeNull()
    expect(grouping.flat).toBe(false)
    // An empty zone (Soffitta) draws no group; the fold matches "hall " to "Hall".
    expect(titles(grouping.groups)).toEqual([
      'zone:Night zone',
      'zone:Zona giorno',
      'no-zone',
      'no-location',
    ])
    expect(grouping.groups.map((g) => g.devices.map((d) => d.id))).toEqual([
      [1, 7],
      [3, 2],
      [4],
      [6, 5],
    ])
    expect(grouping.groups[1]!.selectedCount).toBe(1)
    const keys = grouping.groups.map((g) => g.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('Location: one group per location (folded, by label), then "No location"', () => {
    const grouping = groupPickerDevicesBy(
      [...HOUSE, { id: 8, name: 'Altra kitchen', type: 'light', location: 'kitchen' }],
      [],
      'location',
      ZONES,
    )
    expect(grouping.groupBy).toBe('location')
    expect(grouping.fallback).toBeNull()
    expect(titles(grouping.groups)).toEqual([
      'location:Camera Carol',
      'location:Cantina',
      'location:Guest room',
      'location:hall',
      'location:kitchen',
      'no-location',
    ])
    expect(grouping.groups[4]!.devices.map((d) => d.id)).toEqual([8, 2])
  })

  it('None: one flat list by name, then id — no group to act on', () => {
    const grouping = groupPickerDevicesBy(
      [...HOUSE, { id: 0, name: 'Bathroom', type: 'light', location: 'Bathroom' }],
      [],
      'none',
      ZONES,
    )
    expect(grouping.flat).toBe(true)
    expect(grouping.groups).toHaveLength(1)
    expect(grouping.groups[0]!.devices.map((d) => d.id)).toEqual([0, 6, 1, 4, 5, 3, 2, 7])
    const rows = flattenPickerGrouping(grouping, [], NO_TOGGLES, false)
    expect(rows.every((row) => row.kind === 'device')).toBe(true)
    expect(rows).toHaveLength(8)
  })

  it('a PENDING zone read groups by location and flags it — never "No zone"', () => {
    const grouping = groupPickerDevicesBy(HOUSE, [], 'zone', { state: 'pending' })
    expect(grouping.groupBy).toBe('location')
    expect(grouping.fallback).toBe('pending')
    expect(titles(grouping.groups)).not.toContain('no-zone')
    expect(titles(grouping.groups)[0]).toBe('location:Camera Carol')
  })

  it('a FAILED zone read groups by location and flags it — never "No zone"', () => {
    const grouping = groupPickerDevicesBy(HOUSE, [], 'zone', { state: 'failed' })
    expect(grouping.groupBy).toBe('location')
    expect(grouping.fallback).toBe('failed')
    expect(titles(grouping.groups)).not.toContain('no-zone')
  })

  it('an ANSWERED empty zone list is a real answer: every located device is in "No zone"', () => {
    const grouping = groupPickerDevicesBy(HOUSE, [], 'zone', { state: 'answered', zones: [] })
    expect(grouping.fallback).toBeNull()
    expect(titles(grouping.groups)).toEqual(['no-zone', 'no-location'])
  })

  it('Location and None ignore the zone read entirely — no fallback note', () => {
    expect(groupPickerDevicesBy(HOUSE, [], 'location', { state: 'failed' }).fallback).toBeNull()
    expect(groupPickerDevicesBy(HOUSE, [], 'none', { state: 'pending' }).fallback).toBeNull()
  })

  it('group actions keep working on a zone group', () => {
    const grouping = groupPickerDevicesBy(HOUSE, [], 'zone', ZONES)
    const notte = grouping.groups[0]!
    expect(selectPickerGroup([4], notte)).toEqual([4, 1, 7])
    expect(clearPickerGroup([4, 1, 7], notte)).toEqual([4])
    const rows = flattenPickerGrouping(grouping, [], NO_TOGGLES, false)
    expect(rows.filter((row) => row.kind === 'header')).toHaveLength(4)
  })

  it("the row's second line carries the TYPE, and the room wherever the header does not", () => {
    const cam = HOUSE[0]!
    expect(pickerRowFacts(cam, 'zone')).toEqual({ location: 'Camera Carol', type: 'camera' })
    expect(pickerRowFacts(cam, 'location')).toEqual({ location: null, type: 'camera' })
    expect(pickerRowFacts(cam, 'none')).toEqual({ location: 'Camera Carol', type: 'camera' })
    expect(pickerRowFacts({ id: 9, name: 'X', location: ' ' }, 'none')).toEqual({
      location: null,
      type: null,
    })
  })
})

describe('filters: type, zone, location, reset (D697)', () => {
  const items: readonly PickerDevice[] = [
    { id: 1, name: 'Porch', type: 'sensor', location: 'Sala' },
    { id: 2, name: 'Garage', type: 'cover', location: 'Garage' },
    { id: 3, name: 'Porta', type: 'lock', location: ' sala ' },
    { id: 4, name: 'Misc' },
  ]
  const zonesAnswered: PickerZonesRead = {
    state: 'answered',
    zones: [{ zoneKey: 'giorno', label: 'Zona giorno', locationKeys: ['sala'] }],
  }

  it('lists every type the list holds, "(none)" last, with counts', () => {
    expect(pickerFacetOptions(items, 'type', [], zonesAnswered)).toEqual([
      { key: 'cover', label: 'cover', count: 1 },
      { key: 'lock', label: 'lock', count: 1 },
      { key: 'sensor', label: 'sensor', count: 1 },
      { key: PICKER_NONE_KEY, label: null, count: 1 },
    ])
  })
  it('folds locations and keeps a chosen key the list no longer holds, at count 0', () => {
    const options = pickerFacetOptions(items, 'location', ['cantina'], zonesAnswered)
    expect(options.find((o) => o.key === 'sala')).toEqual({ key: 'sala', label: 'Sala', count: 2 })
    expect(options.find((o) => o.key === 'cantina')).toEqual({
      key: 'cantina',
      label: 'cantina',
      count: 0,
    })
  })
  it('offers zones only from an ANSWERED read', () => {
    expect(pickerFacetOptions(items, 'zone', [], { state: 'pending' })).toEqual([])
    expect(
      pickerFacetOptions(items, 'zone', [], zonesAnswered).map((o) => [o.key, o.count]),
    ).toEqual([
      ['giorno', 2],
      [PICKER_NONE_KEY, 2],
    ])
  })
  it('chains search, type, zone and location; nothing chosen keeps the list itself', () => {
    expect(applyPickerFilters(items, PICKER_NO_FILTERS, zonesAnswered)).toBe(items)
    const byType = { ...PICKER_NO_FILTERS, types: ['cover', PICKER_NONE_KEY] }
    expect(applyPickerFilters(items, byType, zonesAnswered).map((d) => d.id)).toEqual([2, 4])
    const byZone = { ...PICKER_NO_FILTERS, zones: ['giorno'] }
    expect(applyPickerFilters(items, byZone, zonesAnswered).map((d) => d.id)).toEqual([1, 3])
    const byLocation = { ...PICKER_NO_FILTERS, locations: ['garage'] }
    expect(applyPickerFilters(items, byLocation, zonesAnswered).map((d) => d.id)).toEqual([2])
  })
  it('suspends a zone filter while the zones read has not answered (D315)', () => {
    const byZone = { ...PICKER_NO_FILTERS, zones: ['giorno'] }
    expect(applyPickerFilters(items, byZone, { state: 'failed' })).toBe(items)
    expect(pickerZoneFilterSuspended(byZone, { state: 'failed' })).toBe(true)
    expect(pickerZoneFilterSuspended(byZone, zonesAnswered)).toBe(false)
  })
  it('toggles a key, says when filters are active, and Reset clears them all', () => {
    expect(togglePickerKey(['lock'], 'lock')).toEqual([])
    expect(togglePickerKey([], 'lock')).toEqual(['lock'])
    expect(pickerFiltersActive(PICKER_NO_FILTERS)).toBe(false)
    expect(pickerFiltersActive({ ...PICKER_NO_FILTERS, locations: ['sala'] })).toBe(true)
    expect(pickerFiltersActive({ ...PICKER_NO_FILTERS, query: ' x ' })).toBe(true)
    expect(resetPickerFilters()).toEqual(PICKER_NO_FILTERS)
  })
  it('counts selected LISTED ids the filters hide; an off-list id (9) is a chip, not hidden', () => {
    const visible = applyPickerFilters(
      items,
      { ...PICKER_NO_FILTERS, types: ['sensor'] },
      zonesAnswered,
    )
    expect(pickerHiddenSelectedCount([1, 2, 9], items, visible)).toBe(1)
  })
  it('draws a dropdown only when it can narrow, or a key is chosen', () => {
    const one = pickerFacetOptions([{ id: 1, name: 'a', type: 'lock' }], 'type', [], zonesAnswered)
    expect(pickerFacetFilterShown(one, [])).toBe(false)
    expect(pickerFacetFilterShown(one, ['lock'])).toBe(true)
  })
})
