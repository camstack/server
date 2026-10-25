/**
 * Detection-pool glue for the shared {@link PoolMemoryWatchdog}
 * (`@camstack/types`): enumerates the provider's live inference pools
 * (node-default + per-device), samples each worker's RSS from
 * `/proc/<pid>/status`, attaches the cheap internals (backlog, shed,
 * dropped, Python-side mem_stats) and hands the policy verdicts back to
 * the provider's EXISTING dispose-and-recreate machinery.
 *
 * The watchdog is a trigger, not a supervisor: a restart here is exactly the
 * idle-reaper's dispose path — the single-flight `resolveDeviceFactory` /
 * `ensureEngineFactory` rebuild the pool on the next dispatch, and
 * `ensureModelsForSteps` reloads models on demand, identical to an idle
 * eviction. CrashSupervisor is untouched: it supervises the addon RUNNER
 * process; these Python children were previously supervised by nobody but
 * the kernel OOM killer.
 */
import type { IScopedLogger } from '@camstack/types'
import {
  PoolMemoryWatchdog,
  resolvePoolMemoryPolicy,
  type PoolMemoryTelemetry,
} from '@camstack/types'
import { readProcessMemory } from '../../shared/process-memory.js'
import type { EngineFactory } from './engine-factory.js'

export interface GuardedPool {
  readonly key: string
  readonly factory: EngineFactory
}

export interface DetectionPoolMemoryGuardSource {
  /** The live pools, re-enumerated every sweep (pools come and go). */
  listPools(): readonly GuardedPool[]
  /** Dispose the named pool via the owner's lifecycle machinery; the next
   *  dispatch recreates it (single-flight) and reloads models on demand. */
  restartPool(key: string): Promise<void>
}

export function createDetectionPoolMemoryGuard(
  source: DetectionPoolMemoryGuardSource,
  logger: IScopedLogger,
): PoolMemoryWatchdog {
  const log = logger.child('pool-memory')
  /** Pools already reported dead — the `pool is DEAD` line fires on the EDGE.
   *  A pool nobody dispatches to is never condemned, so without this gate one
   *  idle corpse writes an ERROR every sweep forever, which is how a real
   *  signal becomes noise. Cleared when the pool comes back or goes away. */
  const reportedDead = new Set<string>()
  return new PoolMemoryWatchdog({
    policy: resolvePoolMemoryPolicy(process.env),
    log,
    restart: (key) => source.restartPool(key),
    sample: async () => {
      const out: PoolMemoryTelemetry[] = []
      const seen = new Set<string>()
      for (const pool of source.listPools()) {
        seen.add(pool.key)
        const telemetry = await samplePool(pool, log, reportedDead)
        if (telemetry) out.push(telemetry)
      }
      for (const key of [...reportedDead]) if (!seen.has(key)) reportedDead.delete(key)
      return out
    },
  })
}

async function samplePool(
  pool: GuardedPool,
  log: IScopedLogger,
  reportedDead: Set<string>,
): Promise<PoolMemoryTelemetry | null> {
  const pids = pool.factory.getPoolPids()
  if (pids.length === 0) return null // pool not spawned (yet) — nothing to bound

  let maxRssBytes = 0
  const workers: Record<string, unknown>[] = []
  for (const pid of pids) {
    const mem = await readProcessMemory(pid)
    if (!mem) {
      // A worker the watchdog cannot see is a bound that quietly stopped
      // covering it — say so instead of silently shrinking the sample.
      log.warn('pool memory sample dropped for worker pid', {
        meta: { poolKey: pool.key, pid },
      })
      continue
    }
    if (mem.rssBytes > maxRssBytes) maxRssBytes = mem.rssBytes
    workers.push({
      pid,
      rssMb: Math.round(mem.rssBytes / (1024 * 1024)),
      vmMb: Math.round(mem.vmBytes / (1024 * 1024)),
      peakRssMb: Math.round(mem.hwmBytes / (1024 * 1024)),
      swapMb: Math.round(mem.swapBytes / (1024 * 1024)),
      threads: mem.threads,
    })
  }
  if (workers.length === 0) {
    // Two very different things used to share this branch, and conflating them
    // is how the only supervisor these Python children have exempted the one
    // corpse it existed to catch. A pool mid-respawn has pids that vanished and
    // a factory that will be ready again; a DEAD pool has neither, and on
    // 2026-08-25 this branch printed `pool memory sample dropped for worker pid`
    // every sweep for 31 hours next to zero verdicts for that pool.
    //
    // It still does not restart it: condemnation is charged against the
    // per-deviceKey budget by the dispatch path (a restart from here would
    // bypass the budget and reintroduce the per-frame spawn loop it exists to
    // prevent), and the pool is already published on the health channel that
    // takes it out of the balancer. What was missing was SAYING so.
    if (!pool.factory.isReady()) {
      if (!reportedDead.has(pool.key)) {
        reportedDead.add(pool.key)
        log.error('inference pool is DEAD — every worker pid is gone and the pool is not ready', {
          meta: { poolKey: pool.key, pids },
        })
      }
    } else {
      reportedDead.delete(pool.key)
    }
    return null
  }

  const backlog = pool.factory.getPoolBacklog()
  // Python-side internals: request counters, queue depths, caches, malloc
  // arenas. Soft-fail — the RSS bound must never depend on the IPC answering.
  const memStats = await pool.factory
    .getPoolMemStats()
    .catch((err: unknown) => (err instanceof Error ? err.message : String(err)))

  return {
    key: pool.key,
    pids,
    rssBytes: maxRssBytes,
    meta: {
      workers,
      inFlight: backlog.inFlight,
      shed: backlog.shed,
      dropped: backlog.dropped,
      deadlineExpired: backlog.deadlineExpired,
      modelsLoaded: pool.factory.listLoaded().length,
      memStats,
    },
  }
}
