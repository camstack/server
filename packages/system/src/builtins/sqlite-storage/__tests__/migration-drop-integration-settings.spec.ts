/**
 * The hub migration that drops `integration_settings` once every remaining row belongs to an
 * addon whose copy migration is `applied`. On real SQLite: migrated rows go and the ledger is
 * applied; a row of an unmigrated addon fails naming it and leaves the table; a second pass
 * after a drop changes nothing.
 */
import { fileURLToPath } from 'node:url'
import { moveIntegrationRowsToRecords } from '@camstack/types'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DROP_INTEGRATION_SETTINGS_MIGRATION,
  DROP_INTEGRATION_SETTINGS_MIGRATION_ID,
} from '../../../migrations/hub/2026-11-05-drop-integration-settings.js'
import { readLegacyIntegrationRows } from '../migrations/legacy-integration-rows-door.js'
import { ensureLedger } from '../migrations/migration-pass.js'
import { RECORDS_SCHEMA_SQL } from '../records/records-sql.js'
import { MigrationEngine } from '../migrations/migration-engine.js'
import type { HubMigration } from '../migrations/migration-types.js'
import { openOwnedSqliteFile } from '../owned-sqlite-file.js'
import { SqliteSnapshotter } from '../sqlite-snapshotter.js'
import { makeHarness, recordingLogger, type Harness } from './support/owned-files-harness.js'

const SNAPSHOT_WORKER = fileURLToPath(new URL('../sqlite-snapshot-worker.ts', import.meta.url))
const MIGRATED = 'provider-wyze'
const UNMIGRATED = 'provider-leftover'
const APPLIED_ID = `${MIGRATED}/2026-11-05-integration-rows-to-record`

let h: Harness

afterEach(() => {
  h?.cleanup()
})

function seed(applied: boolean, leftoverRows: number): void {
  h = makeHarness()
  const db = new Database(h.pathOf('settings'))
  db.exec(`
    CREATE TABLE integrations (id TEXT PRIMARY KEY, addon_id TEXT NOT NULL, name TEXT NOT NULL);
    CREATE TABLE integration_settings (
      id TEXT PRIMARY KEY,
      integration_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      value_type TEXT NOT NULL
    );
  `)
  db.exec(RECORDS_SCHEMA_SQL)
  db.prepare('INSERT INTO integrations (id, addon_id, name) VALUES (?, ?, ?)').run(
    'int_0001',
    MIGRATED,
    'Wyze',
  )
  db.prepare(
    'INSERT INTO integration_settings (id, integration_id, key, value, value_type) VALUES (?, ?, ?, ?, ?)',
  ).run('int_0001:host', 'int_0001', 'host', '10.0.0.8', 'string')
  const declaration = JSON.stringify({
    class: 'config',
    writeTrigger: 'test',
    retention: { none: 'test' },
  })
  const insertKind = db.prepare(
    `INSERT INTO _record_kinds (kind_id, owner, kind, database, manifest_hash, declaration, state) VALUES (?, 'integration-registry', ?, 'settings', 'x', ?, 'declared')`,
  )
  insertKind.run(1, 'integrations', declaration)
  insertKind.run(2, 'integration-settings', declaration)
  db.prepare('INSERT INTO records (kind_id, id, updated_at, data) VALUES (1, ?, 1, ?)').run(
    'int_0001',
    JSON.stringify({ addonId: MIGRATED, name: 'Wyze', mark: 'keep-me' }),
  )
  db.prepare('INSERT INTO records (kind_id, id, updated_at, data) VALUES (2, ?, 1, ?)').run(
    'int_0001:token',
    JSON.stringify({
      integrationId: 'int_0001',
      key: 'token',
      value: 'moved',
      valueType: 'string',
    }),
  )
  if (leftoverRows > 0) {
    db.prepare('INSERT INTO integrations (id, addon_id, name) VALUES (?, ?, ?)').run(
      'int_0002',
      UNMIGRATED,
      'Leftover',
    )
    const insert = db.prepare(
      'INSERT INTO integration_settings (id, integration_id, key, value, value_type) VALUES (?, ?, ?, ?, ?)',
    )
    for (let i = 0; i < leftoverRows; i += 1) {
      insert.run(`int_0002:k${i}`, 'int_0002', `k${i}`, 'x', 'string')
    }
  }
  if (applied) {
    ensureLedger(db)
    db.prepare(
      `INSERT INTO _migrations (id, owner, level, seq, status, attempts, boot_id) VALUES (?, ?, 'addon-state', 1, 'applied', 1, 'seed')`,
    ).run(APPLIED_ID, MIGRATED)
  }
  db.close()
}

function tableExists(): boolean {
  const db = new Database(h.pathOf('settings'), { readonly: true })
  try {
    return (
      db
        .prepare('SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?')
        .get('table', 'integration_settings') !== undefined
    )
  } finally {
    db.close()
  }
}

function settingsRowCount(): number {
  if (!tableExists()) return 0
  const db = new Database(h.pathOf('settings'), { readonly: true })
  try {
    const row = db.prepare('SELECT COUNT(*) AS n FROM integration_settings').get()
    return typeof row === 'object' && row !== null && 'n' in row && typeof row.n === 'number'
      ? row.n
      : 0
  } finally {
    db.close()
  }
}

function recordSettingsCount(): number {
  const db = new Database(h.pathOf('settings'), { readonly: true })
  try {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS n FROM records WHERE kind_id = (SELECT kind_id FROM _record_kinds WHERE kind = 'integration-settings')`,
      )
      .get()
    return typeof row === 'object' && row !== null && 'n' in row && typeof row.n === 'number'
      ? row.n
      : 0
  } finally {
    db.close()
  }
}

function integrationMark(): string | null {
  const db = new Database(h.pathOf('settings'), { readonly: true })
  try {
    const row = db
      .prepare(`SELECT json_extract(data, '$.mark') AS mark FROM records WHERE id = ?`)
      .get('int_0001')
    return typeof row === 'object' && row !== null && 'mark' in row && typeof row.mark === 'string'
      ? row.mark
      : null
  } finally {
    db.close()
  }
}

function ledger(): { status: string; error: string | null } | undefined {
  const db = new Database(h.pathOf('settings'), { readonly: true })
  try {
    const row = db
      .prepare('SELECT status, error FROM _migrations WHERE id = ?')
      .get(DROP_INTEGRATION_SETTINGS_MIGRATION_ID)
    if (typeof row !== 'object' || row === null || !('status' in row)) return undefined
    const status = row.status
    const error = 'error' in row ? row.error : null
    return {
      status: typeof status === 'string' ? status : '',
      error: typeof error === 'string' ? error : null,
    }
  } finally {
    db.close()
  }
}

async function runPass(bootId: string): Promise<void> {
  const catalogue: readonly HubMigration[] = [DROP_INTEGRATION_SETTINGS_MIGRATION]
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

describe('hub migration: drop integration_settings', () => {
  it('drops the table and the record-kind rows when every owner migration is applied', async () => {
    seed(true, 0)
    await runPass('boot-1')
    expect(tableExists()).toBe(false)
    expect(recordSettingsCount()).toBe(0)
    expect(integrationMark()).toBe('keep-me')
    expect(ledger()?.status).toBe('applied')
  }, 60_000)

  it('refuses, naming the addon and the row count, and leaves the table intact', async () => {
    seed(true, 3)
    await runPass('boot-1')
    const row = ledger()
    expect(row?.status).toBe('failed')
    expect(row?.error).toContain(UNMIGRATED)
    expect(row?.error).toContain('3')
    expect(tableExists()).toBe(true)
    expect(settingsRowCount()).toBe(4)
    expect(recordSettingsCount()).toBe(1)
  }, 60_000)

  it('a second pass after a drop is a no-op', async () => {
    seed(true, 0)
    await runPass('boot-1')
    expect(tableExists()).toBe(false)
    expect(ledger()?.status).toBe('applied')
    await runPass('boot-2')
    expect(tableExists()).toBe(false)
    expect(recordSettingsCount()).toBe(0)
    expect(integrationMark()).toBe('keep-me')
    expect(ledger()?.status).toBe('applied')
    const db = new Database(h.pathOf('settings'))
    try {
      DROP_INTEGRATION_SETTINGS_MIGRATION.run(db)
      expect(
        db
          .prepare('SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?')
          .get('table', 'integration_settings'),
      ).toBeUndefined()
    } finally {
      db.close()
    }
  }, 60_000)

  it('after the drop the door is empty and a copy migration rerun is a no-op', async () => {
    seed(true, 0)
    await runPass('boot-1')
    expect(ledger()?.status).toBe('applied')
    const db = new Database(h.pathOf('settings'))
    try {
      expect(readLegacyIntegrationRows(db, 'int_0001')).toEqual({})
      let cleared = 0
      const result = await moveIntegrationRowsToRecords(
        {
          warn: () => undefined,
          listIntegrations: async () => [{ id: 'int_0001', name: 'Wyze' }],
          readRows: async (id) => readLegacyIntegrationRows(db, id),
          putRecord: async () => 'exists',
          readRecord: async () => ({ name: 'Wyze' }),
          deleteRecord: async () => undefined,
          clearRows: async () => {
            cleared += 1
          },
        },
        {
          addonId: MIGRATED,
          secretPaths: [],
          bodyFrom: (_values, _log, integration) => ({ name: integration.name }),
        },
      )
      expect(result.outcome).toBe('already-done')
      expect(cleared).toBe(0)
    } finally {
      db.close()
    }
  }, 60_000)

  it('a row whose integration is already gone does not block the drop', async () => {
    seed(true, 0)
    const db = new Database(h.pathOf('settings'))
    db.prepare(
      'INSERT INTO integration_settings (id, integration_id, key, value, value_type) VALUES (?, ?, ?, ?, ?)',
    ).run('int_9999:host', 'int_9999', 'host', 'gone', 'string')
    db.close()
    await runPass('boot-1')
    expect(ledger()?.status).toBe('applied')
    expect(tableExists()).toBe(false)
  }, 60_000)

  it('a database that never had the store answers with no rows', () => {
    h = makeHarness()
    const db = new Database(h.pathOf('settings'))
    try {
      expect(readLegacyIntegrationRows(db, 'int_0001')).toEqual({})
    } finally {
      db.close()
    }
  })
})
