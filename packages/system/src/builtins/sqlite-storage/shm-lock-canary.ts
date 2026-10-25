/**
 * Does this process still hold SQLite's DMS lock on its `-shm`? (D679)
 *
 * A WAL connection takes a SHARED fcntl lock on byte 128 of the `-shm` file
 * (`UNIX_SHM_DMS` in `os_unix.c`) and keeps it for its whole life. That lock
 * is how every OTHER process learns that a live connection is using the
 * wal-index: a process that opens the database and can take the byte
 * EXCLUSIVELY concludes it is the first, truncates the `-shm` and rebuilds it.
 * If the owner has lost the lock while still mapping the old regions, its next
 * write past a region boundary is a SIGBUS.
 *
 * The owner lost it on the hub for 17 days (2026-09-12 → 2026-09-29): a
 * `closeSync` on a descriptor of the `-shm` — any descriptor, from any thread
 * of the process — drops every fcntl lock the process holds on that file.
 * `/proc/locks` showed the runner holding its database lock and nothing on the
 * `-shm`, and nothing in the process could see it.
 *
 * This canary is that observation, made by the process about itself: it reads
 * `/proc/locks` (Linux only), finds the `-shm` inode by `stat` — a path
 * lookup, no descriptor — and asks whether a lock owned by this pid covers
 * byte 128. It opens NOTHING of the database's own files: a canary that
 * opened the `-shm` to check the lock would drop it (the guard
 * `scripts/check-sqlite-files-not-opened-by-fs.ts` refuses that shape).
 *
 * It logs a transition, never a heartbeat: INFO the first time the lock is
 * seen held (the line a post-deploy check greps for), WARN when it goes
 * missing, INFO again if it comes back. Elsewhere than Linux it says once that
 * it cannot look, and stops.
 */
import { readFileSync, statSync } from 'node:fs'
import type { IScopedLogger } from '@camstack/types'
import { errMsg } from '@camstack/types'

/** `UNIX_SHM_DMS`: the byte of the `-shm` a live connection holds shared. */
export const SQLITE_SHM_DMS_BYTE = 128

/** How often the canary looks, in ms. One small procfs read. */
export const SHM_LOCK_CANARY_INTERVAL_MS: number = 10 * 60_000

/** One HELD lock from `/proc/locks`. Waiters (`->` lines) are not locks. */
export interface ProcLock {
  readonly pid: number
  /** The inode, as the decimal string procfs prints — never rounded through a double. */
  readonly inode: string
  readonly start: number
  /** `null` = to end of file (`EOF`). */
  readonly end: number | null
}

/**
 * Parse `/proc/locks`. Line shape:
 * `1: POSIX  ADVISORY  READ 3490531 08:31:3769403373 128 128`
 * (`id: TYPE MODE ACCESS PID MAJ:MIN:INODE START END`). A blocked waiter is
 * printed as `1: -> POSIX …` and holds nothing, so it is skipped; a line that
 * does not parse is skipped rather than guessed at.
 */
export function parseProcLocks(text: string): readonly ProcLock[] {
  const locks: ProcLock[] = []
  for (const line of text.split('\n')) {
    const fields = line.trim().split(/\s+/)
    if (fields.length < 8 || fields[1] === '->') continue
    const pid = Number(fields[4])
    const devInode = fields[5]?.split(':')
    const inode = devInode?.[2]
    const start = Number(fields[6])
    const endField = fields[7]
    const end = endField === 'EOF' ? null : Number(endField)
    if (!Number.isInteger(pid) || inode === undefined || !/^\d+$/.test(inode)) continue
    if (!Number.isInteger(start) || (end !== null && !Number.isInteger(end))) continue
    locks.push({ pid, inode, start, end })
  }
  return locks
}

/** Does a lock owned by `pid` on `inode` cover the DMS byte? */
export function holdsDmsLock(locks: readonly ProcLock[], pid: number, inode: string): boolean {
  return locks.some(
    (l) =>
      l.pid === pid &&
      l.inode === inode &&
      l.start <= SQLITE_SHM_DMS_BYTE &&
      (l.end === null || l.end >= SQLITE_SHM_DMS_BYTE),
  )
}

/**
 * `unavailable` = this platform has no `/proc/locks` (said once, then the
 * canary stops). `unreadable` = Linux, but this look failed (the `-shm` absent,
 * procfs unreadable) — a different fact, and on the hub a worrying one.
 */
export type ShmLockState = 'held' | 'missing' | 'unavailable' | 'unreadable'

/** The canary's impure edges, injectable so a spec drives them. */
export interface ShmLockCanaryDeps {
  readonly platform: NodeJS.Platform
  readonly pid: number
  /** The `-shm` inode as a decimal string; throws when the file is absent. */
  readonly shmInode: (shmPath: string) => string
  readonly readProcLocks: () => string
}

const defaultDeps: ShmLockCanaryDeps = {
  platform: process.platform,
  pid: process.pid,
  shmInode: (shmPath) => statSync(shmPath, { bigint: true }).ino.toString(),
  readProcLocks: () => readFileSync('/proc/locks', 'utf8'),
}

export interface ShmLockCanaryOptions {
  readonly dbPath: string
  readonly logger: IScopedLogger
  readonly intervalMs?: number
  readonly deps?: Partial<ShmLockCanaryDeps>
}

export class ShmLockCanary {
  private readonly shmPath: string
  private readonly logger: IScopedLogger
  private readonly intervalMs: number
  private readonly deps: ShmLockCanaryDeps
  private timer: ReturnType<typeof setInterval> | null = null
  private last: ShmLockState | null = null
  private lastError: string | null = null

  constructor(options: ShmLockCanaryOptions) {
    this.shmPath = `${options.dbPath}-shm`
    this.logger = options.logger
    this.intervalMs = options.intervalMs ?? SHM_LOCK_CANARY_INTERVAL_MS
    this.deps = { ...defaultDeps, ...options.deps }
  }

  start(): void {
    if (this.timer !== null) return
    if (this.check() === 'unavailable') return
    const timer = setInterval(() => this.check(), this.intervalMs)
    timer.unref?.()
    this.timer = timer
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
  }

  /** One look. Logs only a change of state. Public for the spec. */
  check(): ShmLockState {
    const state = this.observe()
    if (state !== this.last) this.report(state)
    this.last = state
    return state
  }

  private observe(): ShmLockState {
    if (this.deps.platform !== 'linux') return 'unavailable'
    try {
      const inode = this.deps.shmInode(this.shmPath)
      const locks = parseProcLocks(this.deps.readProcLocks())
      return holdsDmsLock(locks, this.deps.pid, inode) ? 'held' : 'missing'
    } catch (err) {
      this.lastError = errMsg(err)
      return 'unreadable'
    }
  }

  private report(state: ShmLockState): void {
    const meta = { shmPath: this.shmPath, pid: this.deps.pid, byte: SQLITE_SHM_DMS_BYTE }
    switch (state) {
      case 'held':
        this.logger.info('SQLite shm DMS lock held', { meta })
        return
      case 'missing':
        // The failure this canary exists for: the next process that opens
        // the database will rebuild the wal-index under this one (D679).
        this.logger.warn(
          'SQLite shm DMS lock LOST — a second open of the database will rebuild the wal-index under this process (SIGBUS risk, D679)',
          { meta },
        )
        return
      case 'unavailable':
        this.logger.info('SQLite shm DMS lock canary cannot look here', {
          meta: { ...meta, platform: this.deps.platform },
        })
        return
      case 'unreadable':
        this.logger.warn('SQLite shm DMS lock canary could not look', {
          meta: { ...meta, error: this.lastError },
        })
        return
    }
  }
}
