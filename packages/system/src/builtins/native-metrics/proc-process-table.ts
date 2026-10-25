/**
 * The node's process table — every row `ps -eo pid,ppid,pgid,pcpu,rss,etime,
 * command` printed — read from `/proc` on Linux, with no fork.
 *
 * Why the fork mattered, and the numbers, are in `process/proc-stat.ts`. What
 * this file adds is the WHOLE-TABLE read: one `readdir` of `/proc`, then per
 * pid `stat`, `status` and `cmdline`, all through `fs/promises` so the reads
 * land on the libuv pool and the main thread pays only the parse. Measured in
 * the hub container (70 processes, D452): 2–4 ms wall for the walk, against
 * 3–4 ms for `ps` itself — the fork that USED to precede it was the cost.
 *
 * A pid that vanishes between the listing and its reads is omitted whole.
 * Never a partial row: a row with a command and no memory would render as a
 * process using nothing, which is a different claim from "gone".
 */
import { execFile } from 'node:child_process'
import { platform as osPlatform } from 'node:os'
import { promisify } from 'node:util'
import {
  commandFromCmdline,
  elapsedSecSince,
  lifetimeCpuPercent,
  nodeProcReader,
  type ProcReader,
  parseProcStat,
  parseProcStatusRss,
} from '../../process/proc-stat.js'
import type { PsProcessRow } from './process-classification.js'

const execFileAsync = promisify(execFile)

async function readProcRow(
  pid: number,
  uptimeSec: number,
  reader: ProcReader,
): Promise<PsProcessRow | null> {
  let stat: string
  let cmdline: string
  let status: string
  try {
    ;[stat, cmdline, status] = await Promise.all([
      reader.readStat(pid),
      reader.readCmdline(pid),
      reader.readStatus(pid),
    ])
  } catch {
    return null
  }
  const parsed = parseProcStat(stat)
  if (parsed === null) return null
  const rss = parseProcStatusRss(status)
  return {
    pid: parsed.pid,
    ppid: parsed.ppid,
    pgid: parsed.pgid,
    cpuPercent: lifetimeCpuPercent({
      ticks: parsed.ticks,
      startTicks: parsed.startTicks,
      uptimeSec,
    }),
    // A kernel thread has no VmRSS line; `ps` prints 0 for it and so do we.
    // This is the one place absent becomes 0, and only for a row that has no
    // user-space memory to report.
    memoryRssBytes: rss.rssBytes ?? 0,
    uptimeSec: elapsedSecSince({ startTicks: parsed.startTicks, uptimeSec }),
    command: commandFromCmdline(cmdline, parsed.comm),
  }
}

/** Every process in `/proc`, as the rows `ps -eo …` would have printed. */
export async function readProcProcessTable(
  reader: ProcReader = nodeProcReader,
): Promise<readonly PsProcessRow[]> {
  const [pids, uptimeSec] = await Promise.all([reader.listPids(), reader.readUptimeSec()])
  const rows = await Promise.all(pids.map((pid) => readProcRow(pid, uptimeSec, reader)))
  return rows.filter((row): row is PsProcessRow => row !== null)
}

/**
 * Parse `ps etime` → seconds. `MM:SS`, `HH:MM:SS`, `DD-HH:MM:SS`.
 * Only the `ps` path needs this; `/proc` gives the number directly.
 */
export function parseEtime(etime: string): number {
  const dashParts = etime.split('-')
  let days = 0
  let hms = etime
  if (dashParts.length === 2) {
    days = parseInt(dashParts[0]!, 10) || 0
    hms = dashParts[1]!
  }
  const parts = hms.split(':').map((p) => parseInt(p, 10) || 0)
  let hours = 0
  let minutes = 0
  let seconds = 0
  if (parts.length === 3) [hours, minutes, seconds] = parts as [number, number, number]
  else if (parts.length === 2) [minutes, seconds] = parts as [number, number]
  else if (parts.length === 1) [seconds] = parts as [number]
  return days * 86400 + hours * 3600 + minutes * 60 + seconds
}

const PS_ROW_RE = /^(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(.+)$/

/** Parse the output of `ps -eo pid=,ppid=,pgid=,pcpu=,rss=,etime=,command=`. */
export function parsePsTable(stdout: string): readonly PsProcessRow[] {
  const rows: PsProcessRow[] = []
  for (const line of stdout.split('\n')) {
    const match = line.trim().match(PS_ROW_RE)
    if (!match) continue
    const [, pidS, ppidS, pgidS, cpuS, rssS, etimeS, command] = match
    rows.push({
      pid: parseInt(pidS!, 10),
      ppid: parseInt(ppidS!, 10),
      pgid: parseInt(pgidS!, 10),
      cpuPercent: Math.round(parseFloat(cpuS!) * 10) / 10,
      memoryRssBytes: parseInt(rssS!, 10) * 1024,
      uptimeSec: parseEtime(etimeS!),
      command: command!,
    })
  }
  return rows
}

/** The fork. Only reached on a platform without `/proc`. */
export async function spawnPsTable(): Promise<readonly PsProcessRow[]> {
  const { stdout } = await execFileAsync(
    'ps',
    ['-eo', 'pid=,ppid=,pgid=,pcpu=,rss=,etime=,command='],
    { timeout: 5_000, maxBuffer: 8 * 1024 * 1024 },
  )
  return parsePsTable(stdout)
}

/** What decides the source. Injectable so the choice is pinned by a test, not by the CI host. */
export interface ProcessTableDeps {
  readonly platform: NodeJS.Platform
  readonly reader: ProcReader
  readonly spawnPs: () => Promise<readonly PsProcessRow[]>
}

const defaultDeps: ProcessTableDeps = {
  platform: osPlatform(),
  reader: nodeProcReader,
  spawnPs: spawnPsTable,
}

/**
 * The process table, from `/proc` where it exists and from `ps` elsewhere.
 * Throws only when the chosen source cannot answer at all; the caller logs it
 * as a skipped interval.
 */
export function readProcessTable(
  deps: ProcessTableDeps = defaultDeps,
): Promise<readonly PsProcessRow[]> {
  return deps.platform === 'linux' ? readProcProcessTable(deps.reader) : deps.spawnPs()
}
