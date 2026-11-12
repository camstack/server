import { describe, expect, it } from 'vitest'
import { colorCapability } from '../../../capabilities/color.cap.js'
import { controlCapability } from '../../../capabilities/control.cap.js'
import { DeviceFeature, DeviceType } from '../../device-type.js'
import { HeroActionSchema, HeroArgsSchema, heroArgsWithValue } from '../hero-model.js'
import { actionsOf, build, rowOf } from './hero-test-kit.js'

const action = (args: unknown) => ({
  id: 'a',
  label: { en: 'A', it: 'A' },
  icon: 'power',
  call: { cap: 'color', method: 'setColor', args },
  emphasis: 'normal',
  confirm: null,
})

describe('hero args', () => {
  it('carry a nested object of scalars', () => {
    expect(
      HeroArgsSchema.safeParse({ color: { mode: 'hsv', hsv: { h: 120, s: 100, v: 100 } } }).success,
    ).toBe(true)
    expect(
      HeroActionSchema.safeParse(action({ color: { mode: 'mired', colorTemperature: 370 } }))
        .success,
    ).toBe(true)
  })

  it('refuse what is not a scalar or a nested object of scalars', () => {
    expect(HeroArgsSchema.safeParse({ color: [1, 2] }).success).toBe(false)
    expect(HeroArgsSchema.safeParse({ color: { h: null } }).success).toBe(false)
    expect(HeroArgsSchema.safeParse({ color: { h: { s: undefined } } }).success).toBe(false)
  })

  it('heroArgsWithValue sets a dotted path without touching the original', () => {
    const base = { control: { kind: 'numeric' }, other: 1 }
    const next = heroArgsWithValue(base, 'control.value', 21)
    expect(next).toEqual({ control: { kind: 'numeric', value: 21 }, other: 1 })
    expect(base).toEqual({ control: { kind: 'numeric' }, other: 1 })
    expect(heroArgsWithValue({}, 'level', 5)).toEqual({ level: 5 })
  })
})

describe('light colour control', () => {
  const slices = {
    switch: { on: true, lastChangedAt: 1 },
    color: { mode: 'hsv', hsv: { h: 10, s: 80, v: 60 }, lastChangedAt: 1 },
  }
  const caps = ['switch', 'color']

  it('offers colour-temperature presets when the bulb takes mireds, each a valid setColor input', () => {
    const m = build(DeviceType.Light, caps, slices, [DeviceFeature.LightColorMired])
    const acts = actionsOf(rowOf(m, 'color').controls)
    expect(acts.map((a) => a.id)).toEqual(['color.warm', 'color.neutral', 'color.cool'])
    for (const a of acts) {
      expect(a.call).toMatchObject({ cap: 'color', method: 'setColor' })
      const parsed = colorCapability.methods.setColor.input.safeParse({
        deviceId: 7,
        ...a.call.args,
      })
      expect(parsed.success).toBe(true)
    }
  })

  it('offers hue presets when the bulb takes hsv, keeping the current saturation and value', () => {
    const m = build(DeviceType.Light, caps, slices, [DeviceFeature.LightColorHsv])
    const acts = actionsOf(rowOf(m, 'color').controls)
    expect(acts.length).toBeGreaterThan(2)
    for (const a of acts) {
      const parsed = colorCapability.methods.setColor.input.safeParse({
        deviceId: 7,
        ...a.call.args,
      })
      expect(parsed.success).toBe(true)
    }
    expect(acts[0]?.call.args).toMatchObject({ color: { mode: 'hsv', hsv: { s: 80, v: 60 } } })
  })

  it('offers nothing to set when the bulb declares no colour mode', () => {
    const m = build(DeviceType.Light, caps, slices, [])
    expect(actionsOf(rowOf(m, 'color').controls)).toEqual([])
  })
})

describe('control hero', () => {
  const numeric = {
    kind: 'numeric',
    value: 21,
    options: [],
    lastChangedAt: 1,
    min: 16,
    max: 30,
    step: 1,
  }
  const select = { kind: 'select', value: 'eco', options: ['eco', 'comfort'], lastChangedAt: 1 }

  it('a numeric control is a slider whose value lands inside the nested control argument', () => {
    const c = rowOf(build(DeviceType.Control, ['control'], { control: numeric }), 'control')
      .controls[0]
    if (c?.kind !== 'slider') throw new Error('expected a slider')
    expect([c.min, c.max, c.step, c.value]).toEqual([16, 30, 1, 21])
    const args = heroArgsWithValue(c.call.args, c.valueArg, 22)
    expect(
      controlCapability.methods.setValue.input.safeParse({ deviceId: 7, ...args }).success,
    ).toBe(true)
    expect(args).toEqual({ control: { kind: 'numeric', value: 22 } })
  })

  it('a select control is a picker over its options', () => {
    const c = rowOf(build(DeviceType.Control, ['control'], { control: select }), 'control')
      .controls[0]
    if (c?.kind !== 'picker') throw new Error('expected a picker')
    expect(c.options).toEqual(['eco', 'comfort'])
    const args = heroArgsWithValue(c.call.args, c.valueArg, 'comfort')
    expect(
      controlCapability.methods.setValue.input.safeParse({ deviceId: 7, ...args }).success,
    ).toBe(true)
  })

  it('a text control is a text field; a date control stays read-only', () => {
    const m = build(DeviceType.Control, ['control'], {
      control: { kind: 'text', value: 'hi', options: [], lastChangedAt: 1 },
    })
    expect(m.rows.find((r) => r.id === 'control')?.controls[0]?.kind).toBe('text')
    const d = build(DeviceType.Control, ['control'], {
      control: { kind: 'datetime', value: '2026-01-01T00:00:00Z', options: [], lastChangedAt: 1 },
    })
    expect(d.rows.some((r) => r.id === 'control')).toBe(false)
  })
})
