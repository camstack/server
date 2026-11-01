import { DeviceType } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { findDuplicateGatewaySensors, type DuplicateScanRow } from '../ecowitt-duplicate-sensors.js'
import type { Sensor } from '@apocaliss92/nodewitt'
import { entriesForGroup } from '../ecowitt-sensor-groups.js'

const GW = 'ecowitt:192-168-20-181'
const container = (id: number, deviceGroup: string): DuplicateScanRow => ({
  id,
  type: DeviceType.Container,
  parentDeviceId: null,
  config: { system: 'ecowitt', gatewayId: GW, deviceGroup },
})
const sensor = (id: number, parent: number, sensorId: string, mark = ''): DuplicateScanRow => ({
  id,
  type: DeviceType.Sensor,
  parentDeviceId: parent,
  config: { sensorId, gatewayId: GW, mark },
})

describe('duplicate sensors under the gateway container', () => {
  const rows: DuplicateScanRow[] = [
    container(290, 'gateway'),
    sensor(291, 290, 'gateway:tempinf', 'own'),
    sensor(292, 290, 'gateway:humidityin', 'own'),
    sensor(293, 290, 'gateway:baromabsin', 'own'),
    sensor(294, 290, 'gateway:baromrelin', 'own'),
    sensor(4967, 290, 'gateway:temp1f'),
    sensor(5043, 290, 'gateway:0x02'),
    container(295, 'weather-station'),
    sensor(3900, 295, '8E:0x02', 'live'),
    container(315, 'temp-sensor-ch1'),
    sensor(4177, 315, '8E:temp1f', 'live'),
  ]

  it('returns only the copies of a sensor another container owns', () => {
    const { duplicates, scanned } = findDuplicateGatewaySensors(rows)
    expect([...duplicates].sort()).toEqual([4967, 5043])
    expect(scanned).toBe(8)
  })

  it('never returns the gateway own sensors nor the group children', () => {
    const { duplicates } = findDuplicateGatewaySensors(rows)
    for (const keep of [291, 292, 293, 294, 3900, 4177]) expect(duplicates).not.toContain(keep)
  })

  it('a gateway of another integration with the same key is not a duplicate', () => {
    const other: DuplicateScanRow = {
      ...container(400, 'weather-station'),
      config: {
        system: 'ecowitt',
        gatewayId: 'ecowitt:10-0-0-9',
        deviceGroup: 'weather-station',
      },
    }
    const twin = {
      ...sensor(401, 400, 'gateway:tempinf'),
      config: { sensorId: 'gateway:tempinf' },
    }
    expect(findDuplicateGatewaySensors([...rows, other, twin]).duplicates).not.toContain(291)
  })

  it('is idempotent: nothing left to remove once the duplicates are gone', () => {
    const left = rows.filter((r) => r.id !== 4967 && r.id !== 5043)
    expect(findDuplicateGatewaySensors(left).duplicates).toEqual([])
  })
})

describe('the container spawns only sensors of its own group', () => {
  const entries = [
    { sensorId: 'gateway:tempinf', quantity: 'temperature' },
    { sensorId: 'gateway:0x02', quantity: 'temperature' },
    { sensorId: 'gateway:unseen', quantity: 'temperature' },
  ] as const
  const liveSensor = (id: string, category: Sensor['category']): Sensor => ({
    id,
    quantity: 'temperature',
    value: 1,
    unit: '',
    raw: '1',
    lastUpdated: 0,
    category,
  })
  // The live ids are the settled ones: the weather station is `8E:0x02`, not `gateway:0x02`.
  const live = [liveSensor('gateway:tempinf', 'gateway'), liveSensor('8E:0x02', 'weather-station')]

  it('the gateway container drops the reading now owned by a weather station, keeps the rest', () => {
    const ids = entriesForGroup(entries, 'gateway', live).map((e) => e.sensorId)
    expect(ids).toEqual(['gateway:tempinf', 'gateway:unseen'])
  })

  it('the weather-station container keeps it', () => {
    const ids = entriesForGroup(entries, 'weather-station', live).map((e) => e.sensorId)
    expect(ids).toEqual(['gateway:0x02', 'gateway:unseen'])
  })
})
