/**
 * The runner keeps its wal-index lock while the checkpoint worker runs (D679).
 *
 * The live failure, 2026-09-12 → 2026-09-29: `hub/sqlite-settings` died with
 * SIGBUS 6–92 minutes after every open of its database by another process
 * (the 03:00 backup). The checkpoint worker read the `-shm` header with
 * `openSync`/`readSync`/`closeSync` once a second, and a POSIX `close()`
 * drops every fcntl lock the PROCESS holds on that file — SQLite's DMS lock
 * on `-shm` byte 128 included. The next process to open the database then
 * believed it was the first, truncated and rebuilt the `-shm`, and the
 * runner's next write past a wal-index region boundary touched a mapped page
 * beyond end-of-file.
 *
 * This is that sequence with real processes: a child shaped like the runner
 * (`support/shm-lock-holder.mjs`) runs the REAL worker thread over an idle
 * database, THIS process opens it once (the backup), and the child then
 * writes a burst. With the lock kept, the second open sees a live wal-index,
 * the `-shm` is left alone and the child survives. Disarmed by putting the
 * `-shm` open/close back in the worker's tick, the `-shm` shrinks to one
 * region at the second open and the child dies with SIGBUS.
 */
import { spawn } from 'node:child_process'
import { promises as fs, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'

const HOLDER = fileURLToPath(new URL('./support/shm-lock-holder.mjs', import.meta.url))
const WORKER_SOURCE = fileURLToPath(new URL('../wal-checkpoint-worker.ts', import.meta.url))

interface ChildOutcome {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
}

const tmpDirs: string[] = []
afterEach(async () => {
  for (const d of tmpDirs.splice(0)) await fs.rm(d, { recursive: true, force: true })
})

/** What the backup used to do from hub-main: one connection, a read, a PASSIVE, close. */
function openOnceFromAnotherProcess(dbPath: string): void {
  const other = new Database(dbPath)
  try {
    other.prepare('SELECT count(*) AS n FROM t').get()
    other.pragma('wal_checkpoint(PASSIVE)')
  } finally {
    other.close()
  }
}

describe('the runner keeps its -shm lock while the checkpoint worker runs', () => {
  it('a second process opening the database does not rebuild the wal-index under the runner', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shm-lock-'))
    tmpDirs.push(dir)
    const dbPath = path.join(dir, 'camstack.db')
    const shmPath = `${dbPath}-shm`

    const child = spawn(process.execPath, [HOLDER, dbPath, WORKER_SOURCE, '20', '400'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    let survived = false
    const exited = new Promise<ChildOutcome>((resolve) => {
      child.once('exit', (code, signal) => resolve({ code, signal }))
    })

    const out = createInterface({ input: child.stdout })
    let shmBefore = -1
    let shmAfter = -1
    for await (const line of out) {
      if (line === 'READY') {
        shmBefore = statSync(shmPath).size
        openOnceFromAnotherProcess(dbPath)
        shmAfter = statSync(shmPath).size
        child.stdin.write('BURST\n')
      } else if (line === 'SURVIVED') {
        survived = true
      }
    }
    const outcome = await exited

    // Three regions were mapped by the runner; the second open must not have
    // truncated the file under them.
    expect(shmBefore).toBeGreaterThanOrEqual(3 * 32_768)
    expect(shmAfter).toBe(shmBefore)
    const stderrWithoutNodeWarnings = stderr
      .replace(
        /^\(node:\d+\) Warning:.*\n(\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)\n)?/gm,
        '',
      )
      .trimEnd()
    expect({
      signal: outcome.signal,
      code: outcome.code,
      survived,
      stderr: stderrWithoutNodeWarnings,
    }).toEqual({
      signal: null,
      code: 0,
      survived: true,
      stderr: '',
    })
  }, 60_000)
})
