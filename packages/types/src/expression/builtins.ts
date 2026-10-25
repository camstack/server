/**
 * Frozen, null-prototype builtin function table for the expression engine
 * (spec §4 rule 4). The table is the SOLE surface of callable functions: the
 * parser rejects any callee not in it, and the evaluator gates each call on an
 * own-property check against it.
 *
 * Because the object has a NULL prototype AND is `Object.freeze`d:
 *  - it cannot be polluted (no `__proto__` / `constructor` write reaches it);
 *  - a lookup for `toString` / `hasOwnProperty` / `constructor` finds NOTHING
 *    (there is no `Object.prototype` in the chain), so those names are not
 *    callable — they are simply "unknown function" at parse time.
 *
 * Every numeric argument is validated as a finite number and every numeric
 * RESULT is re-checked finite, so `/0`, `sqrt(-1)` (→ NaN) and overflow
 * (`pow(10,400)` → Infinity) all raise `ExpressionEvalError` and fail the link
 * closed rather than emitting a garbage value.
 */

import type { ExpressionValue } from './ast.js'
import {
  DEFAULT_FIRST_SIGHTING_FRESHNESS_MS,
  evaluateSensorLevelEdge,
} from '../catalogs/sensor-active-state.js'
import type {
  CountCallState,
  DwellCallState,
  LatchedAtCallState,
  RoseCallState,
  StatefulExpressionMemory,
} from './expression-source.js'
import { ExpressionEvalError } from './errors.js'

/** Optional runtime hooks the evaluator threads through to builtins. */
export interface ExpressionEvalHooks {
  /** Convert `value` from unit `from` to unit `to`; `null` when the pair is
   *  not convertible. Absent hook → `convert` uses its identity-only stub. */
  readonly convert?: (value: number, from: string, to: string) => number | null
  /**
   * Epoch ms of THIS evaluation. `evaluateExpressionSource` sets it to the same
   * `now` the scope carries. A windowed builtin with no clock fails closed:
   * reading the wall clock here would make an evaluation unrepeatable.
   */
  readonly now?: number
  /**
   * Called by a windowed builtin with the instant its answer will change ON ITS
   * OWN, with no source event. The composer arms ONE timer at the earliest such
   * instant. That is a deadline, never a poll (D659).
   */
  readonly noteDeadline?: (at: number) => void
}

export interface ExpressionBuiltin {
  readonly minArgs: number
  /** `Number.POSITIVE_INFINITY` for variadic builtins. */
  readonly maxArgs: number
  readonly apply: (args: readonly ExpressionValue[], hooks: ExpressionEvalHooks) => ExpressionValue
}

export type StatefulExpressionBuiltin = 'rose' | 'count' | 'dwell' | 'latchedAt'

export function isStatefulBuiltin(name: string): name is StatefulExpressionBuiltin {
  return name === 'rose' || name === 'count' || name === 'dwell' || name === 'latchedAt'
}

// ── argument / result helpers ───────────────────────────────────────────────

function asFiniteNumber(value: unknown, name: string, index: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ExpressionEvalError(`${name}: argument ${index + 1} must be a finite number`)
  }
  return value
}

function asString(value: unknown, name: string, index: number): string {
  if (typeof value !== 'string') {
    throw new ExpressionEvalError(`${name}: argument ${index + 1} must be a string`)
  }
  return value
}

function finiteResult(value: number, name: string): number {
  if (!Number.isFinite(value)) {
    throw new ExpressionEvalError(`${name}: produced a non-finite result`)
  }
  return value
}

function allFiniteNumbers(args: readonly ExpressionValue[], name: string): number[] {
  return args.map((a, idx) => asFiniteNumber(a, name, idx))
}

function asBoolean(value: unknown, name: string, index: number): boolean {
  if (typeof value !== 'boolean') {
    throw new ExpressionEvalError(`${name}: argument ${index + 1} must be a boolean`)
  }
  return value
}

/** A plain decimal (optional sign, fraction, exponent) — never hex, never `Infinity`, never a unit suffix. */
const DECIMAL = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/

/**
 * `number(x)`: a finite number, or a string that IS one, as a number; every
 * other value — `''`, `'unavailable'`, a boolean, null — is `null`
 * (unavailable, never 0: D393). The one bridge from a string-valued source (an
 * HA sensor with a unit and no device_class is an `enum-sensor`) to a number.
 */
function toNumberOrNull(value: ExpressionValue): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!DECIMAL.test(trimmed)) return null
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) ? parsed : null
}

const DEFAULT_ROSE_DEBOUNCE_MS = 2_000

export function evaluateRose(
  level: unknown,
  changedAt: unknown,
  debounceMs: unknown,
  call: RoseCallState,
  field: StatefulExpressionMemory,
  env: {
    readonly currentOutput: number | null
    readonly startedAtMs: number
    readonly nowMs: number
  },
): number | null {
  const active = asBoolean(level, 'rose', 0)
  const timestamp = typeof changedAt === 'number' && Number.isFinite(changedAt) ? changedAt : null
  const debounce =
    debounceMs === undefined ? DEFAULT_ROSE_DEBOUNCE_MS : asFiniteNumber(debounceMs, 'rose', 2)
  if (debounce < 0) {
    throw new ExpressionEvalError('rose: debounce must be a non-negative finite number')
  }

  // Recovery from unavailable: do NOT move edge memory. A provider restart
  // often seeds `false` then pushes the real `on`; updating priorLevel on that
  // seed would re-arm a false→true rise. Keep the pre-flap level (or seed it
  // once when there was none) and emit nothing.
  if (call.disarmNext === true || field.disarmRoseNext) {
    call.disarmNext = false
    if (call.priorLevel === undefined) call.priorLevel = active
    return env.currentOutput
  }

  const verdict = evaluateSensorLevelEdge({
    level: active,
    changedAt: timestamp,
    priorLevel: call.priorLevel,
    startedAtMs: env.startedAtMs,
    nowMs: env.nowMs,
    firstSightingFreshnessMs: DEFAULT_FIRST_SIGHTING_FRESHNESS_MS,
  })
  call.priorLevel = verdict.kind === 'rise' ? true : verdict.nextPriorLevel
  if (verdict.kind === 'none') return env.currentOutput
  if (field.acceptedEdgeAt !== null && verdict.timestamp - field.acceptedEdgeAt < debounce) {
    return env.currentOutput
  }
  field.acceptedEdgeAt = verdict.timestamp
  return verdict.timestamp
}

/** Next evaluation of every `rose` call baselines without rising. */
export function disarmRoseMemory(memory: StatefulExpressionMemory): void {
  memory.disarmRoseNext = true
  for (const [path, call] of memory.calls) {
    if (call.kind !== 'rose') continue
    memory.calls.set(path, { ...call, disarmNext: true })
  }
}

/**
 * `count(x)`: how many times `x` strictly advanced (D670). It starts on the
 * first ANSWERED read of `x`:
 *  - an answered `null` ("never happened") primes it with no high-water, so the
 *    next finite value is a real advance and counts 1;
 *  - an answered finite value primes it with that value as the high-water and
 *    no increment — it is history, not an event;
 *  - anything else (a read that did not answer reaches here as neither) does
 *    NOT prime it (D393: unknown is not null).
 * An unavailable binding never reaches this function at all: the field is
 * judged unavailable before the expression runs.
 *
 * Edge case, accepted: an input that answers `null` and LATER reports a
 * historical value (a sensor's `lastChangedAt` that was null until its first
 * report) counts that value once. For the doorbell it cannot happen — its
 * input is its own `lastPressedAt`, which only advances on a `rose` edge that
 * also emits the press — but an external input can overcount by one.
 */
function asNonNegativeMs(value: unknown, name: string, index: number): number {
  const ms = asFiniteNumber(value, name, index)
  if (ms < 0) {
    throw new ExpressionEvalError(`${name}: delay must be a non-negative finite number`)
  }
  return ms
}

/**
 * `dwell(active, onForMs, offForMs)`: unknown until a delay elapses, then holds
 * the latched boolean through gaps shorter than the opposing delay (D933).
 */
export function evaluateDwell(
  activeRaw: unknown,
  onForMsRaw: unknown,
  offForMsRaw: unknown,
  call: DwellCallState,
  nowMs: number,
  hooks?: ExpressionEvalHooks,
): boolean | null {
  const active = asBoolean(activeRaw, 'dwell', 0)
  const onForMs = asNonNegativeMs(onForMsRaw, 'dwell', 1)
  const offForMs = asNonNegativeMs(offForMsRaw, 'dwell', 2)

  if (call.latched === null) {
    if (call.seenSince === null) call.seenSince = nowMs
    const delay = active ? onForMs : offForMs
    if (nowMs - call.seenSince >= delay) {
      call.latched = active
      return call.latched
    }
    hooks?.noteDeadline?.(call.seenSince + delay)
    return null
  }

  if (active === call.latched) {
    call.pendingSince = null
    return call.latched
  }

  if (call.pendingSince === null) call.pendingSince = nowMs
  const delay = active ? onForMs : offForMs
  if (nowMs - call.pendingSince >= delay) {
    call.latched = active
    call.pendingSince = null
    return call.latched
  }
  hooks?.noteDeadline?.(call.pendingSince + delay)
  return call.latched
}

/** `latchedAt(value)`: epoch ms when `value` last changed; null clears the stamp. */
export function evaluateLatchedAt(
  value: unknown,
  call: LatchedAtCallState,
  nowMs: number,
): number | null {
  if (value === null) {
    call.last = null
    call.at = null
    return null
  }
  if (typeof value !== 'boolean' && typeof value !== 'number' && typeof value !== 'string') {
    return call.at
  }
  if (call.last !== value) {
    call.last = value
    call.at = nowMs
  }
  return call.at
}

export function evaluateCount(
  input: unknown,
  call: CountCallState,
  currentOutput: unknown,
): number {
  const currentCount =
    typeof currentOutput === 'number' && Number.isFinite(currentOutput) && currentOutput >= 0
      ? currentOutput
      : 0
  if (input === null) {
    call.primed = true
    return currentCount
  }
  if (typeof input !== 'number' || !Number.isFinite(input)) return currentCount
  if (!call.primed) {
    call.primed = true
    call.highWater = input
    return currentCount
  }
  if (call.highWater !== null && input <= call.highWater) return currentCount
  call.highWater = input
  return currentCount + 1
}

// ── builtin implementations ────────────────────────────────────────────────

const INF = Number.POSITIVE_INFINITY

const table: Record<string, ExpressionBuiltin> = {
  min: {
    minArgs: 1,
    maxArgs: INF,
    apply: (args) => finiteResult(Math.min(...allFiniteNumbers(args, 'min')), 'min'),
  },
  max: {
    minArgs: 1,
    maxArgs: INF,
    apply: (args) => finiteResult(Math.max(...allFiniteNumbers(args, 'max')), 'max'),
  },
  abs: {
    minArgs: 1,
    maxArgs: 1,
    apply: (args) => finiteResult(Math.abs(asFiniteNumber(args[0]!, 'abs', 0)), 'abs'),
  },
  floor: {
    minArgs: 1,
    maxArgs: 1,
    apply: (args) => finiteResult(Math.floor(asFiniteNumber(args[0]!, 'floor', 0)), 'floor'),
  },
  ceil: {
    minArgs: 1,
    maxArgs: 1,
    apply: (args) => finiteResult(Math.ceil(asFiniteNumber(args[0]!, 'ceil', 0)), 'ceil'),
  },
  sqrt: {
    minArgs: 1,
    maxArgs: 1,
    apply: (args) => finiteResult(Math.sqrt(asFiniteNumber(args[0]!, 'sqrt', 0)), 'sqrt'),
  },
  round: {
    minArgs: 1,
    maxArgs: 2,
    apply: (args) => {
      const x = asFiniteNumber(args[0]!, 'round', 0)
      const digits = args.length > 1 ? Math.trunc(asFiniteNumber(args[1]!, 'round', 1)) : 0
      if (digits < 0 || digits > 100) {
        throw new ExpressionEvalError('round: digits must be between 0 and 100')
      }
      const factor = 10 ** digits
      return finiteResult(Math.round(x * factor) / factor, 'round')
    },
  },
  pow: {
    minArgs: 2,
    maxArgs: 2,
    apply: (args) =>
      finiteResult(asFiniteNumber(args[0]!, 'pow', 0) ** asFiniteNumber(args[1]!, 'pow', 1), 'pow'),
  },
  clamp: {
    minArgs: 3,
    maxArgs: 3,
    apply: (args) => {
      const x = asFiniteNumber(args[0]!, 'clamp', 0)
      const lo = asFiniteNumber(args[1]!, 'clamp', 1)
      const hi = asFiniteNumber(args[2]!, 'clamp', 2)
      if (lo > hi) {
        throw new ExpressionEvalError('clamp: lower bound is greater than upper bound')
      }
      return finiteResult(Math.min(hi, Math.max(lo, x)), 'clamp')
    },
  },
  avg: {
    minArgs: 1,
    maxArgs: INF,
    apply: (args) => {
      const nums = allFiniteNumbers(args, 'avg')
      const total = nums.reduce((acc, v) => acc + v, 0)
      return finiteResult(total / nums.length, 'avg')
    },
  },
  sum: {
    minArgs: 1,
    maxArgs: INF,
    apply: (args) =>
      finiteResult(
        allFiniteNumbers(args, 'sum').reduce((acc, v) => acc + v, 0),
        'sum',
      ),
  },
  coalesce: {
    minArgs: 1,
    maxArgs: INF,
    // First non-null argument (any type); null when all are null. No numeric
    // validation — this is the user-facing fallback idiom (`coalesce(a, 0)`).
    apply: (args) => {
      for (const a of args) {
        if (a !== null) return a
      }
      return null
    },
  },
  age: {
    minArgs: 2,
    maxArgs: 2,
    // age(now, ts) = now - ts (both epoch ms). Elapsed time since a timestamp.
    apply: (args) =>
      finiteResult(asFiniteNumber(args[0]!, 'age', 0) - asFiniteNumber(args[1]!, 'age', 1), 'age'),
  },
  convert: {
    minArgs: 3,
    maxArgs: 3,
    // convert(x, from, to). Delegates to the injected unit table when present;
    // otherwise fails CLOSED unless from===to (after trim) — a silent null unit
    // conversion is a data bug, so an unconfigured conversion skips the link.
    apply: (args, hooks) => {
      const x = asFiniteNumber(args[0]!, 'convert', 0)
      const from = asString(args[1]!, 'convert', 1).trim()
      const to = asString(args[2]!, 'convert', 2).trim()
      if (hooks.convert) {
        const out = hooks.convert(x, from, to)
        if (out === null) {
          throw new ExpressionEvalError(`convert: cannot convert '${from}' to '${to}'`)
        }
        return finiteResult(out, 'convert')
      }
      if (from === to) return x
      throw new ExpressionEvalError('convert: unit conversion table not installed')
    },
  },
  any: {
    minArgs: 1,
    maxArgs: INF,
    apply: (args) => args.map((a, i) => asBoolean(a, 'any', i)).some((b) => b),
  },
  all: {
    minArgs: 1,
    maxArgs: INF,
    apply: (args) => args.map((a, i) => asBoolean(a, 'all', i)).every((b) => b),
  },
  within: {
    minArgs: 2,
    maxArgs: 2,
    // within(ts, windowMs): did `ts` happen no longer than `windowMs` ago? A
    // null `ts` means "never happened", which is outside every window. That is
    // a FACT, not a failed read, so it is not an error (D393 is about failed
    // measurements).
    apply: (args, hooks) => {
      const windowMs = asFiniteNumber(args[1]!, 'within', 1)
      if (windowMs < 0) throw new ExpressionEvalError('within: the window must not be negative')
      const at = args[0]!
      if (at === null) return false
      const ts = asFiniteNumber(at, 'within', 0)
      const now = hooks.now
      if (now === undefined || !Number.isFinite(now)) {
        throw new ExpressionEvalError('within: no clock was supplied to this evaluation')
      }
      const inside = now - ts <= windowMs
      // The first instant at which `now - ts > windowMs` holds.
      if (inside) hooks.noteDeadline?.(ts + windowMs + 1)
      return inside
    },
  },
  number: {
    minArgs: 1,
    maxArgs: 1,
    apply: (args) => toNumberOrNull(args[0]!),
  },
  latest: {
    minArgs: 1,
    maxArgs: INF,
    // The most recent of several timestamps. Nulls ("never") are skipped; the
    // answer is null only when every argument is.
    apply: (args) => {
      const present = args.flatMap((a, i) => (a === null ? [] : [asFiniteNumber(a, 'latest', i)]))
      return present.length === 0 ? null : finiteResult(Math.max(...present), 'latest')
    },
  },
  rose: {
    minArgs: 2,
    maxArgs: 3,
    apply: () => {
      throw new ExpressionEvalError('rose: stateful evaluation context is required')
    },
  },
  count: {
    minArgs: 1,
    maxArgs: 1,
    apply: () => {
      throw new ExpressionEvalError('count: stateful evaluation context is required')
    },
  },
  dwell: {
    minArgs: 3,
    maxArgs: 3,
    apply: () => {
      throw new ExpressionEvalError('dwell: stateful evaluation context is required')
    },
  },
  latchedAt: {
    minArgs: 1,
    maxArgs: 1,
    apply: () => {
      throw new ExpressionEvalError('latchedAt: stateful evaluation context is required')
    },
  },
}

/** Frozen, null-prototype builtin table. */
export const EXPRESSION_BUILTINS: Readonly<Record<string, ExpressionBuiltin>> = Object.freeze(
  Object.assign(Object.create(null), table),
)

/** The set of valid builtin names — used by the parser to reject unknown
 *  callees at parse time (immediate author feedback). */
export const EXPRESSION_BUILTIN_NAMES: ReadonlySet<string> = new Set(Object.keys(table))
