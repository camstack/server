import type { OsdNamedTemplate, OsdSourceOption } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { preferredField, resolveAdaptiveFields } from '../adaptive-field.js'
import {
  applyTemplateTokenKind,
  expandBindingTokens,
  renderNamedTemplate,
  resolveBindingLive,
} from '../named-template-render.js'
import {
  aliasToken,
  bindingInsertChips,
  parseAliasStems,
  parseAliasTokens,
  suggestAlias,
} from '../template-tokens.js'
import { convertForDisplay, dimensionFromSourceUnit } from '../unit-display.js'

describe('parseAliasTokens', () => {
  it('extracts unique alias tokens with kinds', () => {
    expect(parseAliasTokens('{t} / {h.value} · {t.unit} · {t}')).toEqual([
      { alias: 't', kind: 'full', token: '{t}' },
      { alias: 'h', kind: 'value', token: '{h.value}' },
      { alias: 't', kind: 'unit', token: '{t.unit}' },
    ])
  })

  it('treats {alias.full} as full', () => {
    expect(parseAliasTokens('{t.full}')).toEqual([{ alias: 't', kind: 'full', token: '{t.full}' }])
  })

  it('lists unique stems', () => {
    expect(parseAliasStems('{t.value} {t.unit} / {h}')).toEqual(['t', 'h'])
  })
})

describe('applyTemplateTokenKind', () => {
  it('picks value | unit | full without a space between value and unit', () => {
    expect(applyTemplateTokenKind('21.5', '°C', 'full')).toBe('21.5°C')
    expect(applyTemplateTokenKind('21.5', '°C', 'value')).toBe('21.5')
    expect(applyTemplateTokenKind('21.5', '°C', 'unit')).toBe('°C')
  })
})

describe('bindingInsertChips', () => {
  it('offers value, unit, and value+unit inserts from one binding', () => {
    expect(bindingInsertChips({ alias: 't' }).map((c) => c.token)).toEqual([
      '{t.value}',
      '{t.unit}',
      '{t.full}',
    ])
  })
})

describe('renderNamedTemplate', () => {
  it('substitutes token kinds from the same binding + unit conversion', () => {
    const template: OsdNamedTemplate = {
      id: 'outdoor',
      name: 'Outdoor',
      bindings: [
        {
          alias: 't',
          pick: { deviceId: 12 },
          capName: 'thermometer',
          valuePath: 'value',
          displayUnit: '°F',
          maxDecimals: 1,
        },
        {
          alias: 'h',
          pick: { containerId: 1, deviceId: 13 },
          capName: 'humidity-sensor',
          valuePath: 'value',
          maxDecimals: 0,
        },
      ],
      parser: 'T {t.value}{t.unit} H {h.full}',
    }
    const stateByDevice = new Map<number, Record<string, unknown>>([
      [12, { thermometer: { value: 20, unit: '°C' } }],
      [13, { 'humidity-sensor': { value: 55.9, unit: '%' } }],
    ])
    const out = renderNamedTemplate(template, { stateByDevice })
    expect(out).toEqual({ text: 'T 68°F H 55%' })
  })

  it('expands bare {alias} as full (value+unit)', () => {
    const template: OsdNamedTemplate = {
      id: 'bare',
      name: 'Bare',
      bindings: [
        {
          alias: 't',
          pick: { deviceId: 12 },
          capName: 'thermometer',
          valuePath: 'value',
          maxDecimals: 1,
        },
      ],
      parser: '{t}',
    }
    const stateByDevice = new Map<number, Record<string, unknown>>([
      [12, { thermometer: { value: 20, unit: 'C' } }],
    ])
    expect(renderNamedTemplate(template, { stateByDevice })).toEqual({
      text: '20°C',
    })
  })

  it('names a missing device rather than leaving the token', () => {
    const template: OsdNamedTemplate = {
      id: 'x',
      name: 'X',
      bindings: [
        {
          alias: 't',
          pick: { deviceId: 99 },
          capName: 'thermometer',
          valuePath: 'value',
          maxDecimals: 1,
        },
      ],
      parser: '{t}',
    }
    expect(renderNamedTemplate(template, { stateByDevice: new Map() })).toEqual({
      reason: 'no state mirrored for device 99',
    })
  })

  it('exposes live parts for one binding', () => {
    const live = resolveBindingLive(
      {
        alias: 't',
        pick: { deviceId: 12 },
        capName: 'thermometer',
        valuePath: 'value',
        displayUnit: '°F',
        maxDecimals: 1,
      },
      { stateByDevice: new Map([[12, { thermometer: { value: 20, unit: '°C' } }]]) },
    )
    expect(live).toEqual({ value: '68', unit: '°F', formatted: '68°F' })
  })

  it('applies valueMap before decimals/unit (empty string hides)', () => {
    const stateByDevice = new Map<number, Record<string, unknown>>([
      [7, { motion: { detected: true } }],
    ])
    const mapped = resolveBindingLive(
      {
        alias: 'm',
        pick: { deviceId: 7 },
        capName: 'motion',
        valuePath: 'detected',
        maxDecimals: 1,
        valueMap: { true: 'MOTION', false: '' },
      },
      { stateByDevice },
    )
    expect(mapped).toEqual({ value: 'MOTION', unit: '', formatted: 'MOTION' })

    const hidden = resolveBindingLive(
      {
        alias: 'm',
        pick: { deviceId: 7 },
        capName: 'motion',
        valuePath: 'detected',
        maxDecimals: 1,
        valueMap: { true: '', false: 'still' },
      },
      { stateByDevice },
    )
    expect(hidden).toEqual({ value: '', unit: '', formatted: '' })
  })

  it('expands all token forms without crosstalk', () => {
    const text = expandBindingTokens('{t.full}|{t.value}|{t.unit}|{t}', 't', {
      value: '21',
      unit: '°C',
      formatted: '21°C',
    })
    expect(text).toBe('21°C|21|°C|21°C')
  })
})

describe('convertForDisplay', () => {
  it('converts °C to °F', () => {
    expect(convertForDisplay(20, '°C', '°F')).toEqual({ value: 68, unit: '°F' })
  })

  it('normalizes bare C before convert', () => {
    expect(convertForDisplay(20, 'C', '°F')).toEqual({ value: 68, unit: '°F' })
  })

  it('keeps source unit on cross-dimension refusal', () => {
    expect(convertForDisplay(20, '°C', 'hPa')).toEqual({ value: 20, unit: '°C' })
  })
})

describe('dimensionFromSourceUnit', () => {
  it('resolves temperature from bare C', () => {
    expect(dimensionFromSourceUnit('C')).toBe('temperature')
  })

  it('returns undefined for unknown units', () => {
    expect(dimensionFromSourceUnit('nope')).toBeUndefined()
  })
})

describe('resolveAdaptiveFields', () => {
  const options: OsdSourceOption[] = [
    {
      deviceId: 1,
      deviceName: 'A',
      capName: 'binary-sensor',
      valuePath: 'value',
      label: 'Binary · value',
      valueType: 'boolean',
    },
    {
      deviceId: 2,
      deviceName: 'B',
      capName: 'climate',
      valuePath: 'temperature',
      label: 'Climate · temperature',
      valueType: 'number',
    },
    {
      deviceId: 2,
      deviceName: 'B',
      capName: 'climate',
      valuePath: 'humidity',
      label: 'Climate · humidity',
      valueType: 'number',
    },
  ]

  it('auto-selects a single-metric device', () => {
    const d = resolveAdaptiveFields(options, 1)
    expect(d.mode).toBe('auto')
    expect(d.auto?.valuePath).toBe('value')
  })

  it('requires a pick for multi-field climate', () => {
    const d = resolveAdaptiveFields(options, 2)
    expect(d.mode).toBe('pick')
    expect(d.fields).toHaveLength(2)
    expect(preferredField(d.fields)?.valuePath).toBe('temperature')
  })

  it('builds an alias token', () => {
    expect(aliasToken('t')).toBe('{t}')
    expect(aliasToken('t', 'value')).toBe('{t.value}')
  })

  it('suggests unique aliases', () => {
    expect(suggestAlias('Outdoor Temp', new Set())).toBe('outdoor_temp')
    expect(suggestAlias('Outdoor Temp', new Set(['outdoor_temp']))).toBe('outdoor_temp2')
  })
})
