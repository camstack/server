/**
 * Readable one-liners for a generic composition card field.
 */
import {
  compositionSourceKey,
  type CompositionExpressionSource,
  type FieldAggregateKind,
} from '@camstack/types'
import { vocabularyFieldLabel } from '../vocabulary-field-label'

export type AggregateMessageKey =
  | 'customize.fieldsCard.aggregate.avg'
  | 'customize.fieldsCard.aggregate.latest'

export function aggregateMessageKey(kind: FieldAggregateKind): AggregateMessageKey {
  return kind === 'avg-round-1'
    ? 'customize.fieldsCard.aggregate.avg'
    : 'customize.fieldsCard.aggregate.latest'
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function replaceBinding(expr: string, name: string, readable: string): string {
  const pattern = new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(name)}(?![A-Za-z0-9_])`, 'g')
  return expr.replace(pattern, () => readable)
}

/** The expression with each binding written as "device · field label". */
export function formulaOneLiner(
  expr: string,
  bindings: CompositionExpressionSource['bindings'],
  names: ReadonlyMap<string, string>,
  language: string,
  unknownDevice: string,
): string {
  const keys = Object.keys(bindings).toSorted((a, b) => b.length - a.length)
  let text = expr
  for (const name of keys) {
    const binding = bindings[name]
    if (binding === undefined || binding.kind !== 'from') continue
    const device = names.get(compositionSourceKey(binding.source)) ?? unknownDevice
    const field = vocabularyFieldLabel(binding.cap, binding.fieldPath, language)
    text = replaceBinding(text, name, `${device} · ${field}`)
  }
  return humaniseDurations(text)
}

const SECOND_MS = 1000
const MINUTE_MS = 60 * SECOND_MS
const HOUR_MS = 60 * MINUTE_MS

/** Argument indexes that are a duration in milliseconds. */
const DURATION_ARG_INDEX: Readonly<Record<string, readonly number[]>> = {
  within: [1],
  dwell: [1, 2],
  rose: [2],
}

interface CallArg {
  readonly text: string
}

interface DurationCall {
  readonly name: string
  readonly close: number
  readonly args: readonly CallArg[]
}

interface ParsedArgs {
  readonly args: CallArg[]
  readonly close: number
}

function durationPhrase(ms: number): string | null {
  if (!Number.isInteger(ms) || ms < SECOND_MS) return null
  if (ms % HOUR_MS === 0) {
    const hours = ms / HOUR_MS
    return hours === 1 ? '1 h' : `${hours} h`
  }
  if (ms % MINUTE_MS === 0) {
    const minutes = ms / MINUTE_MS
    return minutes === 1 ? '1 min' : `${minutes} min`
  }
  if (ms % SECOND_MS === 0) {
    const seconds = ms / SECOND_MS
    return seconds === 1 ? '1 s' : `${seconds} s`
  }
  return null
}

function literalDuration(text: string): string | null {
  if (!/^\d+$/.test(text.trim())) return null
  return durationPhrase(Number(text.trim()))
}

function parseArgs(source: string, openParen: number): ParsedArgs | null {
  let depth = 1
  let start = openParen + 1
  let quote: string | null = null
  const args: CallArg[] = []
  for (let i = openParen + 1; i < source.length; i += 1) {
    const ch = source[i] ?? ''
    if (quote !== null) {
      if (ch === '\\') {
        i += 1
        continue
      }
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === '(') {
      depth += 1
      continue
    }
    if (ch === ')') {
      depth -= 1
      if (depth === 0) {
        const text = source.slice(start, i)
        if (!(args.length === 0 && text.trim() === '')) args.push({ text })
        return { args, close: i }
      }
      continue
    }
    if (ch === ',' && depth === 1) {
      args.push({ text: source.slice(start, i) })
      start = i + 1
    }
  }
  return null
}

function durationCallAt(expr: string, index: number): DurationCall | null {
  const prev = expr[index - 1]
  if (prev !== undefined && /[A-Za-z0-9_]/.test(prev)) return null
  for (const name of Object.keys(DURATION_ARG_INDEX)) {
    if (!expr.startsWith(name, index)) continue
    const after = index + name.length
    const next = expr[after]
    if (next !== undefined && /[A-Za-z0-9_]/.test(next)) continue
    let open = after
    while (expr[open] === ' ' || expr[open] === '\n') open += 1
    if (expr[open] !== '(') continue
    const parsed = parseArgs(expr, open)
    if (parsed === null) return null
    return { name, close: parsed.close, args: parsed.args }
  }
  return null
}

function rewriteDurationCall(call: DurationCall): string {
  const args = call.args.map((arg) => humaniseDurations(arg.text))
  const indexes = DURATION_ARG_INDEX[call.name] ?? []
  if (call.name === 'within') {
    const window = args[1]
    const phrase = window === undefined ? null : literalDuration(window)
    if (phrase !== null) return `within ${phrase}`
  }
  const rendered = args.map((text, index) => {
    if (!indexes.includes(index)) return text.trim()
    return literalDuration(text) ?? text.trim()
  })
  return `${call.name}(${rendered.join(', ')})`
}

/** Readable durations only. `within(ts, 300000)` becomes `within 5 min`. */
function humaniseDurations(expr: string): string {
  let out = ''
  let i = 0
  while (i < expr.length) {
    const call = durationCallAt(expr, i)
    if (call === null) {
      out += expr[i] ?? ''
      i += 1
      continue
    }
    out += rewriteDurationCall(call)
    i = call.close + 1
  }
  return out
}
