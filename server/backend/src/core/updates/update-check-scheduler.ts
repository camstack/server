/**
 * UpdateCheckScheduler — the periodic "an update exists" poller.
 *
 * ## Why this exists
 *
 * `update.available` had an emitter and no clock. The only periodic caller was
 * `AddonPackageService.runAutoUpdate`, armed by `scheduleAutoUpdate`, which
 * returns early when the auto-update channel is `off` — and every live hub runs
 * `off` (operators want to be TOLD, not to have addons swapped under them). So
 * the one path that could ever fire unattended was structurally dead, and the
 * remaining publishes were request-scoped: `checkUpdates` only when the
 * operator opened the Addons page, `checkServerUpdate` only behind the manual
 * per-node "Check" button.
 *
 * This scheduler is therefore deliberately INDEPENDENT of the auto-update
 * channel — the channel decides whether to INSTALL, this decides how often to
 * LOOK. It takes no channel input at all, so the dead-gate bug cannot come
 * back by accident.
 *
 * ## What one sweep covers
 *
 * All five discovery paths, in one pass:
 *   1. installed addons on the hub          (`checkHubAddons`)
 *   2. the framework/server packages        (`checkFrameworkPackages`)
 *   3. per-node server root updates         (`checkNodeServerUpdate`, hub + agents)
 *   4. installed addons on each agent       (`checkAgentAddons`)
 *   5. per-node SHELL updates               (`checkWrapperUpdate`, hub + agents)
 *
 * (5) is not a variant of (3). `applyServerUpdate` swaps the data-root closure
 * and NEVER touches the image, so on 2026-08-02 the hub's `runningVersion` was
 * perfectly current while the container itself was 13 days old, from a
 * repository that had been renamed and received no builds. "Is my code
 * current" and "is my shell current" are two questions, and only the second
 * one caught that. See D437.
 *
 * Each target publishes through its own {@link UpdateAvailabilityEmitter}, so
 * dedup and durability live there and this class only owns the clock and the
 * failure isolation.
 *
 * ## Failure isolation
 *
 * A check that throws is LOGGED and skipped — it must never publish, because
 * an empty snapshot means "everything is up to date" and would wipe the dedup
 * state, re-announcing the whole list on the next successful poll. A fallible
 * read never looks like "no updates".
 */
import type { IScopedLogger, NodeLiveness } from '@camstack/types'
import { errMsg } from '@camstack/types'

/**
 * Default poll cadence: 6 hours. Registry lookups are cheap but not free, and
 * an operator who is told about a publish within a quarter-day is told in time.
 */
export const DEFAULT_UPDATE_CHECK_INTERVAL_SECONDS = 6 * 60 * 60

/**
 * Floor: 15 minutes. Below this the sweep starts overlapping its own npm
 * lookups on a cluster of any size, and the notification stops being a
 * notification. `setAutoUpdateSettings` clamps to this rather than refusing,
 * so a bad value degrades to "poll briskly" instead of "poll never".
 */
export const MIN_UPDATE_CHECK_INTERVAL_SECONDS = 15 * 60

/** Ceiling: 7 days. Anything longer is indistinguishable from disabled. */
export const MAX_UPDATE_CHECK_INTERVAL_SECONDS = 7 * 24 * 60 * 60

/** Grace after boot before the first sweep, so registry I/O never races boot. */
const DEFAULT_INITIAL_DELAY_MS = 90_000

/** Clamp an operator-supplied interval into the supported window. */
export function clampUpdateCheckInterval(seconds: number): number {
  if (!Number.isFinite(seconds)) return DEFAULT_UPDATE_CHECK_INTERVAL_SECONDS
  const whole = Math.floor(seconds)
  if (whole < MIN_UPDATE_CHECK_INTERVAL_SECONDS) return MIN_UPDATE_CHECK_INTERVAL_SECONDS
  if (whole > MAX_UPDATE_CHECK_INTERVAL_SECONDS) return MAX_UPDATE_CHECK_INTERVAL_SECONDS
  return whole
}

/**
 * The five discovery paths, as narrow ports. Each returns whatever its backing
 * service returns; the scheduler only cares that it resolved.
 */
export interface UpdateCheckTargets {
  /** Fan-out-free node roster (`AgentRegistryService.listNodeLiveness`). */
  readonly listNodes: () => readonly NodeLiveness[]
  /** Installed addon packages on the hub. */
  readonly checkHubAddons: () => Promise<unknown>
  /** Installed addon packages reported by one agent. */
  readonly checkAgentAddons: (nodeId: string) => Promise<unknown>
  /** Framework packages inside the running `@camstack/server` closure. */
  readonly checkFrameworkPackages: () => Promise<unknown>
  /** The node's own runtime-updatable root package. */
  readonly checkNodeServerUpdate: (nodeId: string, isHub: boolean) => Promise<unknown>
  /**
   * The node's SHELL — the container image / app bundle it runs inside. A node
   * that cannot answer this must REJECT: an empty snapshot would clear the
   * dedup state and read as "the image is fine", which is exactly the fake
   * green of 2026-08-02.
   */
  readonly checkWrapperUpdate: (nodeId: string, isHub: boolean) => Promise<unknown>
}

export interface UpdateCheckSchedulerOptions {
  readonly logger: IScopedLogger
  readonly targets: UpdateCheckTargets
  /** Read live on every (re)arm so a settings change takes effect immediately. */
  readonly getIntervalSeconds: () => number
  readonly initialDelayMs?: number
}

export class UpdateCheckScheduler {
  private readonly logger: IScopedLogger
  private readonly targets: UpdateCheckTargets
  private readonly getIntervalSeconds: () => number
  private readonly initialDelayMs: number

  private timer: ReturnType<typeof setInterval> | null = null
  private bootTimer: ReturnType<typeof setTimeout> | null = null
  private intervalSeconds: number = DEFAULT_UPDATE_CHECK_INTERVAL_SECONDS
  private sweeping = false

  constructor(options: UpdateCheckSchedulerOptions) {
    this.logger = options.logger
    this.targets = options.targets
    this.getIntervalSeconds = options.getIntervalSeconds
    this.initialDelayMs = options.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS
  }

  /** Interval currently armed, after clamping. Exposed for assertions + logs. */
  currentIntervalSeconds(): number {
    return this.intervalSeconds
  }

  /** Arm the poller. Safe to call twice — the previous timers are replaced. */
  start(): void {
    this.arm()
    if (this.bootTimer !== null) clearTimeout(this.bootTimer)
    this.bootTimer = setTimeout(() => {
      this.bootTimer = null
      void this.runSweep()
    }, this.initialDelayMs)
    this.bootTimer.unref?.()
  }

  /** Re-read the interval from settings and re-arm if it moved. */
  reschedule(): void {
    const next = clampUpdateCheckInterval(this.getIntervalSeconds())
    if (this.timer !== null && next === this.intervalSeconds) return
    this.arm()
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer)
    if (this.bootTimer !== null) clearTimeout(this.bootTimer)
    this.timer = null
    this.bootTimer = null
  }

  /**
   * One full sweep. Never throws and never runs concurrently with itself — an
   * overlapping tick (slow registry, long agent fan-out) is dropped WITH a log
   * rather than doubling the npm traffic.
   */
  async runSweep(): Promise<void> {
    if (this.sweeping) {
      this.logger.warn('Update check skipped — previous sweep still running')
      return
    }
    this.sweeping = true
    try {
      const nodes = this.targets.listNodes()
      await this.attempt('hub addon packages', 'hub', () => this.targets.checkHubAddons())
      await this.attempt('framework packages', 'hub', () => this.targets.checkFrameworkPackages())
      for (const node of nodes) {
        if (!node.isOnline) {
          // D58: never dispatch at a node the registry already called offline —
          // and a dropped branch is never silent.
          this.logger.warn('Update check skipped — node offline', { tags: { nodeId: node.id } })
          continue
        }
        await this.attempt('node server package', node.id, () =>
          this.targets.checkNodeServerUpdate(node.id, node.isHub),
        )
        // The shell, on EVERY node role — the hub is the one this failure was
        // found on.
        await this.attempt('node wrapper', node.id, () =>
          this.targets.checkWrapperUpdate(node.id, node.isHub),
        )
        if (node.isHub) continue
        await this.attempt('agent addon packages', node.id, () =>
          this.targets.checkAgentAddons(node.id),
        )
      }
    } finally {
      this.sweeping = false
    }
  }

  private arm(): void {
    if (this.timer !== null) clearInterval(this.timer)
    this.intervalSeconds = clampUpdateCheckInterval(this.getIntervalSeconds())
    this.logger.info('Update check scheduled', {
      meta: { intervalSeconds: this.intervalSeconds },
    })
    this.timer = setInterval(() => {
      void this.runSweep()
    }, this.intervalSeconds * 1_000)
    this.timer.unref?.()
  }

  private async attempt(what: string, nodeId: string, run: () => Promise<unknown>): Promise<void> {
    try {
      await run()
    } catch (error: unknown) {
      // Logged, not published: an empty snapshot would read as "up to date"
      // and destroy the dedup state the operator's notifications rely on.
      this.logger.warn(`Update check failed — ${what}`, {
        tags: { nodeId },
        meta: { error: errMsg(error) },
      })
    }
  }
}
