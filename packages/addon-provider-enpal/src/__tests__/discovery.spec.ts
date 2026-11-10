import { DeviceType } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  type BuildEnpalCandidatesInput,
  buildEnpalCandidates as buildAllEnpalCandidates,
  ENPAL_BOX_ID,
} from '../enpal-discovery.js'
import { createSnapshot, type EnpalReading } from '../enpal-snapshot.js'

function snapshotOf(...keys: string[]) {
  return snapshotWithTexts(keys, [])
}

function snapshotWithTexts(keys: readonly string[], textKeys: readonly string[]) {
  const readings: EnpalReading[] = keys.map((key) => ({
    key,
    value: 1,
    unit: undefined,
    measurement: undefined,
  }))
  return createSnapshot(
    'blazor',
    readings,
    1,
    undefined,
    textKeys.map((key) => ({ key, value: 'On' })),
  )
}

const FULL = snapshotWithTexts(
  [
    'Power.DC.Total',
    'Energy.Production.Total.Lifetime',
    'Temperature.Housing.Inside',
    'Energy.Battery.Charge.Level',
    'Power.Battery.Charge.Discharge',
    'Voltage.Battery',
    'Current.Battery',
    'Energy.Battery.Charge.Lifetime',
    'Energy.Battery.Discharge.Lifetime',
    'Temperature.Battery',
    'Battery.SOH',
    'Grid.Import.Power.Total.Calculated',
    'Energy.Grid.Import.Lifetime',
    'Power.Grid.Export',
    'Energy.Grid.Export.Lifetime',
    'Power.Consumption.Total',
    'Energy.Consumption.Total.Lifetime',
    'Heatpump.Power.Consumption.Total',
    'Heatpump.Energy.Consumption.Total.Lifetime',
    'Heatpump.DomesticHotWater.Temperature',
    'Heatpump.Outside.Temperature',
    'Cpu.Load',
  ],
  ['IoT.MainState', 'Inverter.System.State', 'Heatpump.Local.ConnectionState'],
)

const BOX = { name: 'Enpal box', online: true } as const

/** The equipment candidates only: the box's own Gateway candidate is covered below. */
function buildEnpalCandidates(input: Omit<BuildEnpalCandidatesInput, 'box'>) {
  return buildAllEnpalCandidates({ box: BOX, ...input }).filter(
    (c) => c.type !== DeviceType.Gateway,
  )
}

const childIds = (c: { children?: readonly { childNativeId: string }[] }): string[] =>
  (c.children ?? []).map((x) => x.childNativeId)

describe('Enpal discovery: containers per equipment', () => {
  it('offers the installation and the heat pump as two Containers, System and Heat pump (Enpal)', () => {
    const out = buildEnpalCandidates({ snapshot: FULL, adopted: new Map() })
    expect(out.map((c) => [c.childNativeId, c.name, c.type])).toEqual([
      ['impianto', 'System', DeviceType.Container],
      ['heatpump', 'Heat pump (Enpal)', DeviceType.Container],
    ])
    const byId = Object.fromEntries(out.map((c) => [c.childNativeId, childIds(c)]))
    expect(byId['impianto']).toEqual(
      expect.arrayContaining([
        'impianto#pv',
        'impianto#battery',
        'impianto#grid-import',
        'impianto#house',
        'impianto#inverter-temperature',
        'impianto#inverter-state',
      ]),
    )
    expect(byId['heatpump']).toEqual([
      'heatpump#heatpump',
      'heatpump#heatpump-hot-water',
      'heatpump#heatpump-outside',
      'heatpump#heatpump-connection',
    ])
  })

  it('omits an equipment the box reported nothing for, and a child it reported nothing for', () => {
    const out = buildEnpalCandidates({
      snapshot: snapshotOf('Power.Consumption.Total', 'Energy.Battery.Charge.Level'),
      adopted: new Map(),
    })
    expect(out.map((c) => c.childNativeId)).toEqual(['impianto'])
    expect(childIds(out[0]!)).toEqual(['impianto#battery', 'impianto#house'])
  })

  it('a text-only reading (a state label) is enough to offer its equipment', () => {
    const out = buildEnpalCandidates({
      snapshot: snapshotWithTexts([], ['Heatpump.Local.ConnectionState']),
      adopted: new Map(),
    })
    expect(out.map((c) => c.childNativeId)).toEqual(['heatpump'])
  })

  it('offers no equipment while the box has no snapshot', () => {
    expect(buildEnpalCandidates({ snapshot: null, adopted: new Map() })).toEqual([])
  })

  it('flags an adopted container with its device id', () => {
    const out = buildEnpalCandidates({
      snapshot: FULL,
      adopted: new Map([['impianto', 42]]),
    })
    const impianto = out.find((c) => c.childNativeId === 'impianto')
    expect(impianto?.alreadyAdopted).toBe(true)
    expect(impianto?.adoptedDeviceId).toBe(42)
    expect(out.find((c) => c.childNativeId === 'heatpump')?.alreadyAdopted).toBe(false)
  })

  it('children are Sensors carrying the caps their spec registers', () => {
    const out = buildEnpalCandidates({ snapshot: FULL, adopted: new Map() })
    const impianto = out.find((c) => c.childNativeId === 'impianto')
    const child = (id: string) => impianto?.children?.find((c) => c.childNativeId === id)
    expect(child('impianto#battery')?.type).toBe(DeviceType.Sensor)
    expect(child('impianto#battery')?.capabilities).toEqual(['battery', 'power-meter'])
    expect(child('impianto#inverter-state')?.capabilities).toEqual(['enum-sensor'])
  })
})

describe('Enpal discovery: the box as a Gateway', () => {
  it('lists the box first, typed Gateway, with the admin link and no other action', () => {
    const [box] = buildAllEnpalCandidates({ box: BOX, snapshot: FULL, adopted: new Map() })
    expect(box).toMatchObject({
      childNativeId: ENPAL_BOX_ID,
      name: 'Enpal box',
      type: DeviceType.Gateway,
      status: 'online',
      alreadyAdopted: false,
    })
    expect(box?.capabilities).toEqual(['device-admin-link'])
  })

  it('carries the box diagnostics as its children, and no candidate nests it', () => {
    const out = buildAllEnpalCandidates({ box: BOX, snapshot: FULL, adopted: new Map() })
    const box = out.find((c) => c.type === DeviceType.Gateway)
    expect(childIds(box ?? {})).toEqual([
      `${ENPAL_BOX_ID}#box-main-state`,
      `${ENPAL_BOX_ID}#box-cpu-load`,
    ])
    expect(box?.children?.every((c) => c.type === DeviceType.Sensor)).toBe(true)
    expect(out.flatMap((c) => c.children ?? []).some((c) => c.childNativeId === ENPAL_BOX_ID)).toBe(
      false,
    )
    expect(out.filter((c) => c.type === DeviceType.Container)).toHaveLength(2)
  })

  it('is still offered, offline, while the box has no snapshot', () => {
    const out = buildAllEnpalCandidates({
      box: { name: 'Enpal box', online: false },
      snapshot: null,
      adopted: new Map(),
    })
    expect(out.map((c) => [c.childNativeId, c.type, c.status])).toEqual([
      [ENPAL_BOX_ID, DeviceType.Gateway, 'offline'],
    ])
  })

  it('flags an adopted box with its device id', () => {
    const [box] = buildAllEnpalCandidates({
      box: BOX,
      snapshot: FULL,
      adopted: new Map([[ENPAL_BOX_ID, 9]]),
    })
    expect(box?.alreadyAdopted).toBe(true)
    expect(box?.adoptedDeviceId).toBe(9)
  })
})
