import {
  DeviceType,
  type ClimateControlStatus,
  type DeviceContext,
  type IDeviceRuntimeState,
} from '@dominevo/types'
import type { HmCustomEntity, HmDevice, Homematic, ValueChangedEvent } from 'nodehomematic'
import { beforeEach, describe, expect, it } from 'vitest'
import { HmActuatorDevice } from '../devices/hm-actuator-device.js'
import { homematicFacades } from '../homematic-facade-resolver.js'
import { hmClimateEntity, hmDataPoint, hmDevice } from './hm-test-fixtures.js'

/**
 * A climate child's `action`: the floor relay's `STATE` (HmIP-BWTH `:8`) or a
 * valve's `LEVEL` (HmIP-eTRV), and `off` whenever the mode is off. Only the
 * floor-direct `STATE` crosses the channel filter; `:9` / `:10` stay foreign.
 */
const INTEGRATION_ID = 'hm_001'
const ADDRESS = '00315F298E5A18'
const CHANNEL = `${ADDRESS}:1`
const DEVICE_ID = 1502
const FLOOR_DIRECT = 'CLIMATECONTROL_FLOOR_DIRECT_TRANSMITTER'

type ValueListener = (event: ValueChangedEvent) => void

const silentLogger: DeviceContext['logger'] = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child() {
    return silentLogger
  },
  withTags() {
    return silentLogger
  },
}

function climateContext(): DeviceContext {
  let runtime: IDeviceRuntimeState | null = null
  const stableId = `hm:${INTEGRATION_ID}:${ADDRESS}-act-${CHANNEL}`
  return {
    id: DEVICE_ID,
    stableId,
    parentDeviceId: 1445,
    deviceMeta: {
      id: DEVICE_ID,
      stableId,
      addonId: 'provider-homematic',
      type: DeviceType.Climate,
      name: 'Bathroom floor',
      location: null,
      disabled: false,
      parentDeviceId: 1445,
      metadata: null,
    },
    persistedConfig: {
      address: ADDRESS,
      integrationId: INTEGRATION_ID,
      channel: CHANNEL,
      kind: 'climate',
    },
    initialRuntimeState: {},
    eventBus: { emit: () => {}, subscribe: () => () => {}, getRecent: () => [] },
    persistConfig: async () => {},
    bindRuntimeState: (rs: IDeviceRuntimeState) => {
      runtime = rs
    },
    registerNativeCap: (cap: { name: string; runtimeState?: unknown }) => {
      if (cap.runtimeState && runtime) {
        runtime.installCapSchema(
          cap.name,
          cap.runtimeState as Parameters<IDeviceRuntimeState['installCapSchema']>[1],
        )
      }
    },
    logger: silentLogger,
    api: { deviceState: { getCapSlice: { query: async () => null } } },
  } as unknown as DeviceContext
}

const dp = (parameter: string, value: number | boolean) => hmDataPoint({ parameter, value })

const THERMOSTAT_CHANNEL = {
  address: CHANNEL,
  index: 1,
  type: 'HEATING_CLIMATECONTROL_TRANSCEIVER',
}

/** HmIP-BWTH: the thermostat on `:1`, the floor relay on `:8`, an unrelated relay on `:9`. */
function bwth(floorState: boolean | null, otherState: boolean | null): HmDevice {
  return hmDevice({
    address: ADDRESS,
    type: 'HmIP-BWTH',
    channels: [
      {
        ...THERMOSTAT_CHANNEL,
        dataPoints: [dp('SET_POINT_MODE', 1), dp('SET_POINT_TEMPERATURE', 21)],
      },
      {
        address: `${ADDRESS}:8`,
        index: 8,
        type: FLOOR_DIRECT,
        dataPoints: floorState === null ? [] : [dp('STATE', floorState)],
      },
      {
        address: `${ADDRESS}:9`,
        index: 9,
        type: 'CLIMATECONTROL_FLOOR_DIRECT_RECEIVER',
        dataPoints: otherState === null ? [] : [dp('STATE', otherState)],
      },
    ],
  })
}

function install(seeded: HmDevice): { emit: ValueListener } {
  let listener: ValueListener = () => undefined
  const facade = {
    on: (event: string, cb: ValueListener) => {
      if (event === 'valueChanged') listener = cb
      return () => undefined
    },
    devices: (): HmDevice[] => [seeded],
    customEntities: (): HmCustomEntity[] => [
      hmClimateEntity({ device: ADDRESS, channel: CHANNEL }),
    ],
  }
  // Test boundary: a structural stand-in for the library client.
  homematicFacades.set(INTEGRATION_ID, facade as unknown as Homematic)
  return { emit: (event) => listener(event) }
}

function event(channel: string, parameter: string, value: number | boolean): ValueChangedEvent {
  return {
    dpId: `${channel}:${parameter}`,
    device: ADDRESS,
    channel,
    parameter,
    value,
    prevValue: null,
    ts: 1_000,
  }
}

const sliceOf = (device: HmActuatorDevice) =>
  device.runtimeState.getCapState<ClimateControlStatus>('climate-control')

describe('HmActuatorDevice climate action', () => {
  beforeEach(() => homematicFacades.clear())

  it('cold start reads the floor relay STATE on :8 and ignores :9', () => {
    install(bwth(false, true))
    const device = new HmActuatorDevice(climateContext())
    expect(sliceOf(device)?.action).toBe('idle')
  })

  it('cold start with the relay calling for heat reads heating', () => {
    install(bwth(true, false))
    const device = new HmActuatorDevice(climateContext())
    expect(sliceOf(device)?.action).toBe('heating')
  })

  it('a live :8 STATE flips heating and idle; :9 STATE and other :8 parameters are dropped', () => {
    const bus = install(bwth(null, null))
    const device = new HmActuatorDevice(climateContext())
    expect(sliceOf(device)?.action ?? null).toBeNull()

    bus.emit(event(`${ADDRESS}:8`, 'STATE', true))
    expect(sliceOf(device)?.action).toBe('heating')
    bus.emit(event(`${ADDRESS}:9`, 'STATE', false))
    expect(sliceOf(device)?.action).toBe('heating')
    bus.emit(event(`${ADDRESS}:8`, 'LEVEL', 0))
    expect(sliceOf(device)?.action).toBe('heating')
    bus.emit(event(`${ADDRESS}:8`, 'STATE', false))
    expect(sliceOf(device)?.action).toBe('idle')
  })

  it('mode off reports action off, and leaving off forgets the demand until the device says', () => {
    const bus = install(bwth(true, null))
    const device = new HmActuatorDevice(climateContext())
    expect(sliceOf(device)?.action).toBe('heating')

    bus.emit(event(CHANNEL, 'SET_POINT_TEMPERATURE', 5))
    expect(sliceOf(device)?.mode).toBe('off')
    expect(sliceOf(device)?.action).toBe('off')

    bus.emit(event(`${ADDRESS}:8`, 'STATE', true))
    expect(sliceOf(device)?.action).toBe('off')

    bus.emit(event(CHANNEL, 'SET_POINT_TEMPERATURE', 21))
    expect(sliceOf(device)?.mode).toBe('heat')
    expect(sliceOf(device)?.action).toBeNull()
    bus.emit(event(`${ADDRESS}:8`, 'STATE', true))
    expect(sliceOf(device)?.action).toBe('heating')
  })

  it('a valve thermostat reports heating while LEVEL > 0 and idle at 0', () => {
    const etrv = hmDevice({
      address: ADDRESS,
      type: 'HmIP-eTRV',
      channels: [
        {
          ...THERMOSTAT_CHANNEL,
          dataPoints: [dp('SET_POINT_MODE', 1), dp('SET_POINT_TEMPERATURE', 21), dp('LEVEL', 0.35)],
        },
      ],
    })
    const bus = install(etrv)
    const device = new HmActuatorDevice(climateContext())
    expect(sliceOf(device)?.action).toBe('heating')
    bus.emit(event(CHANNEL, 'LEVEL', 0))
    expect(sliceOf(device)?.action).toBe('idle')
    bus.emit(event(CHANNEL, 'LEVEL', 0.8))
    expect(sliceOf(device)?.action).toBe('heating')
  })

  it('a thermostat that reports no demand leaves the action unsaid', () => {
    const bare = hmDevice({
      address: ADDRESS,
      type: 'HmIP-WTH',
      channels: [
        {
          ...THERMOSTAT_CHANNEL,
          dataPoints: [dp('SET_POINT_MODE', 1), dp('SET_POINT_TEMPERATURE', 21)],
        },
      ],
    })
    install(bare)
    const device = new HmActuatorDevice(climateContext())
    expect(sliceOf(device)?.action ?? null).toBeNull()
  })
})
