import { describe, expect, it } from 'vitest'
import {
  evaluateExpressionSource,
  toExpressionValue,
  validateExpressionSource,
} from '../expression-source.js'

describe('toExpressionValue', () => {
  it('passes through primitives incl. null', () => {
    expect(toExpressionValue('x')).toBe('x')
    expect(toExpressionValue(3)).toBe(3)
    expect(toExpressionValue(true)).toBe(true)
    expect(toExpressionValue(null)).toBe(null)
  })

  it('maps non-primitives and non-finite numbers to undefined', () => {
    expect(toExpressionValue(undefined)).toBe(undefined)
    expect(toExpressionValue({})).toBe(undefined)
    expect(toExpressionValue([1])).toBe(undefined)
    expect(toExpressionValue(Number.NaN)).toBe(undefined)
    expect(toExpressionValue(Number.POSITIVE_INFINITY)).toBe(undefined)
  })
})

describe('validateExpressionSource', () => {
  it('accepts a well-formed source', () => {
    expect(validateExpressionSource({ expr: 'clamp(a, 0, 100)', bindings: { a: {} } })).toBeNull()
  })

  it('allows the injected now identifier without a binding', () => {
    expect(validateExpressionSource({ expr: 'age(now, ts)', bindings: { ts: {} } })).toBeNull()
  })

  it('rejects an unbound identifier', () => {
    expect(validateExpressionSource({ expr: 'a + b', bindings: { a: {} } })).toMatch(/unbound/)
  })

  it('rejects a reserved binding name (now)', () => {
    expect(validateExpressionSource({ expr: 'now', bindings: { now: {} } })).toMatch(/reserved/)
  })

  it('rejects a binding name that shadows a builtin', () => {
    expect(validateExpressionSource({ expr: 'min', bindings: { min: {} } })).toMatch(/shadows/)
  })

  it('rejects an illegal binding name', () => {
    expect(validateExpressionSource({ expr: '1', bindings: { '1bad': {} } })).toMatch(/invalid/)
  })

  it('rejects a source that does not compile', () => {
    expect(validateExpressionSource({ expr: 'a.b', bindings: { a: {} } })).toBeTruthy()
  })
})

describe('evaluateExpressionSource', () => {
  it('evaluates with injected now', () => {
    const r = evaluateExpressionSource('age(now, ts)', { ts: 400 }, 1000)
    expect(r).toEqual({ ok: true, value: 600 })
  })

  it('supports coalesce fallback when a binding is null', () => {
    const r = evaluateExpressionSource('coalesce(a, 0) + 1', { a: null }, 0)
    expect(r).toEqual({ ok: true, value: 1 })
  })

  it('returns ok:false with a reason on eval failure', () => {
    const r = evaluateExpressionSource('a * 2', { a: null }, 0)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBeTruthy()
  })

  it('returns ok:false on a parse failure', () => {
    const r = evaluateExpressionSource('a.b', {}, 0)
    expect(r.ok).toBe(false)
  })

  it('forwards stateful calls with their deterministic AST path', () => {
    const calls: string[] = []
    const r = evaluateExpressionSource(
      'rose(active, changedAt)',
      {
        active: true,
        changedAt: 123,
      },
      200,
      {
        invokeStateful: (call) => {
          calls.push(`${call.name}@${call.path}`)
          return call.args[1] ?? null
        },
      },
    )

    expect(r).toEqual({ ok: true, value: 123 })
    expect(calls).toEqual(['rose@root'])
  })

  it('returns a named failure when a stateful call has no context', () => {
    const r = evaluateExpressionSource('count(value)', { value: 1 }, 200)

    expect(r).toEqual({
      ok: false,
      error: 'count: stateful evaluation context is required',
    })
  })
})
