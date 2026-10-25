import { EXPRESSION_BUILTIN_NAMES } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import en from '../../../i18n/en.json'
import it_ from '../../../i18n/it.json'
import {
  applySuggestion,
  BUILTIN_SIGNATURES,
  expressionSuggestions,
} from '../expression-suggestions'

describe('what autocomplete offers (ruling 11)', () => {
  it('exactly the builtins that exist, each with a signature and a hint in both languages', () => {
    expect(Object.keys(BUILTIN_SIGNATURES).toSorted()).toEqual(
      [...EXPRESSION_BUILTIN_NAMES].toSorted(),
    )
    for (const name of EXPRESSION_BUILTIN_NAMES) {
      expect(en.compositionEditor.builtins).toHaveProperty(name)
      expect(it_.compositionEditor.builtins).toHaveProperty(name)
    }
  })
  it('never offers `for` — it does not exist', () => {
    expect(expressionSuggestions('fo', 2, []).map((s) => s.label)).toEqual([])
  })
  it('bindings first, then now, then builtins', () => {
    expect(expressionSuggestions('a', 1, ['avgTemp']).map((s) => s.label)).toEqual([
      'avgTemp',
      'abs(x)',
      'age(now, ts)',
      'all(a, b, …)',
      'any(a, b, …)',
      'avg(a, b, …)',
    ])
    expect(expressionSuggestions('n', 1, []).map((s) => s.label)).toEqual(['now', 'number(x)'])
  })
  it('replaces only the typed prefix and opens the call', () => {
    const avg = expressionSuggestions('round(av', 8, []).find((s) => s.label.startsWith('avg'))
    if (avg === undefined) throw new Error('no avg')
    expect(applySuggestion('round(av, 1)', 8, avg)).toEqual({ text: 'round(avg(, 1)', cursor: 10 })
  })
})
