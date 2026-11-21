/**
 * A cross-process lock beside a session file. Refresh tokens rotate and the hub
 * revokes a session when a rotated-out token is replayed past its grace window,
 * so two processes must never refresh the same session at once: the second one
 * waits, re-reads the file and uses what the first saved.
 *
 * The lock is a file created with `O_EXCL` (`wx`). A lock older than
 * {@link LOCK_STALE_MS} belongs to a crashed holder and is taken over; the wait
 * is bounded by {@link LOCK_WAIT_MS}.
 */
import * as fs from 'node:fs'

/** Longer than a refresh request (15 s) so a live holder is never taken over. */
export const LOCK_STALE_MS = 30_000
export const LOCK_WAIT_MS = 45_000
const LOCK_POLL_MS = 40

export interface LockOptions {
  readonly staleMs?: number
  readonly waitMs?: number
}

export class LockTimeoutError extends Error {
  constructor(lockFile: string) {
    super(`Timed out waiting for the session lock ${lockFile}`)
    this.name = 'LockTimeoutError'
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isExists(err: unknown): boolean {
  return err instanceof Error && Reflect.get(err, 'code') === 'EEXIST'
}

function takeOverIfStale(lockFile: string, staleMs: number): void {
  try {
    const age = Date.now() - fs.statSync(lockFile).mtimeMs
    if (age > staleMs) fs.rmSync(lockFile, { force: true })
  } catch {
    // released between the failed create and the stat: the next attempt wins it
  }
}

/** Run `fn` holding the exclusive lock `lockFile`; always released, even when `fn` throws. */
export async function withFileLock<T>(
  lockFile: string,
  fn: () => Promise<T>,
  opts: LockOptions = {},
): Promise<T> {
  const staleMs = opts.staleMs ?? LOCK_STALE_MS
  const deadline = Date.now() + (opts.waitMs ?? LOCK_WAIT_MS)
  for (;;) {
    try {
      fs.closeSync(fs.openSync(lockFile, 'wx', 0o600))
      break
    } catch (err) {
      if (!isExists(err)) throw err
      takeOverIfStale(lockFile, staleMs)
      if (Date.now() > deadline) throw new LockTimeoutError(lockFile)
      await sleep(LOCK_POLL_MS)
    }
  }
  try {
    return await fn()
  } finally {
    fs.rmSync(lockFile, { force: true })
  }
}
