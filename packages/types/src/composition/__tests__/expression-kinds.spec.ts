import { describe, expect, it } from 'vitest'
import { EXPRESSION_BUILTIN_NAMES } from '../../expression/builtins.js'
import {
  BUILTIN_RESULT_KINDS,
  expressionContainsBuiltinCall,
  type ExpressionKindSet,
  inferExpressionKinds,
} from '../expression-kinds.js'

const NUM: ExpressionKindSet = new Set(['number'])
const NUM_OR_NULL: ExpressionKindSet = new Set(['number', 'null'])
const BOOL: ExpressionKindSet = new Set(['boolean'])

function kinds(expr: string, bindings: ReadonlyArray<readonly [string, ExpressionKindSet]> = []) {
  const result = inferExpressionKinds({ expr, bindingKinds: new Map(bindings) })
  return result.ok ? [...result.kinds].toSorted() : result.error
}

describe('the guard', () => {
  it('knows the result kind of EVERY builtin — a new builtin without a rule fails here', () => {
    for (const name of EXPRESSION_BUILTIN_NAMES)
      expect(BUILTIN_RESULT_KINDS[name], name).toBeDefined()
  })
})

describe('stateful roles', () => {
  it('finds count calls anywhere in the AST, not in string contents', () => {
    expect(expressionContainsBuiltinCall('count(lastPressedAt)', 'count')).toBe(true)
    expect(expressionContainsBuiltinCall('count(lastPressedAt) + 1', 'count')).toBe(true)
    expect(expressionContainsBuiltinCall('flag ? 0 : count(lastPressedAt)', 'count')).toBe(true)
    expect(expressionContainsBuiltinCall('"count("', 'count')).toBe(false)
  })
})

describe('the room fields', () => {
  it('celsius is a number', () => {
    expect(
      kinds('round(avg(t1, t2, t3), 1)', [
        ['t1', NUM],
        ['t2', NUM],
        ['t3', NUM],
      ]),
    ).toEqual(['number'])
  })
  it('occupancy is a boolean even over nullable timestamps', () => {
    expect(
      kinds('any(d1, within(m1, 300000))', [
        ['d1', BOOL],
        ['m1', NUM_OR_NULL],
      ]),
    ).toEqual(['boolean'])
  })
  it('now is a number', () => {
    expect(kinds('now')).toEqual(['number'])
  })
})

describe('null flows where it can', () => {
  it('latest may be null', () => {
    expect(
      kinds('latest(a, b)', [
        ['a', NUM_OR_NULL],
        ['b', NUM],
      ]),
    ).toEqual(['null', 'number'])
  })
  it('coalesce removes null unless every argument may be null', () => {
    expect(kinds('coalesce(a, 0)', [['a', NUM_OR_NULL]])).toEqual(['number'])
    expect(
      kinds('coalesce(a, b)', [
        ['a', NUM_OR_NULL],
        ['b', NUM_OR_NULL],
      ]),
    ).toEqual(['null', 'number'])
  })
  it('a bare nullable binding may be null', () => {
    expect(kinds('a', [['a', NUM_OR_NULL]])).toEqual(['null', 'number'])
  })
})

describe('operators', () => {
  it('+ is number, string, or either', () => {
    expect(
      kinds('a + b', [
        ['a', NUM],
        ['b', NUM],
      ]),
    ).toEqual(['number'])
    expect(kinds('"x" + "y"')).toEqual(['string'])
    expect(kinds('a + "y"', [['a', NUM]])).toEqual(['number', 'string'])
  })
  it('comparisons are boolean; conditionals union their branches', () => {
    expect(kinds('a > 1', [['a', NUM]])).toEqual(['boolean'])
    expect(kinds('a > 1 ? "hot" : 0', [['a', NUM]])).toEqual(['number', 'string'])
  })
})

it('names an unbound identifier', () => {
  expect(kinds('x + 1')).toBe("unbound identifier 'x'")
})
