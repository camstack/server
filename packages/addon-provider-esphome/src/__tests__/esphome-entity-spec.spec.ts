import { describe, expect, it } from 'vitest'
import { planBoard, type ChildPlan } from '../esphome-entity-spec.js'
import type { EspEntity } from '../esphome-link.js'

function entity(partial: Partial<EspEntity> & Pick<EspEntity, 'id' | 'type'>): EspEntity {
  return {
    name: partial.id,
    deviceClass: '',
    category: 'none',
    disabledByDefault: false,
    unit: '',
    supportsPosition: false,
    supportsStop: false,
    isStatusBinarySensor: false,
    supportsBrightness: false,
    min: null,
    max: null,
    step: null,
    options: [],
    eventTypes: [],
    ...partial,
  }
}

function kinds(plans: readonly ChildPlan[]): string[] {
  return plans.map((p) => `${p.kind}:${p.key}`)
}

describe('board entities to child plans', () => {
  it('maps the actuators one to one', () => {
    const plans = planBoard([
      entity({ id: 'switch-relay', type: 'switch' }),
      entity({ id: 'light-lamp', type: 'light', supportsBrightness: true }),
      entity({ id: 'cover-shutter', type: 'cover', supportsPosition: true }),
      entity({ id: 'button-restart', type: 'button' }),
    ])
    expect(kinds(plans)).toEqual([
      'switch:switch-relay',
      'light:light-lamp',
      'cover:cover-shutter',
      'button:button-restart',
    ])
  })

  it('maps number and select to controls and event to an event emitter', () => {
    const plans = planBoard([
      entity({ id: 'number-setpoint', type: 'number', min: 5, max: 30, step: 0.5, unit: 'C' }),
      entity({ id: 'select-mode', type: 'select', options: ['eco', 'comfort'] }),
      entity({ id: 'event-press', type: 'event', eventTypes: ['single', 'double'] }),
    ])
    expect(kinds(plans)).toEqual([
      'number-control:number-setpoint',
      'select-control:select-mode',
      'event:event-press',
    ])
  })

  it('maps a binary sensor by its device class', () => {
    const cls = (deviceClass: string): string =>
      planBoard([entity({ id: 'binary_sensor-x', type: 'binary_sensor', deviceClass })])[0]?.kind ??
      'none'
    expect(cls('door')).toBe('contact')
    expect(cls('window')).toBe('contact')
    expect(cls('garage_door')).toBe('contact')
    expect(cls('moisture')).toBe('flood')
    expect(cls('smoke')).toBe('smoke')
    expect(cls('motion')).toBe('motion')
    expect(cls('occupancy')).toBe('motion')
    expect(cls('')).toBe('binary')
    expect(cls('plug')).toBe('binary')
  })

  it('skips the connection status sensor, diagnostics and disabled-by-default entities', () => {
    const plans = planBoard([
      entity({ id: 'binary_sensor-status', type: 'binary_sensor', isStatusBinarySensor: true }),
      entity({ id: 'sensor-rssi', type: 'sensor', category: 'diagnostic', unit: 'dBm' }),
      entity({ id: 'sensor-hidden', type: 'sensor', disabledByDefault: true, unit: 'V' }),
      entity({ id: 'switch-ok', type: 'switch' }),
    ])
    expect(kinds(plans)).toEqual(['switch:switch-ok'])
  })

  it('folds power, energy, voltage and current sensors into ONE power-meter child', () => {
    const plans = planBoard([
      entity({ id: 'sensor-power', type: 'sensor', deviceClass: 'power', unit: 'W' }),
      entity({ id: 'sensor-energy', type: 'sensor', deviceClass: 'energy', unit: 'Wh' }),
      entity({ id: 'sensor-voltage', type: 'sensor', deviceClass: 'voltage', unit: 'V' }),
      entity({ id: 'sensor-current', type: 'sensor', deviceClass: 'current', unit: 'A' }),
      entity({ id: 'sensor-temp', type: 'sensor', deviceClass: 'temperature', unit: 'C' }),
    ])
    expect(kinds(plans)).toEqual(['power-meter:power-meter', 'numeric-sensor:sensor-temp'])
    const meter = plans.find((p) => p.kind === 'power-meter')
    expect(meter?.slots).toEqual({
      power: 'sensor-power',
      energy: 'sensor-energy',
      voltage: 'sensor-voltage',
      current: 'sensor-current',
    })
  })

  it('a text sensor is an enum sensor, a plain sensor is numeric', () => {
    const plans = planBoard([
      entity({ id: 'text_sensor-version', type: 'text_sensor' }),
      entity({ id: 'sensor-lux', type: 'sensor', unit: 'lx' }),
    ])
    expect(kinds(plans)).toEqual(['enum-sensor:text_sensor-version', 'numeric-sensor:sensor-lux'])
  })
})
