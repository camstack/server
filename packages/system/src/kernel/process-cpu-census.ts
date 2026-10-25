/**
 * process-cpu-census — what THIS process costs, and how much of that is V8's
 * background threads, on the ordinary `[mem]` heartbeat.
 *
 * ## Why this exists
 *
 * `docker stats` reports the CGROUP. On the CamStack hub that is hub-main plus
 * 39 forked runners plus every ffmpeg and python child they spawn, summed into
 * one number — and for months that number was read as if it described hub-main.
 * On 2026-09-12 the container sat at 265–273 % and hub-main was **33 %** of it;
 * a night had already been spent removing messages from hub-main's socket plane
 * on the assumption that it was most of the 212 %. Nothing on any log line
 * could have corrected that, because no process reported its own CPU.
 *
 * The second half is worse, and D458 named it in advance without closing it.
 * `gcPauseMs` is the MAIN-THREAD pause. V8's concurrent marking runs on the
 * platform worker threads, and no in-process counter saw it:
 *
 * | process | `gcPauseMs` says | the workers actually cost |
 * | --- | --- | --- |
 * | hub-main | 673 ms/60 s → 1.1 % | **15.8 %** |
 * | stream-broker | 3 852 ms/300 s → 1.3 % | **36.6 %** |
 * | pipeline-analytics | 2 004 ms/300 s → 0.7 % | **16.1 %** |
 *
 * A 14x to 28x understatement of what turned out to be the single largest item
 * in the container — ~101 % of a core, spread across eleven processes, none of
 * which looked expensive on its own line. That is D393 in its most expensive
 * form: not a failed measurement reported as zero, but a real measurement of
 * the wrong thread reported under a name general enough to be mistaken for the
 * whole thing.
 *
 * ## Why the share, and not the ticks
 *
 * `/proc/<pid>/task/<tid>/stat` counts in USER_HZ jiffies, and nothing in Node
 * exposes `sysconf(_SC_CLK_TCK)`. Hard-coding 100 would be right on every Linux
 * this runs on and would still be an assumption baked into a number nobody
 * could check. So the ticks are used ONLY as a ratio — worker ticks over total
 * ticks — and that ratio scales `process.cpuUsage()`, which is exact
 * microseconds from the kernel. Whatever a jiffy is, it cancels.
 *
 * ## Cost
 *
 * One `process.cpuUsage()` (~1 µs) and one readdir plus ~11 small `/proc` reads
 * per LINE — once a minute on hub-main, once every five on a runner. It is not
 * on the 2 s probe path and it is not on any request path.
 */
import { readdirSync, readFileSync } from 'node:fs'

/**
 * A window shorter than this is not answered. Same rule and same reason as
 * `GC_CENSUS_MIN_WINDOW_MS`: the boot line spans milliseconds, and a percentage
 * computed over it is noise wearing a decimal point. The unread interval is
 * KEPT, so the next line describes it rather than losing it (D393 applied to a
 * rate, as D458 part 3 put it).
 */
export const PROCESS_CPU_MIN_WINDOW_MS = 1_000

/** One thread's cumulative scheduled time, in whatever unit `/proc` counts. */
export interface TaskTicks {
  /** The thread name — `MainThread`, `V8Worker`, `libuv-worker`, … */
  readonly comm: string
  /** Cumulative `utime + stime` for this thread. Units never leave this module. */
  readonly ticks: number
}

/** What V8's background threads cost, when the platform let us find out. */
export interface V8WorkerCpu {
  /** Percent of ONE core, over the same window as the process reading. */
  readonly percentOfCore: number
  /** How many threads that is spread over — 4 is the usual platform pool. */
  readonly threads: number
}

export interface ProcessCpuReading {
  /** Percent of ONE core this process used across the window. */
  readonly percentOfCore: number
  readonly windowMs: number
  /**
   * `null` means UNKNOWN — not zero. Off Linux, or with `/proc` unreadable, or
   * when the thread deltas cannot describe an interval, there is no reading,
   * and the line says nothing rather than printing a zero somebody will quote.
   */
  readonly v8Workers: V8WorkerCpu | null
}

export interface ProcessCpuCensus {
  /** The window since the last read that ANSWERED. `null` when too short. */
  read(at: number): ProcessCpuReading | null
}

export interface ProcessCpuCensusOptions {
  /** Cumulative user+system CPU for the whole process, in microseconds. */
  readonly cpuUsageUs: () => number
  /** Per-thread cumulative ticks, or `null` when the platform cannot say. */
  readonly readTasks: () => readonly TaskTicks[] | null
  readonly startedAt: number
}

/**
 * The census. Always exists — `process.cpuUsage()` is available on every
 * platform Node runs on, so unlike the GC census there is no runtime in which
 * this has nothing to report.
 */
export function createProcessCpuCensus(options: ProcessCpuCensusOptions): ProcessCpuCensus {
  let windowStart = options.startedAt
  let cpuAtStart = options.cpuUsageUs()
  let tasksAtStart = options.readTasks()

  return {
    read: (at: number): ProcessCpuReading | null => {
      const windowMs = at - windowStart
      // Too short to describe: keep the baseline so the interval is not lost.
      if (windowMs < PROCESS_CPU_MIN_WINDOW_MS) return null

      const cpuNow = options.cpuUsageUs()
      const tasksNow = options.readTasks()
      const cpuUs = cpuNow - cpuAtStart
      const percentOfCore = cpuUs <= 0 ? 0 : round1((cpuUs / 1000 / windowMs) * 100)

      const reading: ProcessCpuReading = {
        percentOfCore,
        windowMs,
        v8Workers: shareOfWorkers(tasksAtStart, tasksNow, percentOfCore),
      }

      windowStart = at
      cpuAtStart = cpuNow
      tasksAtStart = tasksNow
      return reading
    },
  }
}

/**
 * The worker share, or `null`.
 *
 * Every way this can fail to be a reading returns `null`: either snapshot
 * missing, no thread scheduled at all across the window (a share of nothing is
 * not zero percent — it is no measurement), or a delta that went BACKWARDS,
 * which means the thread set changed under us and the subtraction describes
 * nothing real.
 */
function shareOfWorkers(
  before: readonly TaskTicks[] | null,
  after: readonly TaskTicks[] | null,
  percentOfCore: number,
): V8WorkerCpu | null {
  if (before === null || after === null) return null
  const b = sum(before)
  const a = sum(after)
  const workerTicks = a.worker - b.worker
  const totalTicks = a.total - b.total
  if (workerTicks < 0 || totalTicks <= 0 || workerTicks > totalTicks) return null
  return {
    percentOfCore: round1(percentOfCore * (workerTicks / totalTicks)),
    threads: a.workerThreads,
  }
}

interface TickSums {
  readonly worker: number
  readonly total: number
  readonly workerThreads: number
}

const V8_WORKER_COMM = 'V8Worker'

function sum(tasks: readonly TaskTicks[]): TickSums {
  let worker = 0
  let total = 0
  let workerThreads = 0
  for (const t of tasks) {
    total += t.ticks
    if (t.comm === V8_WORKER_COMM) {
      worker += t.ticks
      workerThreads += 1
    }
  }
  return { worker, total, workerThreads }
}

function round1(n: number): number {
  return Math.round(n * 10) / 10
}

/**
 * Per-thread ticks for THIS process, or `null` where that cannot be read.
 *
 * `/proc/self/task/<tid>/stat` is `pid (comm) state ppid …`, and `comm` may
 * itself contain spaces and parentheses — so the split is on the LAST `)`,
 * never on whitespace. `utime` and `stime` are the 12th and 13th fields after
 * it. Everything that can fail is inside the try: a non-Linux platform, a
 * container with `hidepid`, a thread that exits between the readdir and the
 * read. A thread that vanishes mid-scan is skipped rather than failing the
 * whole reading — it contributed to neither snapshot's total.
 */
export function readSelfTaskTicks(): readonly TaskTicks[] | null {
  try {
    const tids = readdirSync('/proc/self/task')
    const out: TaskTicks[] = []
    for (const tid of tids) {
      const parsed = parseTaskStat(tid)
      if (parsed !== null) out.push(parsed)
    }
    return out.length === 0 ? null : out
  } catch {
    return null
  }
}

function parseTaskStat(tid: string): TaskTicks | null {
  try {
    const raw = readFileSync(`/proc/self/task/${tid}/stat`, 'utf8')
    const close = raw.lastIndexOf(') ')
    const open = raw.indexOf(' (')
    if (close < 0 || open < 0 || close <= open) return null
    const comm = raw.slice(open + 2, close)
    const fields = raw.slice(close + 2).split(' ')
    // After `comm`: state(0) ppid(1) … utime(11) stime(12).
    const utime = Number(fields[11])
    const stime = Number(fields[12])
    if (!Number.isFinite(utime) || !Number.isFinite(stime)) return null
    return { comm, ticks: utime + stime }
  } catch {
    return null
  }
}

/**
 * The two fields, APPENDED LAST on the `[mem]` line — after everything D446,
 * D456 and D458 appended, so every Loki prefix written since 2026-08-29 still
 * matches (D446's rule).
 *
 * `procCpu` prints whenever there is a window, including at 0.0 %, because an
 * idle process is a reading and it is the one that says a runner is alive and
 * doing nothing. `v8WorkerCpu` is CONDITIONAL and its absence is the reading:
 * the platform could not be asked. It carries its thread count because "36.6 %
 * over four threads" and "36.6 % on one" are different faults.
 */
export function formatProcessCpu(reading: ProcessCpuReading | null | undefined): string {
  if (reading === null || reading === undefined) return ''
  const workers = reading.v8Workers
  return (
    ` procCpu=${reading.percentOfCore.toFixed(1)}%` +
    (workers === null
      ? ''
      : ` v8WorkerCpu=${workers.percentOfCore.toFixed(1)}%/${workers.threads}thr`)
  )
}
