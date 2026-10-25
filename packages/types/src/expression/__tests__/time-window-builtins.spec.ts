/**
 * The room case (D659): occupancy is "any motion within the last five minutes".
 * `within` reads the clock the evaluation was GIVEN, and reports the instant its
 * answer flips, so the composer arms one deadline instead of polling.
 */
import { describe, expect, it } from 'vitest'
import { evaluateAst } from '../evaluator.js'
import {
  type EvaluateExpressionSourceResult,
  evaluateExpressionSource,
  validateExpressionSource,
} from '../expression-source.js'
import { parseExpression } from '../parser.js'

const NOW = 1_000_000
const WINDOW = 300_000
const OCCUPANCY = 'any(d1, d2, within(m1, 300000), within(m2, 300000))'

type ExpressionTestValues = Readonly<Record<string, number | boolean | null>>

interface DeadlinesOfResult {
  readonly result: EvaluateExpressionSourceResult
  readonly noted: number[]
}

function deadlinesOf(expr: string, values: ExpressionTestValues): DeadlinesOfResult {
  const noted: number[] = []
  const result = evaluateExpressionSource(expr, values, NOW, {
    hooks: { noteDeadline: (at) => noted.push(at) },
  })
  return { result, noted }
}

describe('within', () => {
  it('is true inside the window and reports when it will stop being true', () => {
    const { result, noted } = deadlinesOf('within(m, 300000)', { m: NOW - 120_000 })
    expect(result).toEqual({ ok: true, value: true })
    expect(noted).toEqual([NOW - 120_000 + WINDOW + 1])
  })

  it('is false outside the window and reports nothing', () => {
    const { result, noted } = deadlinesOf('within(m, 300000)', { m: NOW - 300_001 })
    expect(result).toEqual({ ok: true, value: false })
    expect(noted).toEqual([])
  })

  it('is true exactly at the edge (now - ts === windowMs), inclusive', () => {
    const { result, noted } = deadlinesOf('within(m, 300000)', { m: NOW - WINDOW })
    expect(result).toEqual({ ok: true, value: true })
    expect(noted).toEqual([NOW + 1])
  })

  it('treats "never happened" (null) as outside the window, which is a fact, not a failed read', () => {
    expect(deadlinesOf('within(m, 300000)', { m: null }).result).toEqual({ ok: true, value: false })
  })

  it('fails closed with no clock', () => {
    const parsed = parseExpression('within(m, 10)')
    expect(() => evaluateAst(parsed.ast, { m: 1 })).toThrow('within: no clock')
  })

  it('refuses a negative window', () => {
    const { result } = deadlinesOf('within(m, -1)', { m: NOW })
    expect(result).toEqual({ ok: false, error: 'within: the window must not be negative' })
  })
})

describe('any / all', () => {
  it('any is true when one argument is', () => {
    expect(deadlinesOf('any(a, b)', { a: false, b: true }).result).toEqual({
      ok: true,
      value: true,
    })
  })
  it('all is false when one argument is', () => {
    expect(deadlinesOf('all(a, b)', { a: true, b: false }).result).toEqual({
      ok: true,
      value: false,
    })
  })
  it('refuses a non-boolean argument by position', () => {
    const { result } = deadlinesOf('any(a, b)', { a: false, b: 3 })
    expect(result).toEqual({ ok: false, error: 'any: argument 2 must be a boolean' })
  })
})

describe('latest', () => {
  it('skips nulls, and is null only when every argument is', () => {
    expect(deadlinesOf('latest(a, b)', { a: null, b: 7 }).result).toEqual({ ok: true, value: 7 })
    expect(deadlinesOf('latest(a, b)', { a: null, b: null }).result).toEqual({
      ok: true,
      value: null,
    })
  })
})

describe('the room occupancy expression', () => {
  it('is occupied from a recent motion, with its deadline', () => {
    const { result, noted } = deadlinesOf(OCCUPANCY, {
      d1: false,
      d2: false,
      m1: NOW - 120_000,
      m2: null,
    })
    expect(result).toEqual({ ok: true, value: true })
    expect(Math.min(...noted)).toBe(NOW - 120_000 + WINDOW + 1)
  })

  it('is occupied while a sensor still holds detected, whatever its last edge', () => {
    const { result } = deadlinesOf(OCCUPANCY, { d1: true, d2: false, m1: NOW - 900_000, m2: null })
    expect(result).toEqual({ ok: true, value: true })
  })

  it('is empty once every window has closed', () => {
    const { result } = deadlinesOf(OCCUPANCY, { d1: false, d2: false, m1: NOW - 300_001, m2: null })
    expect(result).toEqual({ ok: true, value: false })
  })
})

describe('the new names are builtins now', () => {
  it('may not be used as binding names', () => {
    expect(validateExpressionSource({ expr: 'within', bindings: { within: 1 } })).toBe(
      "binding name 'within' shadows a builtin function",
    )
  })
})
