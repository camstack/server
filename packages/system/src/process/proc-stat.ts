/**
 * `/proc/<pid>/stat` and `/proc/<pid>/status`, parsed — the process facts
 * `ps` prints, read without a fork.
 *
 * ## Why this exists
 *
 * Every per-process number this repository showed an operator used to come
 * out of a `ps` child: `ps -eo …` for the node's process table, `ps -p …` for
 * a runner's CPU and RSS. A `child_process` spawn is a synchronous `fork()` of
 * the CALLING process, and the caller was hub-main — the largest process on
 * the host. A 60 s CPU profile of hub-main at 5.8 GB RSS (D441) put 26 forks
 * at p50 91 ms, max 200 ms, 8.5 % of the main thread: ~2.6 s per minute of
 * event loop spent copying page tables so a 4 ms `ps` could run. Measured on
 * the agent node (D452): the same fork costs 1.4 ms from a 45 MB process and
 * 74 ms from a 1 GB one, while a `/proc` walk stays at 1–4 ms whatever the
 * parent's size.
 *
 * `ps` reads these same files. This module reads them directly, on Linux, and
 * reports the same quantities with the same semantics — `pcpu` is the
 * LIFETIME average, `etime` is seconds since start, `rss` is `VmRSS`. `ps`
 * stays as the source on a platform without `/proc` (a developer Mac).
 *
 * ## The one parse rule
 *
 * `comm` (field 2) is wrapped in parentheses and may itself contain spaces
 * and parentheses. Every field after it is positional, so the only correct
 * parse cuts at the LAST `)` and indexes from there: after the cut, field 3
 * (`state`) is index 0, so field N is index N − 3. The thread sampler
 * (`thread-cpu-sampler.ts`) documents the same arithmetic for
 * `/proc/<pid>/task/<tid>/stat`, which has the identical layout.
 */
import { readdir, readFile } from 'node:fs/promises'

/**
 * Kernel jiffies per second (`USER_HZ`). `sysconf(_SC_CLK_TCK)` is not exposed
 * to Node, and this has been 100 on every Linux/x86-64 and arm64 kernel
 * configuration we ship to. A wrong value would scale every CPU number and
 * every elapsed time by one constant — visible at once, not a silent skew.
 */
export const CLOCK_TICKS_PER_SEC = 100

/** The fields of one `/proc/<pid>/stat` line this repository reads. */
export interface ProcStat {
  readonly pid: number
  readonly comm: string
  /** Field 3: `R`, `S`, `D`, `Z`, … */
  readonly state: string
  readonly ppid: number
  readonly pgid: number
  /** `utime + stime`, in jiffies, over the process's whole life. */
  readonly ticks: number
  /** Field 22: jiffies since boot at which this incarnation of the pid began. */
  readonly startTicks: number
  /** Field 24: resident pages. Prefer `VmRSS` from `status`, which is in kB. */
  readonly rssPages: number
}

/**
 * Parse one `/proc/<pid>/stat` line. `null` for a line that does not parse —
 * a process that exited between the readdir and the read leaves a truncated
 * or empty file, and that is normal, not an error.
 */
export function parseProcStat(line: string): ProcStat | null {
  const close = line.lastIndexOf(')')
  const open = line.indexOf('(')
  if (close < 0 || open < 0 || close < open) return null
  const pid = Number(line.slice(0, open).trim())
  const comm = line.slice(open + 1, close)
  const rest = line
    .slice(close + 1)
    .trim()
    .split(/\s+/)
  const state = rest[0]
  const ppid = Number(rest[1])
  const pgid = Number(rest[2])
  const utime = Number(rest[11])
  const stime = Number(rest[12])
  const startTicks = Number(rest[19])
  const rssPages = Number(rest[21])
  if (state === undefined || state === '') return null
  if (![pid, ppid, pgid, utime, stime, startTicks, rssPages].every(Number.isFinite)) return null
  return { pid, comm, state, ppid, pgid, ticks: utime + stime, startTicks, rssPages }
}

/** Resident memory from `/proc/<pid>/status`, in bytes. Absent is `undefined`, never 0. */
export interface ProcStatusRss {
  /** `VmRSS` — what `ps rss` prints. */
  readonly rssBytes: number | undefined
  /** `RssAnon` — private anonymous memory, the runner's own cost. */
  readonly privateBytes: number | undefined
  /** `RssFile` — file-backed pages shared with every process mapping the same files. */
  readonly sharedBytes: number | undefined
}

function statusKb(status: string, key: string): number | undefined {
  const match = status.match(new RegExp(`^${key}:\\s+(\\d+)`, 'm'))
  return match ? parseInt(match[1]!, 10) * 1024 : undefined
}

/** Read `VmRSS` / `RssAnon` / `RssFile` (kB in the file) out of `/proc/<pid>/status`. */
export function parseProcStatusRss(status: string): ProcStatusRss {
  return {
    rssBytes: statusKb(status, 'VmRSS'),
    privateBytes: statusKb(status, 'RssAnon'),
    sharedBytes: statusKb(status, 'RssFile'),
  }
}

/** Inputs for the two `ps`-compatible derivations below. */
export interface LifetimeCpuInput {
  readonly ticks: number
  readonly startTicks: number
  /** First field of `/proc/uptime`, seconds since boot. */
  readonly uptimeSec: number
}

/** Seconds the process has been alive — `ps etime`, whole seconds. */
export function elapsedSecSince(input: Pick<LifetimeCpuInput, 'startTicks' | 'uptimeSec'>): number {
  return Math.max(0, Math.floor(input.uptimeSec - input.startTicks / CLOCK_TICKS_PER_SEC))
}

/**
 * `ps pcpu`: CPU time over elapsed time, as a percentage with one decimal.
 *
 * This is deliberately the LIFETIME average `ps` prints, not an instantaneous
 * rate: the columns fed from it have always shown that quantity, and the
 * instantaneous split is a different number with a different owner
 * (`cpuMainPercent` / `cpuGcPercent` from `thread-cpu-sampler.ts`). A process
 * with no elapsed window yet reports 0, never a division by zero.
 */
export function lifetimeCpuPercent(input: LifetimeCpuInput): number {
  const elapsedSec = input.uptimeSec - input.startTicks / CLOCK_TICKS_PER_SEC
  if (!(elapsedSec > 0)) return 0
  const cpuSec = input.ticks / CLOCK_TICKS_PER_SEC
  return Math.round((cpuSec / elapsedSec) * 1000) / 10
}

/**
 * The procfs surface, injectable — the whole reason the readers above are
 * testable against fixtures rather than against a Linux kernel.
 */
export interface ProcReader {
  /** Numeric entries of `/proc`. */
  readonly listPids: () => Promise<readonly number[]>
  readonly readStat: (pid: number) => Promise<string>
  readonly readStatus: (pid: number) => Promise<string>
  /** Raw `/proc/<pid>/cmdline`: NUL-separated argv, empty for a kernel thread. */
  readonly readCmdline: (pid: number) => Promise<string>
  /** First field of `/proc/uptime`. */
  readonly readUptimeSec: () => Promise<number>
}

const PID_RE = /^\d+$/

export const nodeProcReader: ProcReader = {
  listPids: async () =>
    (await readdir('/proc')).filter((entry) => PID_RE.test(entry)).map((entry) => Number(entry)),
  readStat: (pid) => readFile(`/proc/${pid}/stat`, 'latin1'),
  readStatus: (pid) => readFile(`/proc/${pid}/status`, 'latin1'),
  readCmdline: (pid) => readFile(`/proc/${pid}/cmdline`, 'latin1'),
  readUptimeSec: async () => {
    const [first] = (await readFile('/proc/uptime', 'latin1')).trim().split(/\s+/)
    const seconds = Number(first)
    if (!Number.isFinite(seconds)) throw new Error(`/proc/uptime unreadable: ${String(first)}`)
    return seconds
  },
}

/** `ps command=`: argv joined by spaces, or `[comm]` when there is no argv. */
export function commandFromCmdline(cmdline: string, comm: string): string {
  // A string split, not a regex — a control-character regex literal trips
  // `no-control-regex`, and cmdline's NUL separator is not a pattern anyway.
  const joined = cmdline
    .split('\0')
    .filter((part) => part.length > 0)
    .join(' ')
  return joined.length > 0 ? joined : `[${comm}]`
}
