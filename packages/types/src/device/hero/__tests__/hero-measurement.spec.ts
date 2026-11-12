import { describe, expect, it } from 'vitest'
import { DeviceType } from '../../device-type.js'
import { buildHeroModel } from '../build-hero-model.js'
import { projectDeviceRow } from '../hero-row.js'
import { build, NOW, rowOf } from './hero-test-kit.js'

const MIN = 60_000

describe('a simple sensor is drawn as its ONE measurement', () => {
  it('a hot temperature: value without unit, °C, thermometer, Hot, since the last read', () => {
    const m = build(DeviceType.Sensor, ['temperature-sensor'], {
      'temperature-sensor': { temperature: 48, lastFetchedAt: NOW - 2 * MIN },
    })
    expect(m.measurement).toMatchObject({
      quantity: 'temperature',
      reading: { value: 48, quantity: 'temperature' },
      icon: 'thermometer',
      value: { en: '48' },
      unit: '°C',
      band: 'hot',
      word: { en: 'Hot', it: 'Caldo' },
      since: NOW - 2 * MIN,
      sinceKind: 'updated',
      historyKey: 'cap:temperature-sensor.temperature',
    })
  })

  it('the temperature band: cold below 12 °C, hot above 28 °C, mild between', () => {
    const band = (temperature: number) =>
      build(DeviceType.Sensor, ['temperature-sensor'], {
        'temperature-sensor': { temperature, lastFetchedAt: NOW },
      }).measurement?.band
    expect([band(6.9), band(12), band(28), band(28.5)]).toEqual(['cold', 'mild', 'mild', 'hot'])
  })

  it('a power: watts, the wire speed follows the power and stops at 0 W', () => {
    const at = (power: number) =>
      build(DeviceType.Sensor, ['power-meter'], { 'power-meter': { power, lastFetchedAt: NOW } })
        .measurement
    expect(at(1221)).toMatchObject({
      quantity: 'power',
      icon: 'zap',
      unit: 'W',
      word: { en: 'Active' },
    })
    expect(at(1221)?.level).toBeCloseTo(1221 / 3000)
    expect(at(0)).toMatchObject({ level: 0, word: { en: 'Idle' }, tone: 'muted' })
    expect(at(9000)?.level).toBe(1)
  })

  it('a contact: Open with the time it has held, never a number to chart', () => {
    const m = build(DeviceType.Sensor, ['contact'], {
      contact: { entryOpen: true, lastChangedAt: NOW - 12 * MIN },
    })
    expect(m.measurement).toMatchObject({
      quantity: 'contact',
      value: { en: 'Open', it: 'Aperto' },
      unit: null,
      level: 1,
      since: NOW - 12 * MIN,
      sinceKind: 'changed',
      historyKey: null,
    })
    const never = build(DeviceType.Sensor, ['contact'], {
      contact: { entryOpen: false, lastChangedAt: 0 },
    })
    expect(never.measurement).toMatchObject({ since: null, level: 0 })
  })

  it('a humidity and a text state', () => {
    const h = build(DeviceType.Sensor, ['humidity-sensor'], {
      'humidity-sensor': { humidity: 58, lastFetchedAt: NOW },
    })
    expect(h.measurement).toMatchObject({ quantity: 'humidity', value: { en: '58' }, unit: '%' })
    const t = build(DeviceType.Sensor, ['enum-sensor'], {
      'enum-sensor': { value: 'Eco', lastFetchedAt: NOW },
    })
    expect(t.measurement).toMatchObject({ quantity: 'text', icon: null, value: { en: 'Eco' } })
  })

  it('two measuring caps, an offline sensor, a non-sensor or a missing value keep the old card', () => {
    const slices = {
      'temperature-sensor': { temperature: 21, lastFetchedAt: NOW },
      'humidity-sensor': { humidity: 40, lastFetchedAt: NOW },
    }
    expect(
      build(DeviceType.Sensor, ['temperature-sensor', 'humidity-sensor'], slices).measurement,
    ).toBeUndefined()
    expect(
      build(DeviceType.Sensor, ['temperature-sensor'], slices, [], false).measurement,
    ).toBeUndefined()
    expect(
      build(DeviceType.Switch, ['power-meter'], {
        'power-meter': { power: 40, lastFetchedAt: NOW },
      }).measurement,
    ).toBeUndefined()
    expect(
      build(DeviceType.Sensor, ['temperature-sensor'], {
        'temperature-sensor': { temperature: null, lastFetchedAt: NOW },
      }).measurement,
    ).toBeUndefined()
  })

  it('an energy, voltage or current sensor never shows the watts its slice also carries', () => {
    const withRole = (role: string) =>
      buildHeroModel({
        device: { id: 7, type: DeviceType.Sensor, role, name: 'Meter', online: true },
        caps: ['power-meter'],
        features: [],
        slices: {
          'power-meter': { power: 1221, energy: 42, voltage: 230, current: 5, lastFetchedAt: NOW },
        },
        now: NOW,
        remoteCommands: null,
        access: { canActuate: true },
      }).measurement
    expect(withRole('energy-sensor')).toBeUndefined()
    expect(withRole('voltage-sensor')).toBeUndefined()
    expect(withRole('current-sensor')).toBeUndefined()
    expect(withRole('power-sensor')).toMatchObject({ reading: { value: 1221, quantity: 'power' } })
  })

  it('a contact or a text carries no number to convert', () => {
    expect(
      build(DeviceType.Sensor, ['contact'], { contact: { entryOpen: true, lastChangedAt: NOW } })
        .measurement?.reading,
    ).toBeNull()
  })

  it('the row carries the same measurement', () => {
    const m = build(DeviceType.Sensor, ['temperature-sensor'], {
      'temperature-sensor': { temperature: 6.9, lastFetchedAt: NOW },
    })
    expect(projectDeviceRow(m).measurement).toEqual(m.measurement)
  })
})

describe('a control device edits what the row edits today', () => {
  const control = (slice: Record<string, unknown>) =>
    build(DeviceType.Control, ['control'], {
      control: { options: [], lastChangedAt: 0, ...slice },
    })

  it('a number without bounds is a number field, with bounds a slider', () => {
    const free = control({ kind: 'numeric', value: 2.5 })
    expect(rowOf(free, 'control').controls[0]).toMatchObject({
      kind: 'number',
      value: 2.5,
      step: null,
      valueArg: 'control.value',
      call: { cap: 'control', method: 'setValue', args: { control: { kind: 'numeric' } } },
    })
    const bounded = control({ kind: 'numeric', value: 2, min: 0, max: 10 })
    expect(rowOf(bounded, 'control').controls[0]?.kind).toBe('slider')
  })

  it('a choice is a picker, free text a text field, a date read-only', () => {
    const pick = control({ kind: 'select', value: 'Comfort', options: ['Eco', 'Comfort'] })
    expect(rowOf(pick, 'control').controls[0]?.kind).toBe('picker')
    const text = control({ kind: 'text', value: 'Back on Monday' })
    expect(rowOf(text, 'control').controls[0]).toMatchObject({
      kind: 'text',
      value: 'Back on Monday',
      call: { args: { control: { kind: 'text' } } },
    })
    const date = control({ kind: 'datetime', value: '2026-11-12T10:00:00Z' })
    expect(date.rows.some((r) => r.controls.length > 0)).toBe(false)
  })

  it('the row promotes the number field and the text field as its primary', () => {
    expect(projectDeviceRow(control({ kind: 'numeric', value: 2.5 })).primary?.kind).toBe('number')
    expect(projectDeviceRow(control({ kind: 'text', value: 'x' })).primary?.kind).toBe('text')
  })
})
