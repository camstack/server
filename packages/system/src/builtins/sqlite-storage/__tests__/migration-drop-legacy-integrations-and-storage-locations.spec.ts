/**
 * The hub migration that drops the `integrations` and `storage_locations` tables once their record
 * kinds hold the rows (planning#440 step 5). On real SQLite: the records stay byte-identical and
 * the tables go; a table with rows whose kind is empty is refused naming the table and the count;
 * a second pass changes nothing.
 */
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DROP_LEGACY_INTEGRATIONS_AND_STORAGE_LOCATIONS_MIGRATION,
  DROP_LEGACY_INTEGRATIONS_AND_STORAGE_LOCATIONS_MIGRATION_ID,
} from '../../../migrations/hub/2026-11-06-drop-legacy-integrations-and-storage-locations.js'
import { MigrationEngine } from '../migrations/migration-engine.js'
import type { HubMigration } from '../migrations/migration-types.js'
import { openOwnedSqliteFile } from '../owned-sqlite-file.js'
import { RECORDS_SCHEMA_SQL } from '../records/records-sql.js'
import { SqliteSnapshotter } from '../sqlite-snapshotter.js'
import { makeHarness, recordingLogger, type Harness } from './support/owned-files-harness.js'

const SNAPSHOT_WORKER = fileURLToPath(new URL('../sqlite-snapshot-worker.ts', import.meta.url))
const MIGRATION_ID = DROP_LEGACY_INTEGRATIONS_AND_STORAGE_LOCATIONS_MIGRATION_ID

/** Marks that must survive the drop byte for byte. */
const RECOVERY_LOCATION = JSON.stringify({
  type: 'recordings',
  displayName: 'recordings:default',
  providerId: 'filesystem-storage',
  config: { basePath: '/data', minFreePercent: 17 },
  isSystem: true,
  createdAt: 1,
  updatedAt: 2,
})
const DRAIN_LOCATION = JSON.stringify({
  type: 'recordings',
  displayName: 'old disk',
  providerId: 'filesystem-storage',
  config: { basePath: '/old' },
  isSystem: false,
  createdAt: 3,
  updatedAt: 4,
  mode: 'drain',
})

let h: Harness

afterEach(() => {
  h?.cleanup()
})

function seed(opts: { readonly records: boolean; readonly legacyRows: boolean }): void {
  h = makeHarness()
  const db = new Database(h.pathOf('settings'))
  db.exec(`
    CREATE TABLE integrations (id TEXT PRIMARY KEY, addon_id TEXT NOT NULL, name TEXT NOT NULL);
    CREATE TABLE storage_locations (id TEXT PRIMARY KEY, type TEXT NOT NULL, display_name TEXT NOT NULL);
    CREATE TABLE storage_drain_state (location_id TEXT PRIMARY KEY, started_at_ms INTEGER NOT NULL);
    CREATE TABLE _collection_declarations (name TEXT PRIMARY KEY NOT NULL, decl TEXT NOT NULL);
    CREATE TABLE "addon-settings" (id TEXT PRIMARY KEY, data TEXT NOT NULL);
  `)
  db.exec(RECORDS_SCHEMA_SQL)
  const insertDecl = db.prepare('INSERT INTO _collection_declarations (name, decl) VALUES (?, ?)')
  insertDecl.run('integrations', '{}')
  insertDecl.run('storage_locations', '{}')
  insertDecl.run('storage_drain_state', '{}')
  insertDecl.run('addon-settings', '{}')
  if (opts.legacyRows) {
    const insertInt = db.prepare('INSERT INTO integrations (id, addon_id, name) VALUES (?, ?, ?)')
    for (const n of [1, 2, 3]) insertInt.run(`int_000${n}`, 'provider-x', `I${n}`)
    const insertLoc = db.prepare(
      'INSERT INTO storage_locations (id, type, display_name) VALUES (?, ?, ?)',
    )
    insertLoc.run('recordings:default', 'recordings', 'recordings:default')
    insertLoc.run('recordings:old', 'recordings', 'old disk')
    db.prepare('INSERT INTO storage_drain_state (location_id, started_at_ms) VALUES (?, ?)').run(
      'recordings:old',
      77,
    )
  }
  const kind = db.prepare(
    `INSERT INTO _record_kinds (kind_id, owner, kind, database, manifest_hash, declaration, state) VALUES (?, ?, ?, 'settings', 'x', ?, 'declared')`,
  )
  const declaration = JSON.stringify({
    class: 'config',
    writeTrigger: 't',
    retention: { none: 't' },
  })
  kind.run(1, 'integration-registry', 'integrations', declaration)
  kind.run(2, 'storage-orchestrator', 'locations', declaration)
  kind.run(3, 'storage-orchestrator', 'drain-state', declaration)
  if (opts.records) {
    const insertRecord = db.prepare(
      'INSERT INTO records (kind_id, id, updated_at, data) VALUES (?, ?, 1, ?)',
    )
    for (const n of [1, 2, 3]) {
      insertRecord.run(1, `int_000${n}`, JSON.stringify({ addonId: 'provider-x', name: `I${n}` }))
    }
    insertRecord.run(2, 'recordings:default', RECOVERY_LOCATION)
    insertRecord.run(2, 'recordings:old', DRAIN_LOCATION)
    insertRecord.run(
      3,
      'recordings:old',
      JSON.stringify({ locationId: 'recordings:old', startedAtMs: 77 }),
    )
  }
  db.close()
}

function open<T>(fn: (db: Database.Database) => T): T {
  const db = new Database(h.pathOf('settings'), { readonly: true })
  try {
    return fn(db)
  } finally {
    db.close()
  }
}

function tableExists(name: string): boolean {
  return open(
    (db) =>
      db.prepare('SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?').get('table', name) !==
      undefined,
  )
}

function declared(name: string): boolean {
  return open(
    (db) =>
      db.prepare('SELECT 1 FROM _collection_declarations WHERE name = ?').get(name) !== undefined,
  )
}

function recordData(id: string): string | null {
  return open((db) => {
    const row = db.prepare('SELECT json(data) AS data FROM records WHERE id = ?').get(id)
    return typeof row === 'object' && row !== null && 'data' in row && typeof row.data === 'string'
      ? row.data
      : null
  })
}

function legacyCount(table: string): number {
  return open((db) => {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get()
    return typeof row === 'object' && row !== null && 'n' in row && typeof row.n === 'number'
      ? row.n
      : 0
  })
}

function ledger(): { status: string; error: string | null } | undefined {
  return open((db) => {
    const row = db.prepare('SELECT status, error FROM _migrations WHERE id = ?').get(MIGRATION_ID)
    if (typeof row !== 'object' || row === null || !('status' in row)) return undefined
    const error = 'error' in row ? row.error : null
    return {
      status: typeof row.status === 'string' ? row.status : '',
      error: typeof error === 'string' ? error : null,
    }
  })
}

async function runPass(bootId: string): Promise<void> {
  const catalogue: readonly HubMigration[] = [
    DROP_LEGACY_INTEGRATIONS_AND_STORAGE_LOCATIONS_MIGRATION,
  ]
  const engine = new MigrationEngine({
    logger: recordingLogger(h.lines, 'Migrations'),
    catalogue,
    codeVersion: '1.0.0',
    bootId,
    snapshotterFor: (livePath) =>
      new SqliteSnapshotter({
        livePath,
        logger: recordingLogger(h.lines, 'Snapshot'),
        workerPath: SNAPSHOT_WORKER,
        workerExecArgv: ['--import', 'tsx'],
      }),
  })
  const file = await openOwnedSqliteFile(h.specOf('settings'), {
    ...h.deps,
    migrationCatalogue: catalogue,
    afterOpen: async (opened) => {
      await engine.runFile({
        databaseId: opened.databaseId,
        livePath: opened.livePath,
        call: (op, input) => opened.migrate(op, input),
      })
    },
  })
  await file.stop()
}

describe('hub migration: drop the legacy integrations and storage_locations tables', () => {
  it('drops both tables and their declarations and leaves the records byte-identical', async () => {
    seed({ records: true, legacyRows: true })
    const before = recordData('recordings:default')
    expect(before).toContain('"minFreePercent":17')
    await runPass('boot-1')
    expect(ledger()?.status).toBe('applied')
    expect(tableExists('integrations')).toBe(false)
    expect(tableExists('storage_locations')).toBe(false)
    expect(tableExists('storage_drain_state')).toBe(false)
    expect(declared('integrations')).toBe(false)
    expect(declared('storage_locations')).toBe(false)
    expect(declared('addon-settings')).toBe(true)
    expect(tableExists('addon-settings')).toBe(true)
    expect(recordData('recordings:default')).toBe(before)
    expect(recordData('recordings:old')).toContain('"mode":"drain"')
    expect(recordData('int_0003')).toContain('"name":"I3"')
  }, 60_000)

  it('refuses a table with rows whose record kind is empty, naming the table and the count', async () => {
    seed({ records: false, legacyRows: true })
    await runPass('boot-1')
    const row = ledger()
    expect(row?.status).toBe('failed')
    expect(row?.error).toContain('integrations')
    expect(row?.error).toContain('3 row(s) without a record: int_0001, int_0002, int_0003')
    expect(row?.error).toContain('storage_locations')
    expect(row?.error).toContain('2 row(s) without a record')
    // the drain row's location has no record either: an orphan, so it is not what blocks the drop
    expect(row?.error).not.toContain('storage_drain_state')
    expect(legacyCount('storage_drain_state')).toBe(1)
    expect(legacyCount('integrations')).toBe(3)
    expect(legacyCount('storage_locations')).toBe(2)
    expect(declared('integrations')).toBe(true)
    expect(
      h.lines.some(
        (l) =>
          l.level === 'error' &&
          l.message === 'migration failed' &&
          JSON.stringify(l.extras).includes('int_0001'),
      ),
    ).toBe(true)
  }, 60_000)

  it('refuses a PARTIAL copy: 5 legacy rows, 1 record, table intact, missing ids named', async () => {
    seed({ records: false, legacyRows: false })
    const db = new Database(h.pathOf('settings'))
    try {
      const ins = db.prepare('INSERT INTO integrations (id, addon_id, name) VALUES (?, ?, ?)')
      for (const n of [1, 2, 3, 4, 5]) ins.run(`int_000${n}`, 'provider-x', `I${n}`)
      db.prepare('INSERT INTO records (kind_id, id, updated_at, data) VALUES (1, ?, 1, ?)').run(
        'int_0001',
        JSON.stringify({ addonId: 'provider-x', name: 'I1' }),
      )
    } finally {
      db.close()
    }
    await runPass('boot-1')
    const row = ledger()
    expect(row?.status).toBe('failed')
    expect(row?.error).toContain(
      '4 row(s) without a record: int_0002, int_0003, int_0004, int_0005',
    )
    expect(legacyCount('integrations')).toBe(5)
    expect(declared('integrations')).toBe(true)
  }, 60_000)

  it('refuses a SAME-COUNT partial copy: legacy {A,B} vs records {A,C} names B', async () => {
    seed({ records: false, legacyRows: false })
    const db = new Database(h.pathOf('settings'))
    try {
      const ins = db.prepare('INSERT INTO integrations (id, addon_id, name) VALUES (?, ?, ?)')
      ins.run('int_A', 'provider-x', 'A')
      ins.run('int_B', 'provider-x', 'B')
      const rec = db.prepare(
        'INSERT INTO records (kind_id, id, updated_at, data) VALUES (1, ?, 1, ?)',
      )
      rec.run('int_A', JSON.stringify({ addonId: 'provider-x', name: 'A' }))
      rec.run('int_C', JSON.stringify({ addonId: 'provider-x', name: 'C' }))
    } finally {
      db.close()
    }
    await runPass('boot-1')
    expect(ledger()?.status).toBe('failed')
    expect(ledger()?.error).toContain('1 row(s) without a record: int_B')
    expect(legacyCount('integrations')).toBe(2)
  }, 60_000)

  it('settles drain rows: a live location is copied, an orphan dropped and logged, a recorded one untouched', async () => {
    seed({ records: true, legacyRows: true })
    const db = new Database(h.pathOf('settings'))
    try {
      const ins = db.prepare(
        'INSERT INTO storage_drain_state (location_id, started_at_ms) VALUES (?, ?)',
      )
      ins.run('recordings:default', 500)
      ins.run('ghost:gone', 600)
      db.prepare('UPDATE storage_drain_state SET started_at_ms = 999 WHERE location_id = ?').run(
        'recordings:old',
      )
    } finally {
      db.close()
    }
    await runPass('boot-1')
    expect(ledger()?.status).toBe('applied')
    expect(tableExists('storage_drain_state')).toBe(false)
    const copied = JSON.parse(
      open((d) => {
        const row = d
          .prepare('SELECT json(data) AS data FROM records WHERE kind_id = 3 AND id = ?')
          .get('recordings:default')
        return typeof row === 'object' &&
          row !== null &&
          'data' in row &&
          typeof row.data === 'string'
          ? row.data
          : 'null'
      }),
    )
    expect(copied).toEqual({
      locationId: 'recordings:default',
      startedAtMs: 500,
      startBytes: 0,
      capBytes: 0,
      lastPeerBytes: null,
      lastSweepMs: 0,
      observedGrowthBytes: 0,
      observedElapsedMs: 0,
    })
    expect(recordData('ghost:gone')).toBeNull()
    expect(
      open((d) =>
        d
          .prepare(
            "SELECT 1 FROM records WHERE kind_id = 3 AND id = 'recordings:old' AND json(data) LIKE '%\"startedAtMs\":77%'",
          )
          .get(),
      ),
    ).toBeDefined()
    expect(
      h.lines.some(
        (l) =>
          l.level === 'info' &&
          l.message === 'migration applied' &&
          JSON.stringify(l.extras).includes('ghost:gone'),
      ),
    ).toBe(true)
  }, 60_000)

  it('a second pass after the drop is a no-op, and an empty legacy table with empty kinds drops', async () => {
    seed({ records: true, legacyRows: true })
    await runPass('boot-1')
    await runPass('boot-2')
    expect(ledger()?.status).toBe('applied')
    expect(tableExists('integrations')).toBe(false)
    const db = new Database(h.pathOf('settings'))
    try {
      DROP_LEGACY_INTEGRATIONS_AND_STORAGE_LOCATIONS_MIGRATION.run(db)
    } finally {
      db.close()
    }
    expect(recordData('recordings:default')).toContain('"minFreePercent":17')
    seed({ records: false, legacyRows: false })
    await runPass('boot-1')
    expect(ledger()?.status).toBe('applied')
    expect(tableExists('storage_locations')).toBe(false)
  }, 60_000)
})
