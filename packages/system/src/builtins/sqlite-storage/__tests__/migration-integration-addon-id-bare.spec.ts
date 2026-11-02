/**
 * The hub migration that re-stamps integration rows keyed `addon:<id>` with the bare addon id,
 * run by the real engine over a real SQLite file with the real `records` layout: the row id and a
 * MARKED field survive, rows of another kind are untouched, a clash with a bare row fails naming
 * both ids and writes nothing, and a second pass is a no-op.
 */
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import {
  INTEGRATION_ADDON_ID_BARE_MIGRATION,
  INTEGRATION_ADDON_ID_BARE_MIGRATION_ID,
} from '../../../migrations/hub/2026-11-02-integration-addon-id-bare.js'
import { MigrationEngine } from '../migrations/migration-engine.js'
import type { HubMigration } from '../migrations/migration-types.js'
import { openOwnedSqliteFile } from '../owned-sqlite-file.js'
import { declareKind, ensureRecordsSchema } from '../records/records-catalog.js'
import { integrationRegistryRecordKinds } from '../integration-record-kinds.js'
import { SqliteSnapshotter } from '../sqlite-snapshotter.js'
import { makeHarness, recordingLogger, type Harness } from './support/owned-files-harness.js'

const SNAPSHOT_WORKER = fileURLToPath(new URL('../sqlite-snapshot-worker.ts', import.meta.url))

let h: Harness

interface Seed {
  readonly kindId: number
  readonly id: string
  readonly data: Record<string, unknown>
}

function seedDb(rows: readonly Seed[]): void {
  const db = new Database(h.pathOf('settings'))
  ensureRecordsSchema(db)
  const declaration = integrationRegistryRecordKinds.integrations.declaration
  const mine = declareKind(db, 'integration-registry', 'integrations', declaration, undefined)
  const other = declareKind(db, 'someone-else', 'integrations', declaration, undefined)
  const kindIds: Record<number, number> = { 1: mine.row.kindId, 2: other.row.kindId }
  const insert = db.prepare(
    'INSERT INTO records(kind_id, id, rev, updated_at, data) VALUES (?, ?, 3, 100, jsonb(?))',
  )
  for (const r of rows) insert.run(kindIds[r.kindId], r.id, JSON.stringify(r.data))
  db.close()
}

function body(addonId: string, name: string): Record<string, unknown> {
  return { addonId, name, enabled: true, info: { k: name }, createdAt: 1, updatedAt: 2 }
}

afterEach(() => {
  h.cleanup()
})

function stored(): Record<string, { addonId: unknown; name: unknown; rev: number; kind: number }> {
  const db = new Database(h.pathOf('settings'), { readonly: true })
  try {
    const out: Record<string, { addonId: unknown; name: unknown; rev: number; kind: number }> = {}
    for (const row of db
      .prepare('SELECT kind_id, id, rev, json(data) AS data FROM records')
      .all() as { kind_id: number; id: string; rev: number; data: string }[]) {
      const data = JSON.parse(row.data) as Record<string, unknown>
      out[`${row.kind_id}/${row.id}`] = {
        addonId: data['addonId'],
        name: data['name'],
        rev: row.rev,
        kind: row.kind_id,
      }
    }
    return out
  } finally {
    db.close()
  }
}

function ledger(): { status: string; error: string | null } | undefined {
  const db = new Database(h.pathOf('settings'), { readonly: true })
  try {
    return db
      .prepare('SELECT status, error FROM _migrations WHERE id = ?')
      .get(INTEGRATION_ADDON_ID_BARE_MIGRATION_ID) as
      | { status: string; error: string | null }
      | undefined
  } finally {
    db.close()
  }
}

async function runPass(catalogue: readonly HubMigration[], bootId: string): Promise<void> {
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

describe('hub migration: integration rows are keyed by the bare addon id', () => {
  it('re-stamps addon:<id> to <id>, keeps the row id and every other field, leaves the rest alone', async () => {
    h = makeHarness()
    seedDb([
      { kindId: 1, id: 'int_0038', data: body('addon:loki-logging', 'Loki') },
      { kindId: 1, id: 'int_0027', data: body('camera-grid', 'Grid') },
      { kindId: 2, id: 'int_0038', data: body('addon:loki-logging', 'Other owner') },
    ])
    await runPass([INTEGRATION_ADDON_ID_BARE_MIGRATION], 'boot-1')
    const after = stored()
    expect(after['1/int_0038']).toMatchObject({ addonId: 'loki-logging', name: 'Loki', rev: 4 })
    expect(after['1/int_0027']).toMatchObject({ addonId: 'camera-grid', name: 'Grid', rev: 3 })
    expect(after['2/int_0038']).toMatchObject({ addonId: 'addon:loki-logging', rev: 3 })
    expect(ledger()?.status).toBe('applied')
  }, 60_000)

  it('a second pass is a no-op: nothing is written again', async () => {
    h = makeHarness()
    seedDb([{ kindId: 1, id: 'int_0038', data: body('addon:loki-logging', 'Loki') }])
    await runPass([INTEGRATION_ADDON_ID_BARE_MIGRATION], 'boot-1')
    const first = stored()
    await runPass([INTEGRATION_ADDON_ID_BARE_MIGRATION], 'boot-2')
    expect(stored()).toEqual(first)
  }, 60_000)

  it('a bare row already present for the same addon fails naming both ids and writes nothing', async () => {
    h = makeHarness()
    seedDb([
      { kindId: 1, id: 'int_0038', data: body('addon:loki-logging', 'Loki') },
      { kindId: 1, id: 'int_0041', data: body('loki-logging', 'Loki twin') },
      { kindId: 1, id: 'int_0050', data: body('addon:camera-grid', 'Grid') },
    ])
    await runPass([INTEGRATION_ADDON_ID_BARE_MIGRATION], 'boot-1')
    const after = stored()
    expect(after['1/int_0038']).toMatchObject({ addonId: 'addon:loki-logging', rev: 3 })
    expect(after['1/int_0050']).toMatchObject({ addonId: 'addon:camera-grid', rev: 3 })
    const row = ledger()
    expect(row?.status).toBe('failed')
    expect(row?.error).toContain('int_0038')
    expect(row?.error).toContain('int_0041')
  }, 60_000)

  it('a hub without the records tables is left alone', async () => {
    h = makeHarness()
    new Database(h.pathOf('settings')).close()
    await runPass([INTEGRATION_ADDON_ID_BARE_MIGRATION], 'boot-1')
    expect(ledger()?.status).toBe('applied')
  }, 60_000)
})
