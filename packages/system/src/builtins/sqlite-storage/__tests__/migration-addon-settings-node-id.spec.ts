/**
 * The hub migration that stamps `nodeId` on pre-D986 node rows of `addon-settings`, run by the
 * real engine over a real SQLite file: the node rows gain `nodeId` (parsed from the `@<nodeId>`
 * suffix), a MARKED neighbouring field of every row survives, rows that are not node rows are
 * untouched, and a second pass is a no-op.
 */
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ADDON_SETTINGS_NODE_ID_MIGRATION,
  ADDON_SETTINGS_NODE_ID_MIGRATION_ID,
} from '../../../migrations/hub/2026-11-02-addon-settings-node-id.js'
import { MigrationEngine } from '../migrations/migration-engine.js'
import type { HubMigration } from '../migrations/migration-types.js'
import { openOwnedSqliteFile } from '../owned-sqlite-file.js'
import { SqliteSnapshotter } from '../sqlite-snapshotter.js'
import { makeHarness, recordingLogger, type Harness } from './support/owned-files-harness.js'

const SNAPSHOT_WORKER = fileURLToPath(new URL('../sqlite-snapshot-worker.ts', import.meta.url))

let h: Harness

const ROWS: Readonly<Record<string, unknown>> = {
  // node rows written before D986: no nodeId, a marked neighbouring field
  'detector.backend@agent-1': {
    addonId: 'detector',
    key: 'backend@agent-1',
    value: 'npu',
    mark: 'a1',
  },
  'detector.backend@agent-2': {
    addonId: 'detector',
    key: 'backend@agent-2',
    value: 'gpu',
    mark: 'a2',
  },
  'recorder.path@hub': { addonId: 'recorder', key: 'path@hub', value: '/data', mark: 'h1' },
  // not node rows: a cluster row, and a row that already carries its nodeId
  'detector.threshold': { addonId: 'detector', key: 'threshold', value: 0.5, mark: 'c1' },
  'detector.mode@agent-3': {
    addonId: 'detector',
    key: 'mode@agent-3',
    value: 'x',
    nodeId: 'agent-3',
    mark: 'n3',
  },
}

beforeEach(() => {
  h = makeHarness()
  const seed = new Database(h.pathOf('settings'))
  seed.exec('CREATE TABLE "addon-settings" (id TEXT PRIMARY KEY, data TEXT NOT NULL)')
  const insert = seed.prepare('INSERT INTO "addon-settings" (id, data) VALUES (?, ?)')
  for (const [id, data] of Object.entries(ROWS)) insert.run(id, JSON.stringify(data))
  seed.close()
})
afterEach(() => {
  h.cleanup()
})

function ledgerStatus(): unknown {
  const db = new Database(h.pathOf('settings'), { readonly: true })
  try {
    return db
      .prepare<[string], { status: string }>('SELECT status FROM _migrations WHERE id = ?')
      .get(ADDON_SETTINGS_NODE_ID_MIGRATION_ID)?.status
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

function rows(): Record<string, unknown> {
  const db = new Database(h.pathOf('settings'), { readonly: true })
  try {
    const out: Record<string, unknown> = {}
    for (const row of db.prepare('SELECT id, data FROM "addon-settings" ORDER BY id').all()) {
      if (
        typeof row === 'object' &&
        row !== null &&
        'id' in row &&
        'data' in row &&
        typeof row.id === 'string' &&
        typeof row.data === 'string'
      ) {
        out[row.id] = JSON.parse(row.data)
      }
    }
    return out
  } finally {
    db.close()
  }
}

describe('hub migration: addon-settings node rows carry nodeId', () => {
  it('stamps nodeId from the suffix, keeps every other field, leaves other rows alone', async () => {
    await runPass([ADDON_SETTINGS_NODE_ID_MIGRATION], 'boot-1')
    const after = rows()
    expect(after['detector.backend@agent-1']).toEqual({
      ...(ROWS['detector.backend@agent-1'] as object),
      nodeId: 'agent-1',
    })
    expect(after['detector.backend@agent-2']).toMatchObject({ nodeId: 'agent-2', mark: 'a2' })
    expect(after['recorder.path@hub']).toMatchObject({ nodeId: 'hub', mark: 'h1', value: '/data' })
    expect(after['detector.threshold']).toEqual(ROWS['detector.threshold'])
    expect(after['detector.mode@agent-3']).toEqual(ROWS['detector.mode@agent-3'])
    expect(ledgerStatus()).toBe('applied')
  }, 60_000)

  it('a second pass is a no-op: nothing is edited again', async () => {
    await runPass([ADDON_SETTINGS_NODE_ID_MIGRATION], 'boot-1')
    const first = rows()
    expect(first['detector.backend@agent-1']).toMatchObject({ nodeId: 'agent-1' })
    // The ledger row says applied, so the engine skips it; and the body itself plans nothing.
    await runPass([ADDON_SETTINGS_NODE_ID_MIGRATION], 'boot-2')
    expect(rows()).toEqual(first)
    const db = new Database(h.pathOf('settings'), { readonly: true })
    try {
      expect(ADDON_SETTINGS_NODE_ID_MIGRATION).toBeDefined()
      const plan =
        'plan' in ADDON_SETTINGS_NODE_ID_MIGRATION
          ? ADDON_SETTINGS_NODE_ID_MIGRATION.plan(db)
          : { edits: [{ op: 'never' }] }
      expect(plan).toEqual({ edits: [] })
    } finally {
      db.close()
    }
  }, 60_000)
})
