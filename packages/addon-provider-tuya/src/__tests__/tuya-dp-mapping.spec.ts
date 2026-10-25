import { describe, expect, it } from 'vitest'
import { DeviceType } from '@camstack/types'
import {
  booleanDpPatch,
  classifyTuyaCategory,
  DEFAULT_KETTLE_DP_MAP,
  DEFAULT_KETTLE_TARGET_OPTIONS,
  DEFAULT_SWITCH_DP,
  deviceTypeForKind,
  kettleTargetPatch,
  numberDpPatch,
  readBooleanDp,
  readKettleCurrentTemp,
  readKettleStatus,
  readKettleTargetLabel,
  readNumberDp,
  readStringDp,
  type TuyaKettleDpMap,
} from '../tuya-dp-mapping.js'
import { buildCatalog } from '../tuya-integration-manager.js'
import { buildTuyaCandidates } from '../tuya-discovery.js'
import type { TuyaCatalogEntry } from '../tuya-gateway.js'

/** A fake nodetuya device's `dps` map — the shape `TuyaDevice.get()` returns. */
function fakeDps(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...over }
}

describe('classifyTuyaCategory / deviceTypeForKind', () => {
  it('maps a wall switch (kg) → switch → DeviceType.Switch', () => {
    expect(classifyTuyaCategory('kg')).toBe('switch')
    expect(deviceTypeForKind(classifyTuyaCategory('kg'))).toBe(DeviceType.Switch)
  })

  it('maps a kettle (bh) → kettle → DeviceType.Container', () => {
    expect(classifyTuyaCategory('bh')).toBe('kettle')
    expect(deviceTypeForKind(classifyTuyaCategory('bh'))).toBe(DeviceType.Container)
  })

  it('defaults an unknown / absent category to a raw switch', () => {
    expect(classifyTuyaCategory('mysterious')).toBe('switch')
    expect(classifyTuyaCategory(undefined)).toBe('switch')
  })
})

describe('switch DP mapping (switch cap)', () => {
  it('reads a boolean DP as on/off, tolerating 0/1 numeric form', () => {
    expect(readBooleanDp(fakeDps({ [DEFAULT_SWITCH_DP]: true }), DEFAULT_SWITCH_DP)).toBe(true)
    expect(readBooleanDp(fakeDps({ [DEFAULT_SWITCH_DP]: false }), DEFAULT_SWITCH_DP)).toBe(false)
    expect(readBooleanDp(fakeDps({ [DEFAULT_SWITCH_DP]: 1 }), DEFAULT_SWITCH_DP)).toBe(true)
    expect(readBooleanDp(fakeDps({ [DEFAULT_SWITCH_DP]: 0 }), DEFAULT_SWITCH_DP)).toBe(false)
  })

  it('returns null when the DP is absent (cold start)', () => {
    expect(readBooleanDp(fakeDps(), DEFAULT_SWITCH_DP)).toBeNull()
  })

  it('produces the DP patch a setState writes', () => {
    expect(booleanDpPatch(DEFAULT_SWITCH_DP, true)).toEqual({ '1': true })
    expect(booleanDpPatch('2', false)).toEqual({ '2': false })
  })
})

describe('kettle DP mapping', () => {
  const map: TuyaKettleDpMap = DEFAULT_KETTLE_DP_MAP

  it('reads power + keep-warm booleans off their DPs', () => {
    const dps = fakeDps({ [map.powerDp]: true, [map.keepWarmDp]: false })
    expect(readBooleanDp(dps, map.powerDp)).toBe(true)
    expect(readBooleanDp(dps, map.keepWarmDp)).toBe(false)
  })

  it('reads the current temperature (whole-degree scale)', () => {
    expect(readKettleCurrentTemp(fakeDps({ [map.currentTempDp]: 82 }), map)).toBe(82)
  })

  it('applies the deci-degree scale when configured', () => {
    const deci: TuyaKettleDpMap = { ...map, tempScale: 10 }
    expect(readKettleCurrentTemp(fakeDps({ [deci.currentTempDp]: 825 }), deci)).toBe(82.5)
  })

  it('reads the target-temp setpoint as a select label', () => {
    expect(readKettleTargetLabel(fakeDps({ [map.targetTempDp]: 90 }), map)).toBe('90')
  })

  it('writes the target-temp DP from a select label', () => {
    expect(kettleTargetPatch(map, '100')).toEqual(numberDpPatch(map.targetTempDp, 100))
  })

  it('scales the target-temp patch for deci-degree kettles', () => {
    const deci: TuyaKettleDpMap = { ...map, tempScale: 10 }
    expect(kettleTargetPatch(deci, '80')).toEqual(numberDpPatch(deci.targetTempDp, 800))
  })

  it('rejects a non-numeric target label', () => {
    expect(kettleTargetPatch(map, 'boil')).toBeNull()
  })

  it('reads the work-status enum DP as a raw string', () => {
    expect(readKettleStatus(fakeDps({ [map.statusDp]: 'heating' }), map)).toBe('heating')
    expect(readKettleStatus(fakeDps(), map)).toBeNull()
  })

  it('exposes the localtuya target options', () => {
    expect(DEFAULT_KETTLE_TARGET_OPTIONS).toEqual(['70', '80', '90', '100'])
  })
})

describe('generic DP readers', () => {
  it('readNumberDp only accepts finite numbers', () => {
    expect(readNumberDp(fakeDps({ x: 5 }), 'x')).toBe(5)
    expect(readNumberDp(fakeDps({ x: Number.NaN }), 'x')).toBeNull()
    expect(readNumberDp(fakeDps({ x: 'nope' }), 'x')).toBeNull()
  })

  it('readStringDp coerces a numeric enum to its string form', () => {
    expect(readStringDp(fakeDps({ s: 'warm' }), 's')).toBe('warm')
    expect(readStringDp(fakeDps({ s: 3 }), 's')).toBe('3')
    expect(readStringDp(fakeDps(), 's')).toBeNull()
  })
})

describe('buildCatalog (cloud × LAN discovery merge)', () => {
  it('takes localKey/identity from cloud and fills IP/version from discovery', () => {
    const cloud = [
      { id: 'dev1', name: 'Kettle', localKey: 'key1', category: 'bh', raw: {} },
      { id: 'dev2', name: 'Switch', localKey: 'key2', category: 'kg', ip: '10.0.0.9', raw: {} },
    ]
    const discovered = [
      { id: 'dev1', ip: '10.0.0.5', version: '3.4', raw: {} },
      { id: 'dev3', ip: '10.0.0.7', version: '3.3', raw: {} },
    ]
    const catalog = buildCatalog(cloud, discovered)
    const byId = new Map(catalog.map((e) => [e.deviceId, e]))
    expect(byId.get('dev1')).toMatchObject({ localKey: 'key1', ip: '10.0.0.5', version: '3.4' })
    // cloud IP wins when present; version falls back to blank when neither has it
    expect(byId.get('dev2')).toMatchObject({ localKey: 'key2', ip: '10.0.0.9', version: '' })
    // discovery-only devices are NOT in the catalog (no localKey → uncontrollable)
    expect(byId.has('dev3')).toBe(false)
  })
})

describe('buildTuyaCandidates', () => {
  const entries: TuyaCatalogEntry[] = [
    {
      deviceId: 'dev1',
      name: 'Kitchen kettle',
      localKey: 'k',
      category: 'bh',
      ip: '10.0.0.5',
      version: '3.4',
      online: true,
    },
    {
      deviceId: 'dev2',
      name: 'Hall light',
      localKey: 'k',
      category: 'kg',
      ip: '10.0.0.6',
      version: '3.3',
      online: false,
    },
  ]

  it('produces one candidate per entry with the mapped DeviceType', () => {
    const cands = buildTuyaCandidates({ entries, adopted: new Map() })
    expect(cands).toHaveLength(2)
    const kettle = cands.find((c) => c.childNativeId === 'dev1')
    const light = cands.find((c) => c.childNativeId === 'dev2')
    expect(kettle?.type).toBe(DeviceType.Container)
    expect(kettle?.status).toBe('online')
    expect(light?.type).toBe(DeviceType.Switch)
    expect(light?.status).toBe('offline')
  })

  it('flags already-adopted entries', () => {
    const cands = buildTuyaCandidates({ entries, adopted: new Map([['dev2', 42]]) })
    const light = cands.find((c) => c.childNativeId === 'dev2')
    expect(light?.alreadyAdopted).toBe(true)
    expect(light?.adoptedDeviceId).toBe(42)
  })
})
