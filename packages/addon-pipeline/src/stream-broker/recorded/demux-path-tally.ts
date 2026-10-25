/**
 * demux-path-tally — which demux actually ran, and how often the ffmpeg
 * subprocess fallback did.
 *
 * `demuxSegmentPreferJs` tries the JS mp4box parse first (off-thread via
 * worker_threads in the broker; in-process when the worker file is missing)
 * and falls back to an ffmpeg spawn (a ~140 ms subprocess floor) when the
 * parse yields nothing or throws. That fallback was logged ONCE PER SESSION and counted nowhere, so
 * the rate — the number that decides whether the JS path is a real saving or a
 * decoration — could not be read from the logs at all. Both outcomes are now
 * counted; the fallback additionally produces a rate-limited REPORT the caller
 * logs with its reason.
 *
 * Session-scoped: the broker owns one per WebRTC session and hands it to the
 * feeder, which diffs it across a drag ({@link deltaSince}) so the per-drag
 * aggregate can carry `demuxJs` / `demuxFfmpeg` without a second counter.
 */

/** Which demux served one fragment, and (on the fallback) why the JS one did not. */
export type DemuxPathOutcome =
  | { readonly path: 'js' }
  | { readonly path: 'ffmpeg'; readonly reason: string }

/** A point-in-time reading of the tally — also the mark {@link DemuxPathTally.deltaSince} diffs against. */
export interface DemuxPathCounts {
  readonly js: number
  readonly ffmpeg: number
  /** Reason of the most recent fallback (null while none has happened). */
  readonly lastFallbackReason: string | null
}

/** A fallback the throttle allows the caller to LOG, with what it hid. */
export interface DemuxFallbackReport {
  readonly reason: string
  /** Fallbacks since the tally was created — the rate, not just this one. */
  readonly ffmpegTotal: number
  /** Fallbacks swallowed by the throttle since the last report. */
  readonly suppressed: number
}

/**
 * Minimum wall-clock gap between two logged fallback lines. A fallback is rare
 * BY CONSTRUCTION; if it is not, the suppressed count on the next line says so
 * without turning a per-fragment failure into a per-fragment log flood.
 */
export const DEMUX_FALLBACK_LOG_INTERVAL_MS = 30_000

export class DemuxPathTally {
  private js = 0
  private ffmpeg = 0
  private lastFallbackReason: string | null = null
  private lastReportAtMs: number | null = null
  private suppressed = 0

  constructor(private readonly reportIntervalMs = DEMUX_FALLBACK_LOG_INTERVAL_MS) {}

  /**
   * Record one demux outcome. Returns a report ONLY for an ffmpeg fallback the
   * throttle admits — null means "counted, do not log".
   */
  record(outcome: DemuxPathOutcome, nowMs: number): DemuxFallbackReport | null {
    if (outcome.path === 'js') {
      this.js += 1
      return null
    }
    this.ffmpeg += 1
    this.lastFallbackReason = outcome.reason
    const last = this.lastReportAtMs
    if (last !== null && nowMs - last < this.reportIntervalMs) {
      this.suppressed += 1
      return null
    }
    const report: DemuxFallbackReport = {
      reason: outcome.reason,
      ffmpegTotal: this.ffmpeg,
      suppressed: this.suppressed,
    }
    this.lastReportAtMs = nowMs
    this.suppressed = 0
    return report
  }

  counts(): DemuxPathCounts {
    return {
      js: this.js,
      ffmpeg: this.ffmpeg,
      lastFallbackReason: this.lastFallbackReason,
    }
  }

  /** Counts accumulated since `mark` — the per-drag window over a session total. */
  deltaSince(mark: DemuxPathCounts): DemuxPathCounts {
    return {
      js: this.js - mark.js,
      ffmpeg: this.ffmpeg - mark.ffmpeg,
      lastFallbackReason: this.ffmpeg > mark.ffmpeg ? this.lastFallbackReason : null,
    }
  }
}
