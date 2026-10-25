import { execFile } from 'node:child_process'
import { platform as osPlatform } from 'node:os'
import {
  lifetimeCpuPercent,
  nodeProcReader,
  type ProcReader,
  parseProcStat,
  parseProcStatusRss,
} from './proc-stat.js'

// ===========================================================================
// Per-PID resource usage — zero dependencies.
//
// On Linux every number comes from `/proc/<pid>/stat` and `/proc/<pid>/status`
// with no fork; `ps -p` is the source only where `/proc` does not exist. Why
// the fork mattered — it was a synchronous `fork()` of hub-main, the largest
// process on the host — is in `proc-stat.ts` (D441, D452).
//
// Used by:
// - native-metrics-provider.ts (`getProcessStats`, `getAddonStats`)
// - kernel/moleculer/process-service.ts (`$process.list`, `$process.stats`)
// - addon-registry.service.ts (the hub's own runner census)
// ===========================================================================

export interface PidStats {
  cpu: number // 0–100 percentage
  memory: number // RSS in bytes
  /**
   * Private anonymous resident bytes (Linux RssAnon) — per-process V8 heap +
   * native allocs NOT shared across processes. The meaningful "what this runner
   * actually costs" number (RSS double-counts the shared mmap'd framework).
   * undefined where /proc/<pid>/status is unavailable (e.g. macOS).
   */
  privateBytes?: number
  /** Shared file-backed resident bytes (Linux RssFile). undefined on macOS. */
  sharedBytes?: number
}

/** The impure inputs, injectable so the platform branch is pinned by a test. */
export interface PidStatsDeps {
  readonly platform: NodeJS.Platform
  readonly reader: ProcReader
  /** `ps -o pid=,pcpu=,rss= -p <pids>` — the fork, for a platform without `/proc`. */
  readonly spawnPs: (pids: readonly number[]) => Promise<string>
}

function execPsForPids(pids: readonly number[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'ps',
      ['-o', 'pid=,pcpu=,rss=', '-p', pids.join(',')],
      {
        timeout: 5000,
      },
      (err, stdout) => {
        if (err) return reject(err)
        resolve(stdout)
      },
    )
  })
}

const defaultDeps: PidStatsDeps = {
  platform: osPlatform(),
  reader: nodeProcReader,
  spawnPs: execPsForPids,
}

function parsePsOutput(stdout: string): ReadonlyMap<number, PidStats> {
  const result = new Map<number, PidStats>()
  for (const line of stdout.trim().split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const parts = trimmed.split(/\s+/)
    if (parts.length < 3) continue
    const pid = parseInt(parts[0]!, 10)
    const cpu = parseFloat(parts[1]!)
    const rssKb = parseInt(parts[2]!, 10)
    if (isNaN(pid) || isNaN(cpu) || isNaN(rssKb)) continue
    result.set(pid, {
      cpu: Math.round(cpu * 10) / 10,
      memory: rssKb * 1024, // KB → bytes
    })
  }
  return result
}

/** One pid from `/proc`, or `null` when it is gone or unreadable. */
async function readProcPidStats(
  pid: number,
  uptimeSec: number,
  reader: ProcReader,
): Promise<PidStats | null> {
  let stat: string
  let status: string
  try {
    ;[stat, status] = await Promise.all([reader.readStat(pid), reader.readStatus(pid)])
  } catch {
    return null
  }
  const parsed = parseProcStat(stat)
  if (parsed === null) return null
  const rss = parseProcStatusRss(status)
  if (rss.rssBytes === undefined) return null
  return {
    cpu: lifetimeCpuPercent({ ticks: parsed.ticks, startTicks: parsed.startTicks, uptimeSec }),
    memory: rss.rssBytes,
    privateBytes: rss.privateBytes,
    sharedBytes: rss.sharedBytes,
  }
}

async function readProcPidStatsAll(
  pids: readonly number[],
  reader: ProcReader,
): Promise<ReadonlyMap<number, PidStats>> {
  const uptimeSec = await reader.readUptimeSec()
  const entries = await Promise.all(
    pids.map(async (pid) => [pid, await readProcPidStats(pid, uptimeSec, reader)] as const),
  )
  const result = new Map<number, PidStats>()
  for (const [pid, stats] of entries) {
    if (stats !== null) result.set(pid, stats)
  }
  return result
}

/**
 * Get CPU% and memory RSS for one or more PIDs.
 * Returns a map of pid → stats. Missing/dead PIDs are silently omitted.
 */
export async function getPidStats(
  pids: number | readonly number[],
  deps: PidStatsDeps = defaultDeps,
): Promise<ReadonlyMap<number, PidStats>> {
  const pidArray = typeof pids === 'number' ? [pids] : [...pids]
  if (pidArray.length === 0) return new Map()

  try {
    if (deps.platform === 'linux') return await readProcPidStatsAll(pidArray, deps.reader)
    return parsePsOutput(await deps.spawnPs(pidArray))
  } catch {
    return new Map()
  }
}

/** Get CPU% and memory RSS for a single PID. Returns null if dead. */
export async function getSinglePidStats(pid: number): Promise<PidStats | null> {
  const stats = await getPidStats([pid])
  return stats.get(pid) ?? null
}
