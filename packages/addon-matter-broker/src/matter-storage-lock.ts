/**
 * matter.js guards each fabric's storage directory with `matter.lock` + `matter.pid` and treats a
 * recorded pid that is ALIVE as the owner. After a killed runner the container reuses small pids,
 * so the recorded pid is often an unrelated live process and the fabric never starts. matter.js
 * already takes over a lock whose pid is gone; this covers the live-but-unrelated pid only.
 *
 * The lock stays whenever the recorded process could be a runner of this addon (its command line
 * equals ours). Without `/proc` (macOS, Electron) nothing is judged and nothing is deleted: the
 * matter.js check stays the only one.
 */
import { readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { errMsg, type IScopedLogger } from '@camstack/types'

const LOCK_FILE = 'matter.lock'
const PID_FILE = 'matter.pid'

/** The file reads this module needs; a test supplies its own. */
export interface StorageLockFs {
  readText(path: string): Promise<string>
  remove(path: string): Promise<void>
}

export const NODE_STORAGE_LOCK_FS: StorageLockFs = {
  readText: (path) => readFile(path, 'utf-8'),
  remove: (path) => unlink(path),
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

/** Remove the fabric's lock files when their recorded pid is a live process that is not a runner of ours. */
export async function reclaimStaleFabricLock(
  input: ReclaimStaleLockInput,
): Promise<ReclaimOutcome> {
  const fs = input.fs ?? NODE_STORAGE_LOCK_FS
  let pid: number | null
  try {
    pid = recordedPid(await fs.readText(join(input.fabricDir, PID_FILE)))
  } catch {
    return 'none'
  }
  if (pid === null || pid === input.selfPid) return 'none'
  let own: string
  let theirs: string
  try {
    own = await fs.readText(`/proc/${input.selfPid}/cmdline`)
    theirs = await fs.readText(`/proc/${pid}/cmdline`)
  } catch {
    // No /proc, or the recorded process is gone: matter.js judges it.
    return 'none'
  }
  if (theirs === own) return 'kept'
  try {
    await fs.remove(join(input.fabricDir, LOCK_FILE))
    await fs.remove(join(input.fabricDir, PID_FILE))
  } catch (err: unknown) {
    input.logger.warn('MatterStorageLock: stale lock takeover failed', {
      tags: { brokerId: input.brokerId },
      meta: { pid, error: errMsg(err) },
    })
    return 'kept'
  }
  input.logger.warn('MatterStorageLock: took over a stale fabric lock', {
    tags: { brokerId: input.brokerId },
    meta: { pid, why: 'the recorded pid is a live process that is not a runner of this addon' },
  })
  return 'removed'
}
