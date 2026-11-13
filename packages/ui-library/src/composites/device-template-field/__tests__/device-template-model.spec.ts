import { describe, expect, it } from 'vitest'
import {
  applyTemplateSuggestion,
  carriesDeviceTemplate,
  deviceTemplateToken,
  fieldAccepts,
  formatCatalogueArgs,
  insertCatalogueCall,
  insertTemplateToken,
  parseTemplateSegments,
  templateCaretContext,
  templateSuggestions,
  templateSuggestTrigger,
  textForDeviceCheck,
} from '../device-template-model'
import type { DeviceTemplateParam } from '@camstack/types/device-template-catalogue'

describe('parseTemplateSegments', () => {
  it('splits text and device references, and re-joins to the input', () => {
    const text = 'Now {{ stufa.temperature | round(1) }} in {{ salotto.climate.mode }}!'
    const segments = parseTemplateSegments(text)
    expect(segments.map((s) => s.kind)).toEqual(['text', 'ref', 'text', 'ref', 'text'])
    expect(segments.map((s) => (s.kind === 'text' ? s.text : s.raw)).join('')).toBe(text)
    expect(segments[1]).toMatchObject({ alias: 'stufa', path: 'temperature' })
    expect(segments[3]).toMatchObject({ alias: 'salotto', path: 'climate.mode' })
  })

  it('leaves the consumer slots as text: {{camera}} and {{vars.x}} are not devices', () => {
    const segments = parseTemplateSegments('{{camera}} {{ vars.portion }}')
    expect(segments.every((s) => s.kind === 'text')).toBe(true)
  })
})

describe('fieldAccepts', () => {
  it('a number slot takes numbers only, a yes/no slot booleans only', () => {
    expect(fieldAccepts('number', 'number')).toBe(true)
    expect(fieldAccepts('number', 'string')).toBe(false)
    expect(fieldAccepts('boolean', 'boolean')).toBe(true)
    expect(fieldAccepts('boolean', 'enum')).toBe(false)
  })
  it('a text slot prints any kind', () => {
    for (const kind of ['string', 'number', 'boolean', 'enum']) {
      expect(fieldAccepts('string', kind)).toBe(true)
      expect(fieldAccepts('any', kind)).toBe(true)
    }
  })
})

describe('deviceTemplateToken', () => {
  const caps = [
    { cap: 'temperature-sensor', paths: ['temperature', 'label'] },
    { cap: 'climate', paths: ['temperature', 'mode'] },
  ]
  it('writes the short form when exactly one cap carries the field', () => {
    expect(deviceTemplateToken('stufa', { cap: 'climate', path: 'mode' }, caps)).toBe(
      '{{ stufa.mode }}',
    )
  })
  it('spells the cap out (underscored) when the field name is on several caps', () => {
    expect(
      deviceTemplateToken('stufa', { cap: 'temperature-sensor', path: 'temperature' }, caps),
    ).toBe('{{ stufa.temperature_sensor.temperature }}')
  })
  it('appends unit() when a display unit is passed', () => {
    expect(deviceTemplateToken('garage', { cap: 'climate', path: 'temperature' }, caps, '°C')).toBe(
      "{{ garage.climate.temperature | unit('°C') }}",
    )
    expect(
      deviceTemplateToken(
        'garage',
        { cap: 'temperature-sensor', path: 'temperature' },
        caps,
        "O'Brien",
      ),
    ).toBe("{{ garage.temperature_sensor.temperature | unit('O\\'Brien') }}")
  })
})

describe('insertTemplateToken', () => {
  it('replaces the selection and lands the caret after the token', () => {
    expect(insertTemplateToken('hello world', { start: 6, end: 11 }, '{{rule}}')).toEqual({
      value: 'hello {{rule}}',
      cursor: 14,
    })
  })
  it('clamps a stale selection to an append', () => {
    expect(insertTemplateToken('ab', { start: 9, end: 9 }, '{{x}}')).toEqual({
      value: 'ab{{x}}',
      cursor: 7,
    })
  })
})

describe('template caret context', () => {
  it('names the context and the prefix at the caret', () => {
    expect(templateCaretContext('hello', 5)).toEqual({ kind: 'none' })
    expect(templateCaretContext('{{ ', 3)).toEqual({ kind: 'expression', prefix: '' })
    expect(templateCaretContext('{{ cam', 6)).toEqual({ kind: 'expression', prefix: 'cam' })
    expect(templateCaretContext('{{ camera.', 10)).toEqual({
      kind: 'field',
      alias: 'camera',
      prefix: '',
    })
    expect(templateCaretContext('{{ camera.temp', 14)).toEqual({
      kind: 'field',
      alias: 'camera',
      prefix: 'temp',
    })
    expect(templateCaretContext('{{ camera.temperature | ', 24)).toEqual({
      kind: 'filter',
      prefix: '',
    })
    expect(templateCaretContext('{{ camera.temperature | ro', 26)).toEqual({
      kind: 'filter',
      prefix: 'ro',
    })
    expect(templateCaretContext('{{ a.b }} more', 13)).toEqual({ kind: 'none' })
  })

  it('opens by itself after {{, | or alias.', () => {
    expect(templateSuggestTrigger('{{', 2)).toBe(true)
    expect(templateSuggestTrigger('{{ camera.temperature |', 24)).toBe(true)
    expect(templateSuggestTrigger('{{ camera.', 10)).toBe(true)
    expect(templateSuggestTrigger('hello', 5)).toBe(false)
  })
})

describe('insertCatalogueCall', () => {
  const round = { kind: 'filter' as const, name: 'round', args: [] }
  it('pipes a filter onto the expression under the caret', () => {
    expect(insertCatalogueCall('{{ stufa.temperature', 20, round).value).toBe(
      '{{ stufa.temperature | round',
    )
  })
  it('replaces a half-typed filter instead of adding a second pipe', () => {
    expect(insertCatalogueCall('{{ stufa.temperature | ro', 25, round).value).toBe(
      '{{ stufa.temperature | round',
    )
  })
  it('wraps a new expression and selects the placeholder when the caret is outside', () => {
    const inserted = insertCatalogueCall('hello', 5, round)
    expect(inserted.value).toBe('hello{{ value | round }}')
    expect(inserted.select).toEqual({ start: 8, end: 13 })
  })
})

describe('templateSuggestions', () => {
  const input = {
    aliases: [{ alias: 'stufa', label: 'Stufa' }],
    fields: [{ path: 'temperature', kind: 'number' }],
    includeCamera: true,
    entries: [],
    cameraValues: ['lastPerson'],
    rootVariables: ['now', 'camera', 'loop'],
  }
  it('offers aliases and variables inside {{, fields after a dot, functions after a pipe', () => {
    const inside = templateSuggestions(templateCaretContext('{{ ', 3), input)
    expect(inside.map((item) => item.label)).toContain('stufa')
    expect(inside.map((item) => item.label)).toContain('camera')
    const fields = templateSuggestions(templateCaretContext('{{ camera.', 10), input)
    expect(fields.map((item) => item.label)).toEqual(['temperature', 'lastPerson'])
    const applied = applyTemplateSuggestion('{{ st', 5, templateCaretContext('{{ st', 5), 'stufa')
    expect(applied.value).toBe('{{ stufa')
  })
})

describe('formatCatalogueArgs', () => {
  const params: readonly DeviceTemplateParam[] = [
    { name: 'symbol', type: 'string', optional: false },
    { name: 'from', type: 'string', optional: true },
  ]
  it('quotes strings and drops a trailing optional that was left empty', () => {
    expect(formatCatalogueArgs(params, { symbol: '°C' })).toEqual(["'°C'"])
  })
})

describe('what the hub is asked to vet', () => {
  it('sets only {{ vars.x }} aside by default, as an action run does', () => {
    expect(textForDeviceCheck('{{camera}} {{ vars.x }} {{ a.b }}')).toBe('{{camera}} · {{ a.b }}')
    expect(carriesDeviceTemplate('Motion on {{camera}}')).toBe(true)
    expect(carriesDeviceTemplate('Now {{ vars.x }}')).toBe(false)
  })
  it('a notification text also holds its bare {{name}} variables', () => {
    expect(textForDeviceCheck('{{camera}} {{ vars.x }} {{ a.b }}', 'placeholders')).toBe(
      '· · {{ a.b }}',
    )
    expect(carriesDeviceTemplate('Motion on {{camera}}', 'placeholders')).toBe(false)
    expect(carriesDeviceTemplate('Now {{ a.b }}', 'placeholders')).toBe(true)
  })
})
