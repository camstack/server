import { describe, it, expect } from 'vitest'
import { parseExpression } from '../parser.js'
import { createExpressionScope, evaluateAst } from '../evaluator.js'
import { ExpressionEvalError } from '../errors.js'
import { evaluateCount, type ExpressionEvalHooks } from '../builtins.js'
import type { ExpressionValue } from '../ast.js'
import {
  cloneStatefulExpressionMemory,
  createStatefulExpressionMemory,
  evaluateExpressionSource,
  evaluateStatefulExpressionCall,
  type CountCallState,
} from '../expression-source.js'

function evalStr(
  src: string,
  scope: Record<string, ExpressionValue> = {},
  hooks?: ExpressionEvalHooks,
): ExpressionValue {
  return evaluateAst(parseExpression(src).ast, createExpressionScope(scope), { hooks })
}

function statefulExpressionHarness(
  expr: string,
  options?: { readonly currentOutput?: number | null; readonly startedAtMs?: number },
) {
  const memory = createStatefulExpressionMemory()
  let currentOutput = options?.currentOutput ?? null
  const startedAtMs = options?.startedAtMs ?? 100_000

  return {
    memory,
    evaluate(bindings: Readonly<Record<string, ExpressionValue>>, nowMs: number): number | null {
      const result = evaluateExpressionSource(expr, bindings, nowMs, {
        invokeStateful: (invocation) =>
          evaluateStatefulExpressionCall(invocation, memory, {
            currentOutput,
            startedAtMs,
            nowMs,
          }),
      })
      if (!result.ok) throw new Error(result.error)
      if (result.value !== null && typeof result.value !== 'number') {
        throw new Error(`expected numeric stateful output, got ${typeof result.value}`)
      }
      currentOutput = result.value
      return currentOutput
    },
  }
}

function countHarness(options?: { readonly currentOutput?: unknown }) {
  const call: CountCallState = { kind: 'count', highWater: null, primed: false }
  let currentOutput = options?.currentOutput
  return {
    run(input: unknown): number {
      const next = evaluateCount(input, call, currentOutput)
      currentOutput = next
      return next
    },
  }
}

describe('builtins', () => {
  it('min / max are variadic', () => {
    expect(evalStr('min(3, 1, 2)')).toBe(1)
    expect(evalStr('max(3, 1, 2)')).toBe(3)
  })

  it('abs / floor / ceil / sqrt', () => {
    expect(evalStr('abs(-5)')).toBe(5)
    expect(evalStr('floor(2.9)')).toBe(2)
    expect(evalStr('ceil(2.1)')).toBe(3)
    expect(evalStr('sqrt(9)')).toBe(3)
  })

  it('sqrt of a negative → non-finite → error', () => {
    expect(() => evalStr('sqrt(-1)')).toThrow(ExpressionEvalError)
  })

  it('round with default and explicit digits', () => {
    expect(evalStr('round(2.5)')).toBe(3)
    expect(evalStr('round(2.345, 2)')).toBe(2.35)
  })

  it('pow', () => {
    expect(evalStr('pow(2, 10)')).toBe(1024)
  })

  it('clamp respects ordering and bounds', () => {
    expect(evalStr('clamp(5, 0, 10)')).toBe(5)
    expect(evalStr('clamp(-3, 0, 10)')).toBe(0)
    expect(evalStr('clamp(99, 0, 10)')).toBe(10)
    expect(() => evalStr('clamp(1, 10, 0)')).toThrow(ExpressionEvalError)
  })

  it('avg / sum', () => {
    expect(evalStr('avg(2, 4, 6)')).toBe(4)
    expect(evalStr('sum(1, 2, 3)')).toBe(6)
  })

  it('coalesce returns first non-null across types', () => {
    expect(evalStr('coalesce(null, null, 7)')).toBe(7)
    expect(evalStr(`coalesce(null, 'x')`)).toBe('x')
    expect(evalStr('coalesce(null, null)')).toBe(null)
    expect(evalStr('coalesce(a, 0)', { a: null })).toBe(0)
  })

  it('age computes now - ts', () => {
    expect(evalStr('age(now, ts)', { now: 1000, ts: 400 })).toBe(600)
  })

  it('convert stub is identity when from===to', () => {
    expect(evalStr(`convert(5, 'C', 'C')`)).toBe(5)
    expect(evalStr(`convert(5, ' C ', 'C')`)).toBe(5)
  })

  it('convert stub fails closed when units differ and no hook', () => {
    expect(() => evalStr(`convert(5, 'C', 'F')`)).toThrow(/table not installed/)
  })

  it('convert delegates to the injected hook', () => {
    const hooks: ExpressionEvalHooks = {
      convert: (v, from, to) => (from === 'C' && to === 'F' ? v * 1.8 + 32 : null),
    }
    expect(evalStr(`convert(100, 'C', 'F')`, {}, hooks)).toBe(212)
    expect(() => evalStr(`convert(1, 'C', 'K')`, {}, hooks)).toThrow(ExpressionEvalError)
  })

  it('rejects non-numeric arguments to numeric builtins', () => {
    expect(() => evalStr(`min('a', 1)`)).toThrow(ExpressionEvalError)
  })

  it('rejects wrong arity', () => {
    expect(() => evalStr('pow(2)')).toThrow(ExpressionEvalError)
  })

  it('registers stateful builtin names and keeps their direct path fail-closed', () => {
    expect(() => evalStr('rose(true, 1)')).toThrow('rose: stateful evaluation context is required')
    expect(() => evalStr('count(1)')).toThrow('count: stateful evaluation context is required')
  })
})

describe('rose', () => {
  it('retains the current output for stale or undated first active sightings', () => {
    const stale = statefulExpressionHarness('rose(level, changedAt)', {
      currentOutput: 50,
      startedAtMs: 50_000,
    })
    expect(stale.evaluate({ level: true, changedAt: 60_000 }, 100_000)).toBe(50)

    const undated = statefulExpressionHarness('rose(level, changedAt)', {
      currentOutput: 50,
      startedAtMs: 98_000,
    })
    expect(undated.evaluate({ level: true, changedAt: null }, 100_000)).toBe(50)
  })

  it('returns only a timestamped rising edge and retains it across equality and falls', () => {
    const h = statefulExpressionHarness('rose(level, changedAt)', {
      currentOutput: 50,
      startedAtMs: 100_000,
    })
    expect([
      h.evaluate({ level: false, changedAt: 100_000 }, 100_000),
      h.evaluate({ level: true, changedAt: 101_000 }, 101_000),
      h.evaluate({ level: true, changedAt: 101_000 }, 101_500),
      h.evaluate({ level: false, changedAt: 102_000 }, 102_000),
    ]).toEqual([50, 101_000, 101_000, 101_000])
  })

  it('shares one debounce clock across rises at distinct call paths', () => {
    const h = statefulExpressionHarness('latest(rose(a, at, 2000), rose(b, bt, 2000))', {
      startedAtMs: 198_000,
    })
    expect(h.evaluate({ a: true, at: 200_000, b: false, bt: 199_000 }, 200_000)).toBe(200_000)
    expect(h.evaluate({ a: true, at: 200_000, b: true, bt: 201_000 }, 201_000)).toBe(200_000)
    expect([...h.memory.calls.keys()]).toEqual(['root/arg:0', 'root/arg:1'])
  })

  it('accepts a new rise exactly at the debounce boundary', () => {
    const h = statefulExpressionHarness('rose(level, changedAt)', {
      startedAtMs: 100_000,
    })
    h.evaluate({ level: false, changedAt: 100_000 }, 100_000)
    const outputs: Array<number | null> = []
    for (const timestamp of [101_000, 102_999, 103_000]) {
      if (outputs.length > 0) {
        h.evaluate({ level: false, changedAt: timestamp - 1 }, timestamp - 1)
      }
      outputs.push(h.evaluate({ level: true, changedAt: timestamp }, timestamp))
    }
    expect(outputs).toEqual([101_000, 101_000, 103_000])
  })

  it('rejects a negative or non-finite explicit debounce', () => {
    const negative = statefulExpressionHarness('rose(level, changedAt, debounce)')
    expect(() =>
      negative.evaluate({ level: true, changedAt: 101_000, debounce: -1 }, 101_000),
    ).toThrow(/debounce must be a non-negative finite number/)

    const nonFinite = statefulExpressionHarness('rose(level, changedAt, debounce)')
    expect(() =>
      nonFinite.evaluate(
        { level: true, changedAt: 101_000, debounce: Number.POSITIVE_INFINITY },
        101_000,
      ),
    ).toThrow(/argument 3 must be a finite number/)
  })

  it('clones per-call and field memory without sharing mutable state', () => {
    const original = createStatefulExpressionMemory()
    original.calls.set('root', { kind: 'rose', priorLevel: true })
    original.acceptedEdgeAt = 10
    original.disarmRoseNext = true

    const clone = cloneStatefulExpressionMemory(original)
    const clonedCall = clone.calls.get('root')
    if (clonedCall?.kind !== 'rose') throw new Error('expected cloned rose state')
    clonedCall.priorLevel = false
    clone.acceptedEdgeAt = 20
    clone.disarmRoseNext = false

    expect(original.calls.get('root')).toEqual({ kind: 'rose', priorLevel: true })
    expect(original.acceptedEdgeAt).toBe(10)
    expect(original.disarmRoseNext).toBe(true)
  })

  it('disarm ignores a recovery seed without re-arming a later real on', () => {
    const h = statefulExpressionHarness('rose(level, changedAt)', {
      currentOutput: 50,
      startedAtMs: 100_000,
    })
    h.evaluate({ level: false, changedAt: 100_000 }, 100_000)
    expect(h.evaluate({ level: true, changedAt: 101_000 }, 101_000)).toBe(101_000)

    // Provider restart flap: unavailable → seed false (disarmed) → real on.
    h.memory.disarmRoseNext = true
    expect(h.evaluate({ level: false, changedAt: 102_000 }, 102_000)).toBe(101_000)
    h.memory.disarmRoseNext = false
    // priorLevel stayed true through the seed, so the restored on is no edge.
    expect(h.evaluate({ level: true, changedAt: 103_000 }, 103_000)).toBe(101_000)
    // A later real fall→rise still counts.
    expect(h.evaluate({ level: false, changedAt: 104_000 }, 104_000)).toBe(101_000)
    expect(h.evaluate({ level: true, changedAt: 105_000 }, 105_000)).toBe(105_000)
  })
})

describe('count', () => {
  it('seeds without incrementing and increments only on strict finite advance', () => {
    const h = countHarness({ currentOutput: 2 })
    expect(h.run(100)).toBe(2)
    expect(h.run(100)).toBe(2)
    expect(h.run(99)).toBe(2)
    expect(h.run(null)).toBe(2)
    expect(h.run(Number.POSITIVE_INFINITY)).toBe(2)
    expect(h.run(101)).toBe(3)
    expect(h.run(102)).toBe(4)
  })

  // D670 amendment (2026-09-29): the counter starts on the first ANSWERED read.
  // An answered `null` ("never pressed") primes it with no high-water, so the
  // first press counts. Camera 101 swallowed its first press because the first
  // FINITE value was taken as the seed even though it was a new press.
  it('primes on an answered null, so the first finite value counts 1', () => {
    const h = countHarness()
    expect(h.run(null)).toBe(0)
    expect(h.run(1_790_669_392_385)).toBe(1)
    expect(h.run(1_790_669_392_385)).toBe(1)
    expect(h.run(1_790_669_400_000)).toBe(2)
  })

  it('an answered null primes a restored lifetime count without resetting it', () => {
    const h = countHarness({ currentOutput: 7 })
    expect(h.run(null)).toBe(7)
    expect(h.run(100)).toBe(8)
  })

  it('a read that did not answer (not a number, not null) does not prime', () => {
    const h = countHarness()
    expect(h.run(undefined)).toBe(0)
    expect(h.run(Number.NaN)).toBe(0)
    expect(h.run('x')).toBe(0)
    // Still unprimed: the first finite value is the seed, not a press.
    expect(h.run(100)).toBe(0)
    expect(h.run(101)).toBe(1)
  })

  it('a null after the high-water keeps it', () => {
    const h = countHarness()
    expect(h.run(100)).toBe(0)
    expect(h.run(null)).toBe(0)
    expect(h.run(100)).toBe(0)
    expect(h.run(101)).toBe(1)
  })

  it('normalizes an absent, negative, or non-finite current output to zero', () => {
    expect(countHarness().run(100)).toBe(0)
    expect(countHarness({ currentOutput: -1 }).run(100)).toBe(0)
    expect(countHarness({ currentOutput: Number.NaN }).run(100)).toBe(0)
  })
})
