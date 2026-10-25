/**
 * `ClosedRowMediaGate` — "may this track row still receive media?", plus the
 * sampling that keeps the answer loggable at frame rate.
 *
 * WHY (incident 2026-08-21, track `b50e09f7`): a person track whose row had
 * been closed 4.4 minutes earlier had its `thumbnail`, `keyFrame` and
 * `lastFrame` overwritten with photos of a dog. On a detection-per-session
 * camera the tracker does not run between sessions, so its in-memory track
 * survived with a frozen bbox while the row expired; the animal that walked
 * back in matched that box and inherited the dead track's id. 21 of 7019 tracks
 * in 72 h received best media up to 4.5 min after their last sighting.
 *
 * The association root is fixed in the tracker. This is the capture-side half —
 * defence in depth, and the only half that holds whatever the tracker returns.
 *
 * TWO properties make it safe to run on the per-frame path:
 *
 *  • **It reads POSITIVE knowledge only** (D49). The input is the track store's
 *    in-RAM record of a close it PERFORMED; `undefined` — unknown id, evicted
 *    entry, a store that never closed anything — means WRITE. A missing answer
 *    can never be read as "closed", because losing a live track's media is
 *    worse than tolerating one late write.
 *  • **It asks "is this row closed?", never "how old is this?"** The tracker
 *    owns the age bound; duplicating it here would give the two knobs a way to
 *    disagree. `closedAgeMs` is reported for the log line and gates nothing.
 *
 * The refusal is never silent, but a refused track is refused on EVERY frame —
 * ~10 lines a second for as long as the phantom keeps matching. So each track
 * logs once per `logMinGapMs` and the line carries how many refusals it stands
 * for; the sampling memory is bounded, and its eviction costs an extra LINE,
 * never a write.
 */

/** What the frame path should do with this (track, frame). */
export interface ClosedRowMediaVerdict {
  /** True ⇒ the row is closed: build no media target for this track. */
  readonly refuse: boolean
  /** True ⇒ emit the refusal line for this one (sampling). */
  readonly log: boolean
  /** How long ago the row closed. Reported, never a gate. */
  readonly closedAgeMs: number
  /** Refusals for this track since the last logged line (0 on that line). */
  readonly suppressed: number
}

export interface ClosedRowMediaGateOptions {
  /** At most one line per track per window (default 60s). */
  readonly logMinGapMs?: number
  /** Bound on the per-track sampling memory (default 512 tracks). */
  readonly maxTracked?: number
}

interface TrackSampling {
  lastLoggedAt: number
  suppressed: number
}

const DEFAULT_LOG_MIN_GAP_MS = 60_000
const DEFAULT_MAX_TRACKED = 512

const WRITE: ClosedRowMediaVerdict = {
  refuse: false,
  log: false,
  closedAgeMs: 0,
  suppressed: 0,
}

export class ClosedRowMediaGate {
  private readonly logMinGapMs: number
  private readonly maxTracked: number
  /** trackId → sampling state, insertion-ordered so the oldest evicts first. */
  private readonly sampling = new Map<string, TrackSampling>()

  constructor(options: ClosedRowMediaGateOptions = {}) {
    this.logMinGapMs = options.logMinGapMs ?? DEFAULT_LOG_MIN_GAP_MS
    this.maxTracked = options.maxTracked ?? DEFAULT_MAX_TRACKED
  }

  /**
   * @param rowClosedAt when the store closed this track's row, or `undefined`
   *   when it holds no such record — which always means WRITE.
   */
  evaluate(trackId: string, rowClosedAt: number | undefined, nowMs: number): ClosedRowMediaVerdict {
    if (rowClosedAt === undefined) return WRITE
    const closedAgeMs = Math.max(0, nowMs - rowClosedAt)
    const existing = this.sampling.get(trackId)
    if (existing === undefined) {
      this.remember(trackId, { lastLoggedAt: nowMs, suppressed: 0 })
      return { refuse: true, log: true, closedAgeMs, suppressed: 0 }
    }
    if (nowMs - existing.lastLoggedAt < this.logMinGapMs) {
      existing.suppressed += 1
      return { refuse: true, log: false, closedAgeMs, suppressed: existing.suppressed }
    }
    const suppressed = existing.suppressed
    existing.lastLoggedAt = nowMs
    existing.suppressed = 0
    return { refuse: true, log: true, closedAgeMs, suppressed }
  }

  /** Drop all sampling state (addon dispose). */
  clear(): void {
    this.sampling.clear()
  }

  private remember(trackId: string, state: TrackSampling): void {
    this.sampling.set(trackId, state)
    if (this.sampling.size <= this.maxTracked) return
    const oldest = this.sampling.keys().next()
    if (!oldest.done) this.sampling.delete(oldest.value)
  }
}
