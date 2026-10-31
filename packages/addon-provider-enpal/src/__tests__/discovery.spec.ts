import { DeviceType } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  type BuildEnpalCandidatesInput,
  buildEnpalCandidates as buildAllEnpalCandidates,
  ENPAL_BOX_ID,
} from '../enpal-discovery.js'
import { createSnapshot, type EnpalReading } from '../enpal-snapshot.js'

function snapshotOf(...keys: string[]) {
  const readings: EnpalReading[] = keys.map((key) => ({
    key,
    value: 1,
    unit: undefined,
    measurement: undefined,
  }))
  return createSnapshot('influxdb', readings, 1)
}

const FULL = snapshotOf(
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
  it('offers one Container per physical equipment, each with its children', () => {
    const out = buildEnpalCandidates({ snapshot: FULL, adopted: new Map() })
    expect(out.map((c) => [c.childNativeId, c.name, c.type])).toEqual([
      ['pv', 'Photovoltaic', DeviceType.Container],
      ['battery', 'Battery', DeviceType.Container],
      ['grid', 'Grid', DeviceType.Container],
      ['house', 'House', DeviceType.Container],
      ['heatpump', 'Heat pump', DeviceType.Container],
    ])
    const byId = Object.fromEntries(out.map((c) => [c.childNativeId, childIds(c)]))
    expect(byId['pv']).toEqual(['pv#pv', 'pv#inverter-temperature'])
    expect(byId['battery']).toEqual([
      'battery#battery',
      'battery#battery-charged',
      'battery#battery-discharged',
      'battery#battery-temperature',
      'battery#battery-health',
    ])
    expect(byId['grid']).toEqual(['grid#grid-import', 'grid#grid-export'])
    expect(byId['house']).toEqual(['house#house'])
    expect(byId['heatpump']).toEqual([
      'heatpump#heatpump',
      'heatpump#heatpump-hot-water',
      'heatpump#heatpump-outside',
    ])
  })

  it('omits an equipment the box reported nothing for, and a child it reported nothing for', () => {
    const out = buildEnpalCandidates({
      snapshot: snapshotOf('Power.Consumption.Total', 'Energy.Battery.Charge.Level'),
      adopted: new Map(),
    })
    expect(out.map((c) => c.childNativeId)).toEqual(['battery', 'house'])
    expect(childIds(out[0]!)).toEqual(['battery#battery'])
  })

  it('offers no equipment while the box has no snapshot', () => {
    expect(buildEnpalCandidates({ snapshot: null, adopted: new Map() })).toEqual([])
  })

  it('flags an adopted container with its device id', () => {
    const out = buildEnpalCandidates({
      snapshot: FULL,
      adopted: new Map([['grid', 42]]),
    })
    const grid = out.find((c) => c.childNativeId === 'grid')
    expect(grid?.alreadyAdopted).toBe(true)
    expect(grid?.adoptedDeviceId).toBe(42)
    expect(out.find((c) => c.childNativeId === 'pv')?.alreadyAdopted).toBe(false)
  })

  it('children are Sensors carrying the caps their spec registers', () => {
    const out = buildEnpalCandidates({ snapshot: FULL, adopted: new Map() })
    const battery = out.find((c) => c.childNativeId === 'battery')
    const soc = battery?.children?.find((c) => c.childNativeId === 'battery#battery')
    expect(soc?.type).toBe(DeviceType.Sensor)
    expect(soc?.capabilities).toEqual(['battery', 'power-meter'])
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

  it('is a sibling of the equipment: no children, and no candidate nests it', () => {
    const out = buildAllEnpalCandidates({ box: BOX, snapshot: FULL, adopted: new Map() })
    const box = out.find((c) => c.type === DeviceType.Gateway)
    expect(box?.children).toBeUndefined()
    expect(out.flatMap((c) => c.children ?? []).some((c) => c.childNativeId === ENPAL_BOX_ID)).toBe(
      false,
    )
    expect(out.filter((c) => c.type === DeviceType.Container)).toHaveLength(5)
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
