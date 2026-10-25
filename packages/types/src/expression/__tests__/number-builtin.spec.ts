/**
 * `number(x)` (D663, Task 14 ruling B): an HA sensor with a unit but no
 * device_class is registered as an `enum-sensor`, whose `value` is the raw
 * STRING state (`"0"` days of desiccant). `number` reads it as a number, and
 * anything that is not a finite decimal — `''` (the cold slice),
 * `'unavailable'`, `'NaN'`, a boolean, null — is `null`: unavailable, never 0
 * (D393).
 */
import { describe, expect, it } from 'vitest'
import { inferExpressionKinds } from '../../composition/expression-kinds.js'
import type { ExpressionValue } from '../ast.js'
import { ExpressionEvalError } from '../errors.js'
import { createExpressionScope, evaluateAst } from '../evaluator.js'
import { parseExpression } from '../parser.js'

function evalStr(src: string, scope: Record<string, ExpressionValue> = {}): ExpressionValue {
  return evaluateAst(parseExpression(src).ast, createExpressionScope(scope))
}

describe('number(x)', () => {
  it('reads a numeric string as a number', () => {
    expect(evalStr('number(d)', { d: '0' })).toBe(0)
    expect(evalStr('number(d)', { d: '30' })).toBe(30)
    expect(evalStr('number(d)', { d: ' -1.5 ' })).toBe(-1.5)
    expect(evalStr('number(d)', { d: '2e3' })).toBe(2000)
  })

  it('passes a finite number through', () => {
    expect(evalStr('number(7)')).toBe(7)
  })

  it('is null — never 0 — for everything that is not a finite decimal (D393)', () => {
    for (const d of ['', '   ', 'unavailable', 'unknown', 'NaN', 'Infinity', '0x10', '1,5', '12 d'])
      expect(evalStr('number(d)', { d }), JSON.stringify(d)).toBeNull()
    expect(evalStr('number(d)', { d: true })).toBeNull()
    expect(evalStr('number(d)', { d: null })).toBeNull()
  })

  it('takes exactly one argument — at evaluation and at save', () => {
    expect(() => evalStr('number()')).toThrow(ExpressionEvalError)
    expect(() => evalStr('number("1", "2")')).toThrow(ExpressionEvalError)
    const inferred = inferExpressionKinds({ expr: 'number("1", "2")', bindingKinds: new Map() })
    expect(inferred.ok).toBe(false)
    if (!inferred.ok) expect(inferred.error).toContain('expected exactly 1')
  })

  it('infers number | null from a string source, so a nullable number field accepts it', () => {
    const inferred = inferExpressionKinds({
      expr: 'number(d)',
      bindingKinds: new Map([['d', new Set(['string'] as const)]]),
    })
    expect(inferred.ok && [...inferred.kinds].toSorted()).toEqual(['null', 'number'])
  })
})
