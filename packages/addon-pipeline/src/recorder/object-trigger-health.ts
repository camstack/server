/**
 * The counter that makes a total-rejection regime on the object feed LOUD.
 *
 * ## Why it exists
 *
 * `qualifyObjectTrigger` already named every discard and the caller logged it, one
 * line per event, at `debug`. It was not enough: from the wiring of Track A until
 * 2026-08-29 that feed rejected **100% of events** at 3.3–3.9/s and
 * nobody noticed, because a line per event at `debug` says "this
 * event did not qualify" and never says "NO event qualifies any more".
 * Those are two different facts: 5% discards is the normal operation of the gate,
 * 100% is a dead feature that the operator believes is on.
 *
 * So we count per window and per CAMERA, and the periodic line gives the
 * percentage. A total rejection goes out at `warn`; the rest at `debug`.
 *
 * ## The denominator is the object branch, not the topic
 *
 * `not-object` (motion, audio) is ANOTHER branch of the same topic, not discarded
 * work: counting it in the denominator would make "0 qualified out of N" the permanent
 * state of every camera with motion only. It is counted apart
 * (`otherKinds`) and never raises the alarm, but it appears in the report — because the
 * rule is that a branch that discards work says so, and saying it once a minute
 * is saying it, whereas 3.3 lines per second is hiding it.
 *
 * Pure: no timer, no logger, no clock of its own. The caller
 * passes `nowMs` and receives the reports to print.
 */
import type { ObjectTriggerSkipReason, ObjectTriggerVerdict } from './object-trigger.js'

/** Width of the aggregation window. One minute: short enough for
 *  the line to arrive within the first minute of a broken deploy, long enough
 *  for the sample to be significant at 4 events/s. */
export const OBJECT_TRIGGER_HEALTH_WINDOW_MS = 60_000

/**
 * How many `object` events a window needs before "0 qualified"
 * means anything. Below this threshold zero is indistinguishable from "this
 * camera saw nothing", and a `warn` per idle camera is noise.
 */
export const OBJECT_TRIGGER_MIN_SAMPLE = 5

/** Key of the bucket with no camera: an unreadable envelope does not name one. */
export type ObjectTriggerBucketKey = number | null

/** The periodic verdict on a bucket. `deviceId: null` is the bucket of
 *  unreadable envelopes — the only one that cannot name a camera. */
export interface ObjectTriggerHealthReport {
  readonly deviceId: ObjectTriggerBucketKey
  readonly windowMs: number
  /** `kind: 'object'` events seen in the window — the denominator. */
  readonly objectEvents: number
  /** Of those, how many opened (or re-armed) a recording window. */
  readonly qualified: number
  /** Percentuale di `objectEvents` rifiutata, arrotondata. */
  readonly rejectedPct: number
  /** Events of the same topic with another `kind` (motion, audio). */
  readonly otherKinds: number
  /** The dominant reason among the rejections, or `null` if there were no rejections. */
  readonly topReason: ObjectTriggerSkipReason | null
  readonly byReason: Readonly<Record<string, number>>
  /**
   * The regime this class exists to make loud: enough object
   * events to judge, and none qualified. The caller raises the level.
   */
  readonly totalRejection: boolean
}

interface Tally {
  objectEvents: number
  qualified: number
  otherKinds: number
  readonly byReason: Map<ObjectTriggerSkipReason, number>
}

function emptyTally(): Tally {
  return { objectEvents: 0, qualified: 0, otherKinds: 0, byReason: new Map() }
}

function dominantReason(byReason: ReadonlyMap<ObjectTriggerSkipReason, number>): {
  readonly reason: ObjectTriggerSkipReason | null
  readonly counts: Readonly<Record<string, number>>
} {
  let reason: ObjectTriggerSkipReason | null = null
  let best = 0
  const counts: Record<string, number> = {}
  for (const [r, n] of byReason) {
    counts[r] = n
    if (n > best) {
      best = n
      reason = r
    }
  }
  return { reason, counts }
}

export class ObjectTriggerHealth {
  private readonly buckets = new Map<ObjectTriggerBucketKey, Tally>()
  private windowStartMs: number | null = null

  constructor(
    private readonly windowMs: number = OBJECT_TRIGGER_HEALTH_WINDOW_MS,
    private readonly minSample: number = OBJECT_TRIGGER_MIN_SAMPLE,
  ) {}

  /**
   * Records a verdict and, if the window closed with this event,
   * returns the reports to print (and reopens the window). No timer:
   * the feed runs at ~4/s, so the close always arrives in time, and a
   * window that does not close is a window in which nothing happened.
   */
  record(verdict: ObjectTriggerVerdict, nowMs: number): readonly ObjectTriggerHealthReport[] {
    const due = this.windowStartMs !== null && nowMs - this.windowStartMs >= this.windowMs
    const reports = due ? this.drain(nowMs) : []
    this.windowStartMs ??= nowMs
    this.count(verdict)
    return reports
  }

  private count(verdict: ObjectTriggerVerdict): void {
    if (verdict.qualified) {
      const t = this.bucket(verdict.deviceId)
      t.objectEvents += 1
      t.qualified += 1
      return
    }
    if (verdict.reason === 'not-object') {
      this.bucket(verdict.deviceId).otherKinds += 1
      return
    }
    const key: ObjectTriggerBucketKey = verdict.reason === 'malformed' ? null : verdict.deviceId
    const t = this.bucket(key)
    // An unreadable envelope does not declare a `kind`: it is not an object event, but it is
    // lost work, so it needs a denominator of its own to be able to say
    // "100%". The `null` bucket counts every broken envelope as a missed object.
    t.objectEvents += 1
    t.byReason.set(verdict.reason, (t.byReason.get(verdict.reason) ?? 0) + 1)
  }

  private bucket(key: ObjectTriggerBucketKey): Tally {
    const existing = this.buckets.get(key)
    if (existing !== undefined) return existing
    const fresh = emptyTally()
    this.buckets.set(key, fresh)
    return fresh
  }

  /** Closes the window and returns one report per non-empty bucket. */
  drain(nowMs: number): readonly ObjectTriggerHealthReport[] {
    const windowMs = this.windowStartMs === null ? 0 : nowMs - this.windowStartMs
    const out: ObjectTriggerHealthReport[] = []
    for (const [deviceId, t] of this.buckets) {
      if (t.objectEvents === 0 && t.otherKinds === 0) continue
      const rejected = t.objectEvents - t.qualified
      const { reason, counts } = dominantReason(t.byReason)
      out.push({
        deviceId,
        windowMs,
        objectEvents: t.objectEvents,
        qualified: t.qualified,
        rejectedPct: t.objectEvents === 0 ? 0 : Math.round((rejected / t.objectEvents) * 100),
        otherKinds: t.otherKinds,
        topReason: reason,
        byReason: counts,
        totalRejection: t.objectEvents >= this.minSample && t.qualified === 0,
      })
    }
    this.buckets.clear()
    this.windowStartMs = nowMs
    return out
  }
}
