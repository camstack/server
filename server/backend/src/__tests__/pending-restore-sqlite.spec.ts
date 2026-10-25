/**
 * The boot-time restore puts a database's consistent copy back, and drops what
 * would corrupt it (D693).
 *
 * The trap: SQLite pairs a database with whatever `-wal` sits beside it. A WAL
 * left by the database being REPLACED (a crash, a kill, a runner that never
 * checkpointed) carries valid frames — and SQLite replays them onto the
 * restored file on the first open, page by page. The copy restored intact
 * would come up as a mix of two databases.
 *
 * Real files throughout: real SQLite databases, a real tar.gz in the layout
 * `SystemBackupService.createArchive` writes, a real restore marker, and the
 * same `applyPendingRestore` the launcher calls before any runner starts.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { DATABASE_SNAPSHOT_SUFFIX } from '@camstack/types'
import Database from 'better-sqlite3'
import * as tar from 'tar'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyPendingRestore } from '../pending-restore.js'
import { applySqliteRestore, planSqliteRestore, SQLITE_SNAPSHOT_SUFFIX } from '../sqlite-restore.js'

const LIVE_REL = path.join('addons-data', 'sqlite-settings', 'camstack.db')
const EVENTS_REL = path.join('addons-data', 'sqlite-settings', 'events.db')
const quiet = (): void => undefined

let root = ''
let dataDir = ''
let stage = ''

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'camstack-restore-sqlite-'))
  dataDir = path.join(root, 'data')
  stage = path.join(root, 'stage')
  fs.mkdirSync(path.join(dataDir, 'addons-data', 'sqlite-settings'), { recursive: true })
  fs.mkdirSync(path.join(stage, 'addons-data', 'sqlite-settings'), { recursive: true })
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

/**
 * The database being replaced, as a crash leaves it: committed rows that live
 * ONLY in its `-wal` (never checkpointed), the `-wal` and `-shm` on disk.
 */
function leaveCrashedLiveDatabase(file: string, tag: string): void {
  const db = new Database(file)
  db.pragma('journal_mode = WAL')
  db.pragma('wal_autocheckpoint = 0')
  db.exec('CREATE TABLE device (id INTEGER PRIMARY KEY, name TEXT NOT NULL)')
  db.exec('CREATE INDEX device_name ON device (name)')
  db.pragma('wal_checkpoint(TRUNCATE)')
  const insert = db.prepare('INSERT INTO device (name) VALUES (?)')
  db.transaction(() => {
    for (let i = 0; i < 300; i++) insert.run(`${tag}-${i}`)
  })()
  // Keep all three files as they are while the connection is open, then put
  // them back after the close (which would checkpoint the WAL into the .db and
  // delete it): the files a killed process leaves behind.
  const main = fs.readFileSync(file)
  const wal = fs.readFileSync(`${file}-wal`)
  const shm = fs.readFileSync(`${file}-shm`)
  db.close()
  fs.writeFileSync(file, main)
  fs.writeFileSync(`${file}-wal`, wal)
  fs.writeFileSync(`${file}-shm`, shm)
}

/** A self-contained copy (rollback journal, no sidecars), as the owner's snapshot is. */
function writeSnapshotDatabase(file: string, tag: string, rows: number): void {
  const db = new Database(file)
  db.exec('CREATE TABLE device (id INTEGER PRIMARY KEY, name TEXT NOT NULL)')
  db.exec('CREATE INDEX device_name ON device (name)')
  const insert = db.prepare('INSERT INTO device (name) VALUES (?)')
  db.transaction(() => {
    for (let i = 0; i < rows; i++) insert.run(`${tag}-${i}`)
  })()
  db.close()
}

async function archiveOf(paths: readonly string[]): Promise<string> {
  const archivePath = path.join(root, 'backup.tar.gz')
  await tar.create({ gzip: true, cwd: stage, file: archivePath, portable: true }, [...paths])
  return archivePath
}

function scheduleRestore(archivePath: string, locations?: readonly string[]): void {
  fs.writeFileSync(
    path.join(dataDir, '.pending-restore.json'),
    JSON.stringify({
      archivePath,
      requestedAt: 1,
      source: 'spec',
      ...(locations ? { locations } : {}),
    }),
  )
}

interface RestoredRows {
  readonly names: string[]
  readonly integrity: unknown
}

function rowsOf(file: string): RestoredRows {
  const db = new Database(file)
  try {
    const names: string[] = []
    for (const row of db.prepare('SELECT name FROM device ORDER BY id').all()) {
      if (
        typeof row === 'object' &&
        row !== null &&
        'name' in row &&
        typeof row.name === 'string'
      ) {
        names.push(row.name)
      }
    }
    return { names, integrity: db.pragma('integrity_check', { simple: true }) }
  } finally {
    db.close()
  }
}

describe('applyPendingRestore — SQLite databases', () => {
  it('spells the snapshot suffix exactly as the capability does', () => {
    expect(SQLITE_SNAPSHOT_SUFFIX).toBe(DATABASE_SNAPSHOT_SUFFIX)
  })

  it('promotes the snapshot over the database and drops the stale -wal/-shm it would have replayed', async () => {
    const live = path.join(dataDir, LIVE_REL)
    leaveCrashedLiveDatabase(live, 'old')
    writeSnapshotDatabase(path.join(stage, LIVE_REL + DATABASE_SNAPSHOT_SUFFIX), 'new', 40)
    fs.writeFileSync(path.join(stage, 'config.yaml'), 'cluster: restored\n')
    scheduleRestore(await archiveOf(['config.yaml', LIVE_REL + DATABASE_SNAPSHOT_SUFFIX]))

    await applyPendingRestore(dataDir, quiet)

    // Sampled BEFORE the first open, which would checkpoint and delete them.
    const walLeft = fs.existsSync(`${live}-wal`)
    const shmLeft = fs.existsSync(`${live}-shm`)
    // What the first open sees is the claim: the snapshot's rows, intact —
    // not the snapshot with the replaced database's frames replayed onto it.
    const restored = rowsOf(live)
    expect(restored.integrity).toBe('ok')
    expect(restored.names).toEqual(Array.from({ length: 40 }, (_, i) => `new-${i}`))
    expect(walLeft).toBe(false)
    expect(shmLeft).toBe(false)
    expect(fs.existsSync(live + DATABASE_SNAPSHOT_SUFFIX)).toBe(false)
    expect(fs.readFileSync(path.join(dataDir, 'config.yaml'), 'utf-8')).toBe('cluster: restored\n')
    expect(fs.existsSync(path.join(dataDir, '.pending-restore.json'))).toBe(false)
  })

  it('a multi-file archive promotes EVERY snapshot it carries (D852)', async () => {
    const live = path.join(dataDir, LIVE_REL)
    const events = path.join(dataDir, EVENTS_REL)
    leaveCrashedLiveDatabase(live, 'old-settings')
    leaveCrashedLiveDatabase(events, 'old-events')
    writeSnapshotDatabase(path.join(stage, LIVE_REL + DATABASE_SNAPSHOT_SUFFIX), 'settings', 12)
    writeSnapshotDatabase(path.join(stage, EVENTS_REL + DATABASE_SNAPSHOT_SUFFIX), 'events', 30)
    scheduleRestore(
      await archiveOf([LIVE_REL + DATABASE_SNAPSHOT_SUFFIX, EVENTS_REL + DATABASE_SNAPSHOT_SUFFIX]),
    )

    await applyPendingRestore(dataDir, quiet)

    expect(fs.existsSync(`${live}-wal`)).toBe(false)
    expect(fs.existsSync(`${events}-wal`)).toBe(false)
    expect(rowsOf(live).names).toEqual(Array.from({ length: 12 }, (_, i) => `settings-${i}`))
    const restoredEvents = rowsOf(events)
    expect(restoredEvents.integrity).toBe('ok')
    expect(restoredEvents.names).toEqual(Array.from({ length: 30 }, (_, i) => `events-${i}`))
    expect(fs.existsSync(events + DATABASE_SNAPSHOT_SUFFIX)).toBe(false)
  })

  it('a settings-only archive leaves a live events.db byte-identical, sidecars included', async () => {
    const live = path.join(dataDir, LIVE_REL)
    const events = path.join(dataDir, EVENTS_REL)
    leaveCrashedLiveDatabase(live, 'old-settings')
    leaveCrashedLiveDatabase(events, 'old-events')
    const before = [events, `${events}-wal`, `${events}-shm`].map((f) => fs.readFileSync(f))
    writeSnapshotDatabase(path.join(stage, LIVE_REL + DATABASE_SNAPSHOT_SUFFIX), 'settings', 12)
    scheduleRestore(await archiveOf([LIVE_REL + DATABASE_SNAPSHOT_SUFFIX]))

    await applyPendingRestore(dataDir, quiet)

    expect(rowsOf(live).names).toEqual(Array.from({ length: 12 }, (_, i) => `settings-${i}`))
    const after = [events, `${events}-wal`, `${events}-shm`].map((f) => fs.readFileSync(f))
    for (const [i, bytes] of after.entries())
      expect(bytes.equals(before[i] ?? Buffer.alloc(0))).toBe(true)
  })

  it('an events-only archive leaves settings and the data-root files byte-identical (weekly, D852)', async () => {
    const live = path.join(dataDir, LIVE_REL)
    const events = path.join(dataDir, EVENTS_REL)
    leaveCrashedLiveDatabase(live, 'old-settings')
    leaveCrashedLiveDatabase(events, 'old-events')
    fs.writeFileSync(path.join(dataDir, 'config.yaml'), 'cluster: current\n')
    const files = [live, `${live}-wal`, `${live}-shm`, path.join(dataDir, 'config.yaml')]
    const before = files.map((f) => fs.readFileSync(f))
    writeSnapshotDatabase(path.join(stage, EVENTS_REL + DATABASE_SNAPSHOT_SUFFIX), 'events', 30)
    scheduleRestore(await archiveOf([EVENTS_REL + DATABASE_SNAPSHOT_SUFFIX]))

    await applyPendingRestore(dataDir, quiet)

    const restoredEvents = rowsOf(events)
    expect(restoredEvents.integrity).toBe('ok')
    expect(restoredEvents.names).toEqual(Array.from({ length: 30 }, (_, i) => `events-${i}`))
    const after = files.map((f) => fs.readFileSync(f))
    for (const [i, bytes] of after.entries())
      expect(bytes.equals(before[i] ?? Buffer.alloc(0))).toBe(true)
  })

  it('a legacy archive whose .db came WITHOUT a -wal: the stale -wal beside the target is dropped', async () => {
    const live = path.join(dataDir, LIVE_REL)
    leaveCrashedLiveDatabase(live, 'old')
    writeSnapshotDatabase(path.join(stage, LIVE_REL), 'legacy', 25)
    scheduleRestore(await archiveOf([LIVE_REL]))

    await applyPendingRestore(dataDir, quiet)

    const restored = rowsOf(live)
    expect(restored.integrity).toBe('ok')
    expect(restored.names).toEqual(Array.from({ length: 25 }, (_, i) => `legacy-${i}`))
  })

  it('a legacy archive that carried its own -wal keeps it — those frames ARE its rows', async () => {
    const staged = path.join(stage, LIVE_REL)
    leaveCrashedLiveDatabase(staged, 'archived')
    const live = path.join(dataDir, LIVE_REL)
    leaveCrashedLiveDatabase(live, 'old')
    scheduleRestore(await archiveOf([LIVE_REL, `${LIVE_REL}-wal`, `${LIVE_REL}-shm`]))

    await applyPendingRestore(dataDir, quiet)

    const restored = rowsOf(live)
    expect(restored.integrity).toBe('ok')
    expect(restored.names).toEqual(Array.from({ length: 300 }, (_, i) => `archived-${i}`))
  })

  it('a partial restore that leaves the database out touches none of its files', async () => {
    const live = path.join(dataDir, LIVE_REL)
    leaveCrashedLiveDatabase(live, 'old')
    writeSnapshotDatabase(path.join(stage, LIVE_REL + DATABASE_SNAPSHOT_SUFFIX), 'new', 40)
    fs.writeFileSync(path.join(stage, 'config.yaml'), 'cluster: restored\n')
    scheduleRestore(await archiveOf(['config.yaml', LIVE_REL + DATABASE_SNAPSHOT_SUFFIX]), [
      'config.yaml',
    ])

    await applyPendingRestore(dataDir, quiet)

    expect(fs.existsSync(`${live}-wal`)).toBe(true)
    expect(fs.existsSync(live + DATABASE_SNAPSHOT_SUFFIX)).toBe(false)
    const kept = rowsOf(live)
    expect(kept.names).toHaveLength(300)
    expect(kept.names[0]).toBe('old-0')
  })

  it('says a promised database was NOT restored when the archive carried no snapshot of it', async () => {
    const live = path.join(dataDir, LIVE_REL)
    leaveCrashedLiveDatabase(live, 'old')
    const promised =
      path.posix.join('addons-data', 'sqlite-settings', 'camstack.db') + DATABASE_SNAPSHOT_SUFFIX
    // The manifest first, as `createArchive` writes it; the snapshot it lists is absent.
    fs.writeFileSync(
      path.join(stage, '.camstack-backup-manifest.json'),
      JSON.stringify({ archiveVersion: 1, sqliteSnapshots: [{ snapshotPath: promised }] }),
    )
    fs.writeFileSync(path.join(stage, 'config.yaml'), 'cluster: restored\n')
    scheduleRestore(await archiveOf(['.camstack-backup-manifest.json', 'config.yaml']))
    const lines: string[] = []

    await applyPendingRestore(dataDir, (line) => lines.push(line))

    const warning = lines.findIndex(
      (l) => l.includes('WARNING') && l.includes(promised) && l.includes('NOT restored'),
    )
    expect(warning).toBeGreaterThanOrEqual(0)
    // Said before the restore calls itself complete.
    expect(warning).toBeLessThan(lines.findIndex((l) => l.includes('Restore complete')))
  })

  it('names a promised database a partial restore chose to leave out — without calling it missing', async () => {
    const promised =
      path.posix.join('addons-data', 'sqlite-settings', 'camstack.db') + DATABASE_SNAPSHOT_SUFFIX
    writeSnapshotDatabase(path.join(stage, LIVE_REL + DATABASE_SNAPSHOT_SUFFIX), 'new', 5)
    fs.writeFileSync(
      path.join(stage, '.camstack-backup-manifest.json'),
      JSON.stringify({ archiveVersion: 1, sqliteSnapshots: [{ snapshotPath: promised }] }),
    )
    fs.writeFileSync(path.join(stage, 'config.yaml'), 'cluster: restored\n')
    scheduleRestore(
      await archiveOf([
        '.camstack-backup-manifest.json',
        'config.yaml',
        LIVE_REL + DATABASE_SNAPSHOT_SUFFIX,
      ]),
      ['config.yaml'],
    )
    const lines: string[] = []

    await applyPendingRestore(dataDir, (line) => lines.push(line))

    expect(lines.some((l) => l.includes('WARNING'))).toBe(false)
    expect(
      lines.some((l) => l.includes(promised) && l.includes('outside the chosen locations')),
    ).toBe(true)
  })

  it('a directory fsync that fails is a WARNING — the restore still completes', () => {
    const live = path.join(dataDir, LIVE_REL)
    writeSnapshotDatabase(live + DATABASE_SNAPSHOT_SUFFIX, 'new', 3)
    const lines: string[] = []
    applySqliteRestore(
      dataDir,
      planSqliteRestore([
        path.posix.join('addons-data', 'sqlite-settings', 'camstack.db') + DATABASE_SNAPSHOT_SUFFIX,
      ]),
      (line) => lines.push(line),
      () => {
        throw new Error('EINVAL: fsync on a directory')
      },
    )
    expect(rowsOf(live).names).toEqual(['new-0', 'new-1', 'new-2'])
    expect(lines.some((l) => l.includes('WARNING') && l.includes('could not fsync'))).toBe(true)
  })
})
