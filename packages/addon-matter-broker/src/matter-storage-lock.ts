/**
 * matter.js guards each fabric's storage directory with `matter.lock` + `matter.pid` and treats a
 * recorded pid that is ALIVE as the owner. After a killed runner or a container restart small pids
 * are reused, so the recorded pid is often another process (every addon runner even shares one
 * command line) and the fabric never starts. matter.js already takes over a lock whose pid is
 * gone; this covers the live-but-not-the-owner pid.
 *
 * A pid alone cannot say who owns it, so the owner writes an identity next to the lock
 * (`camstack-owner.json`): its pid, its start time (field 22 of `/proc/<pid>/stat`, clock ticks
 * since boot) and the boot id. The lock is kept only when a live process matches ALL three; a lock
 * with no such record (written before this existed) is stale as well.
 *
 * Without `/proc` (macOS, Electron) nothing is judged and nothing is deleted: the matter.js
 * pid check stays the only one (the existing behaviour, chosen over `process.kill(pid, 0)`
 * because a live pid alone is exactly the signal that proved unreliable).
 */
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { errMsg, type IScopedLogger } from '@camstack/types'

const LOCK_FILE = 'matter.lock'
const PID_FILE = 'matter.pid'
const OWNER_FILE = 'camstack-owner.json'
const BOOT_ID_PATH = '/proc/sys/kernel/random/boot_id'

/** The file access this module needs; a test supplies its own. */
export interface StorageLockFs {
  readText(path: string): Promise<string>
  writeText(path: string, content: string): Promise<void>
  remove(path: string): Promise<void>
}

export const NODE_STORAGE_LOCK_FS: StorageLockFs = {
  readText: (path) => readFile(path, 'utf-8'),
  writeText: async (path, content) => {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, content, 'utf-8')
  },
  remove: (path) => unlink(path),
}

/** What identifies one process for good: a pid is reused, (boot, pid, start time) is not. */
export interface ProcessIdentity {
  readonly pid: number
  readonly startTicks: string
  readonly bootId: string
}

export interface ReclaimStaleLockInput {
  readonly fabricDir: string
  readonly brokerId: string
  readonly selfPid: number
  readonly logger: IScopedLogger
  readonly fs?: StorageLockFs
}

export type ReclaimOutcome = 'none' | 'kept' | 'removed'

function recordedPid(content: string): number | null {
  const pid = Number.parseInt(content.split(' ')[0] ?? '', 10)
  return Number.isFinite(pid) && pid > 0 ? pid : null
}

/** Field 22 of `/proc/<pid>/stat`; the command name (field 2) may hold spaces and parentheses. */
export function startTicksOf(stat: string): string | null {
  const rest = stat
    .slice(stat.lastIndexOf(')') + 1)
    .trim()
    .split(/\s+/)
  const ticks = rest[19]
  return ticks !== undefined && /^\d+$/.test(ticks) ? ticks : null
}

/** The identity of a live process, or null when `/proc` cannot tell (no /proc, or the pid is gone). */
export async function readProcessIdentity(
  fs: StorageLockFs,
  pid: number,
): Promise<ProcessIdentity | null> {
  try {
    const startTicks = startTicksOf(await fs.readText(`/proc/${pid}/stat`))
    if (startTicks === null) return null
    const bootId = (await fs.readText(BOOT_ID_PATH)).trim()
    return bootId === '' ? null : { pid, startTicks, bootId }
  } catch {
    return null
  }
}

function parseOwner(content: string): ProcessIdentity | null {
  try {
    const value: unknown = JSON.parse(content)
    if (typeof value !== 'object' || value === null) return null
    if (!('pid' in value) || typeof value.pid !== 'number') return null
    if (!('startTicks' in value) || typeof value.startTicks !== 'string') return null
    if (!('bootId' in value) || typeof value.bootId !== 'string') return null
    return {
      pid: value.pid,
      startTicks: value.startTicks,
      bootId: value.bootId,
    }
  } catch {
    return null
  }
}

async function readOwner(fs: StorageLockFs, fabricDir: string): Promise<ProcessIdentity | null> {
  try {
    return parseOwner(await fs.readText(join(fabricDir, OWNER_FILE)))
  } catch {
    return null
  }
}

/** Why the recorded pid is not the owner, from the stored identity and the live one; null = it is. */
function staleReason(
  owner: ProcessIdentity | null,
  pid: number,
  live: ProcessIdentity,
): string | null {
  if (owner === null || owner.pid !== pid) return 'no owner identity recorded for this pid'
  if (owner.bootId !== live.bootId) return 'the lock was written before the last boot'
  if (owner.startTicks !== live.startTicks) return 'the pid was reused by another process'
  return null
}

/** Write this process's identity beside the lock so a later start can tell it from a reused pid. */
export async function recordFabricOwner(input: ReclaimStaleLockInput): Promise<void> {
  const fs = input.fs ?? NODE_STORAGE_LOCK_FS
  const self = await readProcessIdentity(fs, input.selfPid)
  if (self === null) {
    input.logger.info('MatterStorageLock: no /proc, fabric owner identity not recorded', {
      tags: { brokerId: input.brokerId },
    })
    return
  }
  try {
    await fs.writeText(join(input.fabricDir, OWNER_FILE), JSON.stringify(self))
  } catch (err: unknown) {
    input.logger.warn('MatterStorageLock: could not record the fabric owner identity', {
      tags: { brokerId: input.brokerId },
      meta: { error: errMsg(err) },
    })
  }
}

/** Remove the fabric's lock files when their recorded pid is not the process that wrote them. */
export async function reclaimStaleFabricLock(
  input: ReclaimStaleLockInput,
): Promise<ReclaimOutcome> {
  const fs = input.fs ?? NODE_STORAGE_LOCK_FS
  const tags = { brokerId: input.brokerId }
  let pid: number | null
  try {
    pid = recordedPid(await fs.readText(join(input.fabricDir, PID_FILE)))
  } catch {
    input.logger.debug('MatterStorageLock: no lock recorded, nothing to reclaim', { tags })
    return 'none'
  }
  if (pid === null || pid === input.selfPid) {
    input.logger.debug('MatterStorageLock: the lock is ours or unreadable, nothing to reclaim', {
      tags,
      meta: { pid },
    })
    return 'none'
  }
  const live = await readProcessIdentity(fs, pid)
  if (live === null) {
    // No /proc, or the recorded process is gone: matter.js judges it.
    input.logger.info('MatterStorageLock: recorded pid not judged here, matter.js decides', {
      tags,
      meta: { pid, why: 'no /proc or the recorded process is gone' },
    })
    return 'none'
  }
  const reason = staleReason(await readOwner(fs, input.fabricDir), pid, live)
  if (reason === null) {
    input.logger.warn('MatterStorageLock: fabric lock kept, its owner is alive', {
      tags,
      meta: { pid, why: 'pid, start time and boot id match a live process' },
    })
    return 'kept'
  }
  try {
    await fs.remove(join(input.fabricDir, LOCK_FILE))
    await fs.remove(join(input.fabricDir, PID_FILE))
  } catch (err: unknown) {
    input.logger.warn('MatterStorageLock: stale lock takeover failed', {
      tags,
      meta: { pid, reason, error: errMsg(err) },
    })
    return 'kept'
  }
  input.logger.warn('MatterStorageLock: took over a stale fabric lock', {
    tags,
    meta: { pid, why: reason },
  })
  return 'removed'
}
