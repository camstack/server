/**
 * Tree-walking evaluator for the safe expression mini-language.
 *
 * SECURITY (spec §4 rule 2/5):
 *  - The scope is an `Object.create(null)` copy of ONLY the caller's own
 *    enumerable binding entries, so `name in scope` is a pure own-key check and
 *    `constructor` / `__proto__` / `toString` are plain unknown identifiers.
 *  - Performs ZERO I/O and never touches `globalThis` / `Date` / `Math`
 *    directly — the only external calls are into the frozen builtin table.
 *  - The grammar has no loops/recursion/lambdas, so a walk is O(nodeCount) by
 *    construction; the step counter is defense-in-depth for a crafted max-size
 *    AST. Nothing blocks: there are no timers, awaits or unbounded loops.
 */
import { ExpressionEvalError } from './errors.js'
import {
  EXPRESSION_BUILTINS,
  type ExpressionEvalHooks,
  isStatefulBuiltin,
  type StatefulExpressionBuiltin,
} from './builtins.js'
import { MAX_EXPRESSION_EVAL_STEPS } from './limits.js'
import type {
  ExpressionBinaryOperator,
  ExpressionNode,
  ExpressionNodePath,
  ExpressionUnaryOperator,
  ExpressionValue,
} from './ast.js'

export interface StatefulCallInvocation {
  readonly name: StatefulExpressionBuiltin
  readonly path: ExpressionNodePath
  readonly args: readonly ExpressionValue[]
}

export interface ExpressionEvalOptions {
  readonly hooks?: ExpressionEvalHooks
  readonly maxSteps?: number
  readonly invokeStateful?: (call: StatefulCallInvocation) => ExpressionValue
}

const EMPTY_HOOKS: ExpressionEvalHooks = Object.freeze({})

/** Build a null-prototype scope from own-enumerable binding entries. Inherited
 *  keys of the input (e.g. from a `{__proto__: {...}}` payload) are NOT copied,
 *  so nothing smuggles in via the prototype chain. */
export function createExpressionScope(
  bindings: Readonly<Record<string, ExpressionValue>>,
): Record<string, ExpressionValue> {
  const scope: Record<string, ExpressionValue> = Object.create(null)
  for (const key of Object.keys(bindings)) {
    if (Object.prototype.hasOwnProperty.call(bindings, key)) {
      scope[key] = bindings[key]!
    }
  }
  return scope
}

function isFiniteNumber(value: ExpressionValue): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** JS truthiness of a primitive value. */
function truthy(value: ExpressionValue): boolean {
  return Boolean(value)
}

function requireFinite(value: number, context: string): number {
  if (!Number.isFinite(value)) {
    throw new ExpressionEvalError(`${context} produced a non-finite result`)
  }
  return value
}

interface EvalContext {
  readonly scope: Record<string, ExpressionValue>
  readonly hooks: ExpressionEvalHooks
  readonly maxSteps: number
  readonly invokeStateful?: (call: StatefulCallInvocation) => ExpressionValue
  steps: number
}

function step(ctx: EvalContext): void {
  ctx.steps += 1
  if (ctx.steps > ctx.maxSteps) {
    throw new ExpressionEvalError('expression evaluation step budget exceeded')
  }
}

function childPath(path: ExpressionNodePath, child: string): ExpressionNodePath {
  return `${path}/${child}`
}

function evalNode(
  node: ExpressionNode,
  ctx: EvalContext,
  path: ExpressionNodePath,
): ExpressionValue {
  step(ctx)
  switch (node.kind) {
    case 'literal':
      return node.value
    case 'identifier': {
      if (!(node.name in ctx.scope)) {
        throw new ExpressionEvalError(`unknown identifier: ${node.name}`)
      }
      return ctx.scope[node.name]!
    }
    case 'unary':
      return evalUnary(node.op, evalNode(node.operand, ctx, childPath(path, 'operand')))
    case 'binary':
      return evalBinary(
        node.op,
        evalNode(node.left, ctx, childPath(path, 'left')),
        evalNode(node.right, ctx, childPath(path, 'right')),
      )
    case 'logical': {
      const left = evalNode(node.left, ctx, childPath(path, 'left'))
      if (node.op === '&&')
        return truthy(left) ? evalNode(node.right, ctx, childPath(path, 'right')) : left
      return truthy(left) ? left : evalNode(node.right, ctx, childPath(path, 'right'))
    }
    case 'conditional':
      return truthy(evalNode(node.test, ctx, childPath(path, 'test')))
        ? evalNode(node.consequent, ctx, childPath(path, 'consequent'))
        : evalNode(node.alternate, ctx, childPath(path, 'alternate'))
    case 'call': {
      const args = node.args.map((arg, index) =>
        evalNode(arg, ctx, childPath(path, `arg:${index}`)),
      )
      return invokeCall(node.callee, args, path, ctx)
    }
  }
}

function evalUnary(op: ExpressionUnaryOperator, operand: ExpressionValue): ExpressionValue {
  if (op === '!') return !truthy(operand)
  // Unary minus — numbers only.
  if (!isFiniteNumber(operand)) {
    throw new ExpressionEvalError('unary "-" requires a finite number')
  }
  return requireFinite(-operand, 'unary "-"')
}

function evalBinary(
  op: ExpressionBinaryOperator,
  left: ExpressionValue,
  right: ExpressionValue,
): ExpressionValue {
  switch (op) {
    case '==':
      return left === right
    case '!=':
      return left !== right
    case '+':
      if (typeof left === 'string' && typeof right === 'string') return left + right
      if (isFiniteNumber(left) && isFiniteNumber(right)) return requireFinite(left + right, '"+"')
      throw new ExpressionEvalError('"+" requires two numbers or two strings')
    case '-':
    case '*':
    case '/':
    case '%': {
      if (!isFiniteNumber(left) || !isFiniteNumber(right)) {
        throw new ExpressionEvalError(`"${op}" requires two finite numbers`)
      }
      const out =
        op === '-'
          ? left - right
          : op === '*'
            ? left * right
            : op === '/'
              ? left / right
              : left % right
      return requireFinite(out, `"${op}"`)
    }
    case '<':
    case '<=':
    case '>':
    case '>=': {
      if (isFiniteNumber(left) && isFiniteNumber(right)) {
        return op === '<'
          ? left < right
          : op === '<='
            ? left <= right
            : op === '>'
              ? left > right
              : left >= right
      }
      if (typeof left === 'string' && typeof right === 'string') {
        return op === '<'
          ? left < right
          : op === '<='
            ? left <= right
            : op === '>'
              ? left > right
              : left >= right
      }
      throw new ExpressionEvalError(`"${op}" requires two numbers or two strings`)
    }
  }
}

function invokeCall(
  callee: string,
  args: readonly ExpressionValue[],
  path: ExpressionNodePath,
  ctx: EvalContext,
): ExpressionValue {
  // Defense-in-depth: the parser already validated the callee, but re-gate on an
  // own-property check of the frozen null-proto table so a lookup can never
  // reach an inherited member.
  if (!Object.prototype.hasOwnProperty.call(EXPRESSION_BUILTINS, callee)) {
    throw new ExpressionEvalError(`unknown function: ${callee}`)
  }
  const builtin = EXPRESSION_BUILTINS[callee]!
  if (args.length < builtin.minArgs || args.length > builtin.maxArgs) {
    throw new ExpressionEvalError(`${callee}: wrong number of arguments (${args.length})`)
  }
  if (isStatefulBuiltin(callee)) {
    if (ctx.invokeStateful === undefined) {
      throw new ExpressionEvalError(`${callee}: stateful evaluation context is required`)
    }
    return ctx.invokeStateful({ name: callee, path, args })
  }
  return builtin.apply(args, ctx.hooks)
}

/** Evaluate an AST node against a scope. Throws `ExpressionEvalError` on any
 *  runtime failure (unknown identifier, type mismatch, non-finite result,
 *  step-budget exhaustion). */
export function evaluateAst(
  node: ExpressionNode,
  scope: Record<string, ExpressionValue>,
  opts?: ExpressionEvalOptions,
): ExpressionValue {
  const ctx: EvalContext = {
    scope,
    hooks: opts?.hooks ?? EMPTY_HOOKS,
    maxSteps: opts?.maxSteps ?? MAX_EXPRESSION_EVAL_STEPS,
    ...(opts?.invokeStateful === undefined ? {} : { invokeStateful: opts.invokeStateful }),
    steps: 0,
  }
  return evalNode(node, ctx, 'root')
}
