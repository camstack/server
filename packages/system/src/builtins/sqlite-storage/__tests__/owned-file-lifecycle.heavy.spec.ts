/**
 * What each OWNED FILE carries (D851): its own serving thread, its own
 * checkpointer and `-shm` canary, its own snapshotter, and — for a file this
 * code creates — incremental auto-vacuum.
 */
import { existsSync } from 'node:fs'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { openOwnedSqliteFile } from '../owned-sqlite-file.js'
import { WalMaintenance } from '../wal-maintenance.js'
import {
  ledgerDeclaration,
  makeHarness,
  recordingLogger,
  type Harness,
} from './support/owned-files-harness.js'

let harness: Harness | null = null
afterEach(() => {
  harness?.cleanup()
  harness = null
})

function pragma(file: string, name: string): unknown {
  const db = new Database(file, { readonly: true })
  try {
    return db.pragma(name, { simple: true })
  } finally {
    db.close()
  }
}

describe('owned file lifecycle', () => {
  it('three files arm three checkpointers, three canaries and three snapshotters', async () => {
    harness = makeHarness()
    const router = await harness.router()
    await router.declareCollection(ledgerDeclaration('lc:e', 'events'))
    await router.declareCollection(ledgerDeclaration('lc:h', 'history'))

    for (const kind of ['checkpointer', 'canary', 'snapshotter']) {
      expect(harness.ledger.started.filter((s) => s.startsWith(`${kind}:`)).toSorted()).toEqual(
        [`${kind}:events`, `${kind}:history`, `${kind}:settings`].toSorted(),
      )
    }
    await harness.stopAll(router)
    expect(harness.ledger.stopped.filter((s) => s.startsWith('checkpointer:')).toSorted()).toEqual([
      'checkpointer:events',
      'checkpointer:history',
      'checkpointer:settings',
    ])
    expect(harness.ledger.stopped.filter((s) => s.startsWith('canary:'))).toHaveLength(3)
  })

  it('each file is served by its own thread — settings on main, events and history apart', async () => {
    harness = makeHarness()
    const router = await harness.router()
    await router.declareCollection(ledgerDeclaration('lc:e', 'events'))
    await router.declareCollection(ledgerDeclaration('lc:h', 'history'))
    const threads = new Map<string, number>()
    for (const file of router.openFiles()) {
      threads.set(file.databaseId, await file.servingThreadId())
    }
    expect(threads.get('settings')).toBe(0)
    const events = threads.get('events')
    const history = threads.get('history')
    expect(events).toBeGreaterThan(0)
    expect(history).toBeGreaterThan(0)
    expect(events).not.toBe(history)
    await harness.stopAll(router)
  })

  it('a file this code creates is auto_vacuum = INCREMENTAL (2)', async () => {
    harness = makeHarness()
    const router = await harness.router()
    await router.declareCollection(ledgerDeclaration('lc:e', 'events'))
    await harness.stopAll(router)
    expect(pragma(harness.pathOf('events'), 'auto_vacuum')).toBe(2)
    expect(pragma(harness.pathOf('settings'), 'auto_vacuum')).toBe(0)
  })

  it('a file that already exists is never flipped to incremental at boot', async () => {
    harness = makeHarness()
    const seed = new Database(harness.pathOf('events'))
    seed.exec('CREATE TABLE seed (id INTEGER PRIMARY KEY)')
    seed.close()
    expect(pragma(harness.pathOf('events'), 'auto_vacuum')).toBe(0)

    const events = await openOwnedSqliteFile(harness.specOf('events'), harness.deps)
    await events.stop()
    expect(pragma(harness.pathOf('events'), 'auto_vacuum')).toBe(0)
  })

  it('creates no events.db when nothing declares it', async () => {
    harness = makeHarness()
    const router = await harness.router()
    await router.declareCollection(ledgerDeclaration('lc:plain'))
    expect(existsSync(harness.pathOf('events'))).toBe(false)
    expect(existsSync(harness.pathOf('history'))).toBe(false)
    await harness.stopAll(router)
  })

  it('idle maintenance hands free pages back on an incremental file, and only then', async () => {
    harness = makeHarness()
    const path = harness.pathOf('events')
    const lines: Parameters<typeof recordingLogger>[0] = []
    const make = (file: string, autoVacuum: boolean): Database.Database => {
      const db = new Database(file)
      if (autoVacuum) db.pragma('auto_vacuum = INCREMENTAL')
      db.pragma('journal_mode = WAL')
      db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, pad TEXT)')
      const insert = db.prepare('INSERT INTO t (pad) VALUES (?)')
      db.transaction(() => {
        for (let i = 0; i < 2000; i += 1) insert.run('x'.repeat(500))
      })()
      db.exec('DELETE FROM t')
      db.pragma('wal_checkpoint(TRUNCATE)')
      return db
    }

    const incremental = make(path, true)
    const freeBefore = Number(incremental.pragma('freelist_count', { simple: true }))
    expect(freeBefore).toBeGreaterThan(100)
    const maintenance = new WalMaintenance({
      db: incremental,
      dbPath: path,
      logger: recordingLogger(lines),
      idleQuietMs: 0,
      incrementalVacuumPages: 64,
    })
    expect(maintenance.vacuumOnce()).toBe(64)
    expect(Number(incremental.pragma('freelist_count', { simple: true }))).toBe(freeBefore - 64)
    incremental.close()

    // A file that is not in incremental mode has nothing this tick can shrink.
    const plain = make(harness.pathOf('history'), false)
    const plainMaintenance = new WalMaintenance({
      db: plain,
      dbPath: harness.pathOf('history'),
      logger: recordingLogger(lines),
      idleQuietMs: 0,
      incrementalVacuumPages: 64,
    })
    expect(plainMaintenance.vacuumOnce()).toBe(0)
    plain.close()
  })
})
