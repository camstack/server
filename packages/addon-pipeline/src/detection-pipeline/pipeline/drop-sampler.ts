/**
 * drop-sampler — keep the record of a dropped detection without the flood.
 *
 * ## Why
 *
 * The full-frame phantom guard logs every detection it removes, on purpose: a
 * branch that drops work silently reads as "never happened", and this repo has
 * paid for that twice. Its own comment set the bound honestly — *"Bounded by
 * how rare full-frame phantoms are, which is the point: if this floods, that is
 * itself the finding."*
 *
 * It flooded. Camera 101 emits a persistent full-frame `vehicle` phantom
 * (score ~0.62, areaRatio 0.949) and the guard was writing **dozens of INFO
 * lines a second** on 2026-08-02. So the finding stands — that camera has a
 * standing phantom worth investigating — but the log volume is now costing more
 * than the record is worth, and it drowns everything else in the same stream.
 *
 * ## The shape
 *
 * FIRST occurrence of each `(deviceId, macroClass)` logs in full: the example
 * is what makes the finding actionable — the bbox, the score, the ratios.
 * After that the pair is counted and a SUMMARY is emitted per interval, so the
 * question "how often does this fire, and on what?" is still answerable — from
 * a counter rather than from N identical lines.
 *
 * Deliberately per `(device, class)` and not global: a phantom on one camera
 * must not mask a new one appearing on another, which a single global counter
 * would do.
 */

/** How often an active drop pattern re-reports, with its count. */
export const DROP_SUMMARY_INTERVAL_MS = 60_000

export interface DropDecision {
  /** Log the full example line. */
  readonly logExample: boolean
  /** Emit a summary now, carrying this many suppressed since the last one. */
  readonly summaryCount: number | null
}

interface Entry {
  count: number
  lastReportedAt: number
}

/**
 * Decides, per `(deviceId, class)`, whether this drop is worth a line.
 *
 * Pure-ish and clock-injected so the interval logic is testable without
 * waiting a minute.
 */
export class DropSampler {
  private readonly seen = new Map<string, Entry>()
  private readonly now: () => number
  private readonly intervalMs: number

  constructor(intervalMs: number = DROP_SUMMARY_INTERVAL_MS, now: () => number = () => Date.now()) {
    this.intervalMs = intervalMs
    this.now = now
  }

  /**
   * Record one drop. Returns what to log.
   *
   * The first sighting of a pair yields the example. Afterwards the count
   * accumulates and a summary is released once per interval — carrying the
   * number suppressed, so nothing about the RATE is lost even though the lines
   * are.
   *
   * `channel` separates occasions that share a device — a replay's drops are
   * sampled apart from the live ones.
   */
  record(deviceId: number, macroClass: string, channel: string = 'live'): DropDecision {
    // `channel` keeps a session replay (D646) off the live camera's budget:
    // same device, same class, different question.
    const key = `${channel}:${deviceId}:${macroClass}`
    const at = this.now()
    const prev = this.seen.get(key)
    if (prev === undefined) {
      this.seen.set(key, { count: 0, lastReportedAt: at })
      return { logExample: true, summaryCount: null }
    }
    prev.count += 1
    if (at - prev.lastReportedAt < this.intervalMs) return { logExample: false, summaryCount: null }
    const n = prev.count
    prev.count = 0
    prev.lastReportedAt = at
    return { logExample: false, summaryCount: n }
  }
}
