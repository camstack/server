/**
 * When the recorder re-resolves its storage locations.
 *
 * ── What was wrong ─────────────────────────────────────────────────────────
 * `RecorderAddon.refreshLocations()` was reachable from exactly three places:
 * `onHubReachable`, the storage-migration path, and the `rescanStorage`
 * recording-cap method. An operator who added a recordings location in the
 * admin UI got NOTHING — the recorder kept the location set it resolved at
 * boot, so the new disk was not in the placement pool, not in the census, and
 * not a write target, until somebody called `rescanStorage` by hand. That is
 * exactly what happened on 2026-09-07 with `recordings:recordings-high-4tb`
 * (D387).
 *
 * ── The two paths, and why BOTH ────────────────────────────────────────────
 * The doorbell (`EventCategory.StorageLocationsChanged`) is telemetry and may
 * be dropped (D8/D11), so it can only ever make the refresh FAST — it can
 * never be the thing that makes it happen. The backstop is what makes it
 * happen: every {@link LOCATION_BACKSTOP_MS} the recorder re-resolves anyway,
 * so a lost event costs latency and nothing else. A design where the event is
 * the only path leaves a node writing to yesterday's disk set forever, and
 * nothing in the logs says why.
 *
 * ── Cheapness ──────────────────────────────────────────────────────────────
 * A refresh is one `storage.listLocations` plus one `storage.resolve` per
 * location, and a bulk edit in the wizard rings the doorbell once per ROW. So
 * doorbells COALESCE: they are collected for {@link LOCATION_DEBOUNCE_MS} and
 * spend one refresh between them, and a doorbell that arrives while a refresh
 * is already running arms exactly one more rather than queueing N.
 */
import type { IScopedLogger } from '@camstack/types'
import { errMsg } from '@camstack/types'

/**
 * How long doorbells are collected before one refresh is spent on them.
 *
 * Long enough that the admin UI's save → close → re-list sequence and a
 * multi-row bulk edit land inside one window; short enough that an operator
 * watching the Storage tab sees the new disk enter the census on the next
 * 30 s placement tick rather than the one after.
 */
export const LOCATION_DEBOUNCE_MS = 2_000

/**
 * The interval at which locations are re-resolved with no doorbell at all.
 *
 * This is the convergence guarantee, not the mechanism: five minutes is the
 * worst case for an operator who adds a disk during an event storm that drops
 * the announcement, and it costs one `listLocations` plus a handful of
 * `resolve` calls — the same reads the boot path already makes once.
 */
export const LOCATION_BACKSTOP_MS = 300_000

export interface LocationRefreshDeps {
  /** Re-resolve the location set. Must be idempotent — both paths call it. */
  readonly refresh: () => Promise<unknown>
  readonly logger: IScopedLogger
  /** Clock, injected so the backstop is testable without wall time. */
  readonly now?: () => number
  readonly debounceMs?: number
  readonly backstopMs?: number
}

/**
 * Coalesces location-change doorbells into refreshes, and converges on its own
 * whether or not any doorbell ever arrives.
 */
export class LocationRefresher {
  private timer: ReturnType<typeof setTimeout> | null = null
  private running = false
  /** A doorbell rang while a refresh was in flight — run exactly one more. */
  private rearm = false
  /** When the last refresh STARTED. `null` ⇒ none since this object was made. */
  private lastStartedAt: number | null = null
  private disposed = false

  constructor(private readonly deps: LocationRefreshDeps) {}

  private get now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  private get debounceMs(): number {
    return this.deps.debounceMs ?? LOCATION_DEBOUNCE_MS
  }

  private get backstopMs(): number {
    return this.deps.backstopMs ?? LOCATION_BACKSTOP_MS
  }

  /**
   * The doorbell. Never awaits the refresh: this runs on the event bus, and a
   * subscriber that blocks on I/O holds up every other consumer of the bus.
   */
  ring(locationId: string, reason: string): void {
    if (this.disposed) return
    this.deps.logger.info(
      'recorder: the storage location set changed — re-resolving where recordings may be written',
      { meta: { locationId, reason, coalesceMs: this.debounceMs } },
    )
    if (this.timer !== null) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.run('storage location change')
    }, this.debounceMs)
  }

  /**
   * The backstop, called from a pass that already runs on a timer. Refreshes
   * only when nothing has refreshed for {@link LOCATION_BACKSTOP_MS} — a
   * doorbell that already produced one resets the clock, so the two paths
   * never both pay.
   */
  async convergeIfDue(): Promise<void> {
    if (this.disposed) return
    const last = this.lastStartedAt
    if (last !== null && this.now - last < this.backstopMs) return
    await this.run('periodic convergence')
  }

  /** Stop the pending doorbell. Nothing in flight is cancelled — it is idempotent. */
  dispose(): void {
    this.disposed = true
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  private async run(trigger: string): Promise<void> {
    if (this.running) {
      // A refresh is already resolving the same set. Arm ONE more rather than
      // stacking a call per doorbell — the second one is what guarantees a
      // change made mid-refresh is seen.
      this.rearm = true
      return
    }
    this.running = true
    this.lastStartedAt = this.now
    try {
      await this.deps.refresh()
    } catch (err: unknown) {
      // A refresh that fails changes nothing (D49): the previously resolved
      // set stands, and the next backstop asks again. Silence here would read
      // as "the locations are current".
      this.deps.logger.warn(
        'recorder: could not re-resolve storage locations — the previously resolved set stands',
        { meta: { trigger, error: errMsg(err) } },
      )
    } finally {
      this.running = false
    }
    if (this.rearm && !this.disposed) {
      this.rearm = false
      await this.run('change during refresh')
    }
  }
}
