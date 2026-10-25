/**
 * Periodic redundancy sweep — the only thing that removes duplicated footage.
 *
 * WHY IT EXISTS AGAIN
 * ───────────────────
 * Every `SegmentWriter` restart re-dials the broker with `withRecordingIntent`,
 * and the broker answers a RECORDING dial with its pre-roll ring (≈10 s). So a
 * restart does not resume at the live edge: it re-writes ~10 s of media that is
 * already on disk. At the 2026-08-27 measurement — **1 814 restarts in 12 h** —
 * that is ~5 hours of duplicated `high`-profile footage per day, on a fuse
 * share that was already at 90 % full.
 *
 * The pruner that used to remove it, `runRedundancyJanitor`, was reachable ONLY
 * from `runFullArchiveWalk`, which was reachable only from
 * `scheduleDeferredFullWalk`, which had no caller at all — so on 2026-08-27
 * all three were deleted together as dead code. That was
 * correct about the walk and left the system with **no duplicate pruner
 * whatsoever**. The precedent for letting this class of waste run unattended is
 * the 179 GB of stranded staging segments in `staging-reconcile.ts`.
 *
 * WHAT IS DIFFERENT FROM THE ONE THAT WAS DELETED
 * ───────────────────────────────────────────────
 * The old janitor ran once, after a walk of the WHOLE archive, and asked the
 * in-RAM index for `segments(deviceId)` — a full copy plus a sort of every row
 * the device owns. At the live shape (7.1 M rows) that copy alone was measured
 * at ~560 MB of transient heap, which is precisely the cost D248 had just
 * finished removing from the pressure sweep. Reconnecting it in that shape
 * would have traded one regression for another.
 *
 * So this one is bounded by a LOOKBACK WINDOW, not by the archive: duplicates
 * are made by a restart, restarts are now, and `segmentsStartingIn` slices the
 * sorted view instead of copying it. Cost grows with footage RECORDED in the
 * window — the invariant the recorder is supposed to satisfy — never with rows
 * already indexed.
 *
 * WHAT IT WILL NOT DO
 * ───────────────────
 * It never deletes a segment that contributes unique coverage:
 * {@link selectRedundantSegments} selects only segments fully contained inside
 * another segment that is KEPT, and staggered partial overlaps are always kept.
 * The delete itself is `SegmentStore.evict` — the same audited path
 * disk-pressure eviction uses, so a removed segment is de-indexed exactly as an
 * evicted one is. A failure for one (device, profile, location) is logged and
 * never aborts the pass.
 */
import { errMsg } from '@camstack/types'
import type { IScopedLogger } from '@camstack/types'
import { selectRedundantSegments } from '../redundant-segments.js'
import type { SegmentRow } from '../types.js'
import type { HeapDeltaTracker } from './heap-delta.js'

/** The profiles a recorder writes. Same set `staging-reconcile` sweeps. */
const SWEPT_PROFILES: readonly string[] = ['high', 'mid', 'low']

/** What one pass removed. */
export interface RedundancySweepResult {
  readonly files: number
  readonly bytes: number
  readonly devices: number
}

export interface RedundancySweeperDeps {
  /** Names a sweep that grew the heap (instrumentation only; see `heap-delta.ts`). */
  readonly heapProbe?: HeapDeltaTracker
  /** Devices to sweep — the recorder's persisted-config device ids. */
  readonly deviceIds: () => Promise<readonly number[]>
  /**
   * Start-sorted rows for one (device, profile) whose `startMs` is in
   * `[fromMs, toMs)`. A SLICE of the index's sorted view — never a copy of the
   * device's archive; see the docblock on why that distinction is the whole
   * design.
   */
  readonly segmentsInWindow: (
    deviceId: number,
    profile: string,
    fromMs: number,
    toMs: number,
  ) => readonly SegmentRow[]
  /** Delete victims on one location (reuses `SegmentStore.evict`); returns bytes. */
  readonly evict: (locationId: string, rows: readonly SegmentRow[]) => Promise<number>
  readonly logger: Pick<IScopedLogger, 'info' | 'warn' | 'debug'>
  /** Interval between passes (ms). */
  readonly intervalMs: number
  /** How far back each pass looks. Must exceed `intervalMs` so nothing slips. */
  readonly lookbackMs: number
  /** Injectable clock — production omits it. */
  readonly now?: () => number
}

/** Group rows by the location that owns them. `evict` is per-location. */
function byLocation(rows: readonly SegmentRow[]): ReadonlyMap<string, readonly SegmentRow[]> {
  const out = new Map<string, SegmentRow[]>()
  for (const row of rows) {
    const found = out.get(row.locationId)
    if (found) found.push(row)
    else out.set(row.locationId, [row])
  }
  return out
}

/**
 * Owns its timer and a single-flight guard, the same shape the retention sweep
 * and the export janitor already use — a slow pass is never overlapped by the
 * next tick.
 */
export class RedundancySweeper {
  private timer: NodeJS.Timeout | null = null
  private sweeping = false

  constructor(private readonly deps: RedundancySweeperDeps) {}

  /**
   * Arm the sweep on its interval. Idempotent.
   *
   * Deliberately NOT run immediately: boot is when the writers are attaching,
   * the staging reconcile is relocating thousands of files over shfs and the
   * first viewer is painting. A duplicate that has waited an hour can wait
   * another one; the write path cannot.
   */
  start(): void {
    if (this.timer !== null) return
    this.timer = setInterval(() => {
      const probe = this.deps.heapProbe
      void (probe === undefined
        ? this.sweep()
        : probe.track({ kind: 'pass', name: 'redundancy' }, () => this.sweep()))
    }, this.deps.intervalMs)
    this.timer.unref?.()
  }

  /** Stop the timer. Idempotent. An in-flight pass still completes. */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /**
   * One pass. Never throws: a device-list read failure aborts THIS pass
   * (logged), a per-location evict failure is logged and the pass continues.
   */
  async sweep(): Promise<RedundancySweepResult> {
    const empty: RedundancySweepResult = { files: 0, bytes: 0, devices: 0 }
    if (this.sweeping) {
      this.deps.logger.debug('recorder: redundancy sweep already running — skipping this tick')
      return empty
    }
    this.sweeping = true
    try {
      let deviceIds: readonly number[]
      try {
        deviceIds = await this.deps.deviceIds()
      } catch (err: unknown) {
        this.deps.logger.warn('recorder: redundancy sweep could not read the device list', {
          meta: { error: errMsg(err) },
        })
        return empty
      }

      const toMs = (this.deps.now ?? Date.now)()
      const fromMs = toMs - this.deps.lookbackMs
      let files = 0
      let bytes = 0
      let devices = 0

      for (const deviceId of deviceIds) {
        let removedHere = 0
        for (const profile of SWEPT_PROFILES) {
          const rows = this.deps.segmentsInWindow(deviceId, profile, fromMs, toMs)
          const redundant = selectRedundantSegments(rows)
          if (redundant.length === 0) continue
          const victims = redundant.map((i) => rows[i]).filter((row) => row !== undefined)
          for (const [locationId, group] of byLocation(victims)) {
            try {
              const reclaimed = await this.deps.evict(locationId, group)
              files += group.length
              bytes += reclaimed
              removedHere += group.length
            } catch (err: unknown) {
              // A branch that drops work says so — and this one drops the
              // RECLAIM, not the footage: the victims stay on disk and the
              // next pass sees them again.
              this.deps.logger.warn('recorder: redundancy sweep could not evict duplicates', {
                tags: { deviceId },
                meta: {
                  profile,
                  locationId,
                  count: group.length,
                  error: errMsg(err),
                },
              })
            }
          }
        }
        if (removedHere > 0) {
          devices += 1
          this.deps.logger.info('recorder: removed duplicated segments for device', {
            tags: { deviceId },
            meta: { files: removedHere, fromMs, toMs },
          })
        }
      }

      // ALWAYS, including the found-nothing case: "the pass ran and found zero"
      // and "there is no pruner" are different answers, and this subsystem has
      // already been the second one once.
      this.deps.logger.info('recorder: redundancy sweep complete', {
        meta: {
          devices,
          files,
          bytes,
          lookbackMs: this.deps.lookbackMs,
          deviceCount: deviceIds.length,
        },
      })
      return { files, bytes, devices }
    } finally {
      this.sweeping = false
    }
  }
}
