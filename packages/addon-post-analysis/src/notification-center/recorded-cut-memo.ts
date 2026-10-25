/**
 * One recorded cut per moment, and a breaker for a recorder that is busy
 * (D686, fix round 1).
 *
 * The outbox drains rows ONE AT A TIME, and since D686 a row whose moment the
 * ring has lost waits for its recorded cut before it sends. A bound per row
 * (30 s) is not a bound on the drain:
 *
 * - a rule with N targets is N outbox rows for ONE moment, and each used to
 *   order its own identical cut. When the recorder is wedged, that is N × 30 s;
 * - a retry of a row cut the same moment again;
 * - a wedged recorder cost 30 s for EVERY recorded row behind the first one,
 *   and a row that waits more than ~16 s itself falls out of the ring into the
 *   recordings path, so a single stall cascades.
 *
 * So the cut (and the gif derived from it) is shared by every row that asks
 * for the same window, retries included, and a cut that timed out opens a
 * BREAKER: for {@link NC_RECORDER_BUSY_MS} recorded rows ship still-only at
 * once, by name, instead of each waiting out the bound again.
 *
 * The memo holds the clip's bytes, so it is bounded twice: by age
 * ({@link NC_RECORDED_CUT_MEMO_TTL_MS}, long enough to span the outbox's early
 * retries) and by count ({@link NC_RECORDED_CUT_MEMO_MAX}).
 */

import type { NcRecordedClipRequest, NcRecordedClipResult } from './recorded-clip.js'
import type { NcRecordedGifResult } from './recorded-gif.js'

/** How long the recorder is treated as busy after a cut timed out. */
export const NC_RECORDER_BUSY_MS = 60_000

/**
 * How long a cut is reused. The outbox retries at 5 s, 10 s, 20 s … so ten
 * minutes covers every retry that could still be about the same notification.
 */
export const NC_RECORDED_CUT_MEMO_TTL_MS = 10 * 60_000

/** At most this many cuts are held (each is a ~10 s clip, a few hundred KB). */
export const NC_RECORDED_CUT_MEMO_MAX = 16

/** A shared cut: one per window, whatever its outcome. Never rejects. */
export type NcSharedCutOutcome =
  | { readonly kind: 'cut'; readonly mp4: Uint8Array<ArrayBuffer>; readonly profile: string }
  | { readonly kind: 'refused'; readonly result: Extract<NcRecordedClipResult, { ok: false }> }
  | { readonly kind: 'threw'; readonly error: string }

/** One memoised window. */
export interface NcSharedCut {
  readonly key: string
  readonly createdAt: number
  /** The recorder was told to give up at this instant (`deadlineMs`). */
  readonly deadlineMs: number
  readonly cut: Promise<NcSharedCutOutcome>
  /** The gif derived from this cut, started by the first row that asked. */
  gif: Promise<NcRecordedGifResult> | null
  /** The cut has answered (whatever the answer). A row that joins a cut
   *  still in flight may wait only what its deadline has left. */
  settled: boolean
}

/**
 * Grace a joining row adds to the cut's own deadline: the recorder checks its
 * deadline between 1 s polls, so its `timed-out` lands up to ~1 s after it.
 */
export const NC_RECORDED_CUT_JOIN_GRACE_MS = 2_000

/** The window a request describes — rows that agree on it share a cut. */
export function recordedCutKey(req: Omit<NcRecordedClipRequest, 'deadlineMs' | 'ruleId'>): string {
  return [
    req.deviceId,
    req.recordId,
    req.aroundMs,
    req.preRollSec,
    req.postRollSec,
    req.speed ?? 1,
  ].join(':')
}

export class NcRecordedCutMemo {
  private readonly cuts = new Map<string, NcSharedCut>()
  private busyUntil = 0

  /** When the busy window closes (0 when it never opened). */
  busyUntilMs(): number {
    return this.busyUntil
  }

  /** Is the recorder inside its busy window? */
  isBusy(now: number): boolean {
    return now < this.busyUntil
  }

  /** A cut timed out: open the breaker. Returns when it closes. */
  noteTimedOut(now: number): number {
    this.busyUntil = Math.max(this.busyUntil, now + NC_RECORDER_BUSY_MS)
    return this.busyUntil
  }

  /** The memoised cut for this window, if one is held. */
  find(key: string, now: number): NcSharedCut | null {
    this.evictAged(now)
    return this.cuts.get(key) ?? null
  }

  /** Start (and hold) the cut for this window. */
  start(
    key: string,
    now: number,
    deadlineMs: number,
    run: () => Promise<NcRecordedClipResult>,
  ): NcSharedCut {
    this.evict(now)
    const cut = run().then(
      (result): NcSharedCutOutcome =>
        result.ok
          ? { kind: 'cut', mp4: result.mp4, profile: result.profile }
          : { kind: 'refused', result },
      (err: unknown): NcSharedCutOutcome => ({ kind: 'threw', error: String(err) }),
    )
    const shared: NcSharedCut = { key, createdAt: now, deadlineMs, cut, gif: null, settled: false }
    void cut.then(() => {
      shared.settled = true
    })
    this.cuts.set(key, shared)
    return shared
  }

  /** How many cuts are held — diagnostics and tests. */
  size(): number {
    return this.cuts.size
  }

  /** Drop cuts past their TTL. Called on every use AND from the notification
   *  centre's periodic drain tick, so bytes do not outlive the last row. */
  evictAged(now: number): void {
    for (const [key, c] of this.cuts) {
      if (now - c.createdAt > NC_RECORDED_CUT_MEMO_TTL_MS) this.cuts.delete(key)
    }
  }

  /** Make room for one more: aged entries first, then the oldest. */
  private evict(now: number): void {
    this.evictAged(now)
    // Oldest first: a Map iterates in insertion order.
    while (this.cuts.size >= NC_RECORDED_CUT_MEMO_MAX) {
      const oldest = this.cuts.keys().next()
      if (oldest.done === true) break
      this.cuts.delete(oldest.value)
    }
  }
}
