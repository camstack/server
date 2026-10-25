/**
 * Read this host's process table — just enough to recognise an ffmpeg writer
 * by its argv — and signal a pid.
 *
 * Both halves sit behind a small named interface so the staging-directory
 * guard (`staging-writer-guard.ts`, D667) can be driven by a fake in a unit
 * test and by the real OS in production, with no cast in between.
 *
 * Linux reads `/proc/<pid>/cmdline` (exact argv, NUL-separated) and
 * `/proc/<pid>/stat` (ppid, start time). macOS has no `/proc`, so it runs
 * `ps -axww -o pid=,ppid=,etime=,command=` — the recorder also runs on the
 * Mac agent. Any other platform gets no lister, and the guard says so.
 */
import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'

/** One process, as far as the table could describe it. */
export interface ListedProcess {
  readonly pid: number
  /** Parent pid; `null` when the table did not say. */
  readonly ppid: number | null
  /**
   * The exact argv, when the platform gives it (Linux). `null` on macOS,
   * where `ps` prints one space-joined string and an argument that contains a
   * space cannot be told apart from two.
   */
  readonly argv: readonly string[] | null
  /** The command line as one string — always present. */
  readonly command: string
  /** How long the process has been running; `null` when it could not be read. */
  readonly ageMs: number | null
}

/**
 * Lists the processes whose command line contains `marker`.
 *
 * Throws when the table cannot be read at all. It never answers "none" for
 * "could not look": an empty list is a table that was read and held no match.
 */
export interface ProcessLister {
  list(marker: string): Promise<readonly ListedProcess[]>
}

/** What sending one signal did. */
export type SignalOutcome = 'sent' | 'gone' | 'denied' | 'failed'

export interface ProcessSignaller {
  send(pid: number, signal: 'SIGTERM' | 'SIGKILL'): SignalOutcome
}

/**
 * Linux `USER_HZ` — the unit of `starttime` in `/proc/<pid>/stat`. It is part
 * of the userspace ABI and 100 on every architecture Linux ships, which is why
 * `procps` itself hard-codes the fallback.
 */
const LINUX_USER_HZ = 100
/** Field index of `starttime` counted from the field AFTER the `(comm)` one. */
const STAT_STARTTIME_INDEX = 19
const STAT_PPID_INDEX = 1
/** `ps` is one short fork; a table that takes longer than this is a sick host. */
const PS_TIMEOUT_MS = 5_000
const PS_MAX_BUFFER = 16 * 1024 * 1024

function errorCode(err: unknown): string | undefined {
  if (err instanceof Error && 'code' in err && typeof err.code === 'string') return err.code
  return undefined
}

/** The two `/proc/<pid>/stat` fields the guard reads. */
export interface LinuxStatFields {
  readonly ppid: number | null
  readonly startTicks: number | null
}

/** `ppid` and `starttime` out of a `/proc/<pid>/stat` body. The `comm` field
 *  may itself contain spaces and parentheses, so fields are counted from the
 *  LAST `)`. */
export function parseLinuxStat(body: string): LinuxStatFields {
  const close = body.lastIndexOf(')')
  if (close < 0) return { ppid: null, startTicks: null }
  const fields = body
    .slice(close + 1)
    .trim()
    .split(/\s+/)
  const ppid = Number(fields[STAT_PPID_INDEX])
  const start = Number(fields[STAT_STARTTIME_INDEX])
  return {
    ppid: Number.isInteger(ppid) ? ppid : null,
    startTicks: Number.isFinite(start) ? start : null,
  }
}

/** The `/proc` reader. `procRoot` is injectable for a test over a fake tree. */
export function createLinuxProcessLister(procRoot = '/proc'): ProcessLister {
  return {
    async list(marker: string): Promise<readonly ListedProcess[]> {
      // The one read that must succeed: without the directory there is no
      // table, and the caller must hear "could not look", never "nobody".
      const entries = await fs.readdir(procRoot)
      const uptimeSec = await fs
        .readFile(`${procRoot}/uptime`, 'utf8')
        .then((body) => Number(body.split(/\s+/)[0]))
        .catch(() => Number.NaN)
      const out: ListedProcess[] = []
      for (const entry of entries) {
        const pid = Number(entry)
        if (!Number.isInteger(pid) || pid <= 0) continue
        let raw: string
        try {
          raw = await fs.readFile(`${procRoot}/${entry}/cmdline`, 'utf8')
        } catch {
          continue // exited between the listing and the read
        }
        // A zombie and a kernel thread have an EMPTY cmdline: neither writes.
        if (raw.length === 0 || !raw.includes(marker)) continue
        const argv = raw.split('\0')
        if (argv[argv.length - 1] === '') argv.pop()
        const stat = await fs
          .readFile(`${procRoot}/${entry}/stat`, 'utf8')
          .then(parseLinuxStat)
          .catch((): LinuxStatFields => ({ ppid: null, startTicks: null }))
        const ageMs =
          stat.startTicks !== null && Number.isFinite(uptimeSec)
            ? Math.max(0, Math.round((uptimeSec - stat.startTicks / LINUX_USER_HZ) * 1000))
            : null
        out.push({ pid, ppid: stat.ppid, argv, command: argv.join(' '), ageMs })
      }
      return out
    },
  }
}

/** `[[dd-]hh:]mm:ss` → ms; `null` for anything else. */
export function parsePsElapsed(etime: string): number | null {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(etime.trim())
  if (match === null) return null
  const [, days, hours, minutes, seconds] = match
  const total =
    Number(days ?? 0) * 86_400 + Number(hours ?? 0) * 3_600 + Number(minutes) * 60 + Number(seconds)
  return total * 1000
}

/** Parse `ps -o pid=,ppid=,etime=,command=` output, keeping lines that contain `marker`. */
export function parsePsTable(stdout: string, marker: string): readonly ListedProcess[] {
  const out: ListedProcess[] = []
  for (const line of stdout.split('\n')) {
    if (!line.includes(marker)) continue
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line)
    if (match === null) continue
    const [, pid, ppid, etime, command] = match
    out.push({
      pid: Number(pid),
      ppid: Number(ppid),
      argv: null,
      command: command ?? '',
      ageMs: parsePsElapsed(etime ?? ''),
    })
  }
  return out
}

/** The macOS (BSD `ps`) reader. `-ww` so a long staging path is never cut. */
export function createPsProcessLister(psPath = 'ps'): ProcessLister {
  return {
    list(marker: string): Promise<readonly ListedProcess[]> {
      return new Promise((resolve, reject) => {
        execFile(
          psPath,
          ['-axww', '-o', 'pid=,ppid=,etime=,command='],
          { timeout: PS_TIMEOUT_MS, maxBuffer: PS_MAX_BUFFER },
          (err, stdout) => {
            if (err) {
              reject(err)
              return
            }
            resolve(parsePsTable(stdout, marker))
          },
        )
      })
    },
  }
}

/** The lister for this platform, or `null` where there is none (Windows). */
export function createProcessLister(
  platform: NodeJS.Platform = process.platform,
): ProcessLister | null {
  if (platform === 'linux') return createLinuxProcessLister()
  if (platform === 'darwin' || platform === 'freebsd' || platform === 'openbsd') {
    return createPsProcessLister()
  }
  return null
}

/** `process.kill`, with the errno turned into an answer instead of a throw. */
export const nodeProcessSignaller: ProcessSignaller = {
  send(pid, signal) {
    try {
      process.kill(pid, signal)
      return 'sent'
    } catch (err: unknown) {
      const code = errorCode(err)
      if (code === 'ESRCH') return 'gone'
      if (code === 'EPERM') return 'denied'
      return 'failed'
    }
  },
}
