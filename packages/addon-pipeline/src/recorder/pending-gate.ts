/**
 * PendingGate — a bound on a fire-and-forget lane.
 *
 * ## Why this exists (2026-08-18, the recorder's two fatals)
 *
 * Under a disk/store stall the recorder's finalize lane itself throttles: each
 * (device, profile) watcher self-serializes and AWAITS stat+move+index, so at
 * most one finalize is in flight per writer and the durable backlog is the
 * ffmpeg playlist on disk. What had NO bound was the work fanned out
 * fire-and-forget per indexed segment (`onIndexed`: the hour-ledger write RPC
 * and the mfra tail read). Those accumulate at finalize rate — ~3.4/s
 * fleet-wide — for as long as the stall lasts, each holding rows, path arrays
 * and read buffers live. Live heap that grows without bound under a stall is
 * exactly what turned into `Ineffective mark-compacts near heap limit` and
 * killed recording twice on 2026-08-17.
 *
 * ## The failure direction is REFUSE, never queue
 *
 * A queue would preserve the work but move the unbounded memory into the
 * queue. Both gated lanes are derived, reconstructible state, so the honest
 * bound is to drop over the limit: a dropped hour-ledger write costs one
 * silent re-seed from the archive walk (the ledger's own contract — D148
 * fails toward the walk), a dropped mfra capture costs that segment's client
 * one extra round trip to the file's tail. The refusal is never silent: the
 * caller logs each drop with its `deviceId` tag, and the gate emits one
 * aggregate saturation report per {@link PENDING_GATE_REPORT_INTERVAL_MS} so a
 * three-hour stall is a visible line every interval, not 36,000 of them.
 */

/** One throttled saturation report — the loud line for the lane. */
export interface PendingGateReport {
  readonly label: string
  /** Refusals since the previous report (including the one triggering it). */
  readonly dropped: number
  /** Tasks in flight at report time — by construction the lane's limit. */
  readonly pending: number
}

export interface PendingGateDeps {
  /** Lane name for the saturation report (e.g. `hour-ledger`, `mfra-capture`). */
  readonly label: string
  /** Maximum tasks in flight before refusals begin. */
  readonly limit: number
  /** Throttled aggregate saturation report. Lane-level — per-drop, per-device
   *  logging is the CALLER's job, where the `deviceId` tag lives. */
  readonly onSaturated: (report: PendingGateReport) => void
  /** An admitted task rejected or threw. The slot is freed either way. */
  readonly onTaskError?: (error: unknown) => void
  /** Floor between saturation reports. Defaults to {@link PENDING_GATE_REPORT_INTERVAL_MS}. */
  readonly reportIntervalMs?: number
  /** Injectable clock (ms) — defaults to `Date.now`. */
  readonly now?: () => number
}

/**
 * Report cadence under sustained saturation. At the recorder's ~3.4 drops/s a
 * stall would otherwise be a warn per drop; one line per 30s keeps the record
 * without drowning the log the operator has to read during the incident.
 */
export const PENDING_GATE_REPORT_INTERVAL_MS = 30_000

export class PendingGate {
  private inFlight = 0
  private droppedSinceReport = 0
  private lastReportAt = Number.NEGATIVE_INFINITY

  constructor(private readonly deps: PendingGateDeps) {}

  /** Tasks currently in flight. */
  get pending(): number {
    return this.inFlight
  }

  /**
   * Admit `task` unless the lane is saturated.
   *
   * Returns `false` when the task was REFUSED — the caller must log the drop
   * (with its `deviceId` tag when the work is about a device); a branch that
   * drops work silently reads as "never happened".
   */
  run(task: () => Promise<unknown>): boolean {
    if (this.inFlight >= this.deps.limit) {
      this.droppedSinceReport += 1
      const now = this.deps.now?.() ?? Date.now()
      const intervalMs = this.deps.reportIntervalMs ?? PENDING_GATE_REPORT_INTERVAL_MS
      if (now - this.lastReportAt >= intervalMs) {
        this.lastReportAt = now
        const dropped = this.droppedSinceReport
        this.droppedSinceReport = 0
        this.deps.onSaturated({ label: this.deps.label, dropped, pending: this.inFlight })
      }
      return false
    }
    this.inFlight += 1
    // `Promise.resolve().then(task)` folds a synchronous throw into the same
    // rejection path, so a throwing task can never leak its slot.
    void Promise.resolve()
      .then(task)
      .catch((error: unknown) => {
        this.deps.onTaskError?.(error)
      })
      .finally(() => {
        this.inFlight -= 1
      })
    return true
  }
}
