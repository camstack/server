/**
 * The checkpoint runs on the worker, over the real engine (D452).
 *
 * The claim is not "a checkpoint happened" — the engine's auto-checkpoint
 * would make that true on its own. The claim is that the SETTINGS connection
 * never had to fold the WAL itself: with its auto-checkpoint raised to the
 * bound, thousands of frames are written and, when the settings connection
 * finally asks `wal_checkpoint(PASSIVE)`, there is nothing left for it to
 * copy — the worker already did. Disarmed by not starting the worker, the
 * same call reports every frame still pending.
 */
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { IScopedLogger, LogExtras } from '@camstack/types'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { SQLITE_WAL_AUTOCHECKPOINT_BOUND_PAGES } from '../sqlite-pragmas.js'
import { WalCheckpointer } from '../wal-checkpointer.js'

interface LoggedLine {
  readonly level: 'debug' | 'info' | 'warn' | 'error'
  readonly message: string
  readonly extras?: LogExtras
}

function makeLogger(): { logger: IScopedLogger; lines: LoggedLine[] } {
  const lines: LoggedLine[] = []
  const push =
    (level: LoggedLine['level']) =>
    (message: string, extras?: LogExtras): void => {
      lines.push(extras === undefined ? { level, message } : { level, message, extras })
    }
  const logger: IScopedLogger = {
    debug: push('debug'),
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
    child: () => logger,
    withTags: () => logger,
  }
  return { logger, lines }
}

interface CheckpointRow {
  readonly busy: number
  readonly log: number
  readonly checkpointed: number
}

function checkpointRow(value: unknown): CheckpointRow {
  const row = Array.isArray(value) ? value[0] : value
  if (
    typeof row === 'object' &&
    row !== null &&
    'busy' in row &&
    'log' in row &&
    'checkpointed' in row &&
    typeof row.busy === 'number' &&
    typeof row.log === 'number' &&
    typeof row.checkpointed === 'number'
  ) {
    return row
  }
  throw new Error(`not a wal_checkpoint row: ${JSON.stringify(value)}`)
}

const WORKER_SOURCE = fileURLToPath(new URL('../wal-checkpoint-worker.ts', import.meta.url))
/** The thread loads the TypeScript source through tsx; production loads the built entry. */
const WORKER_EXEC_ARGV = ['--import', 'tsx']

const tmpDirs: string[] = []
const openDbs: Database.Database[] = []
const checkpointers: WalCheckpointer[] = []
afterEach(async () => {
  for (const c of checkpointers.splice(0)) await c.stop()
  for (const db of openDbs.splice(0)) {
    try {
      db.close()
    } catch {
      /* already closed */
    }
  }
  for (const d of tmpDirs.splice(0)) await fs.rm(d, { recursive: true, force: true })
})

async function openSettingsConnection(): Promise<{ db: Database.Database; dbPath: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wal-checkpointer-'))
  tmpDirs.push(dir)
  const dbPath = path.join(dir, 'camstack.db')
  const db = new Database(dbPath)
  openDbs.push(db)
  db.pragma('journal_mode = WAL')
  db.pragma(`wal_autocheckpoint = ${SQLITE_WAL_AUTOCHECKPOINT_BOUND_PAGES}`)
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, blob BLOB NOT NULL)')
  return { db, dbPath }
}

/** One row per page: a 3 KiB blob on a 4 KiB page is one frame per insert. */
function writeFrames(db: Database.Database, rows: number): void {
  const insert = db.prepare('INSERT INTO t (blob) VALUES (?)')
  const payload = Buffer.alloc(3 * 1024, 7)
  for (let i = 0; i < rows; i++) insert.run(payload)
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting')
    await new Promise((r) => setTimeout(r, 25))
  }
}

describe('WalCheckpointer over real sqlite', () => {
  it('folds the WAL on the worker so the settings connection finds nothing left to checkpoint', async () => {
    const { db, dbPath } = await openSettingsConnection()
    const { logger } = makeLogger()
    const checkpointer = new WalCheckpointer({
      dbPath,
      logger,
      pollMs: 20,
      maxDelayMs: 200,
      workerPath: WORKER_SOURCE,
      workerExecArgv: WORKER_EXEC_ARGV,
    })
    checkpointers.push(checkpointer)
    checkpointer.start()

    // Well past the 1000-frame threshold, well under the settings
    // connection's own bound: only the worker can have folded these.
    writeFrames(db, 2_500)
    await waitFor(() => checkpointer.stats.checkpoints >= 1, 10_000)
    // The worker may still be folding the tail of the burst; give it the
    // frames written after its first pass.
    await waitFor(() => {
      const row = checkpointRow(db.pragma('wal_checkpoint(PASSIVE)'))
      return row.checkpointed === 0 || row.log === row.checkpointed
    }, 10_000)

    const row = checkpointRow(db.pragma('wal_checkpoint(PASSIVE)'))
    // Nothing pending for the settings connection to copy: the worker did it.
    expect(row.log - row.checkpointed).toBe(0)
    expect(checkpointer.stats.frames).toBeGreaterThanOrEqual(1000)
  })

  it('without the worker the same burst is left entirely for the settings connection', async () => {
    const { db } = await openSettingsConnection()
    writeFrames(db, 2_500)
    const row = checkpointRow(db.pragma('wal_checkpoint(PASSIVE)'))
    // This is what "the checkpoint runs inside a writer's commit" looks like
    // from the settings connection: it had to copy every frame itself.
    expect(row.checkpointed).toBeGreaterThanOrEqual(2_500)
  })

  it('stop() closes the thread and its connection', async () => {
    const { dbPath } = await openSettingsConnection()
    const { logger, lines } = makeLogger()
    const checkpointer = new WalCheckpointer({
      dbPath,
      logger,
      pollMs: 20,
      maxDelayMs: 200,
      workerPath: WORKER_SOURCE,
      workerExecArgv: WORKER_EXEC_ARGV,
    })
    checkpointer.start()
    expect(checkpointer.isRunning()).toBe(true)
    await checkpointer.stop()
    expect(checkpointer.isRunning()).toBe(false)
    // An orderly stop is not a death.
    expect(lines.filter((l) => l.level === 'error')).toEqual([])
  })
})
