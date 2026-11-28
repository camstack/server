import { DeviceRole, DeviceType } from '@dominevo/types'
import { describe, expect, it } from 'vitest'
import { planZ2mDevice, roleForPrimaryCap } from '../z2m-exposes.js'
import {
  bulbExposes,
  buttonExposes,
  co2MonitorExposes,
  contactSensorExposes,
  lockExposes,
  meteringPlugExposes,
  shutterExposes,
  trvExposes,
  weatherSensorExposes,
} from './fixtures/z2m-fixtures.js'

describe('planZ2mDevice', () => {
  it('maps a contact sensor to contact + battery, with the inverted Zigbee2MQTT polarity kept', () => {
    const plan = planZ2mDevice(contactSensorExposes)
    expect(plan?.deviceType).toBe(DeviceType.Sensor)
    expect(plan?.capabilities).toEqual(['contact', 'battery'])
    expect(plan?.props['contact']).toBe('contact')
    // Z2M reports `contact: true` when CLOSED: value_on false means "active" (open).
    expect(plan?.binary['contact']).toEqual({ on: false, off: true })
    expect(plan?.skipped.map((s) => s.property)).toEqual(['linkquality', 'voltage'])
  })

  it('maps one weather sensor to ONE device with three readings and a battery', () => {
    const plan = planZ2mDevice(weatherSensorExposes)
    expect(plan?.deviceType).toBe(DeviceType.Sensor)
    expect(plan?.capabilities).toEqual([
      'temperature-sensor',
      'humidity-sensor',
      'pressure-sensor',
      'battery',
    ])
    expect(plan?.units['pressure']).toBe('hPa')
  })

  it('maps a white-ambiance bulb to a Light with brightness on its own scale and colour temperature', () => {
    const plan = planZ2mDevice(bulbExposes)
    expect(plan?.deviceType).toBe(DeviceType.Light)
    expect(plan?.capabilities).toEqual(['switch', 'brightness', 'color'])
    expect(plan?.binary['switch']).toEqual({ on: 'ON', off: 'OFF' })
    expect(plan?.range).toEqual({ brightnessMax: 254, colorTempMin: 153, colorTempMax: 500 })
  })

  it('folds power, energy, voltage and current of a plug into one power-meter and skips config exposes', () => {
    const plan = planZ2mDevice(meteringPlugExposes)
    expect(plan?.deviceType).toBe(DeviceType.Switch)
    expect(plan?.capabilities).toEqual(['switch', 'power-meter'])
    expect(plan?.meter).toEqual({
      power: 'power',
      energy: 'energy',
      voltage: 'voltage',
      current: 'current',
    })
    expect(plan?.skipped.some((s) => s.property === 'led_disabled_night')).toBe(true)
  })

  it('maps a shutter to a Cover, positionable when position is writable', () => {
    const plan = planZ2mDevice(shutterExposes)
    expect(plan?.deviceType).toBe(DeviceType.Cover)
    expect(plan?.capabilities).toEqual(['cover', 'battery'])
    expect(plan?.cover.positionable).toBe(true)
    expect(plan?.props['cover-state']).toBe('state')
  })

  it('maps a lock and keeps its lock_state property', () => {
    const plan = planZ2mDevice(lockExposes)
    expect(plan?.deviceType).toBe(DeviceType.Lock)
    expect(plan?.capabilities).toEqual(['lock-control', 'battery'])
    expect(plan?.binary['lock-control']).toEqual({ on: 'LOCK', off: 'UNLOCK' })
    expect(plan?.props['lock-state']).toBe('lock_state')
  })

  it('maps a TRV to Climate with its setpoint range and modes', () => {
    const plan = planZ2mDevice(trvExposes)
    expect(plan?.deviceType).toBe(DeviceType.Climate)
    expect(plan?.capabilities).toEqual(['climate-control', 'battery'])
    expect(plan?.climate).toEqual({ modes: ['off', 'heat', 'auto'], min: 5, max: 30, step: 0.5 })
    expect(plan?.props['setpoint']).toBe('occupied_heating_setpoint')
  })

  it('maps a button to an EventEmitter announcing its actions', () => {
    const plan = planZ2mDevice(buttonExposes)
    expect(plan?.deviceType).toBe(DeviceType.EventEmitter)
    expect(plan?.capabilities).toEqual(['event-emitter', 'battery'])
    expect(plan?.actions).toEqual(['single', 'double', 'hold'])
  })

  it('maps a CO2 monitor to ONE sensor with air quality, climate readings and light', () => {
    const plan = planZ2mDevice(co2MonitorExposes)
    expect(plan?.deviceType).toBe(DeviceType.Sensor)
    expect(plan?.capabilities).toEqual([
      'temperature-sensor',
      'humidity-sensor',
      'ambient-light-sensor',
      'air-quality-sensor',
    ])
    expect(plan?.air).toEqual({ co2: 'co2' })
  })

  it('plans nothing for a device that exposes nothing mappable', () => {
    expect(planZ2mDevice([])).toBeNull()
  })

  it('names the role of the primary function, none for a switch or a light', () => {
    expect(roleForPrimaryCap('contact')).toBe(DeviceRole.ContactSensor)
    expect(roleForPrimaryCap('switch')).toBeNull()
  })
})
