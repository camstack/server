/**
 * The second Loki migration on REAL SQLite, through the real migration engine: the addon's
 * global settings live in the canonical `addon-settings` table (one row per key, id
 * `loki-logging.<key>`, data `{ addonId, key, value }`), and there is no
 * `loki-logging:addon-settings` table. The moved keys must go from where they are stored.
 */
import { fileURLToPath } from 'node:url'
import {
  type AddonMigrationHost,
  defineAddonMigrations,
  makeInMemoryRecords,
  runAddonMigrations,
} from '@camstack/types'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MigrationEngine } from '../../../sqlite-storage/migrations/migration-engine.js'
import { MigrationsProvider } from '../../../sqlite-storage/migrations/migrations-provider.js'
import { openOwnedSqliteFile } from '../../../sqlite-storage/owned-sqlite-file.js'
import { SqliteSnapshotter } from '../../../sqlite-storage/sqlite-snapshotter.js'
import {
  makeHarness,
  recordingLogger,
  type Harness,
} from '../../../sqlite-storage/__tests__/support/owned-files-harness.js'
import { lokiDestinationsKind } from '../../loki-record-kinds.js'
import { ADDON_MIGRATIONS, type LokiCataloguePorts } from '../index.js'

const SNAPSHOT_WORKER = fileURLToPath(
  new URL('../../../sqlite-storage/sqlite-snapshot-worker.ts', import.meta.url),
)
const wrapper = (addonId: string, key: string, value: unknown): string =>
  JSON.stringify({ addonId, key, value })

let h: Harness
beforeEach(() => {
  h = makeHarness()
  const seed = new Database(h.pathOf('settings'))
  seed.exec('CREATE TABLE "addon-settings" (id TEXT PRIMARY KEY NOT NULL, data TEXT NOT NULL)')
  const insert = seed.prepare('INSERT INTO "addon-settings" (id, data) VALUES (?, ?)')
  insert.run('loki-logging.url', wrapper('loki-logging', 'url', 'http://loki:3100'))
  insert.run('loki-logging.batchSize', wrapper('loki-logging', 'batchSize', 50))
  insert.run('loki-logging.level', wrapper('loki-logging', 'level', 'warn'))
  insert.run('loki-logging.migratedEnabled', wrapper('loki-logging', 'migratedEnabled', true))
  insert.run('other-addon.url', wrapper('other-addon', 'url', 'keep-me'))
  seed.close()
})
afterEach(() => {
  h.cleanup()
})

function rows(): Record<string, string> {
  const db = new Database(h.pathOf('settings'), { readonly: true })
  try {
    const all = db.prepare('SELECT id, data FROM "addon-settings"').all()
    return Object.fromEntries(
      all.flatMap((r) =>
        typeof r === 'object' && r !== null && 'id' in r && 'data' in r
          ? [[String(r.id), String(r.data)]]
          : [],
      ),
    )
  } finally {
    db.close()
  }
}

/** Each ledger row as `status`, or `status: error` for a failed one. */
function ledger(): Record<string, string> {
  const db = new Database(h.pathOf('settings'), { readonly: true })
  try {
    const all = db.prepare('SELECT id, status, error FROM _migrations').all()
    return Object.fromEntries(
      all.flatMap((r) =>
        typeof r === 'object' && r !== null && 'id' in r && 'status' in r
          ? [[String(r.id), 'error' in r && r.error ? `${r.status}: ${r.error}` : String(r.status)]]
          : [],
      ),
    )
  } finally {
    db.close()
  }
}

/** The addon's global read, as the settings backend answers it: the wrappers unwrapped. */
function storedValues(): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [id, data] of Object.entries(rows())) {
    if (!id.startsWith('loki-logging.')) continue
    out[id.slice('loki-logging.'.length)] = JSON.parse(data).value
  }
  return out
}

describe('loki-logging/2026-11-02-drop-moved-settings on real SQLite', () => {
  it('removes the moved keys from the canonical addon-settings table, other rows untouched', async () => {
    const lines: string[] = []
    const engine = new MigrationEngine({
      logger: recordingLogger(h.lines, 'Migrations'),
      catalogue: [],
      codeVersion: '1.0.0',
      snapshotterFor: (livePath) =>
        new SqliteSnapshotter({
          livePath,
          logger: recordingLogger(h.lines, 'Snapshot'),
          workerPath: SNAPSHOT_WORKER,
          workerExecArgv: ['--import', 'tsx'],
        }),
    })
    await openOwnedSqliteFile(h.specOf('settings'), {
      ...h.deps,
      migrationCatalogue: [],
      afterOpen: async (opened) => {
        await engine.runFile({
          databaseId: opened.databaseId,
          livePath: opened.livePath,
          call: (op, input) => opened.migrate(op, input),
        })
      },
    })
    const provider = new MigrationsProvider(engine)
    const stamp = <T extends object>(input: T): T =>
      Object.assign({}, input, { callerAddonId: 'loki-logging' })
    const host: AddonMigrationHost = {
      declareOwner: (input) => provider.declareOwner(stamp(input)),
      startMigration: (input) => provider.startMigration(stamp(input)),
      finishMigration: (input) => provider.finishMigration(stamp(input)),
    }
    const memory = makeInMemoryRecords('loki-logging')
    await memory.records.declare({ destinations: lokiDestinationsKind })
    const handle = memory.records.kind(lokiDestinationsKind)
    const ports: LokiCataloguePorts = {
      readStored: async () => storedValues(),
      readRawStored: async () => storedValues(),
      warn: (message) => {
        lines.push(message)
      },
      ensureIntegration: async () => 'int_0007',
      findIntegration: async () => 'int_0007',
      putRecord: async (id, body) => {
        await handle.put({ id, data: body }, { ifRev: 0 })
        return 'created'
      },
      readRecord: async (id) => {
        const row = await handle.getResolved(id)
        return row === null ? null : { url: row.data.url, hasPassword: false }
      },
      clearOldPassword: async () => undefined,
      readRegistryState: async () => 'active',
      findToggleRecord: async () => null,
      disableRecord: async () => undefined,
      enableRegistry: async () => undefined,
    }
    const report = await runAddonMigrations(
      host,
      defineAddonMigrations(ADDON_MIGRATIONS, ports),
      recordingLogger(h.lines, 'Addon'),
    )
    expect(ledger()).toEqual({
      'loki-logging/2026-11-02-connection-to-records': 'applied',
      'loki-logging/2026-11-02-drop-moved-settings': 'applied',
      'loki-logging/2026-11-02-registry-toggle-to-record': 'applied',
    })
    expect(report.failed ?? []).toEqual([])
    expect(report.applied).toEqual([
      'loki-logging/2026-11-02-connection-to-records',
      'loki-logging/2026-11-02-drop-moved-settings',
      'loki-logging/2026-11-02-registry-toggle-to-record',
    ])
    expect(Object.keys(rows()).sort()).toEqual(['loki-logging.migratedEnabled', 'other-addon.url'])
    expect(rows()['other-addon.url']).toBe(wrapper('other-addon', 'url', 'keep-me'))
  })
})
