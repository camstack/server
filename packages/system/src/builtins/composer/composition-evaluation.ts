/**
 * Evaluating a composition's fields (D659, D670): one pass over the keys a
 * change affects, the own-field readers it must re-run (D670 amendment), and
 * the state-derived events it emits. Split from `composition-runtime.ts`,
 * which owns the records and hands them in through {@link EvaluationHost}.
 *
 * - Stateful expression memory commits only when the whole expression
 *   succeeds.
 * - A declared state-derived event advances its high-water and is emitted
 *   BEFORE the corresponding target write; the committed records are visible
 *   to a synchronous subscriber first.
 * - Derived fields are evaluated before accumulators, and every field reading
 *   an own field that changed is re-evaluated in the same pass.
 * - An edge-latched (`rose`) field holds its last edge through a source
 *   outage: the field goes stale, its value does not change (D713).
 */
import {
  type CompositionEventPlan,
  type CompositionFieldRead,
  cloneStatefulExpressionMemory,
  createEvent,
  disarmRoseMemory,
  EventCategory,
  type ExpressionValue,
  evaluateCompositionField,
  expressionContainsBuiltinCall,
  type FieldOutcome,
  type IScopedLogger,
  type SourceReader,
  type SystemEvent,
} from '@camstack/types'
import type { CompositionEventEmitter } from './composition-target.js'
import {
  currentOutput,
  errorText,
  type FieldRecord,
  fieldKey,
  sameOutcome,
  valueOf,
} from './field-record.js'
import { orderForEvaluation, ownFieldReading } from './own-field-reads.js'

export interface EvaluationDelta {
  readonly keys: ReadonlySet<string>
  readonly valueCaps: ReadonlySet<string>
}

/** What an evaluation reads from, and writes back to, the runtime that owns the records. */
export interface EvaluationHost {
  records(): ReadonlyMap<string, FieldRecord>
  commit(records: ReadonlyMap<string, FieldRecord>): void
  readonly read: SourceReader
  readonly isOwnRead?: (read: CompositionFieldRead) => boolean
  readonly eventPlans: readonly CompositionEventPlan[]
  readonly startedAtMs: number
  emit(plan: CompositionEventPlan, timestamp: number): void
  logTransition(record: FieldRecord, outcome: FieldOutcome): void
}

/**
 * Whether the field's last outcome said a SOURCE did not answer — unavailable
 * for that reason, or held over it. An expression that failed on answered
 * values is not an outage: its rose memory was never committed, so the next
 * success compares against the level from before (D716).
 */
function wasDown(outcome: FieldOutcome | null): boolean {
  if (outcome === null) return false
  if (outcome.state === 'unavailable') return outcome.expressionFailed !== true
  return outcome.held === true
}

function isExpressionValue(value: unknown): value is ExpressionValue {
  return (
    value === null ||
    typeof value === 'number' ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  )
}

/** Whether the field's output is LATCHED by `rose`: it is the last edge, not a reading of now. */
function isEdgeLatch(record: FieldRecord): boolean {
  const source = record.plan.source
  return source.kind === 'expression' && expressionContainsBuiltinCall(source.expr, 'rose')
}

/**
 * D713: an edge-latched field keeps its last known value when a source stops
 * answering. `rose` already returns its current output whenever no edge
 * happened, so its value is the last edge — a doorbell's `lastPressedAt` is
 * history, not a reading of now — and a source outage marks the FIELD stale
 * and leaves the value alone (the `count` accumulator already did, D670). A
 * provider redeploy used to write `null` over the restored stamp. Only for
 * the policies that would otherwise WRITE a stand-in (`null`, `'unknown'`): a
 * `release` field still goes back to its native provider and an `offline` one
 * still takes its device offline. A GONE source (fatal) is not held — the
 * block must fail. An expression that FAILED on answered values is not an
 * outage and is not held. Nothing known (no seed, nothing written) stays
 * unavailable.
 * A measurement (`battery.level`) is NOT held: D393.
 */
function holdLatchedValue(record: FieldRecord, outcome: FieldOutcome): FieldOutcome {
  if (outcome.state !== 'unavailable' || outcome.fatal || outcome.expressionFailed) return outcome
  if (record.plan.unavailable !== 'null' && record.plan.unavailable !== 'unknown') return outcome
  if (!isEdgeLatch(record)) return outcome
  const last = currentOutput(record)
  if (last === undefined || !isExpressionValue(last)) return outcome
  return {
    state: 'stale',
    value: last,
    reason: `${outcome.reason}; holding the last edge`,
    deadline: null,
    held: true,
  }
}

function strictFiniteAdvance(previous: number | null, next: unknown): next is number {
  return typeof next === 'number' && Number.isFinite(next) && (previous === null || next > previous)
}

/** The record key an own read is answered from; null when `read` is a source's. */
export function ownKeyOf(host: EvaluationHost, read: CompositionFieldRead): string | null {
  if (host.isOwnRead === undefined || !host.isOwnRead(read)) return null
  const key = `${read.cap}.${read.fieldPath}`
  return host.records().has(key) ? key : null
}

/**
 * `keys`, derived before accumulators, then — in the same pass — every
 * derived/accumulator field that reads an own field that changed. Bounded by
 * the record count: the validator refuses a cycle, so a chain is at most that
 * long (D6).
 */
export function evaluateWithOwnReaders(
  host: EvaluationHost,
  keys: readonly string[],
  now: number,
): EvaluationDelta {
  const changed = new Set<string>()
  const valueCaps = new Set<string>()
  let round = orderForEvaluation(keys, host.records())
  for (let hop = 0; round.length > 0 && hop <= host.records().size; hop++) {
    const delta = evaluateFields(host, round, now)
    for (const k of delta.keys) changed.add(k)
    for (const c of delta.valueCaps) valueCaps.add(c)
    const readers = [...host.records().values()]
      .filter(
        (r) =>
          (r.plan.role === 'derived' || r.plan.role === 'accumulator') &&
          r.plan.reads.some((read) => {
            const own = ownKeyOf(host, read)
            return own !== null && delta.keys.has(own)
          }),
      )
      .map((r) => fieldKey(r.plan))
    round = orderForEvaluation(readers, host.records())
  }
  return { keys: changed, valueCaps }
}

/** Evaluate `keys` in order against the records in progress; commit whatever was evaluated, even on a throw. */
export function evaluateFields(
  host: EvaluationHost,
  keys: readonly string[],
  now: number,
): EvaluationDelta {
  const changed = new Set<string>()
  const valueCaps = new Set<string>()
  const next = new Map(host.records())
  const read: SourceReader = (r) => {
    const own = ownKeyOf(host, r)
    return own === null ? host.read(r) : ownFieldReading(next, own)
  }
  try {
    for (const key of keys) {
      const record = next.get(key)
      if (record === undefined) continue
      if (record.plan.source.kind === 'series') continue
      const candidateMemory = cloneStatefulExpressionMemory(record.expressionMemory)
      // D49 inverse: a field whose source did not answer must not treat the
      // first answered reading as a one-shot press. Disarm rose so it
      // baselines the level; a later real edge still fires. This holds for a
      // source that was down since BOOT too (D716): its first reading is a
      // first observation, and a provider coming back up restamps a restored
      // `on` with a NEW changedAt that clears the first-sighting freshness
      // floor — an HA restart while the hub was booting rang as a press.
      if (wasDown(record.outcome)) {
        disarmRoseMemory(candidateMemory)
      }
      const evaluatedOutcome = evaluateCompositionField({
        source: record.plan.source,
        read,
        now,
        stateful: {
          currentOutput: currentOutput(record),
          expressionMemory: candidateMemory,
          startedAtMs: host.startedAtMs,
          callPathPrefix: fieldKey(record.plan),
        },
      })
      const expressionSucceeded = evaluatedOutcome.state !== 'unavailable'
      const outcome = holdLatchedValue(record, evaluatedOutcome)
      if (expressionSucceeded) candidateMemory.disarmRoseNext = false
      let evaluated: FieldRecord = {
        ...record,
        outcome,
        ...(expressionSucceeded ? { expressionMemory: candidateMemory } : {}),
      }
      const eventPlans = host.eventPlans.filter(
        (eventPlan) => eventPlan.fieldKey === fieldKey(record.plan),
      )
      if (
        expressionSucceeded &&
        eventPlans.length > 0 &&
        strictFiniteAdvance(record.eventHighWater, outcome.value)
      ) {
        const timestamp = outcome.value
        evaluated = { ...evaluated, eventHighWater: timestamp }
        next.set(key, evaluated)
        // The committed memory and high-water must be visible before a
        // synchronous event subscriber can observe this runtime.
        host.commit(next)
        for (const eventPlan of eventPlans) host.emit(eventPlan, timestamp)
      } else {
        next.set(key, evaluated)
      }
      // ALWAYS stored: `armDeadline` must see a deadline that moved (R1).
      // `changed` is value-driven: writes and logs follow state/value/reason only.
      if (sameOutcome(record.outcome, outcome)) continue
      if (record.outcome?.state !== outcome.state) host.logTransition(record, outcome)
      if (valueOf(record.outcome) !== valueOf(outcome)) valueCaps.add(record.plan.cap)
      changed.add(key)
    }
  } finally {
    // A reader that throws on a later key must not discard the outcomes (and
    // the transitions already logged) of the keys before it, or every pass
    // re-logs them.
    host.commit(next)
  }
  return { keys: changed, valueCaps }
}

export interface StateEventContext {
  readonly deviceId: number
  readonly blockId: string
  readonly events: CompositionEventEmitter
  readonly logger: IScopedLogger
}

/** Emit one state-derived event; a delivery failure is logged, never thrown (D670). */
export function emitStateDerivedEvent(
  ctx: StateEventContext,
  plan: CompositionEventPlan,
  timestamp: number,
): void {
  const extras = {
    tags: { deviceId: ctx.deviceId },
    meta: {
      blockId: ctx.blockId,
      cap: plan.cap,
      eventName: plan.eventName,
      category: plan.category,
      timestamp,
    },
  }
  try {
    if (plan.category !== EventCategory.DoorbellOnPressed)
      throw new Error(`unsupported state-derived event category \`${plan.category}\``)
    const event: SystemEvent = createEvent(
      EventCategory.DoorbellOnPressed,
      { type: 'device', id: ctx.deviceId, deviceId: ctx.deviceId },
      { deviceId: ctx.deviceId, timestamp },
    )
    ctx.events.emit(event)
    ctx.logger.debug('composition: state-derived event emitted', extras)
  } catch (error: unknown) {
    ctx.logger.warn('composition: state-derived event delivery failed', {
      ...extras,
      meta: { ...extras.meta, error: errorText(error) },
    })
  }
}
