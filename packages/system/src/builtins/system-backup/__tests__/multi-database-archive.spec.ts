/**
 * P1 (D693, D852) — an archive carries the databases the run SELECTED, each as
 * its owner's verified snapshot, and no other.
 *
 * Real SQLite files (a live `camstack.db` and a live `events.db` with WAL
 * sidecars), real snapshots via the owner's copy routine, a real tar.gz. The
 * owner is a fake only in that it answers from the test's files.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  DATABASE_SNAPSHOT_PARTIAL_SUFFIX,
  DATABASE_SNAPSHOT_SUFFIX,
  type DatabaseSnapshotWritten,
  type DataStoreDatabase,
  type IScopedLogger,
} from '@camstack/types'
import Database from 'better-sqlite3'
import * as tar from 'tar'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { takeVerifiedCopy } from '../../sqlite-storage/sqlite-snapshot-worker.js'
import {
  BackupSnapshotRefusedError,
  type DatabaseOwner,
  SystemBackupService,
} from '../system-backup.service.js'

const quiet: IScopedLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => quiet,
  withTags: () => quiet,
}

const DIR = path.join('addons-data', 'sqlite-settings')
const REL: Record<DataStoreDatabase, string> = {
  settings: path.join(DIR, 'camstack.db'),
  events: path.join(DIR, 'events.db'),
  history: path.join(DIR, 'history.db'),
}

let tmpRoot = ''
let dataDir = ''
let service: SystemBackupService
const open: Database.Database[] = []

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'camstack-multi-db-'))
  dataDir = path.join(tmpRoot, 'data')
  fs.mkdirSync(path.join(dataDir, DIR), { recursive: true })
  service = new SystemBackupService(dataDir, quiet)
})

afterEach(() => {
  for (const db of open.splice(0)) db.close()
  fs.rmSync(tmpRoot, { recursive: true, force: true })
})

/** A live WAL database with `rows` rows, held open like its owner holds it. */
function openLive(databaseId: DataStoreDatabase, rows: number): string {
  const livePath = path.join(dataDir, REL[databaseId])
  const db = new Database(livePath)
  db.pragma('journal_mode = WAL')
  db.pragma('wal_autocheckpoint = 0')
  db.exec('CREATE TABLE item (id INTEGER PRIMARY KEY, name TEXT NOT NULL)')
  const insert = db.prepare('INSERT INTO item (name) VALUES (?)')
  for (let i = 0; i < rows; i++) insert.run(`${databaseId}-${i}`)
  open.push(db)
  return livePath
}

/** The owner's side: a verified copy beside the live file, as the snapshotter writes it. */
async function snapshotOf(
  databaseId: DataStoreDatabase,
  livePath: string,
): Promise<DatabaseSnapshotWritten> {
  const workDir = livePath + DATABASE_SNAPSHOT_PARTIAL_SUFFIX
  fs.mkdirSync(workDir)
  const copy = await takeVerifiedCopy({
    kind: 'sqlite-snapshot',
    livePath,
    copyPath: path.join(workDir, 'copy'),
    pagesPerStep: 64,
  })
  const snapshotPath = livePath + DATABASE_SNAPSHOT_SUFFIX
  fs.renameSync(path.join(workDir, 'copy'), snapshotPath)
  fs.rmSync(workDir, { recursive: true })
  return {
    databaseId,
    livePath,
    snapshotPath,
    sizeBytes: fs.statSync(snapshotPath).size,
    pageCount: copy.pageCount,
    pageSize: copy.pageSize,
    tables: [...copy.tables],
    copyMs: copy.copyMs,
    verifyMs: copy.verifyMs,
    takenAt: copy.takenAt,
  }
}

interface RecordingOwner extends DatabaseOwner {
  readonly asked: DataStoreDatabase[]
}

function ownerOf(files: Partial<Record<DataStoreDatabase, string>>): RecordingOwner {
  const asked: DataStoreDatabase[] = []
  const entries = (Object.keys(files) as DataStoreDatabase[]).flatMap((databaseId) => {
    const livePath = files[databaseId]
    return livePath === undefined ? [] : [{ databaseId, livePath }]
  })
  return {
    asked,
    listDatabases: async () => entries,
    writeSnapshot: async (databaseId) => {
      asked.push(databaseId)
      const livePath = files[databaseId]
      if (livePath === undefined) throw new Error(`database "${databaseId}" is not open`)
      return snapshotOf(databaseId, livePath)
    },
  }
}

async function archivePaths(archivePath: string): Promise<string[]> {
  const out: string[] = []
  await tar.list({
    file: archivePath,
    onReadEntry: (entry) => {
      out.push(entry.path.replace(/^\.\//, '').replace(/\/+$/, ''))
    },
  })
  return out
}

function twoFiles(): { settings: string; events: string } {
  return { settings: openLive('settings', 40), events: openLive('events', 60) }
}

describe('createArchive — which databases an archive carries', () => {
  it('carries only the selected database, and lists the others as omitted', async () => {
    const files = twoFiles()
    const owner = ownerOf(files)
    const archivePath = path.join(tmpRoot, 'settings-only.tar.gz')
    const result = await service.createArchive({
      archivePath,
      locations: ['addons-data'],
      owner,
      databases: ['settings'],
    })

    expect(owner.asked).toEqual(['settings'])
    const carried = await archivePaths(archivePath)
    expect(carried).toContain(REL.settings + DATABASE_SNAPSHOT_SUFFIX)
    // Not the events snapshot, and never a live file or a sidecar of it.
    for (const suffix of ['', '-wal', '-shm', DATABASE_SNAPSHOT_SUFFIX]) {
      expect(carried).not.toContain(REL.events + suffix)
      expect(result.manifest.entries.some((e) => e.path === REL.events + suffix)).toBe(false)
    }
    expect(result.manifest.omittedDatabases).toEqual(['events'])
    expect(result.manifest.sqliteSnapshots?.map((s) => s.databaseId)).toEqual(['settings'])
  })

  it('an unstated selection is the minimum: settings only', async () => {
    const owner = ownerOf(twoFiles())
    const archivePath = path.join(tmpRoot, 'default.tar.gz')
    const result = await service.createArchive({ archivePath, locations: ['addons-data'], owner })

    expect(owner.asked).toEqual(['settings'])
    expect(result.manifest.omittedDatabases).toEqual(['events'])
    expect(await archivePaths(archivePath)).not.toContain(REL.events + DATABASE_SNAPSHOT_SUFFIX)
  })

  it('carries one verified snapshot per selected database, then deletes every copy', async () => {
    const files = twoFiles()
    const owner = ownerOf(files)
    const archivePath = path.join(tmpRoot, 'weekly.tar.gz')
    const result = await service.createArchive({
      archivePath,
      locations: ['addons-data'],
      owner,
      databases: ['settings', 'events'],
    })

    expect(owner.asked.toSorted()).toEqual(['events', 'settings'])
    const carried = await archivePaths(archivePath)
    expect(carried).toContain(REL.settings + DATABASE_SNAPSHOT_SUFFIX)
    expect(carried).toContain(REL.events + DATABASE_SNAPSHOT_SUFFIX)
    expect(result.manifest.omittedDatabases).toBeUndefined()
    expect(result.manifest.sqliteSnapshots?.map((s) => s.databaseId).toSorted()).toEqual([
      'events',
      'settings',
    ])
    // Each copy existed for this archive only.
    expect(fs.existsSync(files.settings + DATABASE_SNAPSHOT_SUFFIX)).toBe(false)
    expect(fs.existsSync(files.events + DATABASE_SNAPSHOT_SUFFIX)).toBe(false)

    // The events copy is intact: 60 rows.
    const restored = path.join(tmpRoot, 'restored')
    fs.mkdirSync(restored)
    await tar.extract({ file: archivePath, cwd: restored })
    const copy = new Database(path.join(restored, REL.events + DATABASE_SNAPSHOT_SUFFIX), {
      readonly: true,
    })
    try {
      const row = copy.prepare('SELECT count(*) AS n FROM item').get()
      expect(row).toEqual({ n: 60 })
    } finally {
      copy.close()
    }
  })

  it('a run that does not select settings is snapshots-only: no data-root walk, no settings', async () => {
    const files = { ...twoFiles(), history: openLive('history', 7) }
    fs.mkdirSync(path.join(dataDir, 'tls'), { recursive: true })
    fs.writeFileSync(path.join(dataDir, 'tls', 'cert.pem'), 'pem')
    fs.writeFileSync(path.join(dataDir, 'config.yaml'), 'cluster: x\n')
    const owner = ownerOf(files)
    const archivePath = path.join(tmpRoot, 'weekly-only.tar.gz')
    const result = await service.createArchive({
      archivePath,
      locations: ['addons-data', 'tls', 'config.yaml'],
      owner,
      databases: ['events', 'history'],
    })

    expect(owner.asked.toSorted()).toEqual(['events', 'history'])
    const carried = (await archivePaths(archivePath)).filter((p) => !p.endsWith('/'))
    expect(carried.toSorted()).toEqual(
      [
        '.camstack-backup-manifest.json',
        REL.events + DATABASE_SNAPSHOT_SUFFIX,
        REL.history + DATABASE_SNAPSHOT_SUFFIX,
      ].toSorted(),
    )
    expect(result.manifest.entries.map((e) => e.path).toSorted()).toEqual(
      [REL.events + DATABASE_SNAPSHOT_SUFFIX, REL.history + DATABASE_SNAPSHOT_SUFFIX].toSorted(),
    )
    expect(result.manifest.locations).toEqual([])
    expect(fs.existsSync(files.events + DATABASE_SNAPSHOT_SUFFIX)).toBe(false)
    expect(fs.existsSync(files.history + DATABASE_SNAPSHOT_SUFFIX)).toBe(false)
  })

  it('a snapshots-only run refuses, building nothing, when the owner has none of the selected files', async () => {
    const owner = ownerOf({ settings: openLive('settings', 5) })
    const archivePath = path.join(tmpRoot, 'nothing.tar.gz')
    await expect(
      service.createArchive({
        archivePath,
        locations: ['addons-data'],
        owner,
        databases: ['events', 'history'],
      }),
    ).rejects.toThrow(BackupSnapshotRefusedError)
    expect(owner.asked).toEqual([])
    expect(fs.existsSync(archivePath)).toBe(false)
  })

  it('a selected database that does not exist is simply not there — nothing is invented', async () => {
    const owner = ownerOf({ settings: openLive('settings', 5) })
    const result = await service.createArchive({
      archivePath: path.join(tmpRoot, 'no-events.tar.gz'),
      locations: ['addons-data'],
      owner,
      databases: ['settings', 'events', 'history'],
    })
    expect(owner.asked).toEqual(['settings'])
    expect(result.manifest.omittedDatabases).toBeUndefined()
  })

  it('builds NOTHING when one selected snapshot fails, and removes the copies already taken', async () => {
    const files = twoFiles()
    const base = ownerOf(files)
    const owner: DatabaseOwner = {
      listDatabases: base.listDatabases,
      writeSnapshot: async (databaseId) => {
        if (databaseId === 'events') throw new Error('database snapshot refused (row-count)')
        return base.writeSnapshot(databaseId)
      },
    }
    const archivePath = path.join(tmpRoot, 'failed.tar.gz')
    await expect(
      service.createArchive({
        archivePath,
        locations: ['addons-data'],
        owner,
        databases: ['settings', 'events'],
      }),
    ).rejects.toThrow(BackupSnapshotRefusedError)
    expect(fs.existsSync(archivePath)).toBe(false)
    expect(fs.existsSync(files.settings + DATABASE_SNAPSHOT_SUFFIX)).toBe(false)
    expect(fs.existsSync(files.events + DATABASE_SNAPSHOT_SUFFIX)).toBe(false)
  })

  it('refuses a snapshot of the wrong database for the id it was asked', async () => {
    const files = twoFiles()
    const base = ownerOf(files)
    const owner: DatabaseOwner = {
      listDatabases: base.listDatabases,
      // Asked for `events`, answers the settings file.
      writeSnapshot: async () => snapshotOf('settings', files.settings),
    }
    await expect(
      service.createArchive({
        archivePath: path.join(tmpRoot, 'wrong.tar.gz'),
        locations: ['addons-data'],
        owner,
        databases: ['events'],
      }),
    ).rejects.toThrow(/was asked for/)
    // Nothing was built; a copy at a path this run did not derive is the
    // owner's own sweep to remove, never deleted on its word.
    expect(fs.existsSync(path.join(tmpRoot, 'wrong.tar.gz'))).toBe(false)
  })
})
