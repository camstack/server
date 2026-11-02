/**
 * The per-addon init orchestration of a runner, apart from `addon-runner.ts` (whose `main()` runs
 * at import time and cannot be unit-tested).
 *
 * An addon blocked by its OWN migrations is not a crash and not the runner's problem: it is
 * reported and skipped, and its co-located siblings keep initialising (a runner that exited here
 * took every member of its group down with it, five times, into the D6 breaker). Any other init
 * failure stays fatal, through the injected `fatal` (which exits). Only a runner where NOTHING
 * loaded because members were blocked leaves, with the D877 refusal code: parked `refused`, with
 * the reason, no breaker and no respawn.
 */
import { findMigrationsBlocked } from '@camstack/types'
import type { RunnerRefusalReport } from './runner-refusal.js'

export interface RunnerInitEntry {
  readonly spec: { readonly addonId: string }
}

export interface BlockedAddon {
  readonly addonId: string
  readonly migrationIds: readonly string[]
}

export interface RunnerInitPorts<E extends RunnerInitEntry> {
  /** Initialise one addon; throws what its `initialize()` threw. */
  init(entry: E): Promise<void>
  /** Say that an addon is blocked by its migrations (the caller logs with `tags: { addonId }`). */
  blocked(addonId: string, migrationIds: readonly string[]): void
  /** An init failure that is not a blocked-migrations one: reports it and exits. */
  fatal(entry: E, err: unknown): never
}

export interface RunnerInitResult {
  readonly initialised: number
  readonly blocked: readonly BlockedAddon[]
}

export async function runAddonInits<E extends RunnerInitEntry>(
  entries: readonly E[],
  ports: RunnerInitPorts<E>,
): Promise<RunnerInitResult> {
  let initialised = 0
  const blocked: BlockedAddon[] = []
  for (const entry of entries) {
    try {
      await ports.init(entry)
      initialised += 1
    } catch (err: unknown) {
      const migrationIds = findMigrationsBlocked(err)
      if (migrationIds === null) return ports.fatal(entry, err)
      blocked.push({ addonId: entry.spec.addonId, migrationIds })
      ports.blocked(entry.spec.addonId, migrationIds)
    }
  }
  return { initialised, blocked }
}

/** The refusal a runner leaves with when every member was blocked; null when none was. */
export function allBlockedRefusal(blocked: readonly BlockedAddon[]): RunnerRefusalReport | null {
  const first = blocked[0]
  if (first === undefined) return null
  const detail = blocked.map((b) => `${b.addonId} (${b.migrationIds.join(', ')})`).join('; ')
  return {
    addonId: first.addonId,
    code: 'migrations-blocked',
    reason: `no addon of this runner could start: its migrations did not apply: ${detail}.`,
    remedy: 'Fix or retry the migrations (migrations.retry), then restart the addon.',
  }
}
