/**
 * Per-process CPU split: the process's OWN threads vs V8's helper-thread pool.
 *
 * ## Why this exists
 *
 * `ps pcpu` — the number every CPU column in this app renders today — is the
 * process's CPU averaged over its **entire lifetime**. On a runner that has
 * been up for three days it barely moves, which makes it useless as a series:
 * a chart drawn from it is a flat line that cannot show a spike.
 *
 * Worse, a single total hides the finding that rewrote the 2026-08-27
 * diagnosis. Separating the V8 helper threads from the rest showed that ~2
 * whole cores of the container **were not computing** — hub-main was at 73%
 * and `stream-broker` at 61% of their CPU in that pool
 * (`docs/architecture/load-ledger.md`). A CPU chart that does not split the
 * two renders "busy" where the truth is "allocating too much".
 *
 * This module produces both at once, from the source the ledger prescribes:
 * a delta over `/proc/<pid>/task/<tid>/stat`, classified by thread name.
 *
 * ## What `gcPercent` actually contains — read this before quoting it
 *
 * It is the CPU of the threads V8 names `V8Worker`: its platform worker pool.
 * Concurrent marking and sweeping run there, and so does background
 * compilation. So `gcPercent` is **"the V8 helper pool"**, of which GC is the
 * dominant but not the only tenant. It is exactly the quantity the load ledger
 * measured — the 73% / 61% figures are this number — and it is reported under
 * that name for continuity, not because every jiffy in it is a collection.
 * The UI labels it `GC / V8 helpers` for the same reason.
 *
 * ## Cost
 *
 * One `readdir` plus one small `read` per thread, for the camstack-shaped pids
 * ONLY — on a busy node that is ~10 processes × ~10-40 threads. It rides the
 * existing 20 s process-snapshot tick and never adds a timer of its own, so it
 * is strictly cheaper than the full-process-table `ps -eo` scan that tick
 * already pays. There is no high-frequency sampler here; that is the defect
 * the load ledger documents.
 *
 * ## Linux only
 *
 * `/proc/<pid>/task` does not exist on macOS or Windows. Every read returns
 * `null` there, and `null` must reach the UI as "unknown" — never as zero.
 */
import { readFile, readdir } from 'node:fs/promises'

/**
 * Kernel jiffies per second (`USER_HZ`). `sysconf(_SC_CLK_TCK)` is not exposed
 * to Node, and this has been 100 on every Linux/x86-64 and arm64 kernel
 * configuration we ship to. It scales both numerator and denominator of the
 * ratio identically, so a wrong value would scale all CPU numbers by a
 * constant — visible immediately, not a silent skew.
 */
const CLOCK_TICKS_PER_SEC = 100

/**
 * Thread names V8 gives its platform worker pool. `comm` is capped at 15
 * characters by the kernel, which is why this matches a PREFIX.
 */
const V8_HELPER_THREAD_RE = /^V8Worker/

/** Raw tick counts for one process at one instant, already classified. */
export interface ThreadTickSample {
  /** Sum of utime+stime over threads that are NOT in the V8 helper pool. */
  readonly mainTicks: number
  /** Sum of utime+stime over the V8 helper-pool threads. */
  readonly gcTicks: number
  /** Number of threads seen, both classes together. */
  readonly threadCount: number
  /** `Date.now()` at the moment the sample was taken. */
  readonly atMs: number
  /**
   * The process's `starttime` (field 22 of `/proc/<pid>/stat`) — jiffies since
   * boot at which THIS incarnation of the pid began. Read from the main
   * thread, whose tid equals the pid.
   *
   * It is the process's identity, and it is the only thing that distinguishes
   * "the same process, later" from "a different process that got the same pid".
   * `null` when the main thread's stat could not be read, which is also
   * treated as "identity unknown" — see {@link cpuSplitBetween}.
   */
  readonly startTicks: number | null
}

/** The CPU split over the window between two {@link ThreadTickSample}s. */
export interface ThreadCpuSplit {
  /** CPU% of the process's own threads. 100 = one core saturated. */
  readonly mainPercent: number
  /** CPU% of the V8 helper pool — see the module docblock on what this holds. */
  readonly gcPercent: number
  /** Threads seen in the newer sample. */
  readonly threadCount: number
}

/**
 * Parse one `/proc/<pid>/task/<tid>/stat` line.
 *
 * The `comm` field is field 2 and is wrapped in parentheses — and it can
 * itself contain spaces and parentheses (`(V8Worker)`, but also
 * `(some (weird) name)`). Splitting the line on whitespace therefore corrupts
 * every field after it. The only correct parse is to cut at the LAST `)`, take
 * `comm` from inside the parens, and index the remaining fields from there:
 * after the cut, field 3 (`state`) is index 0, so `utime` (field 14) is index
 * 11 and `stime` (field 15) is index 12.
 *
 * `starttime` is field 22, so index 19 by the same arithmetic. It is the
 * thread's own start, which for the main thread (tid == pid) is the PROCESS's
 * start — the identity {@link cpuSplitBetween} checks before it believes a
 * window belongs to the process it belonged to last time.
 *
 * Returns `null` for a line that does not parse — a thread that exited between
 * the readdir and the read leaves a truncated or empty file, and that is
 * normal, not an error.
 */
export interface ParsedThreadStat {
  readonly comm: string
  readonly ticks: number
  /** Field 22 (`starttime`), in jiffies since boot. */
  readonly startTicks: number
}

export function parseThreadStat(line: string): ParsedThreadStat | null {
  const close = line.lastIndexOf(')')
  const open = line.indexOf('(')
  if (close < 0 || open < 0 || close < open) return null
  const comm = line.slice(open + 1, close)
  const rest = line
    .slice(close + 1)
    .trim()
    .split(/\s+/)
  const utime = Number(rest[11])
  const stime = Number(rest[12])
  const startTicks = Number(rest[19])
  if (!Number.isFinite(utime) || !Number.isFinite(stime)) return null
  if (!Number.isFinite(startTicks)) return null
  return { comm, ticks: utime + stime, startTicks }
}

/** Injectable procfs surface — the whole reason this module is testable. */
export interface ProcFsReader {
  readonly listTaskIds: (pid: number) => Promise<readonly string[]>
  readonly readTaskStat: (pid: number, tid: string) => Promise<string>
}

export const nodeProcFsReader: ProcFsReader = {
  listTaskIds: (pid) => readdir(`/proc/${pid}/task`),
  readTaskStat: (pid, tid) => readFile(`/proc/${pid}/task/${tid}/stat`, 'utf8'),
}

/**
 * Read one instant's tick counts for `pid`, or `null` when the process has no
 * readable `/proc/<pid>/task` — it exited, we lack permission, or this is not
 * Linux. `null` is "unknown"; it must never be turned into a zero downstream.
 */
export async function readThreadTicks(
  pid: number,
  reader: ProcFsReader = nodeProcFsReader,
): Promise<ThreadTickSample | null> {
  let tids: readonly string[]
  try {
    tids = await reader.listTaskIds(pid)
  } catch {
    return null
  }
  let mainTicks = 0
  let gcTicks = 0
  let threadCount = 0
  let startTicks: number | null = null
  const mainThreadTid = String(pid)
  for (const tid of tids) {
    let line: string
    try {
      line = await reader.readTaskStat(pid, tid)
    } catch {
      // The thread exited between the readdir and this read. Skipping it
      // under-counts by that thread's ticks for one window, which is a far
      // smaller error than dropping the whole process's sample.
      continue
    }
    const parsed = parseThreadStat(line)
    if (parsed === null) continue
    threadCount += 1
    // The MAIN thread's start is the process's start. Deliberately not the
    // minimum over all threads: if the main thread's read fails, the minimum
    // over the survivors moves between ticks on a process that merely spawned
    // and reaped a worker, and every such window would be discarded as a fake
    // recycle.
    if (tid === mainThreadTid) startTicks = parsed.startTicks
    if (V8_HELPER_THREAD_RE.test(parsed.comm)) gcTicks += parsed.ticks
    else mainTicks += parsed.ticks
  }
  if (threadCount === 0) return null
  return { mainTicks, gcTicks, threadCount, atMs: Date.now(), startTicks }
}

/**
 * The CPU split between two samples of the SAME process.
 *
 * Returns `null` — never a zero — when the window cannot produce a rate:
 *  - the two samples are not separated in time (no window to divide by);
 *  - the pid's `starttime` changed, or is unknown on either side. A changed
 *    starttime means the pid was RECYCLED: this is a different process that
 *    happens to wear the same number. See below for why the tick check alone
 *    does not catch it;
 *  - either tick count went BACKWARDS, which is the same fault seen from the
 *    other side. A negative delta divided by a window would render as a
 *    plausible small number for the wrong process, and a plausible wrong
 *    number is the failure this whole surface exists to avoid.
 *
 * ## Why `starttime` and not just the backwards-tick check
 *
 * The backwards check only fires when the NEW process has burned FEWER ticks
 * than the dead one had. A recycled pid landing on a busier process — an
 * ffmpeg that has been transcoding for a minute inheriting the pid of an
 * ffmpeg that idled — produces a large POSITIVE delta, which divides cleanly
 * and renders as a spike. That is not a hypothetical rounding concern now that
 * the process snapshot attributes each pid to a camera: it would charge one
 * camera for another camera's whole lifetime of CPU, in a chart built
 * specifically to answer "why is 102 worse than 101". `starttime` is the pid's
 * incarnation number and it catches both directions.
 */
export function cpuSplitBetween(
  prev: ThreadTickSample,
  next: ThreadTickSample,
): ThreadCpuSplit | null {
  const windowMs = next.atMs - prev.atMs
  if (windowMs <= 0) return null
  // Unknown identity is not "probably the same process". A window whose two
  // ends cannot be proven to belong to one incarnation is reported as unknown,
  // which the UI renders as a gap — never as a number.
  if (prev.startTicks === null || next.startTicks === null) return null
  if (prev.startTicks !== next.startTicks) return null
  const mainDelta = next.mainTicks - prev.mainTicks
  const gcDelta = next.gcTicks - prev.gcTicks
  if (mainDelta < 0 || gcDelta < 0) return null
  const windowTicks = (windowMs / 1000) * CLOCK_TICKS_PER_SEC
  const pct = (delta: number): number => Math.round((delta / windowTicks) * 1000) / 10
  return {
    mainPercent: pct(mainDelta),
    gcPercent: pct(gcDelta),
    threadCount: next.threadCount,
  }
}

/**
 * Keeps the previous tick sample per pid so the next process-snapshot tick can
 * turn it into a rate.
 *
 * Bounded by construction: {@link sample} replaces the whole map with only the
 * pids it was just asked about, so a pid that stops appearing in the scan is
 * dropped on the following tick rather than accumulating forever.
 */
export class ThreadCpuTracker {
  private previous = new Map<number, ThreadTickSample>()

  constructor(private readonly reader: ProcFsReader = nodeProcFsReader) {}

  /**
   * Sample `pids` and return the split for each one that HAS a usable previous
   * sample. A pid absent from the result has no answer yet — the caller must
   * report `null`, not `0`.
   */
  async sample(pids: readonly number[]): Promise<ReadonlyMap<number, ThreadCpuSplit>> {
    const out = new Map<number, ThreadCpuSplit>()
    const nextPrevious = new Map<number, ThreadTickSample>()
    for (const pid of pids) {
      const next = await readThreadTicks(pid, this.reader)
      if (next === null) continue
      nextPrevious.set(pid, next)
      const prev = this.previous.get(pid)
      if (prev === undefined) continue
      const split = cpuSplitBetween(prev, next)
      if (split !== null) out.set(pid, split)
    }
    this.previous = nextPrevious
    return out
  }
}
