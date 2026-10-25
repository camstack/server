/**
 * When a Home Assistant link comes back, everything is re-announced —
 * bounded, coalesced, and never dropped.
 *
 * The defect this exists to fix: `PushClient` clears its per-topic dedup
 * cache the moment a link returns (correct — HA may have restarted and
 * lost its state buffer), but nothing re-sent anything. The next full
 * push was the periodic reconcile, `reconcileIntervalSec` = 300s away, so
 * every entity in Home Assistant sat blank for up to five minutes after
 * each reconnection. The component was forced to work around it.
 *
 * Why a class rather than a `setTimeout` in the addon: the re-announce is
 * the COMPLETE `cmps` set plus every value for every exported device
 * (D8 — a lost event must not corrupt state, the next full snapshot
 * repairs it). Across ~880 entities that is exactly the work the per-topic
 * dedup exists to avoid doing twice, so a link flapping every few seconds
 * must not be able to trigger it every few seconds.
 *
 * Two properties, and they are opposites that both have to hold:
 *
 *  - **bounded** — at most one run per `minIntervalMs`, and every broker
 *    that returns inside a window collapses into that one run. The
 *    reconcile is fleet-wide, so N brokers returning together need one
 *    pass, not N.
 *  - **never dropped** — a request inside the window is DEFERRED to its
 *    edge, never discarded. By then the dedup cache is already gone;
 *    discarding the request would leave HA blank until the periodic pass,
 *    which is the defect itself wearing a different hat.
 */

/**
 * The storm bound.
 *
 * Deliberately the heartbeat interval: the heartbeat is the probe that
 * discovers a link has returned, so no link can be observed to return
 * more often than this anyway, and it equals the fastest full-reconcile
 * cadence an operator can configure (`startTimer` floors
 * `reconcileIntervalSec` at 30s). The worst case this admits is therefore
 * work the addon already accepts as its own floor.
 */
export const REACHABILITY_RECONCILE_MIN_INTERVAL_MS = 30_000

export interface ReachabilityRun {
  /** Every broker whose link returned since the last run. Never empty. */
  readonly brokerIds: readonly string[]
}

export interface ReachabilityScheduled {
  /** The broker whose return armed this run. */
  readonly brokerId: string
  /** 0 when it runs at once; the remaining bound when it was deferred. */
  readonly delayMs: number
}

export interface ReachabilityReconcilerOptions {
  readonly run: (info: ReachabilityRun) => void
  /** Called when a run is armed — the addon's log line for the wait. */
  readonly onScheduled?: (info: ReachabilityScheduled) => void
  readonly minIntervalMs?: number
}

export class ReachabilityReconciler {
  private readonly options: ReachabilityReconcilerOptions
  private readonly minIntervalMs: number
  private timer: NodeJS.Timeout | null = null
  private lastRunAt: number | null = null
  private pending = new Set<string>()
  private disposed = false

  constructor(options: ReachabilityReconcilerOptions) {
    this.options = options
    this.minIntervalMs = options.minIntervalMs ?? REACHABILITY_RECONCILE_MIN_INTERVAL_MS
  }

  /** One link came back. Ask for a full re-announce. */
  request(brokerId: string): void {
    if (this.disposed) return
    this.pending.add(brokerId)
    if (this.timer !== null) return

    const sinceLast =
      this.lastRunAt === null ? Number.POSITIVE_INFINITY : Date.now() - this.lastRunAt
    const delayMs = Math.max(0, this.minIntervalMs - sinceLast)
    this.options.onScheduled?.({ brokerId, delayMs })
    this.timer = setTimeout(() => {
      this.timer = null
      this.fire()
    }, delayMs)
  }

  dispose(): void {
    this.disposed = true
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    this.pending.clear()
  }

  private fire(): void {
    if (this.disposed) return
    const brokerIds = [...this.pending].sort()
    this.pending.clear()
    if (brokerIds.length === 0) return
    this.lastRunAt = Date.now()
    this.options.run({ brokerIds })
  }
}
