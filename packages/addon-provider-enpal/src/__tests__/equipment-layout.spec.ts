import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DeviceType, resolveContainerPrimaryChild } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { blazorRowsToReadings, blazorRowsToTexts, BlazorRowsSchema } from '../enpal-blazor.js'
import {
  availableSpecs,
  computeSlices,
  ENPAL_SPECS,
  findSpec,
  keysOfSpec,
  type EnpalSpec,
} from '../enpal-catalog.js'
import {
  accessoryChildSpecs,
  childLayoutOf,
  ENPAL_EQUIPMENT,
  findEquipment,
  metadataOf,
  primaryChildPreferenceOf,
  type EnpalEquipment,
} from '../enpal-equipment.js'
import { ENPAL_BOX_ID } from '../enpal-discovery.js'
import { createSnapshot, type EnpalSnapshot } from '../enpal-snapshot.js'

const rows = BlazorRowsSchema.parse(
  JSON.parse(readFileSync(join(__dirname, 'fixtures', 'blazor-rows.json'), 'utf8')),
)
const real = createSnapshot(
  'blazor',
  blazorRowsToReadings(rows),
  1_000,
  undefined,
  blazorRowsToTexts(rows),
)

function equipmentOf(id: string): EnpalEquipment {
  const found = findEquipment(id)
  if (found === undefined) throw new Error(`no equipment ${id}`)
  return found
}

/**
 * Every child of an equipment that reads a box key. A key can feed a live composite (the battery
 * level reads the capacity) and also have its own diagnostic child.
 */
function placementsOf(equipmentId: string, key: string) {
  const found = []
  for (const child of equipmentOf(equipmentId).children) {
    const spec = findSpec(child.specId)
    if (spec !== undefined && keysOfSpec(spec).includes(key)) found.push({ child, spec })
  }
  return found
}

function placementOf(equipmentId: string, key: string) {
  return placementsOf(equipmentId, key)[0]
}

type Row = readonly [section: string, kind: 'S' | 'D', keys: readonly string[]]

const BOX: readonly Row[] = [
  ['Box', 'D', ['IoT.MainState', 'Cpu.Load', 'Memory.Usage', 'HW.Cronny.Result']],
  ['EEBUS', 'D', ['Eebus.ConnectionState', 'Eebus.DiscoveryState', 'Eebus.CertExpiry']],
  [
    'Connectivity',
    'D',
    [
      'LTE.State',
      'LTE.Connection.Type',
      'LTE.Quality',
      'LTE.RSRP',
      'LTE.RSRQ',
      'LTE.RSSI',
      'LTE.SNR',
      'LTE.Failover.Result',
      'LTE.Cronny.Result',
      'WiFi.State',
      'IoT.Data.Consumption.Lan.Down.Month',
      'IoT.Data.Consumption.Lan.Up.Month',
      'IoT.Data.Consumption.Lte.Down.Month',
      'IoT.Data.Consumption.Lte.Up.Month',
    ],
  ],
]

const IMPIANTO: readonly Row[] = [
  [
    'Photovoltaic',
    'S',
    [
      'Power.DC.Total',
      'Power.DC.String.1',
      'Power.DC.String.2',
      'Energy.Production.Total.Day',
      'Energy.Production.Total.Lifetime',
    ],
  ],
  [
    'Photovoltaic',
    'D',
    ['Voltage.String.1', 'Voltage.String.2', 'Current.String.1', 'Current.String.2'],
  ],
  [
    'Battery',
    'S',
    [
      'Energy.Battery.Charge.Level',
      'Energy.Battery.Charge.Load',
      'Power.Battery.Charge.Discharge',
      'Temperature.Battery',
      'Energy.Battery.Charge.Day',
      'Energy.Battery.Discharge.Day',
      'Energy.Battery.Charge.Lifetime',
      'Energy.Battery.Discharge.Lifetime',
    ],
  ],
  [
    'Battery',
    'D',
    [
      'Battery.SOH',
      'Energy.Battery.Capacity',
      'Battery.Power.Rating.Maximum',
      'Battery.ChargeLevel.Max',
      'Battery.ChargeLevel.Min',
      'Power.Battery.Charge.Discharge.Set',
      'Power.Battery.Charge.Max',
      'Power.Battery.Discharge.Max',
      'Current.Battery.Charge.Max',
      'Current.Battery.Discharge.Max',
    ],
  ],
  [
    'Grid',
    'S',
    [
      'Power.Grid.Export',
      'Power.AC.Phase.A',
      'Power.AC.Phase.B',
      'Power.AC.Phase.C',
      'Energy.Grid.Import.Day',
      'Energy.Grid.Export.Day',
      'Energy.Grid.Import.Lifetime',
      'Energy.Grid.Export.Lifetime',
    ],
  ],
  [
    'Grid',
    'D',
    [
      'Voltage.Phase.A',
      'Voltage.Phase.B',
      'Voltage.Phase.C',
      'Frequency.Grid',
      'Power.Grid.Maximum.Feed',
    ],
  ],
  [
    'Home',
    'S',
    [
      'Power.Consumption.Total',
      'Energy.Consumption.Total.Day',
      'Energy.Consumption.Total.Lifetime',
    ],
  ],
  ['Inverter', 'S', ['Inverter.System.State', 'Command.EMS.Mode', 'Power.Inverter.AC.Export']],
  [
    'Inverter',
    'D',
    [
      'Command.Start.Stop',
      'Mode.Forcible.Charge.Discharge',
      'Temperature.Housing.Inside',
      'Inverter.Power.Rating.Maximum',
      'Type.Phase.Inverter',
      'Inverter.Modbus.Health.Rtu.Status',
      'Inverter.Modbus.Health.Tcp.Status',
    ],
  ],
]

const HEATPUMP: readonly Row[] = [
  [
    '',
    'S',
    [
      'Heatpump.Power.Consumption.Total',
      'Heatpump.Energy.Consumption.Total.Lifetime',
      'Heatpump.Outside.Temperature',
      'Heatpump.DomesticHotWater.Temperature',
      'Heatpump.DomesticHotWater.1.Mode',
      'Heatpump.HeatingCircuit.1.Mode',
      'Heatpump.Generator.State.Running',
      'Heatpump.ElectricHeater.State.Running',
    ],
  ],
  [
    '',
    'D',
    [
      'Heatpump.EnergyManagement.State',
      'Heatpump.Power.Desired.Enabled',
      'Heatpump.Settings.PvOptimizationStatus',
      'Heatpump.Generator.Power.Min',
      'Heatpump.Generator.Power.Max',
      'Heatpump.Local.ConnectionState',
    ],
  ],
]

/**
 * Two diagnostics the battery child already carries on its power-meter cap (voltage, current),
 * next to the charge level: they are listed as diagnostics but are not a child of their own.
 */
const CARRIED_BY_BATTERY = ['Voltage.Battery', 'Current.Battery']

function everyKeyIsPlaced(equipmentId: string, table: readonly Row[]): void {
  for (const [section, kind, keys] of table) {
    for (const key of keys) {
      it(`${equipmentId}: ${key} is in ${section === '' ? 'the list' : section} (${kind})`, () => {
        const placed = placementsOf(equipmentId, key).filter(
          (p) => p.child.diagnostic === (kind === 'D'),
        )
        expect(placed.length, `no ${kind} child of ${equipmentId} reads ${key}`).toBeGreaterThan(0)
        expect(placed.map((p) => p.child.section ?? '')).toContain(section)
      })
    }
  }
}

describe('Enpal Box: the Gateway carries the box diagnostics', () => {
  everyKeyIsPlaced(ENPAL_BOX_ID, BOX)
  it('is the gateway, named Enpal Box', () => {
    expect(equipmentOf(ENPAL_BOX_ID).kind).toBe('gateway')
    expect(equipmentOf(ENPAL_BOX_ID).name).toBe('Enpal Box')
  })
  it('has exactly the sections Box, EEBUS and Connectivity', () => {
    const layout = childLayoutOf(equipmentOf(ENPAL_BOX_ID), equipmentOf(ENPAL_BOX_ID).specIds)
    expect([...new Set(layout.map((e) => e.section))]).toEqual(['Box', 'EEBUS', 'Connectivity'])
  })
})

describe('System container', () => {
  everyKeyIsPlaced('impianto', IMPIANTO)
  it('is a container named System', () => {
    expect(equipmentOf('impianto').kind).toBe('container')
    expect(equipmentOf('impianto').name).toBe('System')
  })
  it('carries battery voltage and current on the battery child, which is not hidden', () => {
    for (const key of CARRIED_BY_BATTERY) {
      const placed = placementOf('impianto', key)
      expect(placed?.spec.id).toBe('battery')
      expect(placed?.child.section).toBe('Battery')
    }
  })
  it('has exactly the sections Photovoltaic, Battery, Grid, Home and Inverter', () => {
    const layout = childLayoutOf(equipmentOf('impianto'), equipmentOf('impianto').specIds)
    expect([...new Set(layout.map((e) => e.section))]).toEqual([
      'Photovoltaic',
      'Battery',
      'Grid',
      'Home',
      'Inverter',
    ])
  })
})

describe('Heat pump container', () => {
  everyKeyIsPlaced('heatpump', HEATPUMP)
  it('is a container named Heat pump (Enpal)', () => {
    expect(equipmentOf('heatpump').kind).toBe('container')
    expect(equipmentOf('heatpump').name).toBe('Heat pump (Enpal)')
  })
  it('has no accordion sections', () => {
    const heatpump = equipmentOf('heatpump')
    expect(childLayoutOf(heatpump, heatpump.specIds)).toEqual([])
  })
  it('is offered only when the box reports a heat-pump key', () => {
    const without = createSnapshot(
      'blazor',
      blazorRowsToReadings(rows.filter((r) => !r.key.startsWith('Heatpump.'))),
      1,
      undefined,
      blazorRowsToTexts(rows.filter((r) => !r.key.startsWith('Heatpump.'))),
    )
    const offered = (snapshot: EnpalSnapshot): boolean =>
      availableSpecs(snapshot).some((s) => equipmentOf('heatpump').specIds.includes(s.id))
    expect(offered(real)).toBe(true)
    expect(offered(without)).toBe(false)
  })
})

describe('keys the catalog must not expose', () => {
  const EXACT = [
    'Power.Consumption.AC',
    'Power.AC.Max',
    'V1.1.7',
    'Inverter.Running.State',
    'WiFi.Reason',
    'WiFi.Cronny.Result',
  ]
  const PREFIXES = ['IoT.NetTraffic.', 'LTE.CellularGuard.', 'LTE.Predictor.']
  const readBy = (matches: (key: string) => boolean): string[] =>
    ENPAL_SPECS.filter((spec) => keysOfSpec(spec).some(matches)).map((s) => s.id)
  const metadataKeys = ENPAL_EQUIPMENT.flatMap((e) => e.metadata.map((m) => m.key))

  for (const key of EXACT) {
    it(`no sensor and no attribute reads ${key}`, () => {
      expect(readBy((k) => k === key)).toEqual([])
      expect(metadataKeys).not.toContain(key)
    })
  }
  for (const prefix of PREFIXES) {
    it(`no sensor and no attribute reads ${prefix}*`, () => {
      expect(readBy((k) => k.startsWith(prefix))).toEqual([])
      expect(metadataKeys.filter((k) => k.startsWith(prefix))).toEqual([])
    })
  }
})

describe('identity facts are attributes, never sensors', () => {
  const EXPECTED: Readonly<Record<string, readonly string[]>> = {
    [ENPAL_BOX_ID]: [
      'Device.Name',
      'IoTEdgeDevice.Device.Type',
      'IoTEdgeDevice.SerialNumber',
      'Generation.HW',
      'Generation.SW',
      'Eebus.Ski',
      'LTE.Modem.Type',
      'LTE.Modem.Firmware.Version',
    ],
    impianto: [
      'Code.Device.Type',
      'SoftwareVersion.Service.1',
      'SoftwareVersion.Service.2',
      'Dongle.SerialNumber',
      'SerialNumber.Battery',
      'SoftwareVersion.Service.Battery.Unit.1',
    ],
    heatpump: [
      'Heatpump.IndoorUnit.DeviceType',
      'Heatpump.SerialNumber',
      'Heatpump.IndoorUnit.SerialNumber',
      'Heatpump.SoftwareVersion',
      'Heatpump.IndoorUnit.SoftwareVersion',
      'Heatpump.Gateway.Device.Type',
      'Heatpump.Gateway.SerialNumber',
      'Heatpump.Gateway.SoftwareVersion',
    ],
  }
  for (const [id, keys] of Object.entries(EXPECTED)) {
    it(`${id} carries exactly its identity keys as attributes, and no sensor reads them`, () => {
      expect(equipmentOf(id).metadata.map((m) => m.key)).toEqual(keys)
      for (const key of keys) {
        expect(ENPAL_SPECS.filter((s) => keysOfSpec(s).includes(key)).map((s) => s.id)).toEqual([])
      }
    })
  }

  it('reads the attributes from the real capture, digits and all', () => {
    const attributes = metadataOf(equipmentOf('impianto'), real)
    expect(attributes['model']).toBe('SH12T-ENP')
    expect(attributes['firmware']).toBe('PEARL-H_B001.V001.P040')
    expect(attributes['batteryFirmware']).toBe('SBHBCU-S_22011.04.09')
    expect(metadataOf(equipmentOf('heatpump'), real)['model']).toBe('Compress CS5800iAW 12 MB')
  })

  it('keeps a numeric-looking serial as the text the box sent', () => {
    const snapshot = createSnapshot(
      'blazor',
      [],
      1,
      undefined,
      blazorRowsToTexts([
        {
          key: 'Heatpump.SerialNumber',
          value: '0012345678',
          unit: null,
          timestamp: null,
        },
      ]),
    )
    expect(metadataOf(equipmentOf('heatpump'), snapshot)['serialNumber']).toBe('0012345678')
  })

  it('drops empty and markup text rows', () => {
    const texts = blazorRowsToTexts([
      { key: 'V1.1.7', value: '', unit: null, timestamp: null },
      {
        key: 'Inverter.Running.State',
        value: '<ul><li>Decimal: 11</li></ul>',
        unit: null,
        timestamp: null,
      },
      { key: 'LTE.State', value: 'connected', unit: null, timestamp: null },
    ])
    expect(texts).toEqual([{ key: 'LTE.State', value: 'connected' }])
  })
})

describe('diagnostics are hidden, history untouched', () => {
  it('a diagnostic child is hidden by default and a live one is not', () => {
    const specs = accessoryChildSpecs({
      equipment: 'impianto',
      specIds: ['pv', 'pv-string-1-voltage'],
      integrationId: 'int-1',
    })
    const hidden = Object.fromEntries(specs.map((s) => [s.stableIdSuffix, s.meta.display?.hidden]))
    expect(hidden).toEqual({ pv: undefined, 'pv-string-1-voltage': true })
  })

  it('every child of the Enpal Box is a diagnostic', () => {
    expect(equipmentOf(ENPAL_BOX_ID).children.every((c) => c.diagnostic)).toBe(true)
  })
})

describe('child layout', () => {
  it('names each adopted child by its stable suffix, in catalog order, and skips the rest', () => {
    const layout = childLayoutOf(equipmentOf('impianto'), ['battery-health', 'pv', 'house'])
    expect(layout.map((e) => [e.childKey, e.section])).toEqual([
      ['pv', 'Photovoltaic'],
      ['battery-health', 'Battery'],
      ['house', 'Home'],
    ])
    const orders = layout.map((e) => e.order ?? -1)
    expect(orders).toEqual([...orders].sort((a, b) => a - b))
  })
})

describe('the primary child: a declared preference, the first adopted one wins', () => {
  it('System prefers its Energy system, then PV power, the battery level, the home consumption', () => {
    expect(
      primaryChildPreferenceOf(equipmentOf('impianto'), equipmentOf('impianto').specIds),
    ).toEqual(['energy-system', 'pv', 'battery', 'house'])
  })

  it('Heat pump prefers its power, then the hot water, then the outside temperature', () => {
    expect(
      primaryChildPreferenceOf(equipmentOf('heatpump'), equipmentOf('heatpump').specIds),
    ).toEqual(['heatpump', 'heatpump-hot-water', 'heatpump-outside'])
  })

  it('declares only the children that were adopted', () => {
    expect(primaryChildPreferenceOf(equipmentOf('impianto'), ['house', 'battery'])).toEqual([
      'energy-system',
      'battery',
      'house',
    ])
  })

  it('the gateway and an older container declare nothing', () => {
    expect(
      primaryChildPreferenceOf(equipmentOf(ENPAL_BOX_ID), equipmentOf(ENPAL_BOX_ID).specIds),
    ).toEqual([])
    expect(primaryChildPreferenceOf(findEquipment('pv'), ['pv'])).toEqual([])
  })

  it('names no sensor in the rule: a candidate is a catalog entry of any kind', () => {
    const kinds = new Set(
      ENPAL_EQUIPMENT.flatMap((e) => e.primaryChildPreference).map((id) => findSpec(id)?.kind),
    )
    expect(kinds).toEqual(new Set(['power-meter', 'battery', 'numeric']))
  })

  it('the framework resolves the Energy system whatever order the children come back in', () => {
    const parentStableId = 'enpal-system'
    const specIds = equipmentOf('impianto').specIds
    const children = accessoryChildSpecs({
      equipment: 'impianto',
      specIds,
      integrationId: 'i',
    }).map((spec, index) => ({
      id: index + 1,
      stableId: `${parentStableId}-${spec.stableIdSuffix}`,
      type: spec.meta.type,
      ...(spec.meta.role !== undefined ? { role: spec.meta.role } : {}),
      name: spec.meta.name,
    }))
    const preference = {
      parentStableId,
      childKeys: primaryChildPreferenceOf(equipmentOf('impianto'), specIds),
    }
    for (const order of [children, [...children].reverse()]) {
      const primary = resolveContainerPrimaryChild(
        order,
        undefined,
        'System',
        DeviceType.Container,
        preference,
      )
      expect(primary?.stableId).toBe(`${parentStableId}-energy-system`)
    }
  })
})

describe('every catalog entry resolves against the real capture', () => {
  const available = availableSpecs(real)
  const slicesOf = (spec: EnpalSpec) =>
    computeSlices(spec, real, { invertBatteryPower: false }, 1_000)

  it('offers every entry of the three containers', () => {
    const ids = new Set(available.map((s) => s.id))
    const missing = ENPAL_SPECS.filter((s) => !ids.has(s.id)).map((s) => s.id)
    expect(missing).toEqual([])
  })

  it('reads no numeric entry as null, and refuses no unit', () => {
    for (const spec of ENPAL_SPECS) {
      const slices = slicesOf(spec)
      expect(slices.refusals, spec.id).toEqual([])
      if (slices.numeric !== undefined) expect(slices.numeric.value, spec.id).not.toBeNull()
      if (slices.meter !== undefined) expect(slices.meter.value, spec.id).not.toBeNull()
    }
  })

  it('keeps a label as the box delivered it', () => {
    expect(slicesOf(spec('inverter-state')).text?.value).toBe('Running (0)')
    expect(slicesOf(spec('inverter-ems-mode')).text?.value).toBe(
      'Self-consumption mode (Default) (0)',
    )
  })

  it('marks a certificate expiry as a clock, not a state', () => {
    expect(slicesOf(spec('eebus-cert-expiry')).text).toMatchObject({
      value: '2036-03-13T05:23:24Z',
      timestamp: true,
    })
  })

  it('takes the grid frequency in Hz as the number it is', () => {
    expect(slicesOf(spec('grid-frequency')).numeric?.value).toBe(49.9)
  })

  it('takes the LTE levels as the numbers the box sent', () => {
    expect(slicesOf(spec('lte-rsrp')).numeric?.value).toBe(-105)
    expect(slicesOf(spec('lte-snr')).numeric?.value).toBe(8)
  })

  it('a text the box did not send leaves the slice out instead of inventing a state', () => {
    const without = createSnapshot('blazor', [], 1)
    expect(
      computeSlices(spec('inverter-state'), without, { invertBatteryPower: false }, 1).text,
    ).toBe(undefined)
  })
})

function spec(id: string): EnpalSpec {
  const found = findSpec(id)
  if (found === undefined) throw new Error(`no spec ${id}`)
  return found
}

describe('the unit a numeric reading shows', () => {
  const quantityOf = (id: string): string | undefined => {
    const found = spec(id)
    return found.kind === 'numeric' ? found.quantity : undefined
  }

  it.each([
    ['box-cpu-load', 'percentage'],
    ['box-memory-usage', 'percentage'],
    ['lte-quality', 'percentage'],
    ['battery-health', 'percentage'],
    ['battery-level-max', 'percentage'],
    ['battery-level-min', 'percentage'],
    ['grid-frequency', 'frequency'],
    ['lte-rsrp', 'signal-level'],
    ['lte-rsrq', 'signal-ratio'],
    ['lte-snr', 'signal-ratio'],
  ])('%s is stored as %s, so the row writes its unit', (id, quantity) => {
    expect(quantityOf(id)).toBe(quantity)
  })

  it('reads the grid frequency in hertz without refusing it', () => {
    const found = spec('grid-frequency')
    const out = computeSlices(
      found,
      createSnapshot(
        'influxdb',
        [{ key: 'Frequency.Grid', value: 49.9, unit: 'Hz', measurement: undefined }],
        1,
      ),
      { invertBatteryPower: false },
      1,
    )
    expect(out.numeric?.value).toBe(49.9)
    expect(out.refusals).toEqual([])
  })
})
