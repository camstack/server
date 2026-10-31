/**
 * The boot-time restore of a pre-migration snapshot (D986). Real SQLite files:
 * the snapshot replaces the database, the stale `-wal` of the replaced database
 * is dropped, the snapshot itself stays, and the marker is consumed.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  applyPendingPreMigrationRestore,
  PRE_MIGRATION_RESTORE_MARKER,
} from '../pre-migration-restore.js'

const quiet = (): void => undefined
let dataDir = ''
let dbDir = ''

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'camstack-premig-restore-'))
  dbDir = path.join(dataDir, 'addons-data', 'sqlite-settings')
  fs.mkdirSync(path.join(dbDir, 'camstack.db.pre-migration'), { recursive: true })
})

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true })
})

function makeDb(file: string, tag: string): void {
  const db = new Database(file)
  db.exec('CREATE TABLE t (v TEXT)')
  db.prepare('INSERT INTO t (v) VALUES (?)').run(tag)
  db.close()
}

function readTag(file: string): string | undefined {
  const db = new Database(file, { readonly: true })
  try {
    const row = db.prepare('SELECT v FROM t').get()
    return typeof row === 'object' && row !== null && 'v' in row && typeof row.v === 'string'
      ? row.v
      : undefined
  } finally {
    db.close()
  }
}

function writeMarker(body: object): void {
  fs.writeFileSync(path.join(dataDir, PRE_MIGRATION_RESTORE_MARKER), JSON.stringify(body))
}

describe('applyPendingPreMigrationRestore', () => {
  it('replaces the database with the snapshot, drops the stale sidecars, keeps the snapshot', () => {
    const live = path.join(dbDir, 'camstack.db')
    const snap = path.join(dbDir, 'camstack.db.pre-migration', 'abc12345-x.db')
    makeDb(live, 'migrated')
    makeDb(snap, 'before')
    fs.writeFileSync(`${live}-wal`, 'stale')
    fs.writeFileSync(`${live}-shm`, 'stale')
    writeMarker({
      requests: [
        {
          livePath: path.join('addons-data', 'sqlite-settings', 'camstack.db'),
          snapshotPath: path.join(
            'addons-data',
            'sqlite-settings',
            'camstack.db.pre-migration',
            'abc12345-x.db',
          ),
        },
      ],
    })

    applyPendingPreMigrationRestore(dataDir, quiet)

    expect(readTag(live)).toBe('before')
    expect(fs.existsSync(`${live}-wal`)).toBe(false)
    expect(fs.existsSync(`${live}-shm`)).toBe(false)
    expect(fs.existsSync(snap)).toBe(true)
    expect(fs.existsSync(path.join(dataDir, PRE_MIGRATION_RESTORE_MARKER))).toBe(false)
  })

  it('refuses a path that leaves the data dir and leaves the database alone', () => {
    const live = path.join(dbDir, 'camstack.db')
    makeDb(live, 'migrated')
    writeMarker({ requests: [{ livePath: '../outside.db', snapshotPath: '../outside-snap.db' }] })
    const lines: string[] = []
    applyPendingPreMigrationRestore(dataDir, (line) => lines.push(line))
    expect(readTag(live)).toBe('migrated')
    expect(lines.join('\n')).toMatch(/outside the data dir/)
  })

  it('keeps the marker and the database when the snapshot is missing', () => {
    const live = path.join(dbDir, 'camstack.db')
    makeDb(live, 'migrated')
    writeMarker({
      requests: [
        { livePath: 'addons-data/sqlite-settings/camstack.db', snapshotPath: 'nope/missing.db' },
      ],
    })
    applyPendingPreMigrationRestore(dataDir, quiet)
    expect(readTag(live)).toBe('migrated')
  })

  it('does nothing without a marker', () => {
    const live = path.join(dbDir, 'camstack.db')
    makeDb(live, 'migrated')
    applyPendingPreMigrationRestore(dataDir, quiet)
    expect(readTag(live)).toBe('migrated')
  })
})
