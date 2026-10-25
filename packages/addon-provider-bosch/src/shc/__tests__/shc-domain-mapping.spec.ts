import { describe, expect, it } from 'vitest'
import { DeviceType } from '@camstack/types'
import {
  buildRoomClimatePutBody,
  capsForShcKind,
  classifyShcDevice,
  deviceTypeForShcKind,
  buildPowerSwitchPutBody,
  buildRoomClimateModeBodies,
  mapRoomClimateStateToSlice,
  readShcSwitchOn,
  shcKindForModel,
} from '../shc-domain-mapping.js'

describe('classifyShcDevice', () => {
  it('classifies ROOM_CLIMATE_CONTROL by deviceModel', () => {
    expect(
      classifyShcDevice({
        id: 'roomClimateControl_hz_1',
        deviceModel: 'ROOM_CLIMATE_CONTROL',
        name: 'Living room',
        services: ['RoomClimateControl'],
      }),
    ).toBe('room-climate')
  })

  it('classifies smart plug by PowerSwitch service', () => {
    expect(
      classifyShcDevice({
        id: 'hdm1:001D0000000000',
        deviceModel: 'TWR_SWITCH',
        name: 'Lamp',
        services: ['PowerSwitch'],
      }),
    ).toBe('switch')
  })

  it('classifies TRV by heating services', () => {
    expect(
      classifyShcDevice({
        id: 'hdm1:trv1',
        deviceModel: 'HEATING_THERMOSTAT',
        name: 'Radiator',
        services: ['TemperatureLevel', 'ValveTappet', 'BatteryLevel'],
      }),
    ).toBe('trv')
  })

  it('returns unsupported for unknown models without known services', () => {
    expect(
      classifyShcDevice({
        id: 'x',
        deviceModel: 'MOTION_DETECTOR',
        name: 'Motion',
        services: ['MotionDetection'],
      }),
    ).toBe('unsupported')
  })
})

describe('mapRoomClimateStateToSlice', () => {
  it('maps setpointTemperature and room temperature to climate-control slice', () => {
    const slice = mapRoomClimateStateToSlice({
      '@type': 'climateControlState',
      mode: 'MANUAL',
      setpointTemperature: 22,
      temperature: 20.5,
    })
    expect(slice.target).toBe(22)
    expect(slice.currentTemp).toBe(20.5)
    expect(slice.mode).toBe('heat')
    expect(slice.availableModes).toContain('heat')
  })

  it('maps controller operationMode when mode is absent', () => {
    const slice = mapRoomClimateStateToSlice({
      '@type': 'climateControlState',
      operationMode: 'MANUAL',
      setpointTemperature: 5,
    })
    expect(slice.mode).toBe('heat')
    expect(slice.target).toBe(5)
    expect(slice.currentTemp).toBeNull()
    expect(slice.minTemp).toBe(5)
    expect(slice.maxTemp).toBe(30)
  })

  it('keeps min and max when the controller reports them', () => {
    const slice = mapRoomClimateStateToSlice({
      '@type': 'climateControlState',
      operationMode: 'MANUAL',
      setpointTemperature: 20,
      minTemperature: 10,
      maxTemperature: 25,
    })
    expect(slice.minTemp).toBe(10)
    expect(slice.maxTemp).toBe(25)
  })

  it('maps AUTOMATIC mode to auto', () => {
    const slice = mapRoomClimateStateToSlice({
      '@type': 'climateControlState',
      mode: 'AUTOMATIC',
      setpointTemperature: 19,
      temperature: 18,
    })
    expect(slice.mode).toBe('auto')
  })
})

describe('buildRoomClimateModeBodies', () => {
  it('turns the room off with roomControlMode alone', () => {
    expect(buildRoomClimateModeBodies('off')).toEqual([
      { '@type': 'climateControlState', roomControlMode: 'OFF' },
    ])
  })

  it('enables heating before the schedule mode', () => {
    expect(buildRoomClimateModeBodies('auto')).toEqual([
      { '@type': 'climateControlState', roomControlMode: 'HEATING' },
      { '@type': 'climateControlState', operationMode: 'AUTOMATIC' },
    ])
    expect(buildRoomClimateModeBodies('heat')[1]?.operationMode).toBe('MANUAL')
  })
})

describe('room control mode', () => {
  it('reads OFF even when operationMode stays MANUAL', () => {
    const slice = mapRoomClimateStateToSlice({
      '@type': 'climateControlState',
      operationMode: 'MANUAL',
      roomControlMode: 'OFF',
      setpointTemperature: 5,
    })
    expect(slice.mode).toBe('off')
  })
})

describe('power switch wire format', () => {
  it('reads ON/OFF strings and writes them back', () => {
    expect(readShcSwitchOn({ switchState: 'ON' })).toBe(true)
    expect(readShcSwitchOn({ switchState: 'OFF' })).toBe(false)
    expect(readShcSwitchOn({ switchState: false })).toBe(false)
    expect(buildPowerSwitchPutBody(true)).toEqual({
      '@type': 'powerSwitchState',
      switchState: 'ON',
    })
  })
})

describe('buildRoomClimatePutBody', () => {
  it('builds Bosch PUT body for setpoint change', () => {
    expect(buildRoomClimatePutBody({ target: 22 })).toEqual({
      '@type': 'climateControlState',
      setpointTemperature: 22,
    })
  })
})

describe('shcKindForModel', () => {
  it('maps room climate model constant', () => {
    expect(shcKindForModel('ROOM_CLIMATE_CONTROL')).toBe('room-climate')
  })
})

describe('deviceTypeForShcKind', () => {
  it('maps room-climate to Container and trv to Thermostat', () => {
    expect(deviceTypeForShcKind('room-climate')).toBe(DeviceType.Container)
    expect(deviceTypeForShcKind('trv')).toBe(DeviceType.Thermostat)
  })
})

describe('capsForShcKind', () => {
  it('TRV caps exclude climate-control and include heating-valve', () => {
    expect(capsForShcKind('trv')).toEqual(['temperature-sensor', 'battery', 'heating-valve'])
  })
})
