/**
 * The hub migration that stamps every storage location with its mode, repairs a type with no write
 * target and retires `isDefault` (planning#440 step 5, D385). On real SQLite: a legacy row is
 * stamped, the retired default flag picks the row to re-enable, a marked field survives, and a
 * second pass changes nothing.
 */
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import {
  STORAGE_LOCATIONS_WRITE_SET_MIGRATION,
  STORAGE_LOCATIONS_WRITE_SET_MIGRATION_ID,
} from '../../../migrations/hub/2026-11-08-storage-locations-write-set.js'
import { MigrationEngine } from '../migrations/migration-engine.js'
import type { HubMigration } from '../migrations/migration-types.js'
import { openOwnedSqliteFile } from '../owned-sqlite-file.js'
import { RECORDS_SCHEMA_SQL } from '../records/records-sql.js'
import { SqliteSnapshotter } from '../sqlite-snapshotter.js'
import { makeHarness, recordingLogger, type Harness } from './support/owned-files-harness.js'

const SNAPSHOT_WORKER = fileURLToPath(new URL('../sqlite-snapshot-worker.ts', import.meta.url))
const MIGRATION_ID = STORAGE_LOCATIONS_WRITE_SET_MIGRATION_ID

let h: Harness

afterEach(() => {
  h?.cleanup()
})

function location(over: Record<string, unknown>): string {
  return JSON.stringify({
    type: 'recordings',
    displayName: 'a disk',
    providerId: 'filesystem-storage',
    config: { basePath: '/data', minFreePercent: 17 },
    isSystem: false,
    createdAt: 1,
    updatedAt: 2,
    ...over,
  })
}

function seed(rows: Readonly<Record<string, string>>): void {
  h = makeHarness()
  const db = new Database(h.pathOf('settings'))
  db.exec(RECORDS_SCHEMA_SQL)
  db.prepare(
    `INSERT INTO _record_kinds (kind_id, owner, kind, database, manifest_hash, declaration, state) VALUES (2, 'storage-orchestrator', 'locations', 'settings', 'x', ?, 'declared')`,
  ).run(JSON.stringify({ class: 'config', writeTrigger: 't', retention: { none: 't' } }))
  const insert = db.prepare(
    'INSERT INTO records (kind_id, id, updated_at, data) VALUES (2, ?, 1, ?)',
  )
  for (const [id, data] of Object.entries(rows)) insert.run(id, data)
  db.close()
}

function bodyOf(id: string): Record<string, unknown> {
  return open((db) => {
    const row = db.prepare('SELECT json(data) AS data FROM records WHERE id = ?').get(id)
    const data: unknown = typeof row === 'object' && row !== null ? Reflect.get(row, 'data') : null
    const parsed: unknown = typeof data === 'string' ? JSON.parse(data) : null
    if (typeof parsed !== 'object' || parsed === null) throw new Error(`no record ${id}`)
    return Object.fromEntries(Object.entries(parsed))
  })
}

function open<T>(fn: (db: Database.Database) => T): T {
  const db = new Database(h.pathOf('settings'), { readonly: true })
  try {
    return fn(db)
  } finally {
    db.close()
  }
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
    STORAGE_LOCATIONS_WRITE_SET_MIGRATION,
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

describe('hub migration: storage locations onto the write set', () => {
  it('stamps a legacy row, keeps the marked field, and drops isDefault', async () => {
    seed({
      'recordings:default': location({ isDefault: true }),
      'recordings:ro': location({ config: { basePath: '/ro', readOnly: true, minFreePercent: 17 } }),
    })
    await runPass('boot-1')
    expect(ledger()?.status).toBe('applied')
    const def = bodyOf('recordings:default')
    expect(def['mode']).toBe('active')
    expect(def['enabled']).toBe(true)
    expect(def).not.toHaveProperty('isDefault')
    expect(def['displayName']).toBe('a disk')
    const ro = bodyOf('recordings:ro')
    expect(ro['mode']).toBe('readonly')
    expect(ro['enabled']).toBe(false)
    expect(ro['config']).toEqual({ basePath: '/ro', minFreePercent: 17 })
  })

  it('re-enables the row the retired default flag named when a type has no write target', async () => {
    seed({
      'recordings:a': location({ enabled: false }),
      'recordings:z': location({ enabled: false, isDefault: true }),
    })
    await runPass('boot-1')
    expect(bodyOf('recordings:z')['mode']).toBe('active')
    expect(bodyOf('recordings:a')['mode']).toBe('readonly')
  })

  it('leaves an operator drain alone and a second pass changes nothing', async () => {
    seed({
      'recordings:default': location({ mode: 'active', enabled: true }),
      'recordings:old': location({ mode: 'drain', enabled: false }),
    })
    await runPass('boot-1')
    expect(bodyOf('recordings:old')['mode']).toBe('drain')
    const before = bodyOf('recordings:default')
    await runPass('boot-2')
    expect(bodyOf('recordings:default')).toEqual(before)
  })
})
