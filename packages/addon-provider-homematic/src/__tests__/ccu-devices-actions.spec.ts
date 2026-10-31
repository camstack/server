import { describe, expect, it } from 'vitest'
import type { HmChannel, HmDataPoint, HmDevice, HmValue } from 'nodehomematic'
import { buildCcuDevicesHandlers } from '../ccu/ccu-devices-actions.js'
import { toCcuDeviceRow } from '../ccu/ccu-device-rows.js'
import { fakeDeps } from './ccu-fake.js'

function dp(parameter: string, value: HmValue): HmDataPoint {
  return {
    id: parameter.toLowerCase(),
    parameter,
    type: 'FLOAT',
    value,
    readable: true,
    writable: false,
    hasEvents: true,
  }
}
function maintenance(params: Record<string, HmValue>): HmChannel {
  return {
    address: 'ABC:0',
    index: 0,
    type: 'MAINTENANCE',
    dataPoints: Object.entries(params).map(([k, v]) => dp(k, v)),
  }
}
function device(overrides: Partial<HmDevice>, params: Record<string, HmValue>): HmDevice {
  return {
    address: 'ABC',
    type: 'HmIP-eTRV-2',
    channels: [maintenance(params)],
    ...overrides,
  }
}

describe('toCcuDeviceRow', () => {
  it('reads identity, firmware and maintenance health', () => {
    const row = toCcuDeviceRow(
      device(
        {
          name: 'Bedroom radiator',
          rooms: ['Bedroom'],
          functions: ['Heating'],
          firmware: '1.0.6',
          availableFirmware: '1.0.8',
          updatable: true,
        },
        {
          RSSI_DEVICE: -61,
          RSSI_PEER: -58,
          DUTY_CYCLE: false,
          LOW_BAT: true,
          UNREACH: false,
          CONFIG_PENDING: true,
          SABOTAGE: false,
        },
      ),
    )
    expect(row).toMatchObject({
      address: 'ABC',
      name: 'Bedroom radiator',
      rooms: ['Bedroom'],
      functions: ['Heating'],
      firmware: '1.0.6',
      availableFirmware: '1.0.8',
      updatable: true,
      rssi: -61,
      rssiPeer: -58,
      dutyCycle: null,
      dutyCycleLimited: false,
      lowBattery: true,
      unreach: false,
      configPending: true,
      sabotage: false,
    })
  })

  it('reports what the device does not report as null, never as a healthy default', () => {
    const row = toCcuDeviceRow(device({}, {}))
    expect(row.rssi).toBeNull()
    expect(row.lowBattery).toBeNull()
    expect(row.unreach).toBeNull()
    expect(row.configPending).toBeNull()
    expect(row.sabotage).toBeNull()
    expect(row.name).toBeNull()
  })

  it('treats the CCU "no reading" RSSI marker as unknown', () => {
    expect(toCcuDeviceRow(device({}, { RSSI_DEVICE: 65535 })).rssi).toBeNull()
  })

  it('reads a numeric duty cycle as a percentage', () => {
    const row = toCcuDeviceRow(device({}, { DUTY_CYCLE: 7 }))
    expect(row.dutyCycle).toBe(7)
    expect(row.dutyCycleLimited).toBeNull()
  })
})

describe('listCcuDevices', () => {
  it('lists the devices of a connected integration', async () => {
    const { deps } = fakeDeps({ devices: () => [device({ name: 'Lamp' }, { UNREACH: true })] })
    const handlers = buildCcuDevicesHandlers(deps)
    const out = await handlers.listCcuDevices({ integrationId: 'hm_1' })
    expect(out.devices).toHaveLength(1)
    expect(out.devices[0]?.unreach).toBe(true)
    await expect(handlers.listCcuDevices({ integrationId: 'nope' })).rejects.toThrow(
      /not connected/,
    )
  })
})
