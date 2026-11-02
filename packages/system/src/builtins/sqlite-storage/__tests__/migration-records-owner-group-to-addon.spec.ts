/**
 * The hub migration that re-owns record kinds a grouped runner declared under its GROUP id to the
 * ADDON id, run by the real engine over a real SQLite file with the real `records` layout: the
 * rows follow their kind (a MARKED field and the row id survive), a kind of an unrelated owner is
 * untouched, a clash with an addon-owned kind fails naming both and writes nothing, a row carrying
 * a keychain marker minted under the group is refused, and a second pass is a no-op.
 */
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import {
  RECORDS_OWNER_GROUP_TO_ADDON_MIGRATION,
  RECORDS_OWNER_GROUP_TO_ADDON_MIGRATION_ID,
} from '../../../migrations/hub/2026-11-02-records-owner-group-to-addon.js'
import { MigrationEngine } from '../migrations/migration-engine.js'
import type { HubMigration } from '../migrations/migration-types.js'
import { openOwnedSqliteFile } from '../owned-sqlite-file.js'
import { declareKind, ensureRecordsSchema } from '../records/records-catalog.js'
import { integrationRegistryRecordKinds } from '../integration-record-kinds.js'
import { SqliteSnapshotter } from '../sqlite-snapshotter.js'
import { makeHarness, recordingLogger, type Harness } from './support/owned-files-harness.js'

const SNAPSHOT_WORKER = fileURLToPath(new URL('../sqlite-snapshot-worker.ts', import.meta.url))

let h: Harness

afterEach(() => {
  h.cleanup()
})

interface Seed {
  readonly owner: string
  readonly kind: string
  readonly id: string
  readonly data: Record<string, unknown>
}

function seedDb(rows: readonly Seed[]): void {
  const db = new Database(h.pathOf('settings'))
  ensureRecordsSchema(db)
  const declaration = integrationRegistryRecordKinds.integrations.declaration
  const insert = db.prepare(
    'INSERT INTO records(kind_id, id, rev, updated_at, data) VALUES (?, ?, 3, 100, jsonb(?))',
  )
  for (const r of rows) {
    const kindId = declareKind(db, r.owner, r.kind, declaration, undefined).row.kindId
    insert.run(kindId, r.id, JSON.stringify(r.data))
  }
  db.close()
}

function declareOnly(owner: string, kind: string): void {
  const db = new Database(h.pathOf('settings'))
  declareKind(db, owner, kind, integrationRegistryRecordKinds.integrations.declaration, undefined)
  db.close()
}

function stored(): Record<string, { mark: unknown; rev: number }> {
  const db = new Database(h.pathOf('settings'), { readonly: true })
  try {
    const out: Record<string, { mark: unknown; rev: number }> = {}
    for (const row of db
      .prepare(
        'SELECT k.owner AS owner, k.kind AS kind, r.id AS id, r.rev AS rev, json(r.data) AS data FROM records r JOIN _record_kinds k ON k.kind_id = r.kind_id',
      )
      .all() as {
      owner: string
      kind: string
      id: string
      rev: number
      data: string
    }[]) {
      out[`${row.owner}/${row.kind}/${row.id}`] = {
        mark: (JSON.parse(row.data) as Record<string, unknown>)['mark'],
        rev: row.rev,
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
      .get(RECORDS_OWNER_GROUP_TO_ADDON_MIGRATION_ID) as
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

const ONE = [RECORDS_OWNER_GROUP_TO_ADDON_MIGRATION]

describe('hub migration: records are owned by the addon id, not the runner group', () => {
  it('re-owns the group kinds to the addon, rows follow with the marked field, others untouched', async () => {
    h = makeHarness()
    seedDb([
      {
        owner: 'net-access',
        kind: 'servers',
        id: 'a',
        data: { mark: 'M-servers' },
      },
      {
        owner: 'net-access',
        kind: 'accounts',
        id: 'b',
        data: { mark: 'M-accounts' },
      },
      {
        owner: 'integrations',
        kind: 'waste-source',
        id: 'c',
        data: { mark: 'M-waste' },
      },
      {
        owner: 'net-access',
        kind: 'unlisted',
        id: 'd',
        data: { mark: 'M-unlisted' },
      },
      {
        owner: 'someone-else',
        kind: 'servers',
        id: 'e',
        data: { mark: 'M-else' },
      },
    ])
    await runPass(ONE, 'boot-1')
    const after = stored()
    expect(after['static-turn/servers/a']).toEqual({
      mark: 'M-servers',
      rev: 3,
    })
    expect(after['cloudflare-turn/accounts/b']).toEqual({
      mark: 'M-accounts',
      rev: 3,
    })
    expect(after['waste-collections/waste-source/c']).toEqual({
      mark: 'M-waste',
      rev: 3,
    })
    expect(after['net-access/unlisted/d']).toEqual({
      mark: 'M-unlisted',
      rev: 3,
    })
    expect(after['someone-else/servers/e']).toEqual({ mark: 'M-else', rev: 3 })
    expect(ledger()?.status).toBe('applied')
  }, 60_000)

  it('a second pass is a no-op', async () => {
    h = makeHarness()
    seedDb([{ owner: 'net-access', kind: 'servers', id: 'a', data: { mark: 'M' } }])
    await runPass(ONE, 'boot-1')
    const first = stored()
    await runPass(ONE, 'boot-2')
    expect(stored()).toEqual(first)
  }, 60_000)

  it('an addon-owned kind already present fails naming both and writes nothing', async () => {
    h = makeHarness()
    seedDb([{ owner: 'net-access', kind: 'servers', id: 'a', data: { mark: 'M' } }])
    declareOnly('static-turn', 'servers')
    await runPass(ONE, 'boot-1')
    expect(stored()['net-access/servers/a']).toEqual({ mark: 'M', rev: 3 })
    const row = ledger()
    expect(row?.status).toBe('failed')
    expect(row?.error).toContain('net-access')
    expect(row?.error).toContain('static-turn')
  }, 60_000)

  it('a row holding a keychain marker minted under the group is refused, nothing moves', async () => {
    h = makeHarness()
    seedDb([
      {
        owner: 'net-access',
        kind: 'accounts',
        id: 'b',
        data: {
          mark: 'M',
          token: {
            $secret: 'secret://net-access/records/accounts/b/token',
            v: 1,
          },
        },
      },
      { owner: 'net-access', kind: 'servers', id: 'a', data: { mark: 'M' } },
    ])
    await runPass(ONE, 'boot-1')
    expect(stored()['net-access/servers/a']).toBeDefined()
    expect(ledger()?.status).toBe('failed')
    expect(ledger()?.error).toContain('net-access')
  }, 60_000)

  it('a hub without the records tables is left alone', async () => {
    h = makeHarness()
    new Database(h.pathOf('settings')).close()
    await runPass(ONE, 'boot-1')
    expect(ledger()?.status).toBe('applied')
  }, 60_000)
})
