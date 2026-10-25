/**
 * The order of the recorder's staging boot, in one place (D667).
 *
 * 1. **Reap a previous runner's writers.** A runner that died without a
 *    shutdown hook (V8 OOM, SIGKILL) leaves its ffmpeg writers running. Every
 *    one of them is removed here, including those on directories this runner
 *    will never attach again: an events camera with no trigger, a camera that
 *    was disabled, a placement that moved. Nothing else would ever reach them.
 * 2. **Stamp the cutoff, then start the write path.** Every segment a new
 *    writer produces is named after the stamp.
 * 3. **Recover what is staged before the cutoff**, not awaited. It now runs
 *    against a quiet tree, so it also collects the reaped writers' last
 *    segments. Before this order existed, the recovery relocated a file an
 *    orphan was still appending to — a rename keeps the inode.
 * 4. **Only then sweep staging on unassigned roots.** Those trees used to be
 *    deleted before recovery could collect a reaped writer's tail. If a known
 *    writer survives the reap (or the table is unverified), both mutations
 *    are skipped for this boot.
 */
export interface StagingBootSteps {
  /**
   * `true` when no writer that was actually seen remains. `false` means a
   * known writer survived (or its death could not be confirmed), so no staging
   * tree may be moved or deleted this boot.
   *
   * A table that could not be read before any writer was seen also returns
   * `false`: D667 still starts the write path (the per-spawn check is
   * deliberately fail-open), but a fallible read never authorises moving or
   * deleting staging that an unseen writer may still have open.
   */
  readonly reapPredecessorWriters: () => Promise<boolean>
  readonly sweepUnassignedStaging: () => Promise<void>
  readonly startWritePath: () => Promise<void>
  readonly recoverStagedOrphans: (bootMs: number) => Promise<void>
  readonly now: () => number
}

export async function runStagingBoot(steps: StagingBootSteps): Promise<void> {
  const stagingIsQuiescent = await steps.reapPredecessorWriters()
  const bootMs = steps.now()
  await steps.startWritePath()
  if (!stagingIsQuiescent) return
  void (async () => {
    await steps.recoverStagedOrphans(bootMs)
    await steps.sweepUnassignedStaging()
  })()
}
