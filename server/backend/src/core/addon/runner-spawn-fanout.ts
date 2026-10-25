/**
 * What makes the boot runner plan safe to OVERLAP.
 *
 * `spawnRunnerPlan` used to be `for (…of plan) await initializeAddonGroup(…)`.
 * The fork itself is cheap — `$process.spawnRunner` returns as soon as
 * `child_process.spawn` hands back a pid, and the child's capabilities land
 * later on its INFO heartbeat — but every iteration ALSO does a dynamic
 * `import()` of the addon's built bundle inside the hub process, purely to read
 * its `customActions` export. Forty runners' module graphs, evaluated one after
 * another, were ~4 s of the measured 10 s kernel boot, and it grows linearly
 * with the addon count (docs/design/boot-to-usable-camera.md, item B).
 *
 * Nothing in a plan is ordered: `buildAddonGroupPlan` keys by runner id and
 * `resolveRunnerId` is `execution.group ?? addonId`, so entries are independent
 * by construction. The ordering that IS load-bearing lives BETWEEN the plans
 * (forked addons → in-process builtins → isolated builtins) and is untouched.
 *
 * Two primitives, because overlapping the loop exposes exactly one shared
 * resource: Node's `require.cache`.
 */

/**
 * Concurrent runner spawns during boot.
 *
 * Each unit is a `child_process.spawn` (kernel work) plus a full CJS module
 * graph evaluated ON the hub's event loop. The bound protects the hub, not the
 * code: unbounded, forty simultaneous module evaluations would starve the very
 * event loop that has to answer the children's UDS handshakes. Eight keeps the
 * fork syscalls overlapped while never leaving more than eight bundles being
 * parsed at once.
 */
export const RUNNER_SPAWN_CONCURRENCY = 8

/**
 * Run `spawnOne` over every plan entry with at most `concurrency` in flight.
 *
 * Same lane-pool shape as `BaseDeviceProvider.onRestoreDevices` and
 * `hydrateDevicesFromStorage` (D167) — one queue, N lanes, each lane pulling
 * the next index until the queue is drained. `spawnOne` owns its own failure
 * handling; a unit that settles (however it settles) frees its lane.
 */
export async function spawnPlanConcurrently<K, V>(
  plan: ReadonlyMap<K, V>,
  spawnOne: (runnerId: K, addons: V) => Promise<void>,
  concurrency: number = RUNNER_SPAWN_CONCURRENCY,
): Promise<void> {
  const queue = [...plan.entries()]
  if (queue.length === 0) return
  let next = 0
  const lane = async (): Promise<void> => {
    for (;;) {
      const unit = queue[next++]
      if (unit === undefined) return
      await spawnOne(unit[0], unit[1])
    }
  }
  const lanes = Math.min(Math.max(1, concurrency), queue.length)
  await Promise.all(Array.from({ length: lanes }, lane))
}

/** Serialises work that shares a key. See {@link createKeyedSerializer}. */
export interface KeyedSerializer {
  run<T>(key: string, work: () => Promise<T>): Promise<T>
}

/**
 * Serialise work that shares a key, while different keys run freely.
 *
 * THE reason this exists: loading a forked addon's custom-action catalog first
 * calls `purgeRequireCacheUnder(dirname(entryPath))`, which mutates the
 * PROCESS-GLOBAL `require.cache`. Serially that is always purge-then-import.
 * Overlapped, one addon's purge can fire while a sibling's `import()` of the
 * same directory is still resolving, evicting half of a module graph that is
 * being evaluated — duplicate module instances, or a partially-purged one.
 *
 * It is not hypothetical: `@camstack/addon-remote-storage` ships four addon
 * ids (`sftp-storage`, `s3-storage`, `webdav-storage`, `smb-storage`) whose
 * entries all resolve into the same `dist/` directory, each on its own runner,
 * all in the same plan.
 *
 * Keyed by the purge scope, so the bound above still applies across packages
 * and only true siblings queue behind each other.
 */
export function createKeyedSerializer(): KeyedSerializer {
  const chains = new Map<string, Promise<unknown>>()
  return {
    run<T>(key: string, work: () => Promise<T>): Promise<T> {
      const previous = chains.get(key) ?? Promise.resolve()
      // `.then(work, work)` — a predecessor that REJECTED must not cancel its
      // successors, and must not leave the chain permanently rejected.
      const result = previous.then(work, work)
      // The chain link swallows the outcome; only the caller sees it.
      const link = result.then(
        () => undefined,
        () => undefined,
      )
      chains.set(key, link)
      void link.then(() => {
        // Drop the key once this link is the tail — keeps the map from growing
        // one entry per addon directory for the life of the process.
        if (chains.get(key) === link) chains.delete(key)
      })
      return result
    },
  }
}
