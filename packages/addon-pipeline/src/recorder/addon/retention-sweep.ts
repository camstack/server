/**
 * Periodic footage-retention sweep (recording-spec §6).
 *
 * The disk-pressure eviction path only fires when a volume is TOO FULL
 * (`shouldSaveDiskSpace` + `minFreePercent`); it never enforces a camera's
 * age/size policy. This sweeper closes that gap: on an hourly cadence it prunes
 * footage for every device whose operator set an actionable `retention` policy,
 * delegating the actual selection + delete to the `recording` cap's
 * `pruneFootage` (which owns the retention FLOOR via `selectEvictions` — this
 * sweeper only decides WHICH devices to prune and WHEN).
 *
 * Owns its own timer + single-flight guard so a slow sweep is never overlapped
 * by the next tick — the same subsystem-owns-its-timer shape as the
 * export janitor. Pure over injected deps (config read + prune + logger +
 * clock via `setInterval`), so it is unit-testable with fake timers and a mock
 * `prune`. Every pass is best-effort: a per-device prune failure is logged and
 * never aborts the rest, and the sweep never throws.
 */
import { errMsg } from '@camstack/types'
import type { RecordingConfig, IScopedLogger } from '@camstack/types'
import type { HeapDeltaTracker } from './heap-delta.js'

/** The subset of `pruneFootage`'s result the sweep summary accumulates. */
export interface RetentionPruneResult {
  readonly deletedBuckets: number
  readonly reclaimedBytes: number
}

/** Injected collaborators — the addon supplies real `pruneFootage` + config read. */
export interface RetentionSweeperDeps {
  /** Names a sweep that grew the heap (instrumentation only; see `heap-delta.ts`). */
  readonly heapProbe?: HeapDeltaTracker
  /** Prune footage for one device past its policy; resolves the reclaimed totals. */
  readonly prune: (deviceId: number) => Promise<RetentionPruneResult>
  /** Every persisted device config, keyed by numeric deviceId. */
  readonly readConfigs: () => Promise<ReadonlyMap<number, RecordingConfig>>
  readonly logger: Pick<IScopedLogger, 'info' | 'warn' | 'debug'>
  /** Interval between sweeps (ms). */
  readonly intervalMs: number
}

/**
 * True when the operator set an ACTIONABLE retention policy on a device — at
 * least one of `maxAgeDays` / `maxSizeGb` is present and positive. Mirrors the
 * `> 0` guards `selectEvictions` itself applies, so a `0`/absent limit (which
 * inherits the node default = "keep forever") is treated as NO policy and the
 * device is skipped. NEVER prune a device without an explicit policy — that
 * would delete footage the operator never asked to age out.
 */
export function hasRetentionPolicy(config: RecordingConfig): boolean {
  const retention = config.retention
  if (!retention) return false
  const byAge = retention.maxAgeDays != null && retention.maxAgeDays > 0
  const bySize = retention.maxSizeGb != null && retention.maxSizeGb > 0
  return byAge || bySize
}

export class RetentionSweeper {
  private timer: NodeJS.Timeout | null = null
  /** Single-flight guard: true while a sweep is in flight. */
  private sweeping = false

  constructor(private readonly deps: RetentionSweeperDeps) {}

  /**
   * Arm the sweep: run immediately, then on the interval. Idempotent — a second
   * `start()` while already armed is a no-op. The timer is `unref`'d so it never
   * keeps the process alive.
   */
  start(): void {
    if (this.timer !== null) return
    const tick = (): void => {
      const probe = this.deps.heapProbe
      void (probe === undefined
        ? this.sweep()
        : probe.track({ kind: 'pass', name: 'retention' }, () => this.sweep()))
    }
    tick()
    this.timer = setInterval(tick, this.deps.intervalMs)
    this.timer.unref?.()
  }

  /** Stop the sweep timer. Idempotent. An in-flight sweep still completes. */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /**
   * One retention pass. Single-flighted: a call that fires while a previous
   * sweep is still running is a no-op. Never throws — a config-read failure
   * aborts THIS pass (logged); a per-device prune failure is logged and the
   * sweep continues with the remaining devices.
   */
  async sweep(): Promise<void> {
    if (this.sweeping) {
      this.deps.logger.debug('recorder: retention sweep already running — skipping this tick')
      return
    }
    this.sweeping = true
    try {
      let configs: ReadonlyMap<number, RecordingConfig>
      try {
        configs = await this.deps.readConfigs()
      } catch (err: unknown) {
        this.deps.logger.warn('recorder: retention sweep could not read device configs', {
          meta: { error: errMsg(err) },
        })
        return
      }
      const withPolicy = [...configs].filter(([, config]) => hasRetentionPolicy(config))
      const devicesSkipped = configs.size - withPolicy.length
      // START, with the work in front of it. The first sweep after a staging
      // recovery prunes six weeks of footage that has only just become visible
      // and takes minutes; announcing only the result made that indistinguishable
      // from a hang.
      this.deps.logger.info('recorder: retention sweep starting', {
        meta: { devices: withPolicy.map(([deviceId]) => deviceId), skipped: devicesSkipped },
      })
      let devicesSwept = 0
      let bucketsPruned = 0
      let bytesReclaimed = 0
      for (const [deviceId] of withPolicy) {
        const startedMs = Date.now()
        try {
          const result = await this.deps.prune(deviceId)
          devicesSwept += 1
          bucketsPruned += result.deletedBuckets
          bytesReclaimed += result.reclaimedBytes
          this.deps.logger.info('recorder: retention prune complete for device', {
            tags: { deviceId },
            meta: {
              deletedBuckets: result.deletedBuckets,
              reclaimedBytes: result.reclaimedBytes,
              ms: Date.now() - startedMs,
            },
          })
        } catch (err: unknown) {
          this.deps.logger.warn('recorder: retention prune failed for device', {
            tags: { deviceId },
            meta: { error: errMsg(err) },
          })
        }
      }
      this.deps.logger.info('recorder: retention sweep complete', {
        meta: { devicesSwept, devicesSkipped, bucketsPruned, bytesReclaimed },
      })
    } finally {
      this.sweeping = false
    }
  }
}
