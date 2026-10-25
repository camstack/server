/**
 * Expression-source helpers — the single seam every consumer of the engine
 * shares, so author-time validation and read-time evaluation cannot drift.
 *
 * These were written for the `expression` device-link source and outlived it:
 * wiring was deleted on 2026-08-08 with zero live users, and the engine was
 * kept on purpose. It is the derivation language of a composed device and the
 * escape-hatch leaf of an automation's condition tree — one language, three
 * positions (derive a value, gate a trigger, compute an argument).
 */

import type { ExpressionValue } from './ast.js'
import {
  evaluateCount,
  evaluateDwell,
  evaluateLatchedAt,
  evaluateRose,
  EXPRESSION_BUILTIN_NAMES,
  type ExpressionEvalHooks,
} from './builtins.js'
import { compileExpressionSafe } from './compile.js'
import { ExpressionEvalError } from './errors.js'
import {
  createExpressionScope,
  type ExpressionEvalOptions,
  evaluateAst,
  type StatefulCallInvocation,
} from './evaluator.js'
import {
  EXPRESSION_IDENTIFIER_RE,
  MAX_EXPRESSION_BINDINGS,
  RESERVED_BINDING_NAMES,
} from './limits.js'

export interface RoseCallState {
  readonly kind: 'rose'
  priorLevel?: boolean
  /**
   * Next evaluation seeds `priorLevel` from the current level and emits no
   * edge. Set when a binding recovers from confirmed-unavailable (provider
   * restart / unregister flap): inventing a false→true rise from the restore
   * seed is a synthetic press (D49 inverse).
   */
  disarmNext?: boolean
}

export interface CountCallState {
  readonly kind: 'count'
  highWater: number | null
  /** Whether a read has ANSWERED yet (a finite value or `null`); `highWater` means nothing before. */
  primed: boolean
}

export interface DwellCallState {
  readonly kind: 'dwell'
  pendingSince: number | null
  latched: boolean | null
  seenSince: number | null
}

export interface LatchedAtCallState {
  readonly kind: 'latchedAt'
  last: ExpressionValue | undefined
  at: number | null
}

export type StatefulCallState = RoseCallState | CountCallState | DwellCallState | LatchedAtCallState

export interface StatefulExpressionMemory {
  readonly calls: Map<string, StatefulCallState>
  acceptedEdgeAt: number | null
  /**
   * Every `rose` call in the next successful evaluation baselines without
   * rising. Set when the field recovers from unavailable (binding flap).
   */
  disarmRoseNext: boolean
}

export function createStatefulExpressionMemory(): StatefulExpressionMemory {
  return { calls: new Map(), acceptedEdgeAt: null, disarmRoseNext: false }
}

export function cloneStatefulExpressionMemory(
  memory: StatefulExpressionMemory,
): StatefulExpressionMemory {
  return {
    calls: new Map([...memory.calls].map(([path, call]) => [path, { ...call }])),
    acceptedEdgeAt: memory.acceptedEdgeAt,
    disarmRoseNext: memory.disarmRoseNext,
  }
}

export interface StatefulExpressionEnvironment {
  readonly currentOutput: unknown
  readonly startedAtMs: number
  readonly nowMs: number
}

export function evaluateStatefulExpressionCall(
  invocation: StatefulCallInvocation,
  memory: StatefulExpressionMemory,
  env: StatefulExpressionEnvironment,
  hooks?: ExpressionEvalHooks,
): ExpressionValue {
  const existing = memory.calls.get(invocation.path)
  switch (invocation.name) {
    case 'rose': {
      const call: RoseCallState = existing?.kind === 'rose' ? existing : { kind: 'rose' }
      memory.calls.set(invocation.path, call)
      const currentOutput =
        env.currentOutput === null ||
        (typeof env.currentOutput === 'number' && Number.isFinite(env.currentOutput))
          ? env.currentOutput
          : null
      return evaluateRose(
        invocation.args[0],
        invocation.args[1],
        invocation.args[2],
        call,
        memory,
        { currentOutput, startedAtMs: env.startedAtMs, nowMs: env.nowMs },
      )
    }
    case 'count': {
      const call: CountCallState =
        existing?.kind === 'count' ? existing : { kind: 'count', highWater: null, primed: false }
      memory.calls.set(invocation.path, call)
      return evaluateCount(invocation.args[0], call, env.currentOutput)
    }
    case 'dwell': {
      const call: DwellCallState =
        existing?.kind === 'dwell'
          ? existing
          : { kind: 'dwell', pendingSince: null, latched: null, seenSince: null }
      memory.calls.set(invocation.path, call)
      return evaluateDwell(
        invocation.args[0],
        invocation.args[1],
        invocation.args[2],
        call,
        env.nowMs,
        hooks,
      )
    }
    case 'latchedAt': {
      const call: LatchedAtCallState =
        existing?.kind === 'latchedAt' ? existing : { kind: 'latchedAt', last: undefined, at: null }
      memory.calls.set(invocation.path, call)
      return evaluateLatchedAt(invocation.args[0], call, env.nowMs)
    }
  }
}

/** The `now` epoch-ms binding is auto-injected into every evaluation and is a
 *  reserved binding name (authors may not rebind it). */
export const EXPRESSION_INJECTED_NOW = 'now'

/**
 * Coerce an untrusted `getByPath` / mirror read to an `ExpressionValue`.
 * Non-primitive values (objects, arrays, `undefined`, functions, bigint,
 * symbol) and non-finite numbers become `undefined` so the caller can apply
 * its binding-miss policy (→ `null`). `null` itself is a valid value.
 */
export function toExpressionValue(raw: unknown): ExpressionValue | undefined {
  if (raw === null) return null
  if (typeof raw === 'string') return raw
  if (typeof raw === 'boolean') return raw
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : undefined
  return undefined
}

/** Shape the author-time validator accepts (structural subset of an
 *  {@link ExpressionSource}). */
export interface ExpressionSourceInput {
  readonly expr: string
  readonly bindings: Readonly<Record<string, unknown>>
}

/**
 * Author-time validation. Returns `null` when the source is valid, else a
 * human-readable error message. Checks: the expression compiles; binding count
 * is within `MAX_EXPRESSION_BINDINGS`; every binding name is a legal identifier,
 * is not reserved (`now`/keywords) and does not shadow a builtin; and every
 * FREE identifier of the AST is covered by a binding or the injected `now`.
 */
export function validateExpressionSource(src: ExpressionSourceInput): string | null {
  const names = Object.keys(src.bindings)
  if (names.length > MAX_EXPRESSION_BINDINGS) {
    return `too many bindings (${names.length} > ${MAX_EXPRESSION_BINDINGS})`
  }
  for (const name of names) {
    if (!EXPRESSION_IDENTIFIER_RE.test(name)) {
      return `invalid binding name '${name}'`
    }
    if (RESERVED_BINDING_NAMES.has(name)) {
      return `binding name '${name}' is reserved`
    }
    if (EXPRESSION_BUILTIN_NAMES.has(name)) {
      return `binding name '${name}' shadows a builtin function`
    }
  }
  const compiled = compileExpressionSafe(src.expr)
  if (!compiled.ok) return compiled.error
  const bound = new Set(names)
  for (const id of compiled.parsed.identifiers) {
    if (id === EXPRESSION_INJECTED_NOW) continue
    if (!bound.has(id)) return `expression references unbound identifier '${id}'`
  }
  return null
}

/** Result of an expression evaluation — `ok` carries the value, the error
 *  branch carries a reason the caller can log while it skips the derivation. */
export type EvaluateExpressionSourceResult =
  | { readonly ok: true; readonly value: ExpressionValue }
  | { readonly ok: false; readonly error: string }

/**
 * Shared read-path evaluation. Builds a null-proto scope from `bindingValues`
 * plus the injected `now` (supplied by the caller for determinism and
 * testability), compiles via the LRU, and evaluates. Stateful calls are
 * delegated through `opts.invokeStateful` with their stable AST path. Any
 * failure (parse or eval) returns `{ ok: false }` — the caller treats that as
 * "skip this derivation", never as a throw that takes the pass down.
 */
export function evaluateExpressionSource(
  expr: string,
  bindingValues: Readonly<Record<string, ExpressionValue>>,
  now: number,
  opts?: ExpressionEvalOptions,
): EvaluateExpressionSourceResult {
  const compiled = compileExpressionSafe(expr)
  if (!compiled.ok) return { ok: false, error: compiled.error }
  const scope = createExpressionScope({ ...bindingValues, [EXPRESSION_INJECTED_NOW]: now })
  // The clock a windowed builtin reads is the SAME `now` the scope carries.
  const hooks: ExpressionEvalHooks = { ...opts?.hooks, now }
  try {
    return { ok: true, value: evaluateAst(compiled.parsed.ast, scope, { ...opts, hooks }) }
  } catch (err: unknown) {
    return {
      ok: false,
      error: err instanceof ExpressionEvalError ? err.message : String(err),
    }
  }
}
