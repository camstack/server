import { describe, it, expect } from 'vitest'
import { parseExpression } from '../parser.js'
import { createExpressionScope, evaluateAst } from '../evaluator.js'
import { ExpressionEvalError, ExpressionParseError } from '../errors.js'
import { EXPRESSION_BUILTINS } from '../builtins.js'
import type { ExpressionValue } from '../ast.js'

function evalStr(src: string, scope: Record<string, ExpressionValue> = {}): ExpressionValue {
  return evaluateAst(parseExpression(src).ast, createExpressionScope(scope))
}

describe('security — grammar makes escapes unrepresentable', () => {
  it('member access a.b is unparseable', () => {
    expect(() => parseExpression('a.b')).toThrow(ExpressionParseError)
  })

  it('index access a["b"] is unparseable', () => {
    expect(() => parseExpression('a["b"]')).toThrow(ExpressionParseError)
  })

  it('computed call (min)(1) is unparseable', () => {
    expect(() => parseExpression('(min)(1)')).toThrow(ExpressionParseError)
  })

  it('method access min.call is unparseable', () => {
    expect(() => parseExpression('min.call')).toThrow(ExpressionParseError)
  })

  it('assignment a = b is unparseable', () => {
    expect(() => parseExpression('a = b')).toThrow(ExpressionParseError)
  })

  it('arrow / lambda is unparseable', () => {
    expect(() => parseExpression('() => 1')).toThrow(ExpressionParseError)
  })
})

describe('security — proto names are plain identifiers, never chain reads', () => {
  it('constructor/__proto__/prototype/toString are unknown identifiers in an empty scope', () => {
    for (const name of ['constructor', '__proto__', 'prototype', 'toString', 'hasOwnProperty']) {
      expect(() => evalStr(name), name).toThrow(ExpressionEvalError)
    }
  })

  it('resolve normally ONLY when explicitly bound as own keys', () => {
    expect(evalStr('constructor', { constructor: 42 })).toBe(42)
    expect(evalStr('toString', { toString: 7 })).toBe(7)
  })

  it('createExpressionScope copies own-enumerable keys only (no inherited smuggling)', () => {
    const proto: Record<string, ExpressionValue> = { evil: 1 }
    const input: Record<string, ExpressionValue> = Object.assign(Object.create(proto), { good: 2 })
    const scope = createExpressionScope(input)
    expect('good' in scope).toBe(true)
    expect('evil' in scope).toBe(false)
    expect(() => evaluateAst(parseExpression('evil').ast, scope)).toThrow(ExpressionEvalError)
    expect(evaluateAst(parseExpression('good').ast, scope)).toBe(2)
  })
})

describe('security — builtin table hardening', () => {
  it('is frozen', () => {
    expect(Object.isFrozen(EXPRESSION_BUILTINS)).toBe(true)
  })

  it('has a null prototype (Object.prototype members unreachable)', () => {
    expect(Object.getPrototypeOf(EXPRESSION_BUILTINS)).toBe(null)
  })

  it('does not expose toString / hasOwnProperty / constructor as callable', () => {
    for (const name of ['toString', 'hasOwnProperty', 'constructor']) {
      expect(() => parseExpression(`${name}(1)`), name).toThrow(ExpressionParseError)
    }
  })
})
