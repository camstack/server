import { randomUUID } from 'node:crypto'
import type { SystemEvent } from '@camstack/types'
import { EventCategory } from '@camstack/types'

/**
 * The operator alert for an addon that RUNS below the version the server needs.
 *
 * An addon whose installed package is under the running server's minimum
 * (`camstack.requires.addons`, or its own `requires.server`) is always started:
 * a held-back addon is invisible and silently loses its function, and the
 * `CrashSupervisor` (D6) already bounds a crash loop. What the operator needs is
 * to SEE it, so this tracker turns the gate's verdict into one alert pair on the
 * usual AlertCenter path, the way `AddonHealthMonitor` does for a load failure:
 *
 *   - `AddonUnsupportedVersion` once per streak (same package, same installed
 *     version, same unmet facts), after a short settle window so the alert
 *     centre is subscribed even when the verdict comes from the first boot plan;
 *   - `AddonUnsupportedResolved` when a later judgement finds the package
 *     supported, or the node's installed set no longer holds it, which dismisses
 *     the alert.
 *
 * One tracker per process; the verdict is re-judged on every spawn path, and
 * `observe` is idempotent; given the node's full installed set, a streak whose
 * package is no longer installed is resolved too. State is in memory: a restart raises a still-
 * unsupported addon once more, and AlertCenter upserts it under the same id.
 */
export const UNSUPPORTED_ADDON_SETTLE_MS = 60_000

/** What the gate knows about one addon that runs below its minimum. */
export interface UnsupportedAddonFacts {
  readonly packageName: string
  readonly addonId: string
  readonly installedVersion: string
  /** The running server version, `null` when unreadable. */
  readonly serverVersion: string | null
  /** The minimum the server requires of this package; `null` when only the addon's own `requires.server` is unmet. */
  readonly requiredMinimum: string | null
  /** One line per unmet requirement, versions included. */
  readonly unmet: readonly string[]
}

export interface UnsupportedAddonTrackerOptions {
  readonly eventBus: { emit(event: SystemEvent): void }
  /** The node this tracker runs on (`hub` or the agent's node id). */
  readonly nodeId: string
  readonly log: (line: string) => void
  /** Override for tests. Defaults to {@link UNSUPPORTED_ADDON_SETTLE_MS}. */
  readonly settleMs?: number
  readonly now?: () => number
}

interface Streak {
  readonly facts: UnsupportedAddonFacts
  /** `AddonUnsupportedVersion` has been emitted for this streak. */
  raised: boolean
}

export class UnsupportedAddonTracker {
  private readonly streaks = new Map<string, Streak>()
  private readonly settleMs: number
  private readonly now: () => number
  private readonly startedAt: number
  private timer: NodeJS.Timeout | null = null
  private readonly logged = new Set<string>()

  constructor(private readonly options: UnsupportedAddonTrackerOptions) {
    this.settleMs = options.settleMs ?? UNSUPPORTED_ADDON_SETTLE_MS
    this.now = options.now ?? (() => Date.now())
    this.startedAt = this.now()
  }

  /**
   * One gate run. `judged` is every package the run looked at, `unsupported` the
   * subset below its minimum. A judged package with a streak that is not in
   * `unsupported` any more is resolved; a package this run did not judge is left alone.
   * `installed`, when the run saw the node's FULL package set, also resolves every
   * streak whose package is not in it (uninstalled).
   */
  observe(
    judged: readonly string[],
    unsupported: readonly UnsupportedAddonFacts[],
    installed?: readonly string[],
  ): void {
    if (installed !== undefined) {
      const present = new Set(installed)
      for (const packageName of [...this.streaks.keys()]) {
        if (!present.has(packageName)) this.resolve(packageName)
      }
    }
    const unsupportedNames = new Set(unsupported.map((f) => f.packageName))
    for (const packageName of judged) {
      if (!unsupportedNames.has(packageName)) this.resolve(packageName)
    }
    for (const facts of unsupported) this.raise(facts)
    this.flush()
  }

  /** Log a line the first time only (an unjudged addon is reported once, not on every judgement). */
  logOnce(line: string): void {
    if (this.logged.has(line)) return
    this.logged.add(line)
    this.options.log(line)
  }

  /** Stop the settle timer (shutdown). */
  stop(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
  }

  private raise(facts: UnsupportedAddonFacts): void {
    const existing = this.streaks.get(facts.packageName)
    if (existing !== undefined && sameFacts(existing.facts, facts)) return
    this.options.log(
      `[unsupported-addon] ${facts.addonId} (${facts.packageName}@${facts.installedVersion}) runs below what this server requires: ${facts.unmet.join('; ')}`,
    )
    this.streaks.set(facts.packageName, { facts, raised: false })
  }

  private resolve(packageName: string): void {
    const streak = this.streaks.get(packageName)
    if (streak === undefined) return
    this.streaks.delete(packageName)
    if (!streak.raised) return
    this.options.log(
      `[unsupported-addon] ${streak.facts.addonId} (${packageName}) is supported again, alert cleared`,
    )
    this.emit(EventCategory.AddonUnsupportedResolved, {
      packageName,
      addonId: streak.facts.addonId,
      nodeId: this.options.nodeId,
    })
  }

  /** Emit every pending streak once the settle window is over; otherwise arm one timer for its end. */
  private flush(): void {
    const remaining = this.startedAt + this.settleMs - this.now()
    if (remaining > 0) {
      if (this.timer === null && this.streaks.size > 0) {
        this.timer = setTimeout(() => {
          this.timer = null
          this.flush()
        }, remaining)
        this.timer.unref()
      }
      return
    }
    for (const streak of this.streaks.values()) {
      if (streak.raised) continue
      streak.raised = true
      const f = streak.facts
      this.emit(EventCategory.AddonUnsupportedVersion, {
        packageName: f.packageName,
        addonId: f.addonId,
        nodeId: this.options.nodeId,
        installedVersion: f.installedVersion,
        requiredMinimum: f.requiredMinimum,
        serverVersion: f.serverVersion,
        unmet: [...f.unmet],
      })
    }
  }

  private emit(category: EventCategory, data: Record<string, unknown>): void {
    this.options.eventBus.emit({
      id: randomUUID(),
      timestamp: new Date(),
      category,
      source: { type: 'addon', id: String(data['packageName']) },
      data,
    })
  }
}

function sameFacts(a: UnsupportedAddonFacts, b: UnsupportedAddonFacts): boolean {
  return (
    a.installedVersion === b.installedVersion &&
    a.requiredMinimum === b.requiredMinimum &&
    a.serverVersion === b.serverVersion &&
    a.unmet.join('\n') === b.unmet.join('\n')
  )
}
