/**
 * The boot health snapshot: every addon entry that survived the loader is
 * recorded as a success or a failure on the health monitor.
 *
 * A THIRD state exists: an addon the hub spawn gate held back (its package is
 * below what the running server requires, D989). It was never started, so it is
 * neither a success nor an init failure - recording it as a failure raised an
 * error alert for every held-back addon after each server update. It is logged
 * once with the gate's reason (both versions) and left out; its later spawn,
 * after the package update, records success the normal way.
 */
export interface BootHealthEntry {
  readonly packageName: string
  readonly initialized: boolean
}

export interface BootHealthRecorder {
  recordSuccess(packageName: string, addonId: string): void
  recordFailure(packageName: string, error: Error, addonId: string): void
}

export interface BootHealthInput {
  readonly entries: Iterable<readonly [string, BootHealthEntry]>
  /** Addon id -> the gate's reason, for every addon the spawn gate held back. */
  readonly heldBack: ReadonlyMap<string, string>
  readonly monitor: BootHealthRecorder
  readonly logHeldBack: (addonId: string, reason: string) => void
}

export function recordBootHealth(input: BootHealthInput): void {
  for (const [id, entry] of input.entries) {
    if (entry.initialized) {
      input.monitor.recordSuccess(entry.packageName, id)
      continue
    }
    const reason = input.heldBack.get(id)
    if (reason !== undefined) {
      input.logHeldBack(id, reason)
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
