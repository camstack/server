import { DeviceType } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  retypeOutdoorStations,
  type StationRetypeDevice,
} from '../migrations/retype-outdoor-station.js'

const MARK = 'keep-this-note'

function device(
  partial: Pick<StationRetypeDevice, 'id' | 'type' | 'parentDeviceId'> & {
    readonly stableId?: string
    readonly deviceGroup?: string
    readonly mark?: string
  },
): StationRetypeDevice {
  return {
    id: partial.id,
    stableId: partial.stableId ?? `stable-${partial.id}`,
    type: partial.type,
    parentDeviceId: partial.parentDeviceId,
    config: {
      system: 'ecowitt',
      gatewayId: 'ecowitt:gw',
      deviceGroup: partial.deviceGroup ?? 'gateway',
      stationNote: partial.mark ?? MARK,
    },
  }
}

function world(rows: readonly StationRetypeDevice[]) {
  const store = rows.map((row) => ({ ...row, config: { ...row.config } }))
  return {
    store,
    ports: {
      listDevices: async () => store.map((row) => ({ ...row, config: { ...row.config } })),
      setType: async (deviceId: number, type: string) => {
        const row = store.find((entry) => entry.id === deviceId)
        if (row === undefined) throw new Error(`missing ${deviceId}`)
        row.type = type
      },
    },
  }
}

describe('retype outdoor Ecowitt container', () => {
  it('keeps deviceId, stableId, a marked config field and the child parent link', async () => {
    const { store, ports } = world([
      device({
        id: 10,
        type: DeviceType.Container,
        parentDeviceId: null,
        stableId: 'ecowitt:gw:weather-station',
        deviceGroup: 'weather-station',
      }),
      device({
        id: 11,
        type: DeviceType.Sensor,
        parentDeviceId: 10,
        stableId: 'ecowitt:gw:weather-station-tempf',
        deviceGroup: 'weather-station',
      }),
      device({
        id: 12,
        type: DeviceType.Container,
        parentDeviceId: null,
        deviceGroup: 'gateway',
      }),
    ])
    const result = await retypeOutdoorStations(ports)
    expect(result).toEqual({ outcome: 'done', summary: { retyped: 1 } })
    const station = store.find((row) => row.id === 10)
    const child = store.find((row) => row.id === 11)
    const gateway = store.find((row) => row.id === 12)
    expect(station?.type).toBe(DeviceType.WeatherStation)
    expect(station?.stableId).toBe('ecowitt:gw:weather-station')
    expect(station?.config['stationNote']).toBe(MARK)
    expect(child?.parentDeviceId).toBe(10)
    expect(child?.type).toBe(DeviceType.Sensor)
    expect(gateway?.type).toBe(DeviceType.Container)
  })

  it('a second run changes nothing', async () => {
    const { store, ports } = world([
      device({
        id: 10,
        type: DeviceType.WeatherStation,
        parentDeviceId: null,
        deviceGroup: 'weather-station',
      }),
    ])
    const result = await retypeOutdoorStations(ports)
    expect(result.outcome).toBe('already-done')
    expect(store[0]?.type).toBe(DeviceType.WeatherStation)
    expect(store[0]?.config['stationNote']).toBe(MARK)
  })
})
