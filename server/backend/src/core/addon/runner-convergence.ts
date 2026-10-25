/**
 * Group-runner convergence planner (pure).
 *
 * Group membership is decided ONCE, at a runner's FIRST spawn — the `addons`
 * array handed to `$process.spawnRunner`. Every later lifecycle op preserves
 * it: `$process.restart` respawns a runner from its CAPTURED `runnerAddons`,
 * never from a freshly-declared roster. That means the boot plan
 * (`buildAddonGroupPlan` → `initializeAddonGroup`) is not the only place that
 * has to be group-aware: any path that (re)spawns an addon's runner outside
 * boot (hot-install, retry, operator restart, deploy hot-reload) must converge
 * the LIVE process topology onto the addon's DECLARED runner id
 * (`resolveRunnerId`) and its full co-located roster.
 *
 * This module holds the decision as a pure function so it is unit-testable
 * without the heavyweight `AddonRegistryService`. The caller
 * (`ensureForkedRunner`) executes the plan against `$process.*`.
 *
 * Why not just `$process.restart` the addon? Because restart respawns the
 * runner's OLD roster. A runner named `detection` that was spawned solo (with
 * only `pipeline-runner`, before the group manifest shipped) would be respawned
 * solo forever. To adopt a NEW roster the stale runner(s) must be STOPPED and
 * the group spawned fresh — the convergence this planner encodes.
 */

/** Minimal snapshot of one running runner subprocess (from `$process.list`). */
export interface RunnerProcessSnapshot {
  /** Runner id — the process key (`resolveRunnerId`: group name or addon id). */
  readonly name: string
  /** Ids of the addons this runner currently hosts. */
  readonly addonIds: readonly string[]
}

/** The action the caller must take on the TARGET runner after stopping stragglers. */
export type RunnerConvergenceAction = 'spawn' | 'restart' | 'none'

export interface RunnerConvergencePlan {
  /**
   * Runner ids to `$process.stop` first. Every running runner that hosts a
   * roster member under a topology that does NOT match the declared group —
   * stale solo runners after a group manifest first ships, a partial group,
   * or a same-id runner carrying the wrong roster.
   */
  readonly stop: readonly string[]
  /**
   * What to do with the target runner AFTER the stops:
   *   - `'spawn'`   → `$process.spawnRunner(runnerId, roster)` (fresh group).
   *   - `'restart'` → `$process.restart(runnerId)` (roster already correct;
   *                   respawn in place to pick up new on-disk code).
   *   - `'none'`    → already up with the exact roster and no restart asked.
   */
  readonly action: RunnerConvergenceAction
}

function sameRoster(addonIds: readonly string[], rosterSet: ReadonlySet<string>): boolean {
  return addonIds.length === rosterSet.size && addonIds.every((a) => rosterSet.has(a))
}

/**
 * Decide how to converge the live runner topology onto the declared group.
 *
 * @param runnerId       the addon's resolved runner id (`resolveRunnerId`).
 * @param rosterAddonIds the FULL co-located roster (every eligible addon that
 *                       resolves to `runnerId`). Always includes the addon
 *                       itself; size-1 for a groupless addon.
 * @param running        current runner subprocesses (`$process.list`).
 * @param opts.restart   true when the caller wants an in-place respawn even if
 *                       the roster already matches (deploy hot-reload path).
 */
export function planRunnerConvergence(
  runnerId: string,
  rosterAddonIds: readonly string[],
  running: readonly RunnerProcessSnapshot[],
  opts: { readonly restart: boolean },
): RunnerConvergencePlan {
  const rosterSet = new Set(rosterAddonIds)

  const target = running.find((p) => p.name === runnerId)
  const targetIsCorrect = target !== undefined && sameRoster(target.addonIds, rosterSet)

  if (targetIsCorrect) {
    // The exact group runner is already up. Only stragglers to stop are OTHER
    // runners that (wrongly) host a roster member.
    const stop = running
      .filter((p) => p.name !== runnerId && p.addonIds.some((a) => rosterSet.has(a)))
      .map((p) => p.name)
    return { stop, action: opts.restart ? 'restart' : 'none' }
  }

  // No correct runner: either nothing hosts the roster, or a same-id runner
  // carries the WRONG roster, or roster members are scattered across stale
  // solo runners. Stop every runner that hosts a roster member (INCLUDING a
  // wrong-roster same-id runner — restart would just re-spawn its stale
  // roster), then spawn the group fresh.
  const stop = running
    .filter((p) => p.name === runnerId || p.addonIds.some((a) => rosterSet.has(a)))
    .map((p) => p.name)
  return { stop, action: 'spawn' }
}
