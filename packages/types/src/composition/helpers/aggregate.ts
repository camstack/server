/**
 * A group reducer (D944). Offline and unknown members are excluded and
 * counted. They are never passed in as 0 or false (D393). A free expression
 * does not use this — `avg` / `any` still include a stale value.
 */
import type { ExpressionValue } from '../../expression/ast.js'
import type { AggregateReducer } from './spec.js'

export interface AggregateReadResult {
  readonly state: 'fresh' | 'stale' | 'unavailable'
  readonly value?: ExpressionValue
  /** Set when `state` is `unavailable` and the source is gone. */
  readonly fatal?: boolean
  readonly reason?: string
}

export interface AggregateCounts {
  readonly included: number
  readonly excluded: number
  readonly total: number
}

export type AggregatePublish = 'value' | 'included' | 'excluded' | 'total'
export type AggregateEmpty = 'null' | 'omit' | 'offline'

export interface EvaluateAggregateInput {
  readonly reducer: AggregateReducer
  readonly members: readonly AggregateReadResult[]
  readonly publish: AggregatePublish
  readonly empty: AggregateEmpty
}

export interface AggregateValue {
  readonly kind: 'value'
  readonly value: number | boolean | null
  readonly counts: AggregateCounts
}

export interface AggregateUnavailable {
  readonly kind: 'unavailable'
  readonly fatal: boolean
  readonly reason: string
  readonly counts: AggregateCounts
}

export type AggregateOutcome = AggregateValue | AggregateUnavailable

function isBinaryReducer(reducer: AggregateReducer): boolean {
  return reducer === 'any' || reducer === 'all'
}

function includedValue(
  reducer: AggregateReducer,
  member: AggregateReadResult,
): number | boolean | null {
  if (member.state !== 'fresh') return null
  if (isBinaryReducer(reducer)) return typeof member.value === 'boolean' ? member.value : null
  return typeof member.value === 'number' && Number.isFinite(member.value) ? member.value : null
}

function median(values: readonly number[]): number {
  const sorted = [...values].toSorted((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  const right = sorted[mid]
  const left = sorted[mid - 1]
  if (right === undefined) throw new Error('median requires at least one finite number')
  if (sorted.length % 2 === 1) return right
  if (left === undefined) throw new Error('median requires at least one finite number')
  return (left + right) / 2
}

function reduceNumbers(reducer: AggregateReducer, values: readonly number[]): number {
  if (reducer === 'min') return Math.min(...values)
  if (reducer === 'max') return Math.max(...values)
  if (reducer === 'sum') return values.reduce((sum, value) => sum + value, 0)
  if (reducer === 'median') return median(values)
  const total = values.reduce((sum, value) => sum + value, 0)
  return total / values.length
}

function reduceBooleans(reducer: AggregateReducer, values: readonly boolean[]): boolean {
  return reducer === 'all' ? values.every((value) => value) : values.some((value) => value)
}

function countsOf(included: number, total: number): AggregateCounts {
  return { included, excluded: total - included, total }
}

function fatalReason(members: readonly AggregateReadResult[]): string | null {
  const reasons = members.flatMap((member) =>
    member.state === 'unavailable' && member.fatal === true ? [member.reason ?? 'source gone'] : [],
  )
  return reasons.length === 0 ? null : reasons.join('; ')
}

function emptyOutcome(empty: AggregateEmpty, counts: AggregateCounts): AggregateOutcome {
  if (empty === 'null') return { kind: 'value', value: null, counts }
  return {
    kind: 'unavailable',
    fatal: false,
    reason: 'no member included — unknown is not 0 or off',
    counts,
  }
}

/** Pure. `members` is not mutated. An empty included set is null or unavailable, never 0 or false. */
export function evaluateAggregate(input: EvaluateAggregateInput): AggregateOutcome {
  const included = input.members.flatMap((member) => {
    const value = includedValue(input.reducer, member)
    return value === null ? [] : [value]
  })
  const counts = countsOf(included.length, input.members.length)
  const gone = fatalReason(input.members)
  if (gone !== null) return { kind: 'unavailable', fatal: true, reason: gone, counts }
  if (input.publish === 'included') return { kind: 'value', value: counts.included, counts }
  if (input.publish === 'excluded') return { kind: 'value', value: counts.excluded, counts }
  if (input.publish === 'total') return { kind: 'value', value: counts.total, counts }
  if (included.length === 0) return emptyOutcome(input.empty, counts)
  if (isBinaryReducer(input.reducer)) {
    const flags = included.filter((value): value is boolean => typeof value === 'boolean')
    return { kind: 'value', value: reduceBooleans(input.reducer, flags), counts }
  }
  const numbers = included.filter((value): value is number => typeof value === 'number')
  return { kind: 'value', value: reduceNumbers(input.reducer, numbers), counts }
}
