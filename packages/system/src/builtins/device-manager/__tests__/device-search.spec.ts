/**
 * `deviceManager.search` — the device → value picker query.
 *
 * Driven through `searchDevices` with injected sources (the fleet, the
 * bindings, the status) so what is under test is the search itself: facet
 * semantics, cursor stability, id resolution, the hidden-incompatible rule and
 * the "a failed read is a null reading, not a missing device" rule.
 */
import { describe, expect, it, vi } from 'vitest'
import { DeviceType } from '@dominevo/types'
import type { DeviceInfo } from '@dominevo/types'
import { searchDevices, type DeviceSearchDeps } from '../device-search.js'

const LOCATIONS = ['Kitchen', 'Garage', 'Garden', 'Hall', 'Office'] as const
const INTEGRATIONS = ['hue', 'ha', 'zigbee'] as const
const TYPES = [DeviceType.Sensor, DeviceType.Light, DeviceType.Camera] as const

function device(id: number, over: Partial<DeviceInfo> = {}): DeviceInfo {
  return {
    id,
    stableId: `s${id}`,
    addonId: 'fake',
    type: TYPES[id % TYPES.length] ?? DeviceType.Sensor,
    name: `Device ${String(id).padStart(5, '0')}`,
    location: LOCATIONS[id % LOCATIONS.length] ?? null,
    disabled: false,
    parentDeviceId: null,
    online: true,
    features: [],
    isCamera: false,
    config: {},
    integrationId: INTEGRATIONS[id % INTEGRATIONS.length],
    ...over,
  }
}

interface FakeOpts {
  readonly fleet: readonly DeviceInfo[]
  /** device id → bound caps; default: even ids hold `temperature`, ids divisible by 6 also `battery`. */
  readonly caps?: (id: number) => readonly string[]
  readonly status?: DeviceSearchDeps['readStatus']
}

function makeDeps(o: FakeOpts): DeviceSearchDeps {
  const caps =
    o.caps ??
    ((id: number) => [
      ...(id % 2 === 0 ? ['temperature'] : []),
      ...(id % 6 === 0 ? ['battery'] : []),
    ])
  return {
    listDevices: async () => o.fleet,
    boundCaps: async (ids) => new Map(ids.map((id) => [id, caps(id)])),
    fieldsOf: (cap) =>
      cap === 'temperature'
        ? { cap, fields: [{ path: 'value', quantity: 'temperature' }] }
        : cap === 'battery'
          ? { cap, fields: [{ path: 'percentage' }, { path: 'lowBattery' }] }
          : null,
    readStatus:
      o.status ??
      (async (ids, wanted) =>
        Object.fromEntries(
          ids.map((id) => [
            String(id),
            Object.fromEntries(
              wanted.map((cap) => [
                cap,
                cap === 'temperature' ? { value: id / 10 } : { percentage: 50, lowBattery: false },
              ]),
            ),
          ]),
        )),
    integrationLabels: async () =>
      new Map([
        ['hue', 'Philips Hue'],
        ['ha', 'Home Assistant'],
      ]),
    logger: { warn: vi.fn() },
  }
}

const smallFleet = Array.from({ length: 60 }, (_, i) => device(i + 1))

describe('searchDevices', () => {
  it('lists only compatible devices, counts the hidden ones, and reveals them on request', async () => {
    const deps = makeDeps({ fleet: smallFleet })
    const hidden = await searchDevices(deps, { requires: { caps: ['temperature'] }, limit: 200 })
    expect(hidden.compatibleTotal).toBe(30)
    expect(hidden.hiddenIncompatible).toBe(30)
    expect(hidden.fleetTotal).toBe(60)
    expect(hidden.total).toBe(30)
    expect(hidden.items.every((i) => i.compatible)).toBe(true)

    const shown = await searchDevices(deps, {
      requires: { caps: ['temperature'] },
      includeIncompatible: true,
      limit: 200,
    })
    expect(shown.total).toBe(60)
    const incompatible = shown.items.filter((i) => !i.compatible)
    expect(incompatible).toHaveLength(30)
    expect(incompatible.every((i) => i.values.length === 0)).toBe(true)
    // compatible devices sort ahead of the greyed ones
    expect(shown.items.slice(0, 30).every((i) => i.compatible)).toBe(true)
  })

  it('returns only the required caps values, each with its live reading', async () => {
    const deps = makeDeps({ fleet: smallFleet })
    const res = await searchDevices(deps, {
      requires: { caps: ['temperature', 'battery'] },
      ids: [6, 2],
    })
    const six = res.items.find((i) => i.id === 6)
    expect(six?.values.map((v) => `${v.cap}.${v.path}`)).toEqual([
      'temperature.value',
      'battery.percentage',
      'battery.lowBattery',
    ])
    expect(six?.values[0]).toMatchObject({ reading: '0.6', quantity: 'temperature' })
    expect(six?.values[2]).toMatchObject({ reading: 'false', label: 'Low battery' })
    expect(res.items.find((i) => i.id === 2)?.values).toHaveLength(1)
  })

  it('an action require keeps only devices that offer it, and mode all is the intersection', async () => {
    const deps = makeDeps({
      fleet: [device(1), device(2), device(3)],
      caps: (id) => (id === 2 ? ['cover'] : id === 3 ? ['cover', 'switch'] : ['battery']),
    })
    const one = await searchDevices(deps, {
      requires: { actions: ['cover.open'] },
      includeIncompatible: true,
      limit: 20,
    })
    const byId = new Map(one.items.map((item) => [item.id, item]))
    expect(byId.get(1)?.compatible).toBe(false)
    expect(byId.get(2)?.compatible).toBe(true)
    expect(byId.get(3)?.compatible).toBe(true)
    expect(one.items.every((item) => item.values.length === 0)).toBe(true)
    expect(one.hiddenIncompatible).toBe(1)

    const both = await searchDevices(deps, {
      requires: { actions: ['cover.open', 'switch.on'], mode: 'all' },
      limit: 20,
    })
    expect(both.items.map((item) => item.id)).toEqual([3])
    expect(both.compatibleTotal).toBe(1)
    expect(both.items[0]?.values).toEqual([])
  })

  it('mode all requires every cap', async () => {
    const deps = makeDeps({ fleet: smallFleet })
    const res = await searchDevices(deps, {
      requires: { caps: ['temperature', 'battery'], mode: 'all' },
      limit: 200,
    })
    expect(res.items.map((i) => i.id)).toEqual(expect.arrayContaining([6, 12]))
    expect(res.compatibleTotal).toBe(10)
  })

  it('text matches name, location, type, integration label and id', async () => {
    const deps = makeDeps({ fleet: smallFleet })
    const ids = async (text: string) =>
      (await searchDevices(deps, { text, limit: 200 })).items.map((i) => i.id)
    const byDigits = await ids('00007')
    // The padded name "00007" is an exact word. A neighbour such as "00017"
    // is one edit away, so the shared fuzzy rank includes it afterwards.
    expect(byDigits[0]).toBe(7)
    expect(byDigits.indexOf(17)).toBeGreaterThan(0)
    expect((await ids('garage')).every((id) => LOCATIONS[id % 5] === 'Garage')).toBe(true)
    expect((await ids('philips')).every((id) => INTEGRATIONS[id % 3] === 'hue')).toBe(true)
    expect((await ids('camera')).length).toBe(20)
    expect(await ids('zzz-nothing')).toEqual([])
  })

  describe('a location filter (D1089)', () => {
    it('accepts a room id as well as a name, for one release', async () => {
      const deps: DeviceSearchDeps = {
        ...makeDeps({ fleet: smallFleet }),
        roomNameOf: (value) => (value === 'room_garage' ? 'Garage' : null),
      }
      const byName = await searchDevices(deps, { filters: { locations: ['Garage'] } })
      const byId = await searchDevices(deps, { filters: { locations: ['room_garage'] } })
      expect(byName.total).toBeGreaterThan(0)
      expect(byId.total).toBe(byName.total)
      const unknownId = await searchDevices(deps, { filters: { locations: ['room_gone'] } })
      expect(unknownId.total).toBe(0)
    })
  })

  describe('facets', () => {
    it('count the compatible set with the OTHER facets applied, not their own', async () => {
      const deps = makeDeps({ fleet: smallFleet })
      const base = await searchDevices(deps, { requires: { caps: ['temperature'] } })
      const garage = await searchDevices(deps, {
        requires: { caps: ['temperature'] },
        filters: { locations: ['Garage'] },
      })
      // Choosing a location leaves the location facet itself untouched ...
      expect(garage.facets.locations).toEqual(base.facets.locations)
      // ... but narrows the other two to that location.
      const garageCompatible = smallFleet.filter(
        (d) => d.location === 'Garage' && d.id % 2 === 0,
      ).length
      expect(garage.total).toBe(garageCompatible)
      expect(garage.facets.types.reduce((n, t) => n + t.count, 0)).toBe(garageCompatible)
      expect(garage.facets.integrations.reduce((n, t) => n + t.count, 0)).toBe(garageCompatible)
      expect(base.facets.types.reduce((n, t) => n + t.count, 0)).toBe(30)
    })

    it('exclude incompatible devices and carry integration labels', async () => {
      const deps = makeDeps({ fleet: smallFleet })
      const res = await searchDevices(deps, { requires: { caps: ['temperature'] } })
      expect(res.facets.locations.reduce((n, l) => n + l.count, 0)).toBe(30)
      const hue = res.facets.integrations.find((i) => i.id === 'hue')
      expect(hue?.label).toBe('Philips Hue')
      const zigbee = res.facets.integrations.find((i) => i.id === 'zigbee')
      expect(zigbee?.label).toBe('zigbee')
    })

    it('are ordered by count then value', async () => {
      const deps = makeDeps({ fleet: smallFleet })
      const res = await searchDevices(deps, {})
      const counts = res.facets.locations.map((l) => l.count)
      expect(counts).toEqual([...counts].sort((a, b) => b - a))
    })
  })

  describe('pagination', () => {
    it('walks the whole list exactly once, in a stable order', async () => {
      const deps = makeDeps({ fleet: smallFleet })
      const seen: number[] = []
      let cursor: string | null = null
      let pages = 0
      do {
        const res = await searchDevices(deps, { limit: 7, cursor })
        seen.push(...res.items.map((i) => i.id))
        cursor = res.nextCursor
        pages += 1
      } while (cursor !== null)
      expect(pages).toBe(9)
      expect(new Set(seen).size).toBe(60)
      const whole = await searchDevices(deps, { limit: 200 })
      expect(seen).toEqual(whole.items.map((i) => i.id))
    })

    it('a device added mid-scroll does not shift or repeat the pages already seen', async () => {
      const fleet = [...smallFleet]
      const deps = { ...makeDeps({ fleet }), listDevices: async () => fleet }
      const first = await searchDevices(deps, { limit: 10 })
      fleet.push(device(61, { name: 'Device 00000 first' }))
      const second = await searchDevices(deps, { limit: 10, cursor: first.nextCursor })
      const firstIds = new Set(first.items.map((i) => i.id))
      expect(second.items.some((i) => firstIds.has(i.id))).toBe(false)
    })

    it('suggestions and totals appear on the first page only', async () => {
      const deps = makeDeps({ fleet: smallFleet })
      const first = await searchDevices(deps, { limit: 5, contextDeviceId: 1 })
      expect(first.suggested.length).toBeGreaterThan(0)
      const second = await searchDevices(deps, {
        limit: 5,
        contextDeviceId: 1,
        cursor: first.nextCursor,
      })
      expect(second.suggested).toEqual([])
    })

    it('restarts from the first page on an undecodable cursor, and says so', async () => {
      const deps = makeDeps({ fleet: smallFleet })
      const res = await searchDevices(deps, { limit: 5, cursor: '%%%not-a-cursor' })
      expect(res.items).toHaveLength(5)
      expect(deps.logger.warn).toHaveBeenCalled()
    })
  })

  it('suggests compatible devices at the context device location, never the device itself', async () => {
    const deps = makeDeps({ fleet: smallFleet })
    const res = await searchDevices(deps, {
      requires: { caps: ['temperature'] },
      contextDeviceId: 5,
    })
    expect(res.suggested.length).toBeGreaterThan(0)
    expect(
      res.suggested.every(
        (d) => d.location === smallFleet[4]?.location && d.compatible && d.id !== 5,
      ),
    ).toBe(true)
  })

  describe('ids', () => {
    it('resolves the asked devices regardless of filters and names the missing ones', async () => {
      const deps = makeDeps({ fleet: smallFleet })
      const res = await searchDevices(deps, {
        ids: [4, 999, 3],
        text: 'nothing-matches-this',
        filters: { locations: ['Nowhere'] },
        requires: { caps: ['temperature'] },
      })
      expect(res.items.map((i) => i.id)).toEqual([4, 3])
      expect(res.missingIds).toEqual([999])
      expect(res.nextCursor).toBeNull()
      expect(res.items[0]?.compatible).toBe(true)
      expect(res.items[1]?.compatible).toBe(false)
    })
  })

  describe('readings', () => {
    it('a failed state read yields reading null, not a dropped device', async () => {
      const deps = makeDeps({
        fleet: smallFleet,
        status: async () => {
          throw new Error('state store down')
        },
      })
      const res = await searchDevices(deps, { requires: { caps: ['temperature'] }, limit: 5 })
      expect(res.items).toHaveLength(5)
      for (const item of res.items) {
        expect(item.values).toHaveLength(1)
        expect(item.values[0]?.reading).toBeNull()
      }
      expect(deps.logger.warn).toHaveBeenCalled()
    })

    it('a cap the aggregate could not read for one device nulls only that value', async () => {
      const deps = makeDeps({
        fleet: smallFleet,
        status: async () => ({ '2': { temperature: null }, '4': { temperature: { value: 21.5 } } }),
      })
      const res = await searchDevices(deps, {
        requires: { caps: ['temperature'] },
        ids: [2, 4],
      })
      expect(res.items.map((i) => i.values[0]?.reading)).toEqual([null, '21.5'])
    })

    it('reads status for the returned page only, never the fleet', async () => {
      const readStatus = vi.fn(async (_ids: readonly number[], _caps: readonly string[]) => ({}))
      const deps = makeDeps({ fleet: smallFleet, status: readStatus })
      await searchDevices(deps, { requires: { caps: ['temperature'] }, limit: 5 })
      const ids = readStatus.mock.calls[0]?.[0] ?? []
      expect(ids.length).toBeLessThanOrEqual(5)
    })
  })

  describe('order by name', () => {
    // A Sensor named "Alfa" and a Camera named "Zeta": type order would put
    // the camera first; the picker orders by NAME.
    const zeta = device(1, { name: 'Zeta porta', type: DeviceType.Camera, location: 'Hall' })
    const alfa = device(2, { name: 'Alfa porta', type: DeviceType.Sensor, location: 'Hall' })
    const fleet = [zeta, alfa]

    it('empty text lists devices alphabetically, whatever their type', async () => {
      const res = await searchDevices(makeDeps({ fleet }), { limit: 20 })
      expect(res.items.map((item) => item.id)).toEqual([2, 1])
    })

    it('with text, one rank tier is ordered by name', async () => {
      const res = await searchDevices(makeDeps({ fleet }), { text: 'porta', limit: 20 })
      expect(res.items.map((item) => item.id)).toEqual([2, 1])
    })
  })

  describe('text ranking', () => {
    const parent = device(1, {
      name: 'Bagno camerette',
      type: DeviceType.Camera,
      location: 'Upstairs',
    })
    const child = device(2, {
      name: 'Movimento',
      parentDeviceId: 1,
      type: DeviceType.Sensor,
      location: 'Hall',
      stableId: 'motion-1',
    })
    const exactTypo = device(3, {
      name: 'Bagn camerete',
      type: DeviceType.Light,
      location: 'Office',
    })
    const device102 = device(102, {
      name: 'Cortile',
      stableId: 'stable-102',
      location: 'Garden',
      type: DeviceType.Camera,
    })
    const device108 = device(108, {
      name: 'Ingresso',
      stableId: 'stable-108',
      location: 'Hall',
      type: DeviceType.Sensor,
    })
    const fleet = [parent, child, exactTypo, device102, device108]

    it('finds a child whose parent container is named "Bagno camerette"', async () => {
      const deps = makeDeps({ fleet })
      const res = await searchDevices(deps, { text: 'bagno camerette', limit: 20 })
      expect(res.items.map((item) => item.id)).toContain(2)
      expect(res.total).toBe(2)
      expect(res.facets.types.find((facet) => facet.value === DeviceType.Sensor)?.count).toBe(1)
    })

    it('a typo of the parent name still finds the child', async () => {
      const deps = makeDeps({ fleet })
      const res = await searchDevices(deps, { text: 'bagn camerete', limit: 20 })
      expect(res.items.map((item) => item.id)).toContain(2)
    })

    it('ranks an exact name above a fuzzy hit', async () => {
      const deps = makeDeps({ fleet })
      const res = await searchDevices(deps, { text: 'bagn camerete', limit: 20 })
      const ids = res.items.map((item) => item.id)
      expect(ids[0]).toBe(3)
      expect(ids.indexOf(3)).toBeLessThan(ids.indexOf(2))
    })

    it('never fuzzy-matches device 102 when the query is 108', async () => {
      const deps = makeDeps({ fleet })
      const as108 = await searchDevices(deps, { text: '108', limit: 20 })
      expect(as108.items.map((item) => item.id)).toEqual([108])
      const asHash = await searchDevices(deps, { text: '#102', limit: 20 })
      expect(asHash.items.map((item) => item.id)).toEqual([102])
    })

    it('pages the ranked list without repeats or gaps', async () => {
      const deps = makeDeps({ fleet })
      const full = await searchDevices(deps, { text: 'bagn camerete', limit: 20 })
      const seen: number[] = []
      let cursor: string | null = null
      do {
        const page = await searchDevices(deps, { text: 'bagn camerete', limit: 1, cursor })
        seen.push(...page.items.map((item) => item.id))
        cursor = page.nextCursor
      } while (cursor !== null)
      expect(seen).toEqual(full.items.map((item) => item.id))
      expect(new Set(seen).size).toBe(seen.length)
    })
  })

  it('a 5,000-device fleet answers a faceted, filtered, paged query inside the time budget', async () => {
    const fleet = Array.from({ length: 5000 }, (_, i) => device(i + 1))
    const deps = makeDeps({ fleet })
    const run = async () =>
      searchDevices(deps, {
        text: 'device',
        requires: { caps: ['temperature'] },
        filters: { locations: ['Garage', 'Hall'], types: ['light'] },
        includeIncompatible: true,
        contextDeviceId: 10,
        limit: 50,
      })
    await run() // warm
    const started = performance.now()
    const res = await run()
    const elapsed = performance.now() - started
    expect(res.fleetTotal).toBe(5000)
    expect(res.items).toHaveLength(50)
    expect(res.nextCursor).not.toBeNull()
    expect(res.facets.locations.length).toBe(5)
    // Measured ~15 ms; the budget leaves headroom for a loaded CI box while
    // still failing on an accidental O(n^2) over the fleet.
    expect(elapsed).toBeLessThan(250)
  })
})
