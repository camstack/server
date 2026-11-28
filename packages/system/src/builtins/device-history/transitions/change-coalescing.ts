/**
 * The ONE burst rule of the device transitions read (D1084).
 *
 * A device reports one real change as several raw points: a cover goes `open`, `position 6`,
 * `opening`, then `open` and `position 100`. The Interactions view shows it as one change per
 * field (`state closed -> open`, `position 0 -> 100`), so the points of ONE capability are
 * grouped into a burst and each field of the burst is written from its value before the first
 * change to its last. A field that ended where it began shows nothing.
 *
 * A burst ends when the capability has been quiet for `SETTLE_QUIET_MS`, or `SETTLE_MAX_HOLD_MS`
 * after it began (a flapping sensor). The row is stamped with the burst's last change. A burst
 * that has not yet gone quiet is NOT returned: it is still being written by the device, and a
 * page read now and again a moment later must agree.
 *
 * Pure. Nothing else in the repository implements this rule; the write-time correlator that
 * held it before was removed with the confirmation machinery.
 */
import type { TransitionValue } from '@dominevo/types'

/** A capability's changes closer together than this are one burst. */
export const SETTLE_QUIET_MS = 5_000
/** A burst never lasts longer than this, however busy the capability stays. */
export const SETTLE_MAX_HOLD_MS = 60_000

/** One recorded value of an audited field, as device-history holds it. */
export interface FieldPoint {
  readonly capName: string
  readonly field: string
  readonly at: number
  readonly value: TransitionValue
}

/** One change of an audited field, after the burst rule. `from` is never unknown here. */
export interface FieldChange {
  readonly capName: string
  readonly field: string
  readonly at: number
  readonly from: TransitionValue
  readonly to: TransitionValue
}

export interface CoalesceInput {
  /** Every point of the window, in any order. */
  readonly points: readonly FieldPoint[]
  /** The value each `capName|field` held before the window; absent = never seen. */
  readonly before: ReadonlyMap<string, TransitionValue>
  /** The clock: a burst quiet for less than `SETTLE_QUIET_MS` is still open and not returned. */
  readonly now: number
}

export function fieldKey(capName: string, field: string): string {
  return `${capName}|${field}`
}

function sameValue(a: TransitionValue, b: TransitionValue): boolean {
  if (Object.is(a, b)) return true
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false
  return JSON.stringify(a) === JSON.stringify(b)
}

interface HeldField {
  readonly from: TransitionValue
  readonly to: TransitionValue
}

interface Burst {
  readonly firstAt: number
  lastAt: number
  readonly fields: Map<string, HeldField>
}

function closeBurst(capName: string, burst: Burst, now: number, out: FieldChange[]): void {
  if (now - burst.lastAt < SETTLE_QUIET_MS && now - burst.firstAt < SETTLE_MAX_HOLD_MS) return
  for (const [field, held] of burst.fields) {
    if (sameValue(held.from, held.to)) continue
    out.push({
      capName,
      field,
      at: burst.lastAt,
      from: held.from,
      to: held.to,
    })
  }
}

/** Group the points of each capability into bursts and answer the net change of each field. */
export function coalesceChanges(input: CoalesceInput): readonly FieldChange[] {
  const byCap = new Map<string, FieldPoint[]>()
  for (const point of input.points) {
    const list = byCap.get(point.capName)
    if (list === undefined) byCap.set(point.capName, [point])
    else list.push(point)
  }
  const out: FieldChange[] = []
  for (const [capName, points] of byCap) {
    const held = new Map<string, TransitionValue>()
    for (const point of points) {
      const key = fieldKey(capName, point.field)
      const known = input.before.get(key)
      if (known !== undefined) held.set(key, known)
    }
    let burst: Burst | null = null
    for (const point of points.toSorted((a, b) => a.at - b.at)) {
      const key = fieldKey(capName, point.field)
      const prior = held.get(key)
      held.set(key, point.value)
      // A field never seen before is the device being learned, not changing.
      if (prior === undefined || sameValue(prior, point.value)) continue
      if (
        burst !== null &&
        (point.at - burst.lastAt >= SETTLE_QUIET_MS ||
          point.at - burst.firstAt >= SETTLE_MAX_HOLD_MS)
      ) {
        closeBurst(capName, burst, Number.POSITIVE_INFINITY, out)
        burst = null
      }
      burst ??= { firstAt: point.at, lastAt: point.at, fields: new Map() }
      burst.lastAt = point.at
      const earlier = burst.fields.get(point.field)
      burst.fields.set(point.field, {
        from: earlier?.from ?? prior,
        to: point.value,
      })
    }
    if (burst !== null) closeBurst(capName, burst, input.now, out)
  }
  return out.toSorted((a, b) => b.at - a.at)
}
