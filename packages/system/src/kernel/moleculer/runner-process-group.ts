/**
 * A runner OWNS a process group, and the kernel reaps it on every runner exit (D668).
 *
 * ## Why
 *
 * An addon-runner spawns long-lived children: recorder ffmpeg writers, stream-broker
 * ffmpeg, llama-server, tailscaled, cloudflared, HAP ffmpeg. Their only kill was the
 * addon's own graceful `stop()`, which a runner that dies of SIGABRT (V8 OOM), SIGKILL
 * or a native crash never runs. ffmpeg ignores SIGPIPE and does not quit on stdin EOF,
 * so a dead reader does not stop it either. On 2026-09-28 at 10:21 CEST the hub's
 * recorder runner aborted; 28 ffmpeg writers survived as orphans and kept writing into
 * the SAME staging directories the respawned runner's 28 new writers used — 13 minutes
 * of dual writers on every camera, until they were killed by hand.
 *
 * Runners were spawned `detached: false`, i.e. inside hub-main's own group, so there
 * was no handle meaning "this runner and everything under it". Now every runner is
 * spawned `detached: true` on POSIX, which makes it a SESSION and group leader
 * (`setsid`): pgid === runner pid, and every descendant that does not itself call
 * `setsid`/`setpgid` inherits that group. A process group outlives its leader, so
 * `kill(-pgid)` still reaches the orphans after the runner is gone — which is exactly
 * the moment it matters.
 *
 * ## What `detached` does NOT change
 *
 * - The child stays REF'd: nothing calls `unref()`, so the parent still waits on it,
 *   still gets its `exit`, still reads its stdout/stderr pipes.
 * - `process.ppid` is unchanged, so the runner can detect a lost parent before or
 *   after READY and hard-stop its own group.
 * - UDS/stdio wiring is fd-based and independent of the session.
 *
 * What it DOES change: the runner is no longer in hub-main's group, so a signal sent to
 * hub-main's group (`kill -- -<pid>` in `server/backend/src/main.ts`, a terminal Ctrl+C)
 * no longer reaches runners by itself. `signalAllRunnerGroups` is the replacement, and
 * the process `exit` backstop below hard-stops any groups a hub/agent still owns.
 *
 * ## Out of scope, deliberately
 *
 * - Windows has no process groups in this sense; nothing here runs on `win32` and the
 *   runner is spawned exactly as before.
 * - A descendant that calls `setsid`/`setpgid` itself (or is spawned `detached: true`
 *   by an addon) leaves the group and is NOT reaped. No shipped addon does; one that
 *   needs to must own its child's lifetime some other way.
 * - The kernel knows the runner id, not which device a child served. Per-device
 *   attribution is the addon's (the recorder's own foreign-writer reap, D667).
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { nodeProcReader, parseProcStat, type ProcReader } from '../../process/proc-stat.js'

const execFileAsync = promisify(execFile)

/** SIGTERM → SIGKILL grace for a runner's group, in ms. ffmpeg finalises a segment well inside it. */
export const RUNNER_GROUP_REAP_GRACE_MS = 2_000
/** How often the group is probed for emptiness during the grace. */
const GROUP_PROBE_INTERVAL_MS = 100

/** Whether a runner is spawned as a process-group leader on this platform. */
export function runnerOwnsProcessGroup(platform: NodeJS.Platform = process.platform): boolean {
  return platform !== 'win32'
}

/** One live (non-zombie) member of a process group. */
export interface GroupMember {
  readonly pid: number
  /** Executable name (`ffmpeg`, `llama-server`, …). */
  readonly command: string
}

/**
 * The OS surface a group reap needs. Injectable so a unit test never signals a real pid:
 * the fake-spawn suites hand out pids like 70001, and a `kill(-70001)` on a developer's
 * machine is not a test.
 */
export interface ProcessGroupOps {
  /** `process.kill`. A negative pid addresses a group; signal 0 probes. Throws ESRCH when empty. */
  readonly kill: (pid: number, signal: NodeJS.Signals | 0) => void
  /** Live members of `pgid`, or `null` when the table could not be read. */
  readonly listMembers: (pgid: number) => Promise<readonly GroupMember[] | null>
  readonly sleep: (ms: number) => Promise<void>
  readonly graceMs: number
}

/** What one reap did. `membersAtExit === null` means the table was unreadable, not empty. */
export interface GroupReapResult {
  readonly pgid: number
  readonly membersAtExit: readonly GroupMember[] | null
  /** Members still present after the grace, which were sent SIGKILL. */
  readonly killed: readonly GroupMember[] | null
  /** The group was already empty when the reap began — the normal case after a clean stop. */
  readonly alreadyEmpty: boolean
  /** A signal the OS refused for a reason other than ESRCH (EPERM). */
  readonly error: string | null
}

function errnoOf(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined
  const code: unknown = Reflect.get(err, 'code')
  return typeof code === 'string' ? code : undefined
}

type SignalOutcome = 'delivered' | 'empty' | { readonly error: string }

function signalGroup(
  ops: ProcessGroupOps,
  pgid: number,
  signal: NodeJS.Signals | 0,
): SignalOutcome {
  try {
    ops.kill(-pgid, signal)
    return 'delivered'
  } catch (err) {
    // ESRCH: nobody left in the group. That is the NORMAL outcome, not an error.
    if (errnoOf(err) === 'ESRCH') return 'empty'
    return {
      error: `${errnoOf(err) ?? 'unknown'}: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

function signalPid(ops: ProcessGroupOps, pid: number): SignalOutcome {
  try {
    ops.kill(pid, 0)
    return 'delivered'
  } catch (err) {
    return errnoOf(err) === 'ESRCH' ? 'empty' : { error: errnoOf(err) ?? 'unknown' }
  }
}

/**
 * A pgid this module may address. `kill(-1)` signals every process the caller may
 * signal and `kill(-0)` is the caller's OWN group — both are catastrophes, not reaps.
 */
function isAddressableGroup(pgid: number): boolean {
  return Number.isInteger(pgid) && pgid > 1 && pgid !== process.pid
}

/**
 * SIGTERM the whole group, wait up to `graceMs` for it to empty, SIGKILL what is left.
 *
 * pid reuse: POSIX never hands out a pid while a process group with that id exists, so
 * the SIGTERM always lands on our group. The SIGKILL is sent only when the group is
 * still populated at the end of the grace, which is the same group; the residual window
 * (group empties, the pid wraps around AND is reused as a new group leader, all inside
 * the grace) is not reachable in practice.
 */
export async function reapProcessGroup(
  pgid: number,
  ops: ProcessGroupOps,
): Promise<GroupReapResult> {
  if (!isAddressableGroup(pgid)) {
    return {
      pgid,
      membersAtExit: null,
      killed: null,
      alreadyEmpty: true,
      error: `refused pgid ${pgid}`,
    }
  }
  const membersAtExit = await ops.listMembers(pgid)
  const term = signalGroup(ops, pgid, 'SIGTERM')
  if (term === 'empty') {
    return { pgid, membersAtExit, killed: [], alreadyEmpty: true, error: null }
  }
  if (typeof term === 'object') {
    return { pgid, membersAtExit, killed: null, alreadyEmpty: false, error: term.error }
  }
  for (let waited = 0; waited < ops.graceMs; waited += GROUP_PROBE_INTERVAL_MS) {
    await ops.sleep(Math.min(GROUP_PROBE_INTERVAL_MS, ops.graceMs - waited))
    if (signalGroup(ops, pgid, 0) === 'empty') {
      return { pgid, membersAtExit, killed: [], alreadyEmpty: false, error: null }
    }
  }
  // Still populated after the grace: SIGKILL at once — a second table read here cost
  // 100–300 ms of `ps` on macOS while the deaf child kept writing. Who is being killed
  // is answered from the snapshot, one signal-0 probe per member (a zombie answers it
  // too, so this can over-count by a process init has not reaped yet; never under).
  const survivors =
    membersAtExit === null
      ? null
      : membersAtExit.filter((m) => signalPid(ops, m.pid) === 'delivered')
  const kill = signalGroup(ops, pgid, 'SIGKILL')
  return {
    pgid,
    membersAtExit,
    killed: kill === 'empty' ? [] : survivors,
    alreadyEmpty: false,
    error: typeof kill === 'object' ? kill.error : null,
  }
}

/** `ffmpeg×28 llama-server×1` — what a reap line says it removed. */
export function summarizeMembers(members: readonly GroupMember[]): string {
  const counts = new Map<string, number>()
  for (const m of members) counts.set(m.command, (counts.get(m.command) ?? 0) + 1)
  return [...counts.entries()].map(([command, n]) => `${command}×${n}`).join(' ')
}

// ── Reading a group's members ────────────────────────────────────────────────

async function listMembersFromProc(
  pgid: number,
  reader: ProcReader,
): Promise<readonly GroupMember[]> {
  const pids = await reader.listPids()
  const rows = await Promise.all(
    pids.map(async (pid) => {
      try {
        return parseProcStat(await reader.readStat(pid))
      } catch {
        return null // exited between the readdir and the read
      }
    }),
  )
  return rows.flatMap((row) =>
    row !== null && row.pgid === pgid && row.state !== 'Z'
      ? [{ pid: row.pid, command: row.comm }]
      : [],
  )
}

const PS_GROUP_ROW_RE = /^(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/

/** Parse `ps -A -o pid=,pgid=,stat=,comm=` for one group, zombies excluded. */
export function parsePsGroupMembers(stdout: string, pgid: number): readonly GroupMember[] {
  const members: GroupMember[] = []
  for (const line of stdout.split('\n')) {
    const match = line.trim().match(PS_GROUP_ROW_RE)
    if (!match) continue
    const [, pidS, pgidS, stat = '', comm = ''] = match
    if (Number(pgidS) !== pgid || stat.startsWith('Z')) continue
    const command = comm.trim()
    members.push({ pid: Number(pidS), command: command.slice(command.lastIndexOf('/') + 1) })
  }
  return members
}

async function listMembersFromPs(pgid: number): Promise<readonly GroupMember[]> {
  const { stdout } = await execFileAsync('ps', ['-A', '-o', 'pid=,pgid=,stat=,comm='], {
    timeout: 3_000,
    maxBuffer: 8 * 1024 * 1024,
  })
  return parsePsGroupMembers(stdout, pgid)
}

/** Live members of `pgid`: `/proc` on Linux, `ps` elsewhere; `null` when neither answers. */
export async function listProcessGroupMembers(
  pgid: number,
  platform: NodeJS.Platform = process.platform,
): Promise<readonly GroupMember[] | null> {
  try {
    return platform === 'linux'
      ? await listMembersFromProc(pgid, nodeProcReader)
      : await listMembersFromPs(pgid)
  } catch {
    return null
  }
}

export const defaultProcessGroupOps: ProcessGroupOps = {
  kill: (pid, signal) => {
    process.kill(pid, signal)
  },
  listMembers: (pgid) => listProcessGroupMembers(pgid),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  graceMs: RUNNER_GROUP_REAP_GRACE_MS,
}

// ── Groups this process owns: the main-process exit backstop ─────────────────

interface OwnedGroup {
  readonly runnerId: string
  readonly kill: ProcessGroupOps['kill']
}

/**
 * Every runner group this process leads and has not finished reaping. Process-wide on
 * purpose: `process.on('exit')` and hub-main's signal handler must reach the groups of
 * every `$process` service in the process, and neither holds a service reference.
 */
const ownedGroups = new Map<number, OwnedGroup>()
let exitBackstopInstalled = false

function installExitBackstop(): void {
  if (exitBackstopInstalled) return
  exitBackstopInstalled = true
  // `exit` handlers must be synchronous: no grace and no later escalation are possible.
  // Anything still registered here therefore gets SIGKILL. SIGTERM was insufficient:
  // when the launcher called `process.exit()` its live runners received TERM, but a
  // TERM-deaf grandchild could outlive both the runner and the process that was meant
  // to escalate. Normal broker shutdown reaps groups before this last-resort hook runs.
  process.on('exit', () => {
    for (const [pgid, group] of ownedGroups) {
      try {
        group.kill(-pgid, 'SIGKILL')
      } catch {
        /* ESRCH: already empty */
      }
    }
  })
}

export function registerRunnerGroup(pgid: number, group: OwnedGroup): void {
  if (!isAddressableGroup(pgid)) return
  ownedGroups.set(pgid, group)
  installExitBackstop()
}

export function releaseRunnerGroup(pgid: number): void {
  ownedGroups.delete(pgid)
}

/**
 * Signal every runner group this process owns, synchronously. Hub-main's SIGTERM/SIGINT
 * handler calls it: before D668 the runners were in hub-main's own group and its
 * `kill -- -<pid>` reached them and their children; now each is its own group.
 * Returns how many groups were signalled.
 */
export function signalAllRunnerGroups(signal: NodeJS.Signals): number {
  beginRunnerShutdown()
  let signalled = 0
  for (const [pgid, group] of ownedGroups) {
    try {
      group.kill(-pgid, signal)
      signalled += 1
    } catch {
      /* ESRCH: already empty */
    }
  }
  return signalled
}

/**
 * Set once this process has begun an ORDERLY shutdown (hub-main's SIGTERM/SIGINT
 * handler, through {@link signalAllRunnerGroups}, which signals every runner
 * BEFORE the broker stops the process service). A runner that exits after this point is part of the
 * shutdown, not a crash: its exit is INFO and it is never respawned. Without it
 * a clean hub stop logged `ERROR Process exited (code=0)` once per runner and
 * scheduled a respawn into the dying node (CT200, 2026-10-23).
 */
let runnerShutdownInProgress = false

export function beginRunnerShutdown(): void {
  runnerShutdownInProgress = true
}

export function isRunnerShutdownInProgress(): boolean {
  return runnerShutdownInProgress
}

/** Test seam: forget a shutdown a previous case began (one process hosts every spec). */
export function resetRunnerShutdownForTests(): void {
  runnerShutdownInProgress = false
}

/** Test seam: the groups currently owned, by pgid. */
export function ownedRunnerGroupIds(): readonly number[] {
  return [...ownedGroups.keys()]
}

export interface RunnerParentDeathWatchdogOptions {
  readonly initialPpid?: number
  readonly readPpid?: () => number
  readonly intervalMs?: number
}

/**
 * Arm the runner's parent-death watchdog before addon code starts loading.
 *
 * A parent can die while an addon module or `initialize()` is still pending, so
 * installing this only after READY leaves exactly the boot window where a detached
 * runner can become an orphan. Any PPID change means the direct parent died and the
 * kernel reparented us; checking for a change also covers a non-PID-1 subreaper.
 */
export function startRunnerParentDeathWatchdog(
  onParentDeath: () => void,
  options: RunnerParentDeathWatchdogOptions = {},
): NodeJS.Timeout | null {
  const initialPpid = options.initialPpid ?? process.ppid
  if (!Number.isInteger(initialPpid) || initialPpid <= 1) return null
  const readPpid = options.readPpid ?? (() => process.ppid)
  const intervalMs = options.intervalMs ?? 5_000
  let fired = false
  const timer = setInterval(() => {
    if (fired || readPpid() === initialPpid) return
    fired = true
    clearInterval(timer)
    onParentDeath()
  }, intervalMs)
  return timer
}

/**
 * Last resort for a detached runner whose direct parent disappeared without an
 * `exit` hook (SIGKILL, native crash). The runner's own pid is also its pgid, so
 * one SIGKILL removes the runner and every descendant in that group atomically.
 *
 * Calling `kill(-process.pid, ...)` from an ordinary, non-group-leading process
 * returns ESRCH: while this pid exists, no unrelated process group can have the
 * same id. That makes the failed call a safe compatibility fallback for an older
 * parent that did not spawn the runner detached.
 */
export function killOwnRunnerGroupAfterParentLoss(
  platform: NodeJS.Platform = process.platform,
  kill: ProcessGroupOps['kill'] = (target, signal) => {
    process.kill(target, signal)
  },
): boolean {
  const pid = process.pid
  if (!runnerOwnsProcessGroup(platform) || !Number.isInteger(pid) || pid <= 1) return false
  try {
    kill(-pid, 'SIGKILL')
    return true
  } catch {
    return false
  }
}
