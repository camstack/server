/**
 * What an expression can PRODUCE: the static half of type validation at save
 * (D659). The language is untyped at runtime; this walk gives the set of value
 * kinds the result may take, so a save that would write a string into
 * `celsius`, or a possible null into a non-nullable field, is refused by name
 * before it is stored.
 */
import type {
  ExpressionBinaryOperator,
  ExpressionNode,
  ExpressionValue,
} from '../expression/ast.js'
import { EXPRESSION_BUILTINS, type ExpressionBuiltin } from '../expression/builtins.js'
import { compileExpressionSafe } from '../expression/compile.js'
import { EXPRESSION_INJECTED_NOW } from '../expression/expression-source.js'

export type ExpressionValueKind = 'number' | 'string' | 'boolean' | 'null'
export type ExpressionKindSet = ReadonlySet<ExpressionValueKind>

export interface FixedKindRule {
  readonly kind: 'fixed'
  readonly result: readonly ExpressionValueKind[]
}
/** `coalesce`: the first non-null argument, null only when every argument may be null. */
export interface CoalesceKindRule {
  readonly kind: 'coalesce'
}
export type BuiltinKindRule = FixedKindRule | CoalesceKindRule

const NUMBER: FixedKindRule = { kind: 'fixed', result: ['number'] }
const BOOLEAN: FixedKindRule = { kind: 'fixed', result: ['boolean'] }

/** One rule per builtin. `expression-kinds.spec.ts` fails for a builtin missing here. */
export const BUILTIN_RESULT_KINDS: Readonly<Record<string, BuiltinKindRule>> = Object.freeze({
  min: NUMBER,
  max: NUMBER,
  abs: NUMBER,
  floor: NUMBER,
  ceil: NUMBER,
  sqrt: NUMBER,
  round: NUMBER,
  pow: NUMBER,
  clamp: NUMBER,
  avg: NUMBER,
  sum: NUMBER,
  age: NUMBER,
  convert: NUMBER,
  coalesce: { kind: 'coalesce' },
  any: BOOLEAN,
  all: BOOLEAN,
  within: BOOLEAN,
  latest: { kind: 'fixed', result: ['number', 'null'] },
  number: { kind: 'fixed', result: ['number', 'null'] },
  rose: { kind: 'fixed', result: ['number', 'null'] },
  count: NUMBER,
  dwell: { kind: 'fixed', result: ['boolean', 'null'] },
  latchedAt: { kind: 'fixed', result: ['number', 'null'] },
  schmitt: { kind: 'fixed', result: ['boolean', 'null'] },
})

export interface InferExpressionKindsInput {
  readonly expr: string
  readonly bindingKinds: ReadonlyMap<string, ExpressionKindSet>
}
export interface InferredKinds {
  readonly ok: true
  readonly kinds: ExpressionKindSet
}
export interface InferenceFailure {
  readonly ok: false
  readonly error: string
}
export type InferExpressionKindsResult = InferredKinds | InferenceFailure

class KindInferenceError extends Error {}

export function kindOfValue(value: ExpressionValue): ExpressionValueKind {
  if (value === null) return 'null'
  if (typeof value === 'number') return 'number'
  if (typeof value === 'string') return 'string'
  return 'boolean'
}

function only(kind: ExpressionValueKind): ExpressionKindSet {
  return new Set([kind])
}

function union(...sets: readonly ExpressionKindSet[]): ExpressionKindSet {
  return new Set(sets.flatMap((s) => [...s]))
}

function withoutNull(set: ExpressionKindSet): ExpressionKindSet {
  return new Set([...set].filter((k) => k !== 'null'))
}

function binaryKinds(
  op: ExpressionBinaryOperator,
  left: ExpressionKindSet,
  right: ExpressionKindSet,
): ExpressionKindSet {
  if (op === '+') {
    const all = [...left, ...right]
    if (all.every((k) => k === 'string')) return only('string')
    if (all.every((k) => k === 'number')) return only('number')
    return new Set<ExpressionValueKind>(['number', 'string'])
  }
  if (op === '-' || op === '*' || op === '/' || op === '%') return only('number')
  return only('boolean')
}

/** "exactly N" / "at least N" / "N–M", for an arity refusal that says what IS allowed. */
function arityRange(builtin: ExpressionBuiltin): string {
  if (builtin.minArgs === builtin.maxArgs) return `exactly ${builtin.minArgs}`
  if (builtin.maxArgs === Number.POSITIVE_INFINITY) return `at least ${builtin.minArgs}`
  return `${builtin.minArgs}–${builtin.maxArgs}`
}

function callKinds(callee: string, args: readonly ExpressionKindSet[]): ExpressionKindSet {
  const builtin = EXPRESSION_BUILTINS[callee]
  if (builtin !== undefined && (args.length < builtin.minArgs || args.length > builtin.maxArgs)) {
    throw new KindInferenceError(
      `${callee}: wrong number of arguments (${args.length}); expected ${arityRange(builtin)}`,
    )
  }
  const rule = BUILTIN_RESULT_KINDS[callee]
  if (rule === undefined)
    throw new KindInferenceError(`no result-kind rule for builtin '${callee}'`)
  if (rule.kind === 'fixed') return new Set(rule.result)
  const nonNull = union(...args.map(withoutNull))
  return args.every((a) => a.has('null')) ? union(nonNull, only('null')) : nonNull
}

function kindsOf(
  node: ExpressionNode,
  bindings: ReadonlyMap<string, ExpressionKindSet>,
): ExpressionKindSet {
  switch (node.kind) {
    case 'literal':
      return only(kindOfValue(node.value))
    case 'identifier': {
      if (node.name === EXPRESSION_INJECTED_NOW) return only('number')
      const bound = bindings.get(node.name)
      if (bound === undefined) throw new KindInferenceError(`unbound identifier '${node.name}'`)
      return bound
    }
    case 'unary':
      return only(node.op === '!' ? 'boolean' : 'number')
    case 'binary':
      return binaryKinds(node.op, kindsOf(node.left, bindings), kindsOf(node.right, bindings))
    case 'logical':
      // `a || b` returns an OPERAND, not a boolean.
      return union(kindsOf(node.left, bindings), kindsOf(node.right, bindings))
    case 'conditional':
      return union(kindsOf(node.consequent, bindings), kindsOf(node.alternate, bindings))
    case 'call':
      return callKinds(
        node.callee,
        node.args.map((a) => kindsOf(a, bindings)),
      )
  }
}

function nodeContainsCall(node: ExpressionNode, callee: string): boolean {
  switch (node.kind) {
    case 'literal':
    case 'identifier':
      return false
    case 'unary':
      return nodeContainsCall(node.operand, callee)
    case 'binary':
    case 'logical':
      return nodeContainsCall(node.left, callee) || nodeContainsCall(node.right, callee)
    case 'conditional':
      return (
        nodeContainsCall(node.test, callee) ||
        nodeContainsCall(node.consequent, callee) ||
        nodeContainsCall(node.alternate, callee)
      )
    case 'call':
      return node.callee === callee || node.args.some((arg) => nodeContainsCall(arg, callee))
  }
}

export function expressionContainsBuiltinCall(expr: string, callee: string): boolean {
  const compiled = compileExpressionSafe(expr)
  return compiled.ok && nodeContainsCall(compiled.parsed.ast, callee)
}

export function inferExpressionKinds(input: InferExpressionKindsInput): InferExpressionKindsResult {
  const compiled = compileExpressionSafe(input.expr)
  if (!compiled.ok) return { ok: false, error: compiled.error }
  try {
    return {
      ok: true,
      kinds: kindsOf(compiled.parsed.ast, input.bindingKinds),
    }
  } catch (err: unknown) {
    if (err instanceof KindInferenceError) return { ok: false, error: err.message }
    throw err
  }
}
