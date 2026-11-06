/**
 * The boot health snapshot: every addon entry that survived the loader is
 * recorded on the health monitor as a success or a failure.
 *
 * An addon running below the version the server requires is not a third state:
 * it is spawned and initialized like any other, and the operator hears about it
 * through the `UnsupportedAddonTracker` (D1017), not through this snapshot.
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
  readonly monitor: BootHealthRecorder
}

export function recordBootHealth(input: BootHealthInput): void {
  for (const [id, entry] of input.entries) {
    if (entry.initialized) {
      input.monitor.recordSuccess(entry.packageName, id)
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
