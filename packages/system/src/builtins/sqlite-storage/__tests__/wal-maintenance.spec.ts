/**
 * WAL maintenance — the gate, not the checkpoint.
 *
 * The live hub's WAL reached a 248,955,152-byte high-water mark, roughly 2x
 * the 130 MB database, because the only `wal_checkpoint(TRUNCATE)` in the tree
 * runs inside system-backup. But a truncating checkpoint takes the writer lock
 * and copies the whole WAL synchronously on the thread that serves every
 * request — an unconditional periodic one is the disease, not the cure.
 *
 * So the tests that matter here are the ones about NOT checkpointing: below
 * the high-water mark nothing is touched at all, and above it the checkpoint
 * is still refused while the database is being written to. The happy path is
 * the easy part.
 */

import { promises as fs, statSync, utimesSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { IScopedLogger, LogExtras } from '@camstack/types'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { WalMaintenance } from '../wal-maintenance.js'

interface LoggedLine {
  readonly level: 'debug' | 'info' | 'warn' | 'error'
  readonly message: string
  readonly extras?: LogExtras
}

interface RecordingLogger {
  readonly logger: IScopedLogger
  readonly lines: readonly LoggedLine[]
}

function makeLogger(): RecordingLogger {
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

const tmpDirs: string[] = []
const openDbs: Database.Database[] = []
afterEach(async () => {
  for (const db of openDbs.splice(0)) {
    try {
      db.close()
    } catch {
      /* already closed by a test */
    }
  }
  for (const d of tmpDirs.splice(0)) await fs.rm(d, { recursive: true, force: true })
})

interface Fixture {
  readonly db: Database.Database
  readonly dbPath: string
  readonly walPath: string
}

async function makeDb(): Promise<Fixture> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wal-maint-'))
  tmpDirs.push(dir)
  const dbPath = path.join(dir, 'camstack.db')
  const db = new Database(dbPath)
  openDbs.push(db)
  db.pragma('journal_mode = WAL')
  // Keep SQLite's own autocheckpoint out of the way so the test controls the
  // WAL size rather than racing an implicit checkpoint.
  db.pragma('wal_autocheckpoint = 0')
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, blob TEXT NOT NULL)')
  return { db, dbPath, walPath: `${dbPath}-wal` }
}

/** Write until the WAL exceeds `bytes`. */
function growWal(db: Database.Database, walPath: string, bytes: number): number {
  const insert = db.prepare<[string], unknown>('INSERT INTO t (blob) VALUES (?)')
  const row = 'x'.repeat(4096)
  for (let i = 0; i < 5000; i++) {
    insert.run(row)
    if (statSync(walPath).size > bytes) break
  }
  return statSync(walPath).size
}

/** Force the WAL's mtime `ms` into the past — the decoder of "idle". */
function backdateWal(walPath: string, ms: number): void {
  const when = new Date(Date.now() - ms)
  utimesSync(walPath, when, when)
}

const TINY_HIGH_WATER = 32 * 1024
const IDLE_MS = 30_000

function makeMaintenance(
  fixture: Fixture,
  logger: IScopedLogger,
  overrides?: { readonly highWaterBytes?: number; readonly idleQuietMs?: number },
): WalMaintenance {
  return new WalMaintenance({
    db: fixture.db,
    dbPath: fixture.dbPath,
    logger,
    highWaterBytes: overrides?.highWaterBytes ?? TINY_HIGH_WATER,
    idleQuietMs: overrides?.idleQuietMs ?? IDLE_MS,
  })
}

describe('WalMaintenance', () => {
  it('does nothing at all while the WAL is below the high-water mark', async () => {
    const fx = await makeDb()
    fx.db.prepare<[string], unknown>('INSERT INTO t (blob) VALUES (?)').run('small')
    const before = statSync(fx.walPath).size
    expect(before).toBeLessThan(TINY_HIGH_WATER)
    // Even backdated (i.e. "idle"), a small WAL must not be checkpointed —
    // the cheap stat is the whole point of the gate.
    backdateWal(fx.walPath, IDLE_MS * 2)

    const { logger } = makeLogger()
    const outcome = makeMaintenance(fx, logger).runOnce()

    expect(outcome.kind).toBe('below-high-water')
    expect(statSync(fx.walPath).size).toBe(before)
  })

  it('REFUSES to checkpoint an oversized WAL that was written to recently', async () => {
    // The stall guard. On a busy NVR this is the branch that runs, every tick.
    const fx = await makeDb()
    const before = growWal(fx.db, fx.walPath, TINY_HIGH_WATER)
    expect(before).toBeGreaterThan(TINY_HIGH_WATER)

    const { logger, lines } = makeLogger()
    const outcome = makeMaintenance(fx, logger).runOnce()

    expect(outcome.kind).toBe('deferred-not-idle')
    expect(statSync(fx.walPath).size).toBe(before)
    // A branch that drops work says so.
    expect(lines.some((l) => l.message.includes('deferred'))).toBe(true)
  })

  it('checkpoints and truncates an oversized WAL once the database goes quiet', async () => {
    const fx = await makeDb()
    const before = growWal(fx.db, fx.walPath, TINY_HIGH_WATER)
    backdateWal(fx.walPath, IDLE_MS * 2)

    const { logger, lines } = makeLogger()
    const outcome = makeMaintenance(fx, logger).runOnce()

    expect(outcome.kind).toBe('checkpointed')
    if (outcome.kind !== 'checkpointed') throw new Error('unreachable')
    expect(outcome.beforeBytes).toBe(before)
    expect(outcome.afterBytes).toBeLessThan(before)
    expect(statSync(fx.walPath).size).toBeLessThan(before)
    // It logs what it reclaimed, in bytes, on the line that did the work.
    const reclaimed = lines.find((l) => l.message.includes('checkpoint'))
    expect(reclaimed).toBeDefined()
    expect(reclaimed?.extras?.meta).toMatchObject({ beforeBytes: before })
  })

  it('leaves the data readable after a truncating checkpoint', async () => {
    const fx = await makeDb()
    growWal(fx.db, fx.walPath, TINY_HIGH_WATER)
    const expected = fx.db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM t').get()?.n
    backdateWal(fx.walPath, IDLE_MS * 2)

    const { logger } = makeLogger()
    makeMaintenance(fx, logger).runOnce()

    expect(fx.db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM t').get()?.n).toBe(expected)
  })

  it('restores the connection busy_timeout after bounding the checkpoint', async () => {
    // The checkpoint is bounded by a short busy_timeout so it cannot block the
    // main thread waiting for a reader. Every other statement on this shared
    // connection must get the original timeout back.
    const fx = await makeDb()
    const original = fx.db.pragma('busy_timeout', { simple: true })
    growWal(fx.db, fx.walPath, TINY_HIGH_WATER)
    backdateWal(fx.walPath, IDLE_MS * 2)

    const { logger } = makeLogger()
    makeMaintenance(fx, logger).runOnce()

    expect(fx.db.pragma('busy_timeout', { simple: true })).toBe(original)
  })

  it('reports a failure instead of throwing when the connection is gone', async () => {
    const fx = await makeDb()
    growWal(fx.db, fx.walPath, TINY_HIGH_WATER)
    // Closing the last connection checkpoints and REMOVES the sidecar, so
    // stage an oversized WAL back afterwards: the gate must open and the
    // pragma must then fail against the dead handle.
    fx.db.close()
    await fs.writeFile(fx.walPath, Buffer.alloc(TINY_HIGH_WATER * 2))
    backdateWal(fx.walPath, IDLE_MS * 2)

    const { logger, lines } = makeLogger()
    const outcome = makeMaintenance(fx, logger).runOnce()

    expect(outcome.kind).toBe('failed')
    expect(lines.some((l) => l.level === 'warn')).toBe(true)
  })

  it('reports no-wal when the sidecar does not exist', async () => {
    const fx = await makeDb()
    await fs.rm(fx.walPath, { force: true })
    const { logger } = makeLogger()
    expect(makeMaintenance(fx, logger).runOnce().kind).toBe('no-wal')
  })

  it('start() schedules an unref’d timer and stop() is idempotent', async () => {
    const fx = await makeDb()
    const { logger } = makeLogger()
    const m = makeMaintenance(fx, logger)
    m.start()
    m.start() // a second start must not leave a timer orphaned
    m.stop()
    m.stop()
    expect(m.isRunning()).toBe(false)
  })
})
