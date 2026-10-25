/**
 * One composed field, evaluated from what its sources say NOW (D659).
 *
 * Pure. The composer calls it on every source change, and the slice-5 editor
 * will call it for its live preview, so both see the same answer.
 *
 * The rules (spec §2):
 *  - a source that is offline or unreadable keeps its last value and is marked
 *    STALE; the field is stale and keeps computing (D49);
 *  - a source that is GONE makes the field UNAVAILABLE, `fatal`, and never a
 *    plausible number (D393);
 *  - a source that is unavailable but NOT gone (e.g. a cap unregistered at
 *    runtime, R7b) makes the field UNAVAILABLE, non-fatal, `value: null`: it
 *    may come back on its own, no block failure is raised for it;
 *  - an expression that fails on a value makes the field unavailable for that
 *    value, and NOT fatal: the next value may compute.
 *
 * `confirmed` (D663, D49): whether a NON-fatal unavailability is an ANSWER — a
 * cap the provider unregistered and a re-read agreed, a field the source
 * reported without, an expression that failed on a value — or only the
 * absence of one (a failed read, a first or empty read, a source not tracked
 * yet). Only a confirmed unavailability may hand a `release`-mode field back
 * to the native provider; an unconfirmed one holds it on its last value.
 * Absent means NOT confirmed. Fatal is always confirmed.
 *
 * When an expression has more than one unavailable binding, a FATAL one always
 * wins the outcome, regardless of position: every binding is scanned before
 * the field is judged, so an earlier non-fatal binding (e.g. a cap that is
 * momentarily unregistered) can never hide a later fatal one (a deleted
 * source) behind an early return.
 */
import { normalizeUnit } from '../device/source-info.js'
import type { ExpressionValue } from '../expression/ast.js'
import { type ExpressionEvalHooks, evaluateCount } from '../expression/builtins.js'
import {
  evaluateExpressionSource,
  evaluateStatefulExpressionCall,
  type StatefulExpressionMemory,
} from '../expression/expression-source.js'
import { tryConvertUnit } from '../units/convert.js'
import {
  type CompositionExpressionSource,
  type CompositionFieldRead,
  type CompositionFieldSource,
  compositionSourceKey,
} from './composition.js'
import { expressionContainsBuiltinCall } from './expression-kinds.js'

export interface SourceFreshReading {
  readonly state: 'fresh'
  readonly value: ExpressionValue
}
export interface SourceStaleReading {
  readonly state: 'stale'
  readonly value: ExpressionValue
  readonly reason: string
}
export interface SourceUnavailableReading {
  readonly state: 'unavailable'
  readonly reason: string
  /** True when the source is GONE: device or cap missing, two reads agreed. */
  readonly fatal: boolean
  /** The unavailability is an answer, not a missing one (see the header). Absent = not confirmed. */
  readonly confirmed?: boolean
}
export type SourceReading = SourceFreshReading | SourceStaleReading | SourceUnavailableReading
export type SourceReader = (read: CompositionFieldRead) => SourceReading

export interface FieldValueOutcome {
  readonly state: 'fresh' | 'stale'
  readonly value: ExpressionValue
  readonly reason: string | null
  /** When a windowed builtin's answer flips on its own; null when nothing will. */
  readonly deadline: number | null
  /**
   * The value is the field's LAST output, held over a source that did not
   * answer: the expression did not run. Set by the composer for an
   * edge-latched (`rose`) field (D713) — a recovery from it is a recovery from unavailable.
   */
  readonly held?: true
}
export interface FieldUnavailableOutcome {
  readonly state: 'unavailable'
  /** Always `null` — an unavailable field is never a stand-in value (D393). */
  readonly value: null
  readonly reason: string
  readonly fatal: boolean
  /** Fatal, or a non-fatal unavailability that is an answer (see the header). Absent = not confirmed. */
  readonly confirmed?: boolean
  /**
   * Every source answered and the expression failed on the values. Absent =
   * a source did not answer. Only the latter is an outage a stateful edge
   * must re-baseline after (D716).
   */
  readonly expressionFailed?: true
}
export type FieldOutcome = FieldValueOutcome | FieldUnavailableOutcome

export interface EvaluateCompositionFieldInput {
  readonly source: CompositionFieldSource
  readonly read: SourceReader
  readonly now: number
  readonly stateful?: {
    readonly currentOutput: unknown
    readonly expressionMemory: StatefulExpressionMemory
    readonly startedAtMs: number
    /** Scope structural AST paths to their owning output field. */
    readonly callPathPrefix?: string
  }
}

function describeRead(read: CompositionFieldRead): string {
  return `${compositionSourceKey(read.source)} ${read.cap}.${read.fieldPath}`
}

function isConfirmed(reading: SourceUnavailableReading): boolean {
  return reading.fatal || reading.confirmed === true
}

function fromReading(reading: SourceReading, read: CompositionFieldRead): FieldOutcome {
  if (reading.state === 'unavailable') {
    return {
      state: 'unavailable',
      value: null,
      reason: `${describeRead(read)}: ${reading.reason}`,
      fatal: reading.fatal,
      confirmed: isConfirmed(reading),
    }
  }
  return {
    state: reading.state,
    value: reading.value,
    reason: reading.state === 'stale' ? `${describeRead(read)}: ${reading.reason}` : null,
    deadline: null,
  }
}

function expressionOutcome(
  source: CompositionExpressionSource,
  read: SourceReader,
  now: number,
  stateful: EvaluateCompositionFieldInput['stateful'],
): FieldOutcome {
  const values: Record<string, ExpressionValue> = {}
  const staleReasons: string[] = []
  // A fatal unavailable binding always wins the outcome, no matter where it
  // falls in iteration order — so every binding is scanned before judging,
  // rather than returning on the first unavailable one (that would let an
  // earlier non-fatal binding mask a later deleted source). Likewise a
  // CONFIRMED non-fatal one wins over an unconfirmed one: the field is
  // unavailable for a real reason even while another binding's read failed.
  let fatalUnavailable: FieldUnavailableOutcome | null = null
  let nonFatalUnavailable: FieldUnavailableOutcome | null = null
  for (const [name, binding] of Object.entries(source.bindings)) {
    if (binding.kind === 'literal') {
      values[name] = binding.value
      continue
    }
    const reading = read(binding)
    if (reading.state === 'unavailable') {
      const outcome: FieldUnavailableOutcome = {
        state: 'unavailable',
        value: null,
        reason: `binding \`${name}\` (${describeRead(binding)}): ${reading.reason}`,
        fatal: reading.fatal,
        confirmed: isConfirmed(reading),
      }
      if (reading.fatal) {
        fatalUnavailable = outcome
        break
      }
      if (nonFatalUnavailable === null || (outcome.confirmed && !nonFatalUnavailable.confirmed))
        nonFatalUnavailable = outcome
      continue
    }
    values[name] = reading.value
    if (reading.state === 'stale') staleReasons.push(`\`${name}\`: ${reading.reason}`)
  }
  const unavailable = fatalUnavailable ?? nonFatalUnavailable
  if (unavailable !== null) {
    if (
      stateful !== undefined &&
      stateful.currentOutput !== undefined &&
      expressionContainsBuiltinCall(source.expr, 'count')
    ) {
      return {
        state: 'stale',
        value: evaluateCount(
          null,
          { kind: 'count', highWater: null, primed: false },
          stateful.currentOutput,
        ),
        reason: `${unavailable.reason}; holding the last accumulator value`,
        deadline: null,
      }
    }
    return unavailable
  }
  const deadlines: number[] = []
  const hooks: ExpressionEvalHooks = {
    noteDeadline: (at) => deadlines.push(at),
    // G3: the unit table every other unit consumer uses, keyed by the spellings
    // `normalizeUnit` produces — so a hand-written "F" / "celsius" converts. A
    // refused pair is `null` here, which the builtin turns into a NAMED
    // evaluation error quoting the units as written.
    convert: (value, from, to) =>
      tryConvertUnit(value, normalizeUnit(from) ?? from, normalizeUnit(to) ?? to) ?? null,
  }
  const result = evaluateExpressionSource(source.expr, values, now, {
    hooks,
    ...(stateful === undefined
      ? {}
      : {
          invokeStateful: (invocation) =>
            evaluateStatefulExpressionCall(
              stateful.callPathPrefix === undefined
                ? invocation
                : { ...invocation, path: `${stateful.callPathPrefix}@${invocation.path}` },
              stateful.expressionMemory,
              {
                currentOutput: stateful.currentOutput,
                startedAtMs: stateful.startedAtMs,
                nowMs: now,
              },
              hooks,
            ),
        }),
  })
  if (!result.ok) {
    return {
      state: 'unavailable',
      value: null,
      reason: `the expression failed: ${result.error}`,
      fatal: false,
      confirmed: true,
      expressionFailed: true,
    }
  }
  return {
    state: staleReasons.length > 0 ? 'stale' : 'fresh',
    value: result.value,
    reason: staleReasons.length > 0 ? staleReasons.join('; ') : null,
    deadline: deadlines.length > 0 ? Math.min(...deadlines) : null,
  }
}

export function evaluateCompositionField(input: EvaluateCompositionFieldInput): FieldOutcome {
  const { source } = input
  switch (source.kind) {
    case 'from':
      return fromReading(input.read(source), source)
    case 'expression':
      return expressionOutcome(source, input.read, input.now, input.stateful)
    case 'code':
      return {
        state: 'unavailable',
        value: null,
        reason: 'code fields are not runnable in the composer — they arrive in slice 4',
        fatal: true,
        confirmed: true,
      }
  }
}
