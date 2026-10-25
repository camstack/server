/**
 * One composed field's record and the pure judgements over it (D659, D663):
 * what it may write, whether it is released (a CONFIRMED unavailability of a
 * `release`-mode field, S1b) or HELD (no answer yet, D49), and how a report or a
 * log line names it. Split from `composition-runtime.ts`, which holds the
 * behaviour.
 */
import {
  type CapabilityLookup,
  type CompositionFieldItem,
  type CompositionFieldPlan,
  type CompositionFieldState,
  compositionFieldKey,
  compositionItemFieldPath,
  createStatefulExpressionMemory,
  type ExpressionValue,
  type FieldOutcome,
  type StatefulExpressionMemory,
} from '@camstack/types'
import type { PulseFieldSeed } from './pulse-seed.js'

export const NO_FIELDS: ReadonlySet<string> = new Set()

export interface FieldRecord {
  readonly plan: CompositionFieldPlan
  readonly outcome: FieldOutcome | null
  /** The effective target value observed before this runtime took ownership. Never changes. */
  readonly initial: unknown
  /** Whether `written` is an accepted runtime answer; kept separate because every falsey value is valid. */
  readonly hasWritten: boolean
  /** What the target last accepted from this runtime. */
  readonly written: unknown
  readonly expressionMemory: StatefulExpressionMemory
  /** Last finite state value already represented by a derived event. */
  readonly eventHighWater: number | null
  /**
   * A pulse timestamp whose start seed could not be read (D49, D938). A null
   * result is not published, so a failed read is not "no ring".
   */
  readonly pulseHold: boolean
}

export function fieldKey(plan: CompositionFieldPlan): string {
  return compositionFieldKey(plan)
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function valueAtPath(value: unknown, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>((node, segment) => (isRecord(node) ? node[segment] : undefined), value)
}

function initialValue(
  plan: CompositionFieldPlan,
  byCap: ReadonlyMap<string, Readonly<Record<string, unknown>> | null> | undefined,
  lookupCap: CapabilityLookup,
): unknown {
  const slice = byCap?.get(plan.cap)
  if (slice === undefined || slice === null) return undefined
  const item = plan.item
  if (item === undefined) return valueAtPath(slice, plan.path)
  const itemArray = lookupCap(plan.cap)?.status?.itemArray
  if (itemArray === undefined || itemArray.path !== item.arrayPath) return undefined
  const entries = valueAtPath(slice, item.arrayPath)
  if (!Array.isArray(entries)) return undefined
  const matching = entries.find(
    (entry) => isRecord(entry) && entry[itemArray.keyField] === item.key,
  )
  return valueAtPath(matching, plan.path)
}

export function createFieldRecord(
  plan: CompositionFieldPlan,
  byCap: ReadonlyMap<string, Readonly<Record<string, unknown>> | null> | undefined,
  lookupCap: CapabilityLookup,
): FieldRecord {
  const initial = initialValue(plan, byCap, lookupCap)
  return {
    plan,
    outcome: null,
    initial,
    hasWritten: false,
    written: undefined,
    expressionMemory: createStatefulExpressionMemory(),
    eventHighWater: typeof initial === 'number' && Number.isFinite(initial) ? initial : null,
    pulseHold: false,
  }
}

/** Apply a pulse start seed (D938). `keep` leaves the slice seed in place. */
function applyPulseSeed(record: FieldRecord, seed: PulseFieldSeed | undefined): FieldRecord {
  if (seed === undefined || seed.kind === 'keep') return record
  if (seed.kind === 'hold') {
    return { ...record, initial: undefined, eventHighWater: null, pulseHold: true }
  }
  const value = seed.value
  return {
    ...record,
    initial: value,
    eventHighWater: typeof value === 'number' && Number.isFinite(value) ? value : null,
    pulseHold: false,
  }
}

export function fieldRecords(
  fields: readonly CompositionFieldPlan[],
  byCap: ReadonlyMap<string, Readonly<Record<string, unknown>> | null> | undefined,
  lookupCap: CapabilityLookup,
  pulseSeeds: ReadonlyMap<string, PulseFieldSeed> | undefined,
): ReadonlyMap<string, FieldRecord> {
  return new Map(
    fields.map((plan) => {
      const key = fieldKey(plan)
      const record = applyPulseSeed(createFieldRecord(plan, byCap, lookupCap), pulseSeeds?.get(key))
      return [key, record] as const
    }),
  )
}

export function currentOutput(record: FieldRecord): unknown {
  return record.hasWritten ? record.written : record.initial
}

/** The top-level field a record writes: an item leaf writes its whole array. */
export function topLevelField(plan: CompositionFieldPlan): string {
  return plan.item === undefined ? plan.path : plan.item.arrayPath
}

/** The field as a report or a log line names it: `items[desiccant].status` for an item leaf. */
export function fieldPath(plan: CompositionFieldPlan): string {
  return plan.item === undefined
    ? plan.path
    : compositionItemFieldPath(plan.item.arrayPath, plan.item.key, plan.path)
}

export function itemOf(plan: CompositionFieldPlan): Partial<Pick<CompositionFieldState, 'item'>> {
  return plan.item === undefined ? {} : { item: plan.item }
}

export function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size === b.size && [...a].every((x) => b.has(x))
}

export function valueOf(outcome: FieldOutcome | null): ExpressionValue | undefined {
  return outcome === null || outcome.state === 'unavailable' ? undefined : outcome.value
}

export function reasonOf(outcome: FieldOutcome | null): string | null {
  if (outcome === null) return 'not evaluated yet'
  return outcome.reason
}

/** State, value and reason — what a write or a log line is about. NEVER the deadline (R1). */
export function sameOutcome(a: FieldOutcome | null, b: FieldOutcome): boolean {
  return (
    a !== null && a.state === b.state && valueOf(a) === valueOf(b) && reasonOf(a) === reasonOf(b)
  )
}

/** A source is GONE: the outcome that must never be masked by a non-fatal one. */
export function isFatal(outcome: FieldOutcome | null): boolean {
  return outcome !== null && outcome.state === 'unavailable' && outcome.fatal
}

/** A `release`-mode field whose source is CONFIRMED unavailable: not the composition's to write (S1b). Stale is a value (D49). */
export function isReleased(record: FieldRecord): boolean {
  const outcome = record.outcome
  return (
    record.plan.unavailable === 'release' &&
    outcome?.state === 'unavailable' &&
    outcome.confirmed === true
  )
}

/** A `release`-mode field with no value and no ANSWER yet (a failed, first or empty read): held on its last value, never released (D49). */
export function isHeld(record: FieldRecord): boolean {
  const outcome = record.outcome
  return (
    record.plan.unavailable === 'release' &&
    outcome?.state === 'unavailable' &&
    outcome.confirmed !== true
  )
}

export function namedField(r: FieldRecord): ReleasedField {
  return {
    cap: r.plan.cap,
    path: r.plan.path,
    ...itemOf(r.plan),
    reason: reasonOf(r.outcome) ?? 'unavailable',
  }
}

export function writable(record: FieldRecord): ExpressionValue | undefined {
  const outcome = record.outcome
  if (outcome === null) return undefined
  if (
    record.pulseHold &&
    !record.hasWritten &&
    (outcome.state === 'unavailable' || outcome.value === null)
  ) {
    return undefined
  }
  if (outcome.state !== 'unavailable') return outcome.value
  switch (record.plan.unavailable) {
    case 'null':
      return null
    case 'unknown':
      return 'unknown'
    default:
      return undefined
  }
}

/** A `release`-mode field handed back to the native provider, and why (for the block report). */
export interface ReleasedField {
  readonly cap: string
  readonly path: string
  readonly item?: CompositionFieldItem
  readonly reason: string
}

/** Why a cap's last write did not land; the cap is re-written whole on the next pass that evaluates it. */
export interface PendingWrite {
  readonly kind: 'refused' | 'threw'
  readonly error: string
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function pendingReason(cap: string, pending: PendingWrite): string {
  return pending.kind === 'refused'
    ? `the \`${cap}\` capability refused the value: ${pending.error}`
    : `writing the \`${cap}\` capability threw: ${pending.error}`
}
