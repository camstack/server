import { describe, it, expect } from 'vitest'
import { parseExpression } from '../parser.js'
import { createExpressionScope, evaluateAst } from '../evaluator.js'
import { ExpressionEvalError } from '../errors.js'
import type { ExpressionValue } from '../ast.js'

function evalStr(src: string, scope: Record<string, ExpressionValue> = {}): ExpressionValue {
  return evaluateAst(parseExpression(src).ast, createExpressionScope(scope))
}

describe('evaluator', () => {
  it('does arithmetic', () => {
    expect(evalStr('2 + 3 * 4 - 1')).toBe(13)
    expect(evalStr('10 % 3')).toBe(1)
    expect(evalStr('7 / 2')).toBe(3.5)
  })

  it('concatenates two strings with +', () => {
    expect(evalStr(`'a' + 'b'`)).toBe('ab')
  })

  it('rejects mixed string/number +', () => {
    expect(() => evalStr(`'a' + 1`)).toThrow(ExpressionEvalError)
  })

  it('compares numbers and strings but not across types', () => {
    expect(evalStr('1 < 2')).toBe(true)
    expect(evalStr(`'a' < 'b'`)).toBe(true)
    expect(() => evalStr(`1 < 'b'`)).toThrow(ExpressionEvalError)
  })

  it('uses strict equality across value types', () => {
    expect(evalStr('1 == 1')).toBe(true)
    expect(evalStr(`1 == '1'`)).toBe(false)
    expect(evalStr('null == null')).toBe(true)
    expect(evalStr('true != false')).toBe(true)
  })

  it('short-circuits && and || (right side not evaluated)', () => {
    // `missing` is an unbound identifier; if the right side were evaluated it
    // would throw. Short-circuit must avoid that.
    expect(evalStr('false && missing')).toBe(false)
    expect(evalStr('true || missing')).toBe(true)
  })

  it('returns operand values from && / ||', () => {
    expect(evalStr('0 || 5')).toBe(5)
    expect(evalStr('2 && 3')).toBe(3)
  })

  it('evaluates ternary lazily', () => {
    expect(evalStr('true ? 1 : missing')).toBe(1)
    expect(evalStr('false ? missing : 2')).toBe(2)
  })

  it('throws on an unknown identifier', () => {
    expect(() => evalStr('a + 1')).toThrow(/unknown identifier: a/)
  })

  it('reads bound identifiers from scope', () => {
    expect(evalStr('a * 2', { a: 21 })).toBe(42)
  })

  it('null propagates to an eval error under arithmetic', () => {
    expect(() => evalStr('a * 2', { a: null })).toThrow(ExpressionEvalError)
  })

  it('rejects non-finite results (divide by zero, overflow)', () => {
    expect(() => evalStr('1 / 0')).toThrow(ExpressionEvalError)
    expect(() => evalStr('pow(10, 400)')).toThrow(ExpressionEvalError)
  })

  it('rejects unary minus on non-numbers', () => {
    expect(() => evalStr(`-'x'`)).toThrow(ExpressionEvalError)
  })

  it('applies logical not truthiness', () => {
    expect(evalStr('!0')).toBe(true)
    expect(evalStr(`!'x'`)).toBe(false)
    expect(evalStr('!null')).toBe(true)
  })

  it('enforces the step budget on a large AST', () => {
    const parsed = parseExpression(Array.from({ length: 50 }, () => '1').join(' + '))
    expect(() => evaluateAst(parsed.ast, createExpressionScope({}), { maxSteps: 5 })).toThrow(
      /step budget/,
    )
  })

  it.each([
    ['-count(n)', { n: 1 }, ['count@root/operand']],
    ['count(a) + count(b)', { a: 1, b: 2 }, ['count@root/left', 'count@root/right']],
    ['count(a) && count(b)', { a: 1, b: 2 }, ['count@root/left', 'count@root/right']],
    [
      'count(test) ? count(a) : count(b)',
      { test: 1, a: 2, b: 3 },
      ['count@root/test', 'count@root/consequent'],
    ],
  ])('assigns structural paths through %s', (src, bindings, expected) => {
    const paths: string[] = []
    evaluateAst(parseExpression(src).ast, createExpressionScope(bindings), {
      invokeStateful: (call) => {
        paths.push(`${call.name}@${call.path}`)
        return call.args[0] ?? null
      },
    })
    expect(paths).toEqual(expected)
  })

  it.each([
    [true, ['rose@root/arg:0/consequent', 'rose@root/arg:1']],
    [false, ['count@root/arg:0/alternate', 'rose@root/arg:1']],
  ])('keeps stable call paths across lazy branch flag=%s', (flag, expected) => {
    const paths: string[] = []
    const parsed = parseExpression('latest(flag ? rose(a, at) : count(n), rose(b, bt))')
    evaluateAst(
      parsed.ast,
      createExpressionScope({ flag, a: true, at: 10, n: 1, b: false, bt: 20 }),
      {
        invokeStateful: (call) => {
          paths.push(`${call.name}@${call.path}`)
          return 1
        },
      },
    )
    expect(paths).toEqual(expected)
  })

  it('keeps a later sibling path unchanged when a different branch executes first', () => {
    const siblingPath = (flag: boolean): string => {
      const paths: string[] = []
      evaluateAst(
        parseExpression('latest(flag ? rose(a, at) : count(n), rose(b, bt))').ast,
        createExpressionScope({ flag, a: true, at: 10, n: 1, b: false, bt: 20 }),
        {
          invokeStateful: (call) => {
            paths.push(call.path)
            return 1
          },
        },
      )
      return paths[1] ?? ''
    }

    expect(siblingPath(true)).toBe(siblingPath(false))
  })

  it('assigns byte-identical paths when the same source is parsed and evaluated twice', () => {
    const collect = (): readonly string[] => {
      const paths: string[] = []
      evaluateAst(
        parseExpression('count(a) + rose(b, at)').ast,
        createExpressionScope({ a: 1, b: true, at: 2 }),
        {
          invokeStateful: (call) => {
            paths.push(`${call.name}@${call.path}`)
            return 1
          },
        },
      )
      return paths
    }

    expect(collect()).toEqual(collect())
  })

  it('does not route pure builtins through the stateful invocation hook', () => {
    const calls: string[] = []
    const value = evaluateAst(parseExpression('min(3, 1)').ast, createExpressionScope({}), {
      invokeStateful: (call) => {
        calls.push(call.name)
        return 99
      },
    })
    expect(value).toBe(1)
    expect(calls).toEqual([])
  })

  it.each([
    'rose(true, 1)',
    'count(1)',
  ])('refuses stateful call %s without an invocation context', (src) => {
    expect(() => evalStr(src)).toThrow(/stateful evaluation context is required/)
  })

  it('checks stateful builtin arity before invoking the hook', () => {
    const calls: string[] = []
    expect(() =>
      evaluateAst(parseExpression('rose(true)').ast, createExpressionScope({}), {
        invokeStateful: (call) => {
          calls.push(call.name)
          return 1
        },
      }),
    ).toThrow(/wrong number of arguments/)
    expect(calls).toEqual([])
  })
})
