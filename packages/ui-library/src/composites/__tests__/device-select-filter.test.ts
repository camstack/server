import { describe, expect, it } from 'vitest'
import {
  type DeviceSelectCandidate,
  deviceFacets,
  deviceMatchesFilter,
  deviceOptionDescription,
  deviceOptionLabel,
  devicesToOptions,
  filterDeviceOptions,
  matchesFacets,
  partitionSuggested,
  type SuggestionFleetDevice,
  sameLocationSuggestions,
  selectedDeviceOptions,
} from '../device-select-filter'

const dev = (over: Partial<DeviceSelectCandidate> & { id: number }): DeviceSelectCandidate => ({
  type: 'sensor',
  name: `Device ${over.id}`,
  location: null,
  features: [],
  ...over,
})

describe('deviceMatchesFilter', () => {
  it('matches every device when the filter is absent or empty', () => {
    const d = dev({ id: 1 })
    expect(deviceMatchesFilter(d)).toBe(true)
    expect(deviceMatchesFilter(d, {})).toBe(true)
    expect(deviceMatchesFilter(d, { caps: [], types: [] })).toBe(true)
  })

  it('matches on feature ∩ caps intersection', () => {
    const d = dev({ id: 1, features: ['contact', 'battery-operated'] })
    expect(deviceMatchesFilter(d, { caps: ['contact', 'switch'] })).toBe(true)
    expect(deviceMatchesFilter(d, { caps: ['motion'] })).toBe(false)
  })

  it('matches on type ∈ types', () => {
    const d = dev({ id: 1, type: 'switch', features: [] })
    expect(deviceMatchesFilter(d, { types: ['switch', 'sensor'] })).toBe(true)
    expect(deviceMatchesFilter(d, { types: ['camera'] })).toBe(false)
  })

  it('unions caps and types (either clause is sufficient)', () => {
    const byType = dev({ id: 1, type: 'switch', features: [] })
    const byCap = dev({ id: 2, type: 'generic', features: ['contact'] })
    const filter = { caps: ['contact'], types: ['switch'] }
    expect(deviceMatchesFilter(byType, filter)).toBe(true)
    expect(deviceMatchesFilter(byCap, filter)).toBe(true)
    expect(deviceMatchesFilter(dev({ id: 3, type: 'x', features: ['y'] }), filter)).toBe(false)
  })

  it('excludeDeviceId always drops the device, even if it would otherwise match', () => {
    const d = dev({ id: 10, type: 'switch', features: ['contact'] })
    expect(deviceMatchesFilter(d, { caps: ['contact'], excludeDeviceId: 10 })).toBe(false)
    expect(deviceMatchesFilter(d, { excludeDeviceId: 10 })).toBe(false)
    expect(deviceMatchesFilter(d, { excludeDeviceId: 99 })).toBe(true)
  })

  it('tolerates missing features array', () => {
    const d: DeviceSelectCandidate = { id: 1, type: 'sensor', name: 'x', location: null }
    expect(deviceMatchesFilter(d, { caps: ['contact'] })).toBe(false)
  })
})

describe('deviceOptionLabel', () => {
  it('folds location into the label when present', () => {
    expect(deviceOptionLabel(dev({ id: 1, name: 'Contact', location: 'Kitchen' }))).toBe(
      'Contact (Kitchen)',
    )
  })
  it('uses the bare name when no location', () => {
    expect(deviceOptionLabel(dev({ id: 1, name: 'Contact', location: null }))).toBe('Contact')
    expect(deviceOptionLabel(dev({ id: 1, name: 'Contact', location: '' }))).toBe('Contact')
  })
})

describe('devicesToOptions', () => {
  it('filters, maps to {value:id,label,description,location}, and sorts by label', () => {
    const devices = [
      dev({ id: 3, name: 'Zulu', type: 'switch' }),
      dev({ id: 1, name: 'Alpha', type: 'switch' }),
      dev({ id: 2, name: 'Cam', type: 'camera' }),
    ]
    const opts = devicesToOptions(devices, { types: ['switch'] })
    expect(opts).toEqual([
      { value: '1', label: 'Alpha', description: 'switch', location: null },
      { value: '3', label: 'Zulu', description: 'switch', location: null },
    ])
  })
})

describe('filterDeviceOptions', () => {
  const opts = [
    { value: '1', label: 'Front Door (Front door)' },
    { value: '2', label: 'Kitchen Switch (Kitchen)' },
  ]
  it('returns all on empty query', () => {
    expect(filterDeviceOptions(opts, '   ')).toHaveLength(2)
  })
  it('matches by name, location, and id (AND over tokens)', () => {
    expect(filterDeviceOptions(opts, 'door').map((o) => o.value)).toEqual(['1'])
    expect(filterDeviceOptions(opts, 'kitchen switch').map((o) => o.value)).toEqual(['2'])
    expect(filterDeviceOptions(opts, '2')).toHaveLength(1)
    expect(filterDeviceOptions(opts, 'nope')).toHaveLength(0)
  })
})

describe('selectedDeviceOptions', () => {
  const opts = [
    { value: '1', label: 'One' },
    { value: '2', label: 'Two' },
  ]
  it('resolves in selection order and synthesises stale ids', () => {
    expect(selectedDeviceOptions(opts, ['2', '9'])).toEqual([
      { value: '2', label: 'Two' },
      { value: '9', label: '9' },
    ])
  })
})

/**
 * The linked-devices picker (D356): every non-container device is a
 * candidate, the ones sharing the camera's location are SUGGESTED, and a
 * catalogue of hundreds is narrowed by location / type facets before the
 * free-text search. Nothing links itself any more — the operator picks.
 */
describe('excludeTypes', () => {
  it('drops a type the filter excludes, whatever else matches', () => {
    const c = dev({ id: 1, type: 'container', features: ['switch'] })
    expect(deviceMatchesFilter(c, { excludeTypes: ['container'] })).toBe(false)
    expect(deviceMatchesFilter(c, { caps: ['switch'], excludeTypes: ['container'] })).toBe(false)
    expect(
      deviceMatchesFilter(dev({ id: 2, type: 'switch' }), { excludeTypes: ['container'] }),
    ).toBe(true)
  })
})

describe('deviceFacets', () => {
  it('lists the distinct locations and types, sorted, skipping a missing location', () => {
    const facets = deviceFacets([
      dev({ id: 1, type: 'switch', location: 'Hall' }),
      dev({ id: 2, type: 'sensor', location: 'Kitchen' }),
      dev({ id: 3, type: 'switch', location: null }),
      dev({ id: 4, type: 'light', location: 'Hall' }),
    ])
    expect(facets).toEqual({
      locations: ['Hall', 'Kitchen'],
      types: ['light', 'sensor', 'switch'],
    })
  })
})

describe('matchesFacets', () => {
  it('keeps a device only when it matches every facet that has a choice', () => {
    const d = dev({ id: 1, type: 'switch', location: 'Hall' })
    expect(matchesFacets(d, { locations: [], types: [] })).toBe(true)
    expect(matchesFacets(d, { locations: ['Hall'], types: [] })).toBe(true)
    expect(matchesFacets(d, { locations: ['Kitchen'], types: [] })).toBe(false)
    expect(matchesFacets(d, { locations: ['Hall'], types: ['sensor'] })).toBe(false)
  })
})

describe('deviceOptionDescription', () => {
  it('names the location, the type and the container the device lives in', () => {
    const inContainer = dev({
      id: 3520,
      type: 'switch',
      name: 'Faretti hall 2',
      location: 'Hall',
      parentName: 'Pulsante faretti hall',
    })
    expect(deviceOptionDescription(inContainer)).toBe('Hall · switch · in Pulsante faretti hall')
    expect(deviceOptionDescription(dev({ id: 1, type: 'sensor', location: null }))).toBe('sensor')
  })
})

describe('partitionSuggested', () => {
  it('puts the suggested items first, in order, and keeps every other item', () => {
    const items = [{ id: 1 }, { id: 2 }, { id: 3 }]
    expect(partitionSuggested(items, new Set([2]), (i) => i.id)).toEqual({
      suggested: [items[1]],
      others: [items[0], items[2]],
    })
    expect(partitionSuggested(items, new Set<number>(), (i) => i.id)).toEqual({
      suggested: [],
      others: items,
    })
  })
})

describe('sameLocationSuggestions', () => {
  const fleetRow = (
    over: Partial<SuggestionFleetDevice> & { id: number },
  ): SuggestionFleetDevice => ({
    type: 'sensor',
    name: `Device ${over.id}`,
    stableId: `s${over.id}`,
    location: null,
    parentDeviceId: null,
    primaryChildEntityId: null,
    role: null,
    ...over,
  })
  // The live shape (D356): a container grouping two equal switches, a lone
  // sensor in the room, and a device elsewhere.
  const container = fleetRow({
    id: 3513,
    type: 'container',
    name: 'Pulsante faretti hall',
    location: 'Hall',
  })
  const spot1 = fleetRow({
    id: 3519,
    type: 'switch',
    name: 'Faretti hall 1',
    location: 'Hall',
    parentDeviceId: 3513,
  })
  const spot2 = fleetRow({
    id: 3520,
    type: 'switch',
    name: 'Faretti hall 2',
    location: 'Hall',
    parentDeviceId: 3513,
  })
  const door = fleetRow({ id: 4001, name: 'Porta hall', location: 'Hall' })
  const kitchen = fleetRow({ id: 4002, name: 'Porta kitchen', location: 'Kitchen' })

  it('suggests the devices sharing the location, and nothing elsewhere', () => {
    const ids = sameLocationSuggestions([door, kitchen], 'Hall')
    expect([...ids]).toEqual([4001])
  })

  it('suggests nothing without a location', () => {
    expect(sameLocationSuggestions([door], null).size).toBe(0)
    expect(sameLocationSuggestions([door], '').size).toBe(0)
  })

  it('never suggests a container; a container contributes only its auto-selected primary child', () => {
    const ids = sameLocationSuggestions([container, spot1, spot2, door], 'Hall')
    expect(ids.has(3513)).toBe(false)
    // Two equal switches: the shared resolver's tie-break picks the first.
    expect(ids.has(3519)).toBe(true)
    expect(ids.has(3520)).toBe(false)
    expect(ids.has(4001)).toBe(true)
  })

  it("uses the container's stored pick when there is one", () => {
    const picked = { ...container, primaryChildEntityId: spot2.stableId }
    const ids = sameLocationSuggestions([picked, spot1, spot2], 'Hall')
    expect([...ids]).toEqual([3520])
  })

  it('resolves the automatic primary by role before type, as the container renders', () => {
    const lock = fleetRow({
      id: 10,
      type: 'container',
      name: 'Porta front door',
      location: 'Hall',
    })
    const battery = fleetRow({
      id: 11,
      type: 'sensor',
      name: 'Batteria',
      location: 'Hall',
      parentDeviceId: 10,
      role: 'battery-sensor',
    })
    const contact = fleetRow({
      id: 12,
      type: 'sensor',
      name: 'Contatto',
      location: 'Hall',
      parentDeviceId: 10,
      role: 'contact-sensor',
    })
    expect([...sameLocationSuggestions([lock, battery, contact], 'Hall')]).toEqual([12])
  })

  it('a container in the room whose children carry no location still contributes its primary', () => {
    const child = { ...spot1, location: null }
    expect([...sameLocationSuggestions([container, child], 'Hall')]).toEqual([3519])
  })

  it('a container with no child suggests nothing', () => {
    expect(sameLocationSuggestions([container], 'Hall').size).toBe(0)
  })
})

describe('matchesFacets with several values per facet', () => {
  // Facets are dropdown MULTI-selects (operator, 2026-09-05): a chosen set is
  // "any of these"; an empty set is "all".
  it('matches any chosen location and any chosen type', () => {
    const d = dev({ id: 1, type: 'switch', location: 'Hall' })
    expect(matchesFacets(d, { locations: ['Kitchen', 'Hall'], types: [] })).toBe(true)
    expect(matchesFacets(d, { locations: ['Kitchen'], types: [] })).toBe(false)
    expect(matchesFacets(d, { locations: [], types: ['sensor', 'switch'] })).toBe(true)
    expect(matchesFacets(d, { locations: ['Hall'], types: ['sensor'] })).toBe(false)
  })
})
