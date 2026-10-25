/**
 * A composition's read of its OWN output, answered from the runtime's records
 * (D670 amendment, 2026-09-29). Split from `composition-runtime.ts`, which
 * decides WHEN a read is an own read (`isOwnRead`) and re-runs its readers.
 *
 * Through the hub such a read was circular: the effective slice of an ADDED cap
 * exists only once the composer's claim lands, and the claim lands only once
 * every required field has a value — camera 101's `pressCountSinceStart =
 * count(lastPressedAt)` was one of them, and nothing served its doorbell for
 * 12 h.
 */
import type { SourceReading } from '@camstack/types'
import { type FieldRecord, writable } from './field-record.js'

/** Derived fields before accumulators: a count reads the value its own pass just computed. */
const EVALUATION_ORDER: Readonly<Record<string, number>> = { derived: 0, accumulator: 1 }

/** `keys` in evaluation order: derived, then accumulators, then the rest; stable within a rank. */
export function orderForEvaluation(
  keys: readonly string[],
  records: ReadonlyMap<string, FieldRecord>,
): readonly string[] {
  const rank = (k: string): number => EVALUATION_ORDER[records.get(k)?.plan.role ?? ''] ?? 2
  return [...keys].toSorted((a, b) => rank(a) - rank(b))
}

/**
 * The own field `key` as the runtime holds it right now (`records`: the pass in
 * progress) — exactly what the runtime PUBLISHES for it, which is what the hub
 * answered before (review H1). An unavailable field under the `null` or
 * `unknown` policy is published as `null` / `'unknown'`, so a reader sees that
 * value; only a field nothing is written for (`release`, `offline`) reads as
 * unavailable. Answering those as unavailable left `count` unprimed while a
 * source was late at boot, and it then swallowed the first press as its seed.
 *
 * Not evaluated yet is unavailable: nothing is published, and unknown is never
 * `null` (D393). The evaluation order makes this unreachable for a derived
 * reader of a derived field. Never fatal here: a gone source fails the block
 * through the field that reads it directly.
 */
export function ownFieldReading(
  records: ReadonlyMap<string, FieldRecord>,
  key: string,
): SourceReading {
  const record = records.get(key)
  const outcome = record?.outcome ?? null
  if (record === undefined || outcome === null)
    return { state: 'unavailable', reason: `own field \`${key}\` not evaluated yet`, fatal: false }
  if (outcome.state === 'unavailable') {
    const published = writable(record)
    if (published !== undefined) return { state: 'fresh', value: published }
    return {
      state: 'unavailable',
      reason: `own field \`${key}\`: ${outcome.reason}`,
      fatal: false,
      ...(outcome.confirmed === true ? { confirmed: true } : {}),
    }
  }
  if (outcome.state === 'stale')
    return {
      state: 'stale',
      value: outcome.value,
      reason: `own field \`${key}\`: ${outcome.reason ?? 'stale'}`,
    }
  return { state: 'fresh', value: outcome.value }
}
