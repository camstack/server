/**
 * Pure DeviceSelector semantics (scope model v3). No I/O — the matcher,
 * fleet resolver, v2→v3 migration and effective-scope summary are all
 * exercised directly.
 */
import { describe, expect, it } from 'vitest'
import { DeviceType } from '../../device/device-type.js'
import type { DeviceSelector, TokenScope } from '../auth-records.js'
import type { DeviceMetaLike } from '../device-selector.js'
import {
  deviceSelectorMatches,
  normalizeTokenScopes,
  resolveViewableDeviceIds,
  summarizeEffectiveScope,
} from '../device-selector.js'

// Reolink topology from CLAUDE.md: camera 5 with 3 accessories, Hik 7 + 1,
// camera 9 (no children), plus a standalone light 20 in "Garden".
const FLEET: readonly DeviceMetaLike[] = [
  { id: 5, type: DeviceType.Camera, location: 'Front door', parentDeviceId: null },
  { id: 51, type: DeviceType.Siren, location: null, parentDeviceId: 5 },
  { id: 52, type: DeviceType.Light, location: null, parentDeviceId: 5 },
  { id: 53, type: DeviceType.Sensor, location: null, parentDeviceId: 5 },
  { id: 7, type: DeviceType.Camera, location: 'Garden', parentDeviceId: null },
  { id: 71, type: DeviceType.Siren, location: null, parentDeviceId: 7 },
  { id: 9, type: DeviceType.Camera, location: null, parentDeviceId: null },
  { id: 20, type: DeviceType.Light, location: 'Garden', parentDeviceId: null },
]

function meta(id: number): DeviceMetaLike {
  const m = FLEET.find((d) => d.id === id)
  if (!m) throw new Error(`no fixture device ${id}`)
  return m
}

describe('deviceSelectorMatches', () => {
  it('all matches every device', () => {
    const sel: DeviceSelector = { kind: 'all' }
    for (const d of FLEET) expect(deviceSelectorMatches(sel, d)).toBe(true)
  })

  it('ids matches only listed ids', () => {
    const sel: DeviceSelector = { kind: 'ids', ids: [5, 7] }
    expect(deviceSelectorMatches(sel, meta(5))).toBe(true)
    expect(deviceSelectorMatches(sel, meta(7))).toBe(true)
    expect(deviceSelectorMatches(sel, meta(9))).toBe(false)
    expect(deviceSelectorMatches(sel, meta(51))).toBe(false)
  })

  it('types matches by device type (dynamic)', () => {
    const sel: DeviceSelector = { kind: 'types', types: [DeviceType.Camera] }
    expect(deviceSelectorMatches(sel, meta(5))).toBe(true)
    expect(deviceSelectorMatches(sel, meta(9))).toBe(true)
    expect(deviceSelectorMatches(sel, meta(51))).toBe(false) // siren
    expect(deviceSelectorMatches(sel, meta(20))).toBe(false) // light
  })

  it('locations matches by location label; null location matches nothing', () => {
    const sel: DeviceSelector = { kind: 'locations', locations: ['Garden'] }
    expect(deviceSelectorMatches(sel, meta(7))).toBe(true)
    expect(deviceSelectorMatches(sel, meta(20))).toBe(true)
    expect(deviceSelectorMatches(sel, meta(5))).toBe(false) // Front door
    expect(deviceSelectorMatches(sel, meta(51))).toBe(false) // null location
  })
})

describe('resolveViewableDeviceIds — fleet expansion + inheritance', () => {
  it('category:device[view] resolves to the whole fleet', () => {
    const scopes: TokenScope[] = [{ type: 'category', target: 'device', access: ['view'] }]
    const set = resolveViewableDeviceIds(scopes, FLEET, 'view')
    expect(set).toEqual(new Set(FLEET.map((d) => d.id)))
  })

  it('ids selector at view inherits children of the named parent', () => {
    const scopes: TokenScope[] = [
      { type: 'device', selector: { kind: 'ids', ids: [5] }, access: ['view'] },
    ]
    const set = resolveViewableDeviceIds(scopes, FLEET, 'view')
    // parent 5 + its 3 children, nothing else
    expect([...set].sort((a, b) => a - b)).toEqual([5, 51, 52, 53])
  })

  it('create access does NOT inherit children by default', () => {
    const scopes: TokenScope[] = [
      { type: 'device', selector: { kind: 'ids', ids: [5] }, access: ['view', 'create'] },
    ]
    const view = resolveViewableDeviceIds(scopes, FLEET, 'view')
    const create = resolveViewableDeviceIds(scopes, FLEET, 'create')
    expect([...view].sort((a, b) => a - b)).toEqual([5, 51, 52, 53])
    expect([...create]).toEqual([5]) // no accessory inheritance for create
  })

  it('includeLinked:true forces inheritance even for create', () => {
    const scopes: TokenScope[] = [
      {
        type: 'device',
        selector: { kind: 'ids', ids: [5] },
        access: ['create'],
        includeLinked: true,
      },
    ]
    const create = resolveViewableDeviceIds(scopes, FLEET, 'create')
    expect([...create].sort((a, b) => a - b)).toEqual([5, 51, 52, 53])
  })

  it('includeLinked:false suppresses inheritance even for view', () => {
    const scopes: TokenScope[] = [
      {
        type: 'device',
        selector: { kind: 'ids', ids: [5] },
        access: ['view'],
        includeLinked: false,
      },
    ]
    const view = resolveViewableDeviceIds(scopes, FLEET, 'view')
    expect([...view]).toEqual([5])
  })

  it('types selector at view covers all cameras AND their accessories', () => {
    const scopes: TokenScope[] = [
      { type: 'device', selector: { kind: 'types', types: [DeviceType.Camera] }, access: ['view'] },
    ]
    const set = resolveViewableDeviceIds(scopes, FLEET, 'view')
    // every camera (5,7,9) + accessories of 5 and 7 (51,52,53,71); light 20 excluded
    expect([...set].sort((a, b) => a - b)).toEqual([5, 7, 9, 51, 52, 53, 71])
  })

  it('locations selector covers devices in the location', () => {
    const scopes: TokenScope[] = [
      {
        type: 'device',
        selector: { kind: 'locations', locations: ['Garden'] },
        access: ['view'],
        includeLinked: false,
      },
    ]
    const set = resolveViewableDeviceIds(scopes, FLEET, 'view')
    expect([...set].sort((a, b) => a - b)).toEqual([7, 20])
  })
})

describe('normalizeTokenScopes — v2 → v3 migration', () => {
  it('migrates a legacy device:targets grant to an ids selector', () => {
    const legacy = [{ type: 'device', targets: ['5', '7'], access: ['view'] }]
    const [scope, ...rest] = normalizeTokenScopes(legacy)
    expect(rest).toHaveLength(0)
    expect(scope).toEqual({
      type: 'device',
      selector: { kind: 'ids', ids: [5, 7] },
      access: ['view'],
    })
  })

  it('passes a v3 selector grant through unchanged', () => {
    const v3 = [
      { type: 'device', selector: { kind: 'types', types: ['camera'] }, access: ['view'] },
    ]
    expect(normalizeTokenScopes(v3)).toEqual(v3)
  })

  it('drops malformed scopes but keeps valid siblings', () => {
    const mixed = [
      { type: 'category', target: 'device', access: ['view'] },
      { type: 'nonsense' },
      { type: 'device', targets: ['9'], access: ['create'] },
    ]
    const out = normalizeTokenScopes(mixed)
    expect(out).toHaveLength(2)
    expect(out[1]).toEqual({
      type: 'device',
      selector: { kind: 'ids', ids: [9] },
      access: ['create'],
    })
  })

  it('returns [] for non-array input', () => {
    expect(normalizeTokenScopes(undefined)).toEqual([])
    expect(normalizeTokenScopes(null)).toEqual([])
    expect(normalizeTokenScopes('nope')).toEqual([])
  })
})

describe('summarizeEffectiveScope — the auth.me contract', () => {
  it('admin is omnipotent', () => {
    const s = summarizeEffectiveScope([], FLEET, true)
    expect(s.isAdmin).toBe(true)
    expect(s.allDevicesViewable).toBe(true)
    expect(s.viewableDeviceCount).toBe(FLEET.length)
  })

  it('a zero-scope non-admin sees nothing', () => {
    const s = summarizeEffectiveScope([], FLEET, false)
    expect(s.isAdmin).toBe(false)
    expect(s.allDevicesViewable).toBe(false)
    expect(s.viewableDeviceCount).toBe(0)
    expect(s.device.view.deviceCount).toBe(0)
  })

  it('reports a type-selector viewer with counts, not id lists', () => {
    const scopes: TokenScope[] = [
      { type: 'device', selector: { kind: 'types', types: [DeviceType.Camera] }, access: ['view'] },
    ]
    const s = summarizeEffectiveScope(scopes, FLEET, false)
    expect(s.allDevicesViewable).toBe(false)
    expect(s.viewableDeviceCount).toBe(7) // 3 cameras + 4 accessories
    expect(s.device.view.deviceCount).toBe(7)
    expect(s.device.create.deviceCount).toBe(0)
  })

  it('surfaces capability and addon grants and category:system access', () => {
    const scopes: TokenScope[] = [
      { type: 'category', target: 'system', access: ['view'] },
      { type: 'capability', target: 'addons', access: ['view', 'create'] },
      { type: 'addon', target: 'homeassistant', access: ['view'] },
    ]
    const s = summarizeEffectiveScope(scopes, FLEET, false)
    expect(s.system).toEqual(['view'])
    expect(s.capabilities).toEqual([{ name: 'addons', access: ['view', 'create'] }])
    expect(s.addons).toEqual([{ name: 'homeassistant', access: ['view'] }])
  })
})
