/**
 * repeat-warn-sampler — keep the record of a repeating fault without the flood.
 *
 * ## Why
 *
 * Every branch here that drops work logs it, on purpose: silence reads as "it
 * never happened". But `getCameraStatuses` is POLLED — the admin Cameras page
 * refetches it every 5s — and it fans out over every camera. So a fault that
 * affects the whole fleet does not produce one line, it produces
 * `cameras × sources` lines per poll, twelve times a minute.
 *
 * It flooded. On 2026-08-21 the live hub wrote **337 WARN lines in one minute**
 * — `camera function authority TIMED OUT` plus `camera status stage could not
 * be read` — from roughly five polls of `getCameraStatuses` while the cameras
 * were slow. The finding stands (those cameras ARE slow, and that is worth
 * knowing); the volume was costing more than the record was worth and drowned
 * everything else in the same stream.
 *
 * ## The shape
 *
 * Same shape as `DropSampler` in the detection pipeline, which was written for
 * the identical problem one plane over (addons never import each other, so this
 * is a deliberate second copy rather than a shared import).
 *
 * FIRST occurrence of a key logs in full — the example is what makes the
 * finding actionable. After that the key is counted and a SUMMARY is released
 * once per interval carrying the suppressed count, so "how often, and on what?"
 * is still answerable from a counter rather than from N identical lines.
 *
 * Keys are per `(deviceId, source)` at every call site here, never global: a
 * camera that has been unreachable for an hour must not mask a second one
 * going down, which one global counter would do.
 */

/** How often an active fault re-reports, with its suppressed count. */
export const WARN_SUMMARY_INTERVAL_MS = 60_000

/** What the caller should write for this occurrence. */
export interface WarnDecision {
  /** Write the full example line. */
  readonly logExample: boolean
  /** Write a summary now, carrying this many suppressed since the last one. */
  readonly summaryCount: number | null
}

interface SamplerEntry {
  count: number
  lastReportedAt: number
}

/** Neither an example nor a summary — the common case once a fault is known. */
const SILENT: WarnDecision = { logExample: false, summaryCount: null }

/**
 * Decides, per key, whether this occurrence is worth a line.
 *
 * Clock-injected so the interval logic is testable without waiting a minute.
 */
export class RepeatWarnSampler {
  private readonly seen = new Map<string, SamplerEntry>()
  private readonly now: () => number
  private readonly intervalMs: number

  constructor(intervalMs: number = WARN_SUMMARY_INTERVAL_MS, now: () => number = () => Date.now()) {
    this.intervalMs = intervalMs
    this.now = now
  }

  /**
   * Record one occurrence. Returns what to log.
   *
   * @param key A stable identity for the fault — always including the numeric
   *            deviceId at the call sites here, so one camera's standing fault
   *            can never suppress another's.
   */
  record(key: string): WarnDecision {
    const at = this.now()
    const prev = this.seen.get(key)
    if (prev === undefined) {
      this.seen.set(key, { count: 0, lastReportedAt: at })
      return { logExample: true, summaryCount: null }
    }
    prev.count += 1
    if (at - prev.lastReportedAt < this.intervalMs) return SILENT
    const suppressed = prev.count
    prev.count = 0
    prev.lastReportedAt = at
    return { logExample: false, summaryCount: suppressed }
  }
}
