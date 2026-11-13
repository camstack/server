import { describe, expect, it, vi } from 'vitest'
import type { HmDataPoint } from 'nodehomematic'
import { buildCcuDeviceStateHandlers } from '../ccu/ccu-device-state-actions.js'
import { fakeDeps } from './ccu-fake.js'
import { hmDataPoint, hmDevice } from './hm-test-fixtures.js'

const ADDRESS = '00315F298E5093'

function writable(point: HmDataPoint, extra: Partial<HmDataPoint> = {}): HmDataPoint {
  return { ...point, writable: true, ...extra }
}

function actuator() {
  return hmDevice({
    address: ADDRESS,
    type: 'HmIP-BSM',
    name: 'Bagno',
    firmware: '1.4.8',
    availableFirmware: '1.6.2',
    updatable: true,
    firmwareUpdateState: 'READY_FOR_UPDATE',
    channels: [
      {
        address: `${ADDRESS}:0`,
        index: 0,
        type: 'MAINTENANCE',
        dataPoints: [
          hmDataPoint({ parameter: 'RSSI_DEVICE', type: 'INTEGER', value: -64 }),
          hmDataPoint({ parameter: 'RSSI_PEER', type: 'INTEGER', value: -71 }),
          hmDataPoint({ parameter: 'UNREACH', type: 'BOOL', value: false }),
          hmDataPoint({ parameter: 'LOW_BAT', type: 'BOOL', value: true }),
          hmDataPoint({ parameter: 'DUTY_CYCLE', type: 'BOOL', value: false }),
          hmDataPoint({ parameter: 'CONFIG_PENDING', type: 'BOOL', value: true }),
        ],
      },
      {
        address: `${ADDRESS}:1`,
        index: 1,
        type: 'KEY_TRANSCEIVER',
        name: 'Bagno sinistra',
        dataPoints: [
          writable(hmDataPoint({ parameter: 'PRESS_SHORT', type: 'ACTION' }), {
            readable: false,
          }),
        ],
      },
      {
        address: `${ADDRESS}:4`,
        index: 4,
        type: 'SWITCH_VIRTUAL_RECEIVER',
        dataPoints: [
          writable(hmDataPoint({ parameter: 'STATE', type: 'BOOL', value: true })),
          writable(hmDataPoint({ parameter: 'ON_TIME', type: 'FLOAT', unit: 's' }), {
            min: 0,
            max: 111600,
          }),
          hmDataPoint({ parameter: 'PROCESS', type: 'ENUM', value: 0 }),
        ],
      },
    ],
  })
}

describe('getCcuDeviceState', () => {
  it('reports diagnostics, firmware and every channel value with its write metadata', async () => {
    const { deps } = fakeDeps({ devices: () => [actuator()] })
    const state = await buildCcuDeviceStateHandlers(deps).getCcuDeviceState({
      integrationId: 'hm_1',
      address: ADDRESS,
    })
    expect(state.diagnostics).toEqual({
      rssiDevice: -64,
      rssiPeer: -71,
      unreach: false,
      lowBattery: true,
      dutyCycle: false,
      configPending: true,
    })
    expect(state.firmware).toEqual({
      installed: '1.4.8',
      available: '1.6.2',
      updatable: true,
      state: 'READY_FOR_UPDATE',
    })
    expect(state.channels.map((channel) => channel.address)).toEqual([
      `${ADDRESS}:0`,
      `${ADDRESS}:1`,
      `${ADDRESS}:4`,
    ])
    const relay = state.channels[2]
    expect(relay?.values.map((value) => [value.parameter, value.writable])).toEqual([
      ['STATE', true],
      ['ON_TIME', true],
      ['PROCESS', false],
    ])
    expect(relay?.values[1]).toMatchObject({ min: 0, max: 111600, unit: 's' })
  })

  it('reports a diagnostic the device does not have as null, never as false', async () => {
    const bare = hmDevice({
      address: ADDRESS,
      type: 'HM-LC-Sw1-FM',
      channels: [
        {
          address: `${ADDRESS}:0`,
          index: 0,
          type: 'MAINTENANCE',
          dataPoints: [hmDataPoint({ parameter: 'LOWBAT', type: 'BOOL', value: false })],
        },
      ],
    })
    const { deps } = fakeDeps({ devices: () => [bare] })
    const state = await buildCcuDeviceStateHandlers(deps).getCcuDeviceState({
      integrationId: 'hm_1',
      address: ADDRESS,
    })
    expect(state.diagnostics).toEqual({
      rssiDevice: null,
      rssiPeer: null,
      unreach: null,
      lowBattery: false,
      dutyCycle: null,
      configPending: null,
    })
    expect(state.firmware).toEqual({
      installed: null,
      available: null,
      updatable: null,
      state: null,
    })
  })

  it('refuses a device the CCU does not know', async () => {
    const { deps } = fakeDeps({ devices: () => [] })
    await expect(
      buildCcuDeviceStateHandlers(deps).getCcuDeviceState({
        integrationId: 'hm_1',
        address: ADDRESS,
      }),
    ).rejects.toThrow(/not known/)
  })
})

describe('setCcuValue', () => {
  it('writes a writable value only once confirmed, logged with the device tag', async () => {
    const setValue = vi.fn(async () => undefined)
    const { deps, logger } = fakeDeps({ devices: () => [actuator()], setValue })
    const handlers = buildCcuDeviceStateHandlers(deps)
    const input = {
      integrationId: 'hm_1',
      channel: `${ADDRESS}:4`,
      parameter: 'STATE',
      value: false,
      deviceId: 42,
    }
    await expect(handlers.setCcuValue({ ...input, confirmed: false })).rejects.toThrow(
      /confirmation/,
    )
    expect(setValue).not.toHaveBeenCalled()

    await handlers.setCcuValue({ ...input, confirmed: true })
    expect(setValue).toHaveBeenCalledWith(
      { device: ADDRESS, channel: `${ADDRESS}:4`, parameter: 'STATE' },
      false,
    )
    const line = logger.lines.find((entry) => entry.message.includes('value written'))
    expect(line?.tags).toEqual({ deviceId: 42 })
  })

  it('presses a key (an ACTION value) with true', async () => {
    const setValue = vi.fn(async () => undefined)
    const { deps } = fakeDeps({ devices: () => [actuator()], setValue })
    await buildCcuDeviceStateHandlers(deps).setCcuValue({
      integrationId: 'hm_1',
      channel: `${ADDRESS}:1`,
      parameter: 'PRESS_SHORT',
      value: true,
      confirmed: true,
    })
    expect(setValue).toHaveBeenCalledWith(
      { device: ADDRESS, channel: `${ADDRESS}:1`, parameter: 'PRESS_SHORT' },
      true,
    )
  })

  it('refuses a read-only or unknown value before any write', async () => {
    const setValue = vi.fn(async () => undefined)
    const { deps } = fakeDeps({ devices: () => [actuator()], setValue })
    const handlers = buildCcuDeviceStateHandlers(deps)
    const base = { integrationId: 'hm_1', value: 1, confirmed: true }
    await expect(
      handlers.setCcuValue({ ...base, channel: `${ADDRESS}:4`, parameter: 'PROCESS' }),
    ).rejects.toThrow(/not a writable value/)
    await expect(
      handlers.setCcuValue({ ...base, channel: `${ADDRESS}:4`, parameter: 'LEVEL' }),
    ).rejects.toThrow(/not a writable value/)
    await expect(
      handlers.setCcuValue({ ...base, channel: 'NOPE:1', parameter: 'STATE' }),
    ).rejects.toThrow(/not known/)
    expect(setValue).not.toHaveBeenCalled()
  })
})
