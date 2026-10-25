import { describe, it, expect } from 'vitest'
import { parseExpression } from '../parser.js'
import { ExpressionParseError } from '../errors.js'
import { createExpressionScope, evaluateAst } from '../evaluator.js'
import type { ExpressionValue } from '../ast.js'

function evalStr(src: string, scope: Record<string, ExpressionValue> = {}): ExpressionValue {
  const parsed = parseExpression(src)
  return evaluateAst(parsed.ast, createExpressionScope(scope))
}

describe('parser precedence + structure', () => {
  it('multiplication binds tighter than addition', () => {
    expect(evalStr('1 + 2 * 3')).toBe(7)
  })

  it('&& binds tighter than ||', () => {
    // true || (false && false) === true; if || bound tighter it would be false
    expect(evalStr('true || false && false')).toBe(true)
  })

  it('comparison binds tighter than equality', () => {
    expect(evalStr('1 < 2 == true')).toBe(true)
  })

  it('ternary is right-associative', () => {
    // false ? 1 : true ? 2 : 3  →  (false ? 1 : (true ? 2 : 3)) → 2
    expect(evalStr('false ? 1 : true ? 2 : 3')).toBe(2)
  })

  it('parses unary chains', () => {
    expect(evalStr('!!true')).toBe(true)
    expect(evalStr('- -5')).toBe(5)
  })

  it('parses nested parentheses regrouping precedence', () => {
    expect(evalStr('(1 + 2) * 3')).toBe(9)
  })

  it('parses calls with args and separates identifiers from callees', () => {
    const parsed = parseExpression('min(a, 2, max(b, 3))')
    expect([...parsed.callees].toSorted()).toEqual(['max', 'min'])
    expect([...parsed.identifiers].toSorted()).toEqual(['a', 'b'])
  })

  it('parses a zero-arg-free call form min(1)', () => {
    expect(evalStr('min(1)')).toBe(1)
  })

  it('rejects an unknown function at parse time', () => {
    expect(() => parseExpression('frobnicate(1)')).toThrow(ExpressionParseError)
  })

  it('rejects trailing input', () => {
    expect(() => parseExpression('1 2')).toThrow(ExpressionParseError)
  })

  it('rejects an unclosed paren', () => {
    expect(() => parseExpression('(1 + 2')).toThrow(ExpressionParseError)
  })

  it('rejects too many call arguments', () => {
    const args = Array.from({ length: 20 }, (_, i) => String(i)).join(', ')
    expect(() => parseExpression(`min(${args})`)).toThrow(ExpressionParseError)
  })

  it('rejects an over-complex (too many nodes) expression', () => {
    // Deeply nested parens generate one node per literal + wrapper; balloon
    // past MAX_EXPRESSION_AST_NODES via a long additive chain.
    const chain = Array.from({ length: 300 }, () => '1').join(' + ')
    expect(() => parseExpression(chain)).toThrow(/too complex/)
  })

  it('reports node count', () => {
    const parsed = parseExpression('1 + 2')
    // two literals + one binary
    expect(parsed.nodeCount).toBe(3)
  })
})
