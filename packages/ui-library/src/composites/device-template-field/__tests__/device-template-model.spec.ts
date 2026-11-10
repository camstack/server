import { describe, expect, it } from 'vitest'
import {
  carriesDeviceTemplate,
  deviceTemplateToken,
  fieldAccepts,
  insertTemplateToken,
  parseTemplateSegments,
  textForDeviceCheck,
} from '../device-template-model'

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
