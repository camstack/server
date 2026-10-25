/**
 * Formula autocomplete (spec §3, D676 ruling 11). It offers only what the
 * engine has: the binding names, `now`, and every builtin in
 * `EXPRESSION_BUILTIN_NAMES` — a spec pins the signature table to that set, so
 * a builtin added to the engine without a hint fails CI, and a mockup's `for`
 * (which does not exist) can never be offered.
 */
import { EXPRESSION_BUILTIN_NAMES, EXPRESSION_INJECTED_NOW } from '@camstack/types'

export type SuggestionKind = 'binding' | 'now' | 'builtin'

export interface ExpressionSuggestion {
  readonly kind: SuggestionKind
  readonly label: string
  readonly insert: string
  readonly hintKey: string | null
}

export const BUILTIN_SIGNATURES: Readonly<Record<string, string>> = {
  min: 'min(a, b, …)',
  max: 'max(a, b, …)',
  abs: 'abs(x)',
  floor: 'floor(x)',
  ceil: 'ceil(x)',
  sqrt: 'sqrt(x)',
  round: 'round(x, digits?)',
  pow: 'pow(x, y)',
  clamp: 'clamp(x, lo, hi)',
  avg: 'avg(a, b, …)',
  sum: 'sum(a, b, …)',
  coalesce: 'coalesce(a, b, …)',
  age: 'age(now, ts)',
  convert: 'convert(x, "from", "to")',
  any: 'any(a, b, …)',
  all: 'all(a, b, …)',
  within: 'within(ts, ms)',
  number: 'number(x)',
  latest: 'latest(ts, …)',
  rose: 'rose(level, changedAt, debounceMs?)',
  count: 'count(x)',
  dwell: 'dwell(active, onForMs, offForMs)',
  latchedAt: 'latchedAt(value)',
}

export const MAX_SUGGESTIONS = 8

const PREFIX_RE = /[A-Za-z_][A-Za-z0-9_]*$/

export function expressionSuggestions(
  text: string,
  cursor: number,
  bindings: readonly string[],
): readonly ExpressionSuggestion[] {
  const prefix = PREFIX_RE.exec(text.slice(0, cursor))?.[0] ?? ''
  if (prefix === '') return []
  const fromBindings: ExpressionSuggestion[] = bindings
    .filter((b) => b.startsWith(prefix))
    .toSorted()
    .map((b) => ({ kind: 'binding', label: b, insert: b, hintKey: null }))
  const fromNow: ExpressionSuggestion[] = EXPRESSION_INJECTED_NOW.startsWith(prefix)
    ? [
        {
          kind: 'now',
          label: EXPRESSION_INJECTED_NOW,
          insert: EXPRESSION_INJECTED_NOW,
          hintKey: 'compositionEditor.now',
        },
      ]
    : []
  const fromBuiltins: ExpressionSuggestion[] = [...EXPRESSION_BUILTIN_NAMES]
    .filter((name) => name.startsWith(prefix))
    .toSorted()
    .map((name) => ({
      kind: 'builtin',
      label: BUILTIN_SIGNATURES[name] ?? name,
      insert: `${name}(`,
      hintKey: `compositionEditor.builtins.${name}`,
    }))
  return [...fromBindings, ...fromNow, ...fromBuiltins].slice(0, MAX_SUGGESTIONS)
}

export interface SuggestionApplied {
  readonly text: string
  readonly cursor: number
}

export function applySuggestion(
  text: string,
  cursor: number,
  suggestion: ExpressionSuggestion,
): SuggestionApplied {
  const prefix = PREFIX_RE.exec(text.slice(0, cursor))?.[0] ?? ''
  const start = cursor - prefix.length
  return {
    text: `${text.slice(0, start)}${suggestion.insert}${text.slice(cursor)}`,
    cursor: start + suggestion.insert.length,
  }
}
