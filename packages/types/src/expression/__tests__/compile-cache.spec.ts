import { describe, it, expect, beforeEach } from 'vitest'
import {
  compileExpression,
  compileExpressionSafe,
  __clearExpressionCompileCache,
} from '../compile.js'
import { EXPRESSION_COMPILE_CACHE_CAPACITY } from '../limits.js'
import { ExpressionParseError } from '../errors.js'

describe('compile cache', () => {
  beforeEach(() => {
    __clearExpressionCompileCache()
  })

  it('returns the SAME ParsedExpression instance on a hit', () => {
    const a = compileExpression('1 + 2')
    const b = compileExpression('1 + 2')
    expect(a).toBe(b)
  })

  it('compileExpression throws on a bad source', () => {
    expect(() => compileExpression('1 +')).toThrow(ExpressionParseError)
  })

  it('compileExpressionSafe never throws and reports the error', () => {
    const r = compileExpressionSafe('1 +')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBeTruthy()
  })

  it('negatively caches failures (second compile of a bad string returns same result object)', () => {
    const first = compileExpressionSafe('a.b')
    const second = compileExpressionSafe('a.b')
    expect(first.ok).toBe(false)
    expect(first).toBe(second)
  })

  it('evicts the least-recently-used entry at capacity', () => {
    // Fill to capacity with distinct sources.
    for (let i = 0; i < EXPRESSION_COMPILE_CACHE_CAPACITY; i++) {
      compileExpression(`${i} + 0`)
    }
    const firstInstance = compileExpression('0 + 0')
    // Touch every OTHER entry so `0 + 0` becomes LRU, then overflow by one.
    for (let i = 1; i < EXPRESSION_COMPILE_CACHE_CAPACITY; i++) {
      compileExpression(`${i} + 0`)
    }
    compileExpression('9999 + 0') // overflow → evicts LRU (`0 + 0`)
    const refetched = compileExpression('0 + 0')
    // Evicted → re-parsed → a NEW instance.
    expect(refetched).not.toBe(firstInstance)
  })
})
