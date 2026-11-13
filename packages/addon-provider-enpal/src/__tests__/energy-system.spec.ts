/**
 * The Energy system device of an Enpal System (#513): one `energy-system` slice
 * filled from the readings the box already sends. A part the box does not
 * report is null, a value it does not report is null — never 0 (D393). The
 * storage is a field of the model, never the `battery` cap (#522).
 */
import {
  type DeviceContext,
  DeviceType,
  type EnergySystemStatus,
  energySystemSelfConsumptionPct,
  type IDeviceRuntimeState,
  type IScopedLogger,
} from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { EnpalEnergySystemDevice } from '../devices/enpal-energy-system-device.js'
import {
  computeEnergySystemStatus,
  EnergySystemCounterGuards,
  ENERGY_SYSTEM_CHILD_KEY,
} from '../enpal-energy-system.js'
import { accessoryChildSpecs, findEquipment, primaryChildPreferenceOf } from '../enpal-equipment.js'
import { createSnapshot, type EnpalSnapshot } from '../enpal-snapshot.js'

const quiet: IScopedLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => quiet,
  withTags: () => quiet,
}

type Row = readonly [string, number, string | undefined]

function snapshotOf(rows: readonly Row[]): EnpalSnapshot {
  return createSnapshot(
    'influxdb',
    rows.map(([key, value, unit]) => ({ key, value, unit, measurement: undefined })),
    1_000,
  )
}

const FULL: readonly Row[] = [
  ['Power.DC.Total', 4200, 'W'],
  ['Energy.Production.Total.Lifetime', 12000, 'kWh'],
  ['Energy.Production.Total.Day', 18.4, 'kWh'],
  ['Power.Grid.Export', 1500, 'W'],
  ['Energy.Grid.Import.Lifetime', 3000, 'kWh'],
  ['Energy.Grid.Export.Lifetime', 5000, 'kWh'],
  ['Energy.Grid.Import.Day', 2.1, 'kWh'],
  ['Energy.Grid.Export.Day', 7.3, 'kWh'],
  ['Power.Consumption.Total', 900, 'W'],
  ['Energy.Consumption.Total.Lifetime', 8000, 'kWh'],
  ['Energy.Consumption.Total.Day', 11.2, 'kWh'],
  ['Heatpump.Power.Consumption.Total', 600, 'W'],
  ['Heatpump.Energy.Consumption.Total.Lifetime', 1500, 'kWh'],
  ['Energy.Battery.Charge.Level', 74, '%'],
  ['Power.Battery.Charge.Discharge', 1800, 'W'],
  ['Energy.Battery.Charge.Load', 7.4, 'kWh'],
  ['Energy.Battery.Capacity', 10, 'kWh'],
  ['Energy.Battery.Charge.Lifetime', 2500, 'kWh'],
  ['Energy.Battery.Discharge.Lifetime', 2300, 'kWh'],
  ['Energy.Battery.Charge.Day', 6.1, 'kWh'],
  ['Energy.Battery.Discharge.Day', 4.2, 'kWh'],
]

const PLAIN = { invertBatteryPower: false }

function status(rows: readonly Row[], invert = false): EnergySystemStatus {
  return computeEnergySystemStatus(snapshotOf(rows), { invertBatteryPower: invert }, 5_000).status
}

describe('computeEnergySystemStatus', () => {
  it('fills every part from the readings the box sends', () => {
    expect(status(FULL)).toEqual({
      solar: { powerW: 4200, energyKwh: 12000, todayKwh: 18.4 },
      grid: {
        powerW: -1500,
        importKwh: 3000,
        exportKwh: 5000,
        importTodayKwh: 2.1,
        exportTodayKwh: 7.3,
      },
      house: { powerW: 900, energyKwh: 8000, todayKwh: 11.2 },
      heatPump: { powerW: 600, energyKwh: 1500, todayKwh: null },
      storage: {
        stateOfChargePct: 74,
        storedKwh: 7.4,
        capacityKwh: 10,
        powerW: 1800,
        chargedKwh: 2500,
        dischargedKwh: 2300,
        chargedTodayKwh: 6.1,
        dischargedTodayKwh: 4.2,
      },
      lastFetchedAt: 5_000,
    })
  })

  it('a box without a heat pump or a storage has neither part, not zeros', () => {
    const rows = FULL.filter(([key]) => !key.startsWith('Heatpump.') && !key.includes('Battery'))
    const s = status(rows)
    expect(s.heatPump).toBeNull()
    expect(s.storage).toBeNull()
    expect(s.solar?.powerW).toBe(4200)
  })

  it('an unreported value inside a part is null', () => {
    const rows = FULL.filter(([key]) => key !== 'Energy.Production.Total.Day')
    expect(status(rows).solar).toEqual({ powerW: 4200, energyKwh: 12000, todayKwh: null })
  })

  it('the storage power is + charging, and the invert setting flips it', () => {
    expect(status(FULL).storage?.powerW).toBe(1800)
    expect(status(FULL, true).storage?.powerW).toBe(-1800)
  })

  it('the grid is + importing when the signed export reading is negative', () => {
    const rows: readonly Row[] = [['Power.Grid.Export', -700, 'W']]
    expect(status(rows).grid?.powerW).toBe(700)
  })

  it('an import-only reading gives the grid power only while it imports', () => {
    expect(status([['Grid.Import.Power.Total.Calculated', 320, 'W']]).grid?.powerW).toBe(320)
    // 0 import with no export reading: importing nothing, exporting unknown — not "still",
    // and with no other grid value the part is unknown as a whole.
    expect(status([['Grid.Import.Power.Total.Calculated', 0, 'W']]).grid).toBeNull()
  })

  it('today’s self-consumption derives from the produced and exported totals', () => {
    const pct = energySystemSelfConsumptionPct(status(FULL))
    expect(pct).toBeCloseTo(((18.4 - 7.3) / 18.4) * 100, 5)
  })
})

describe('EnergySystemCounterGuards', () => {
  it('holds a lifetime counter that drops for one poll, and keeps the gauges as read', () => {
    const guards = new EnergySystemCounterGuards()
    const first = guards.apply(status(FULL))
    expect(first.solar?.energyKwh).toBe(12000)
    const dropped = FULL.map(
      ([key, value, unit]): Row =>
        key === 'Energy.Production.Total.Lifetime'
          ? [key, 0, unit]
          : key === 'Power.DC.Total'
            ? [key, 10, unit]
            : [key, value, unit],
    )
    const second = guards.apply(status(dropped))
    expect(second.solar?.energyKwh).toBe(12000)
    expect(second.solar?.powerW).toBe(10)
  })
})

describe('the Energy system child of the System container', () => {
  const SYSTEM = findEquipment('impianto')

  it('is spawned under the System, whatever children it was adopted with', () => {
    const children = accessoryChildSpecs({
      equipment: 'impianto',
      specIds: ['pv'],
      integrationId: 'int-1',
    })
    const child = children.find((c) => c.stableIdSuffix === ENERGY_SYSTEM_CHILD_KEY)
    expect(child?.meta.type).toBe(DeviceType.EnergySystem)
    expect(child?.meta.integrationId).toBe('int-1')
    expect(child?.config).toEqual({ integrationId: 'int-1', system: 'enpal' })
  })

  it('is not spawned under the heat pump or the box', () => {
    for (const equipment of ['heatpump', 'box']) {
      const children = accessoryChildSpecs({ equipment, specIds: [], integrationId: 'int-1' })
      expect(children.some((c) => c.stableIdSuffix === ENERGY_SYSTEM_CHILD_KEY)).toBe(false)
    }
  })

  it('is the System’s first preferred primary child', () => {
    expect(primaryChildPreferenceOf(SYSTEM, ['house'])).toEqual([ENERGY_SYSTEM_CHILD_KEY, 'house'])
  })

  it('options are the plain ones by default', () => {
    expect(computeEnergySystemStatus(snapshotOf([]), PLAIN, 1).status).toEqual({
      solar: null,
      grid: null,
      house: null,
      heatPump: null,
      storage: null,
      lastFetchedAt: 1,
    })
  })
})

describe('EnpalEnergySystemDevice', () => {
  it('registers the energy-system cap and never battery', async () => {
    let runtime: IDeviceRuntimeState | null = null
    const registered: string[] = []
    // A DeviceContext is the kernel's own object; the spec supplies only what the device reads.
    const ctx = {
      id: 12,
      stableId: 'enpal-system-energy-system',
      parentDeviceId: 9,
      deviceMeta: {
        type: DeviceType.EnergySystem,
        name: 'Energy system',
        location: null,
        disabled: false,
        addonId: 'provider-enpal',
        metadata: {},
      },
      persistedConfig: { integrationId: 'int-1', system: 'enpal' },
      initialRuntimeState: {},
      eventBus: { emit: vi.fn(), subscribe: vi.fn(() => () => {}), getRecent: vi.fn(() => []) },
      persistConfig: vi.fn(async () => {}),
      bindRuntimeState: (rs: IDeviceRuntimeState) => {
        runtime = rs
      },
      registerNativeCap: vi.fn((cap: { name: string; runtimeState?: unknown }) => {
        registered.push(cap.name)
        if (cap.runtimeState && runtime) {
          runtime.installCapSchema(
            cap.name,
            cap.runtimeState as Parameters<IDeviceRuntimeState['installCapSchema']>[1],
          )
        }
      }),
      api: {},
      logger: quiet,
    } as unknown as DeviceContext
    const device = new EnpalEnergySystemDevice(ctx)
    await device.onActivate()
    expect(registered).toContain('energy-system')
    expect(registered).not.toContain('battery')
    expect(device.type).toBe(DeviceType.EnergySystem)
    await device.removeDevice().catch(() => undefined)
  })
})
