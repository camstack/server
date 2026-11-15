import { DEVICE_TEMPLATE_CATALOGUE } from '@camstack/types/device-template-catalogue'
import { describe, expect, it } from 'vitest'
import {
  applyTemplateSuggestion,
  templateCaretContext,
  templateFieldSource,
  templateSuggestions,
  templateSuggestTrigger,
  type TemplateSuggestionInput,
} from '../device-template-model'

const INPUT: TemplateSuggestionInput = {
  aliases: [],
  fields: [],
  includeCamera: false,
  entries: DEVICE_TEMPLATE_CATALOGUE,
  cameraValues: [],
  rootVariables: [],
}

function at(text: string): { value: string; caret: number } {
  const caret = text.indexOf('^')
  return { value: text.replace('^', ''), caret }
}

describe('argument context', () => {
  it('sees the caret inside the parentheses of a piped call', () => {
    const { value, caret } = at('{{ garage.temp | unit(^')
    expect(templateCaretContext(value, caret)).toMatchObject({
      kind: 'argument',
      filter: 'unit',
      index: 0,
      typed: '',
      quote: null,
      source: { alias: 'garage', path: 'temp' },
    })
  })

  it('counts the argument and keeps what is typed inside the opening quote', () => {
    const { value, caret } = at("{{ garage.temp | unit('°C', '^")
    expect(templateCaretContext(value, caret)).toMatchObject({
      index: 1,
      quote: "'",
      typed: '',
    })
    const second = at("{{ x.y | unit('°^")
    expect(templateCaretContext(second.value, second.caret)).toMatchObject({
      index: 0,
      typed: '°',
      prefix: "'°",
    })
  })

  it('is not an argument once the call is closed, or the string is', () => {
    const closed = at("{{ x.y | unit('°C')^")
    expect(templateCaretContext(closed.value, closed.caret).kind).toBe('filter')
    const string = at("{{ x.y | unit('°C'^")
    expect(templateCaretContext(string.value, string.caret).kind).toBe('none')
  })

  it('keeps a comma inside quotes in the same argument', () => {
    const { value, caret } = at("{{ x.y | replace('a,^")
    expect(templateCaretContext(value, caret)).toMatchObject({
      index: 0,
      typed: 'a,',
    })
  })

  it('has no field source for a variable or a typed expression', () => {
    const a = at('{{ now | time(^')
    expect(templateFieldSource(a.value, a.caret)).toBeNull()
    const b = at('{{ g.t | round(1) | unit(^')
    expect(templateFieldSource(b.value, b.caret)).toEqual({
      alias: 'g',
      path: 't',
    })
  })

  it('opens the list by itself on `(` and on an empty quote, not mid-word', () => {
    expect(templateSuggestTrigger('{{ g.t | unit(', 14)).toBe(true)
    expect(templateSuggestTrigger("{{ g.t | unit('", 15)).toBe(true)
    expect(templateSuggestTrigger("{{ g.t | unit('°", 16)).toBe(false)
  })
})

describe('argument suggestions', () => {
  it('offers the units of the field dimension, quoted', () => {
    const { value, caret } = at('{{ g.t | unit(^')
    const rows = templateSuggestions(templateCaretContext(value, caret), {
      ...INPUT,
      fieldUnit: '°C',
    })
    expect(rows.map((r) => r.label)).toEqual(expect.arrayContaining(['°C', '°F', 'K']))
    expect(rows.map((r) => r.label)).not.toContain('hPa')
    expect(rows.find((r) => r.label === '°F')?.replacement).toBe("'°F'")
  })

  it('falls back to every unit when the field unit is unknown', () => {
    const { value, caret } = at('{{ g.t | unit(^')
    const rows = templateSuggestions(templateCaretContext(value, caret), INPUT)
    expect(rows.map((r) => r.label)).toEqual(expect.arrayContaining(['°C', 'hPa']))
  })

  it('narrows by what is typed after the quote', () => {
    const { value, caret } = at("{{ now | time('HH:^")
    const rows = templateSuggestions(templateCaretContext(value, caret), INPUT)
    expect(rows.map((r) => r.label)).toEqual(['HH:mm', 'HH:mm:ss'])
  })

  it('offers digits as bare numbers and nothing for a free parameter', () => {
    const digits = at('{{ g.t | round(^')
    const rows = templateSuggestions(templateCaretContext(digits.value, digits.caret), INPUT)
    expect(rows.map((r) => r.replacement)).toEqual(['0', '1', '2', '3', '4'])
    const free = at('{{ g.t | replace(^')
    expect(templateSuggestions(templateCaretContext(free.value, free.caret), INPUT)).toEqual([])
  })

  it('inserts the quoted literal over what was typed, eating a quote already closed after the caret', () => {
    const { value, caret } = at("{{ now | time('HH^') }}")
    const ctx = templateCaretContext(value, caret)
    const pick = templateSuggestions(ctx, INPUT).find((r) => r.label === 'HH:mm')
    expect(pick).toBeDefined()
    const result = applyTemplateSuggestion(value, caret, ctx, pick?.replacement ?? '')
    expect(result.value).toBe("{{ now | time('HH:mm') }}")
    expect(result.cursor).toBe("{{ now | time('HH:mm'".length)
  })

  it('replaces a bare caret with the whole literal', () => {
    const { value, caret } = at('{{ g.t | unit(^')
    const ctx = templateCaretContext(value, caret)
    const result = applyTemplateSuggestion(value, caret, ctx, "'°F'")
    expect(result.value).toBe("{{ g.t | unit('°F'")
  })
})
