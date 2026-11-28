/**
 * The catalog entries the Energy system device shows are not also Sensor devices: a fresh
 * integration never creates them, and an existing child still carrying one stops being
 * declared, which the kernel's accessory reconciliation turns into a (D49-gated) removal.
 */
import { DeviceType } from '@dominevo/types'
import { describe, expect, it } from 'vitest'
import { ENERGY_SYSTEM_INPUT_SPEC_IDS, ENPAL_SPECS } from '../enpal-catalog.js'
import { buildEnpalCandidates } from '../enpal-discovery.js'
import { computeEnergySystemStatus } from '../enpal-energy-system.js'
import { accessoryChildSpecs, ENPAL_EQUIPMENT } from '../enpal-equipment.js'
import { createSnapshot } from '../enpal-snapshot.js'

const ROWS: ReadonlyArray<readonly [string, number, string]> = [
  ['Power.DC.Total', 4200, 'W'],
  ['Energy.Production.Total.Lifetime', 12000, 'kWh'],
  ['Energy.Production.Total.Day', 18.4, 'kWh'],
  ['Power.Grid.Export', 1500, 'W'],
  ['Energy.Grid.Import.Lifetime', 3000, 'kWh'],
  ['Power.Consumption.Total', 900, 'W'],
  ['Energy.Battery.Charge.Level', 74, '%'],
  ['Power.Battery.Charge.Discharge', 1800, 'W'],
  ['Battery.SOH', 96, '%'],
  ['Heatpump.Power.Consumption.Total', 600, 'W'],
  ['Temperature.Housing.Inside', 31, 'C'],
  ['Cpu.Load', 12, '%'],
]

const snapshot = createSnapshot(
  'influxdb',
  ROWS.map(([key, value, unit]) => ({ key, value, unit, measurement: undefined })),
  1_000,
)

const OPTIONS = { invertBatteryPower: false }

describe('Energy system inputs are not Sensor devices', () => {
  it('the inputs are catalog entries the Energy system reads', () => {
    const ids = new Set(ENPAL_SPECS.map((s) => s.id))
    for (const id of ENERGY_SYSTEM_INPUT_SPEC_IDS) expect(ids.has(id)).toBe(true)
  })

  it('discovery offers no Sensor for them and still offers the other sensors', () => {
    const offered = buildEnpalCandidates({
      box: { name: 'Box', online: true },
      snapshot,
      adopted: new Map(),
    }).flatMap((c) => [c, ...(c.children ?? [])])
    const sensorIds = offered
      .filter((c) => c.type === DeviceType.Sensor)
      .map((c) => c.childNativeId.split('#')[1])
    for (const id of ENERGY_SYSTEM_INPUT_SPEC_IDS) expect(sensorIds).not.toContain(id)
    expect(sensorIds).toContain('box-cpu-load')
  })

  it('a container adopted before still declares only the other sensors', () => {
    const impianto = ENPAL_EQUIPMENT.find((e) => e.id === 'impianto')
    const specs = accessoryChildSpecs({
      equipment: 'impianto',
      specIds: impianto?.specIds ?? [],
      integrationId: 'int-1',
    })
    const suffixes = specs.map((s) => s.stableIdSuffix)
    for (const id of ENERGY_SYSTEM_INPUT_SPEC_IDS) expect(suffixes).not.toContain(id)
    expect(suffixes).toContain('energy-system')
    expect(suffixes).toContain('pv-string-1-power')
    expect(suffixes).toContain('inverter-state')
    const heat = accessoryChildSpecs({
      equipment: 'heatpump',
      specIds: ['heatpump', 'heatpump-hot-water'],
      integrationId: 'int-1',
    })
    expect(heat.map((s) => s.stableIdSuffix)).toEqual(['heatpump-hot-water'])
  })

  it('the Energy system values come from the same catalog specs, unchanged', () => {
    const { status } = computeEnergySystemStatus(snapshot, OPTIONS, 5_000)
    expect(status.solar).toEqual({ powerW: 4200, energyKwh: 12000, todayKwh: 18.4 })
    expect(status.storage?.stateOfChargePct).toBe(74)
    expect(status.storage?.healthPct).toBe(96)
    expect(status.heatPump?.powerW).toBe(600)
    expect(status.grid?.powerW).toBe(-1500)
  })
})
