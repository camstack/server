/**
 * One retry for a runner the crash breaker parked as `failed`, when the package
 * it hosts changed version (#346).
 *
 * The D6 breaker is terminal on purpose. But a runner that tripped because its
 * package was stale for the server (an update landed before the addon's new
 * version) is not broken for good: the reconcile that follows installs the
 * version that works. The ledger remembers the package versions at the moment
 * of the trip and allows ONE restart when the versions on disk differ. The
 * restart consumes the snapshot, so a runner that trips again records a fresh
 * one and needs another version change: one retry per new version, never a loop.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

/** `addonDir -> package version` (`null` when unreadable). */
export type RunnerPackageVersions = Readonly<Record<string, string | null>>

export type FailedRetryDecision =
  | {
      readonly retry: true
      readonly from: RunnerPackageVersions
      readonly to: RunnerPackageVersions
    }
  | { readonly retry: false; readonly reason: 'no-trip-recorded' | 'version-unchanged' }

export class FailedRunnerRetryLedger {
  private readonly atTrip = new Map<string, RunnerPackageVersions>()

  /** The breaker tripped for `runnerId`; remember what it was running. */
  recordTrip(runnerId: string, versions: RunnerPackageVersions): void {
    this.atTrip.set(runnerId, versions)
  }

  /**
   * Is a restart owed for `runnerId`, given the versions now on disk? An
   * unreadable current version is never a change (a failed read changes
   * nothing). A positive answer consumes the snapshot.
   */
  decide(runnerId: string, current: RunnerPackageVersions): FailedRetryDecision {
    const from = this.atTrip.get(runnerId)
    if (from === undefined) return { retry: false, reason: 'no-trip-recorded' }
    const changed = Object.entries(current).some(
      ([dir, version]) => version !== null && version !== from[dir],
    )
    if (!changed) return { retry: false, reason: 'version-unchanged' }
    this.atTrip.delete(runnerId)
    return { retry: true, from, to: current }
  }

  /** Forget a runner (stop / operator restart). */
  forget(runnerId: string): void {
    this.atTrip.delete(runnerId)
  }
}

/** The package.json version of each addon dir; `null` when unreadable. */
export function readRunnerPackageVersions(addonDirs: readonly string[]): RunnerPackageVersions {
  const out: Record<string, string | null> = {}
  for (const dir of addonDirs) {
    try {
      const raw: unknown = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8'))
      const version = typeof raw === 'object' && raw !== null ? Reflect.get(raw, 'version') : null
      out[dir] = typeof version === 'string' && version.length > 0 ? version : null
    } catch {
      out[dir] = null
    }
  }
  return out
}
