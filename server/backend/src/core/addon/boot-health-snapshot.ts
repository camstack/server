/**
 * The boot health snapshot: every addon entry that survived the loader is
 * recorded on the health monitor as a success, a failure, or - a THIRD state -
 * held back.
 *
 * An addon the hub spawn gate held back (its package is below what the running
 * server requires, D989) was never started, so it is not an init failure:
 * recording one raised an error alert for every held-back addon after each
 * server update. But `recordFailure` was also the only thing that ARMED the
 * monitor's retry loop, which is how a held-back addon came back by itself once
 * its package reached the required version. `recordHeldBack` keeps that retry
 * (same backoff, same reload path) and emits no failure and no alert; a retry
 * that finds the gate open records success the normal way.
 */
export interface BootHealthEntry {
  readonly packageName: string
  readonly initialized: boolean
}

export interface BootHealthRecorder {
  recordSuccess(packageName: string, addonId: string): void
  recordFailure(packageName: string, error: Error, addonId: string): void
  recordHeldBack(packageName: string, reason: string, addonId: string): void
}

export interface BootHealthInput {
  readonly entries: Iterable<readonly [string, BootHealthEntry]>
  /** Addon id -> the gate's reason, for every addon the spawn gate held back. */
  readonly heldBack: ReadonlyMap<string, string>
  readonly monitor: BootHealthRecorder
}

export function recordBootHealth(input: BootHealthInput): void {
  for (const [id, entry] of input.entries) {
    if (entry.initialized) {
      input.monitor.recordSuccess(entry.packageName, id)
      continue
    }
    const reason = input.heldBack.get(id)
    if (reason !== undefined) {
      input.monitor.recordHeldBack(entry.packageName, reason, id)
      continue
    }
    // The catch handlers of Phase 1/2 do not carry the error forward, so a generic one is
    // synthesized; the real error is in the addon log.
    input.monitor.recordFailure(
      entry.packageName,
      new Error(`Addon "${id}" failed to initialize — see addon logs for details`),
      id,
    )
  }
}

/**
 * The ids the spawn gate currently holds back, with the gate's reason. Each gate
 * run over a set of ids replaces what was held for THOSE ids (an addon the gate
 * now lets through is released) and leaves every other id alone.
 */
export class HeldBackAddons {
  private readonly reasons = new Map<string, string>()

  track<T>(addonIds: readonly string[], run: (onDeferred: (id: string, reason: string) => void) => T): T {
    for (const id of addonIds) this.reasons.delete(id)
    return run((id, reason) => {
      this.reasons.set(id, reason)
    })
  }

  has(addonId: string): boolean {
    return this.reasons.has(addonId)
  }

  asMap(): ReadonlyMap<string, string> {
    return this.reasons
  }
}
