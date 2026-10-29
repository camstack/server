/**
 * Adaptive poll cadence for one PetKit feeder.
 *
 * PetKit's classic REST API has no usable push channel: the app-side IoT broker
 * exists but community integrations report it rarely delivers device-state
 * messages, so state only moves when polled. The cadence is therefore fast
 * while something is happening and slow otherwise, and backs off on failures
 * (a 429 or a dropped session must not be hammered).
 */

/** Poll period while idle. */
export const SLOW_POLL_MS = 30_000
/** Poll period while something is happening (community integrations run 5 s boosts without 429). */
export const FAST_POLL_MS = 10_000
/** Longest wait after repeated failures. */
export const MAX_BACKOFF_MS = 300_000
/** How long a feed / command / eating event keeps the fast cadence. */
export const ACTIVITY_WINDOW_MS = 180_000
/** How long a bowl-weight change keeps the fast cadence (the scale settles over minutes). */
export const BOWL_CHANGE_WINDOW_MS = 300_000
/** How long a consumer read keeps the fast cadence. */
export const READ_WINDOW_MS = 60_000

/** Why the cadence is fast right now (for the log line). */
export type FastReason = 'activity' | 'bowl-change' | 'consumer-read'

/** A bowl weight that differs from the previous reading. */
export interface BowlChange {
  readonly from: number | null
}

export class PollCadence {
  private activityUntil = 0
  private bowlUntil = 0
  private readUntil = 0
  private lastBowl: number | null = null
  private failures = 0

  /** A feed, command or eating/feeding state was seen. */
  noteActivity(now: number): void {
    this.activityUntil = Math.max(this.activityUntil, now + ACTIVITY_WINDOW_MS)
  }

  /** A consumer asked for the status. */
  noteRead(now: number): void {
    this.readUntil = Math.max(this.readUntil, now + READ_WINDOW_MS)
  }

  /** The latest bowl reading in grams; returns the previous value when it changed, else undefined. */
  noteBowl(now: number, grams: number | null): BowlChange | undefined {
    const previous = this.lastBowl
    this.lastBowl = grams
    if (previous === grams) return undefined
    this.bowlUntil = Math.max(this.bowlUntil, now + BOWL_CHANGE_WINDOW_MS)
    return { from: previous }
  }

  noteSuccess(): void {
    this.failures = 0
  }

  noteFailure(): void {
    this.failures += 1
  }

  /** Why the cadence is fast at `now`, or null when idle. */
  fastReason(now: number): FastReason | null {
    if (now < this.activityUntil) return 'activity'
    if (now < this.bowlUntil) return 'bowl-change'
    if (now < this.readUntil) return 'consumer-read'
    return null
  }

  /** Milliseconds to wait before the next poll. */
  nextDelay(now: number): number {
    if (this.failures > 0) {
      return Math.min(MAX_BACKOFF_MS, SLOW_POLL_MS * 2 ** (this.failures - 1))
    }
    return this.fastReason(now) !== null ? FAST_POLL_MS : SLOW_POLL_MS
  }
}
