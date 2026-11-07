import { describe, expect, it } from 'vitest'
import { resolveTemplateRef, templateCapKey, type DeviceTemplateView } from '../device-template.js'

const view: DeviceTemplateView = {
  deviceId: 7,
  addonId: 'provider-x',
  stableId: 'stove-1',
  slices: {
    'temperature-sensor': { value: 21.5, online: true, history: { last: 3 } },
    switch: { on: true, online: true },
  },
}

describe('resolveTemplateRef', () => {
  it('resolves alias.field when the field name is unique across the caps', () => {
    expect(resolveTemplateRef(view, ['value'])).toEqual({
      kind: 'value',
      cap: 'temperature-sensor',
      fieldPath: ['value'],
      value: 21.5,
    })
    expect(resolveTemplateRef(view, ['on'])).toMatchObject({
      kind: 'value',
      cap: 'switch',
      value: true,
    })
  })

  it('walks into a nested field', () => {
    expect(resolveTemplateRef(view, ['history', 'last'])).toMatchObject({ kind: 'value', value: 3 })
  })

  it('refuses an ambiguous alias.field by name and lists the caps', () => {
    expect(resolveTemplateRef(view, ['online'])).toEqual({
      kind: 'ambiguous',
      field: 'online',
      caps: ['temperature-sensor', 'switch'],
    })
  })

  it('accepts alias.<cap>.field, hyphen or underscore spelled', () => {
    expect(resolveTemplateRef(view, ['switch', 'online'])).toMatchObject({
      kind: 'value',
      value: true,
    })
    expect(templateCapKey('temperature-sensor')).toBe('temperature_sensor')
    expect(resolveTemplateRef(view, ['temperature_sensor', 'online'])).toMatchObject({
      kind: 'value',
      cap: 'temperature-sensor',
      value: true,
    })
  })

  it('answers missing for an unknown field, an absent value and an empty path', () => {
    expect(resolveTemplateRef(view, ['nope'])).toEqual({ kind: 'missing', reason: 'unknown-field' })
    expect(resolveTemplateRef(view, ['switch', 'nope'])).toEqual({
      kind: 'missing',
      reason: 'unknown-field',
    })
    expect(resolveTemplateRef(view, [])).toEqual({ kind: 'missing', reason: 'no-field' })
  })
})
