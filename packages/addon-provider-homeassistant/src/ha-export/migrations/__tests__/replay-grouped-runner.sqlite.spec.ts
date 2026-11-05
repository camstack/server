/**
 * REPLAY (planning#445): an install that jumps versions runs OLD addon migrations against CURRENT
 * server code. This replays the whole `homeassistant-export` catalogue from the pre-migration
 * shape (legacy `addon-settings` keys + the leftover rows of the integration owned by the SIBLING
 * `provider-homeassistant`) through the real path a grouped runner takes: the addon's declaration
 * from the real manifest, its real runner id (`resolveRunnerId`), the real UDS caller stamping
 * (`LocalChildRegistry` + `createUdsAddonContext`), the real `MigrationsProvider` and engine over
 * real SQLite. It iterates the catalogue, so a future migration that needs a door the runner
 * cannot reach fails here. Every migration must be applied or skipped; none failed or blocked.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  type AddonDeclaration,
  defineAddonMigrations,
  makeInMemoryRecords,
  resolveRunnerId,
  runAddonMigrations,
} from '@camstack/types'
import { z } from 'zod'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createUdsAddonContext } from '../../../../../system/src/kernel/moleculer/addon-context-factory.js'
import { createLocalTransport } from '../../../../../system/src/kernel/transport/create-local-transport.js'
import { LocalChildClient } from '../../../../../system/src/kernel/transport/local-child-client.js'
import { LocalChildRegistry } from '../../../../../system/src/kernel/transport/local-child-registry.js'
import {
  installedRunnerResolver,
  installedSiblingResolver,
} from '../../../../../system/src/builtins/sqlite-storage/migrations/installed-runner-resolver.js'
import {
  ensureLegacyIntegrationRowsTable,
  patchLegacyIntegrationRows,
} from '../../../../../system/src/builtins/sqlite-storage/migrations/legacy-integration-rows-door.js'
import { MigrationEngine } from '../../../../../system/src/builtins/sqlite-storage/migrations/migration-engine.js'
import { MigrationsProvider } from '../../../../../system/src/builtins/sqlite-storage/migrations/migrations-provider.js'
import {
  InlineOwnedFile,
  openOwnedSqliteFile,
} from '../../../../../system/src/builtins/sqlite-storage/owned-sqlite-file.js'
import { SqliteSnapshotter } from '../../../../../system/src/builtins/sqlite-storage/sqlite-snapshotter.js'
import {
  makeHarness,
  recordingLogger,
  type Harness,
} from '../../../../../system/src/builtins/sqlite-storage/__tests__/support/owned-files-harness.js'
import { haExportTargetsKind } from '../../target-records.js'
import { haExportLinksKind } from '../legacy-links-kind.js'
import { haExportMigrationPorts } from '../bind-ports.js'
import { ADDON_MIGRATIONS } from '../index.js'

const SNAPSHOT_WORKER = fileURLToPath(
  new URL(
    '../../../../../system/src/builtins/sqlite-storage/sqlite-snapshot-worker.ts',
    import.meta.url,
  ),
)
const MANIFEST = fileURLToPath(new URL('../../../../package.json', import.meta.url))
const EXPORT = 'homeassistant-export'
const PROVIDER = 'provider-homeassistant'
const INTEGRATION = 'int_0006'

const StoredRows = z.array(z.object({ id: z.string(), data: z.string() }))
const wrapper = (key: string, value: unknown): string =>
  JSON.stringify({ addonId: EXPORT, key, value })

let h: Harness
let addonsDir: string
beforeEach(() => {
  h = makeHarness()
  addonsDir = mkdtempSync(path.join(os.tmpdir(), 'replay-addons-'))
  mkdirSync(path.join(addonsDir, '@camstack', 'provider-homeassistant'), {
    recursive: true,
  })
  // The REAL manifest: the export's `execution.group` is what puts it in its own runner.
  writeFileSync(
    path.join(addonsDir, '@camstack', 'provider-homeassistant', 'package.json'),
    readFileSync(MANIFEST, 'utf-8'),
  )
})
afterEach(() => {
  h.cleanup()
  rmSync(addonsDir, { recursive: true, force: true })
})

describe('homeassistant-export catalogue replayed in its real grouped runner', () => {
  it('applies every migration: none is refused by the migrations door', async () => {
    const runnerIdOf = installedRunnerResolver(addonsDir)
    const runnerId = runnerIdOf(EXPORT)
    // The premise: the sibling is in another runner than the export, as shipped.
    expect(runnerId).not.toBe(EXPORT)
    expect(runnerIdOf(PROVIDER)).toBe(PROVIDER)

    const engine = new MigrationEngine({
      logger: recordingLogger(h.lines, 'Migrations'),
      catalogue: [],
      codeVersion: '1.0.0',
      runnerIdOf,
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
      migrationCatalogue: [],
      afterOpen: async (opened) => {
        await engine.runFile({
          databaseId: opened.databaseId,
          livePath: opened.livePath,
          call: (op, input) => opened.migrate(op, input),
        })
      },
    })
    if (!(file instanceof InlineOwnedFile)) throw new Error('settings is served inline')
    const db = file.backend.getDatabase()
    if (db === null) throw new Error('the settings database is not open')

    // The pre-migration shape: the addon's old keys, the integration of the SIBLING and its rows.
    db.exec(
      'CREATE TABLE IF NOT EXISTS "addon-settings" (id TEXT PRIMARY KEY NOT NULL, data TEXT NOT NULL)',
    )
    const put = db.prepare('INSERT INTO "addon-settings" (id, data) VALUES (?, ?)')
    const legacy: Record<string, unknown> = {
      membership: { ha_001: ['101', '104'] },
      'exportTo:ha_001': true,
      'mediaRole:ha_001': 'publicEndpoint',
      publicBaseUrl: 'http://ha.example.com',
      reconcileIntervalSec: 217,
    }
    for (const [key, value] of Object.entries(legacy))
      put.run(`${EXPORT}.${key}`, wrapper(key, value))
    db.exec(
      'CREATE TABLE IF NOT EXISTS integrations (id TEXT PRIMARY KEY NOT NULL, addon_id TEXT NOT NULL)',
    )
    db.prepare('INSERT INTO integrations (id, addon_id) VALUES (?, ?)').run(INTEGRATION, PROVIDER)
    ensureLegacyIntegrationRowsTable(db)
    patchLegacyIntegrationRows(db, INTEGRATION, {
      brokerId: 'ha_001',
      exportTo: true,
    })

    const provider = new MigrationsProvider(engine, {
      database: () => db,
      runnerIdOf,
      areSiblings: installedSiblingResolver(addonsDir),
    })

    // The real caller stamping: the parent stamps what the UDS connection and the claim prove.
    const registry = new LocalChildRegistry({
      server: createLocalTransport().createServer('hub'),
      resolveChildIdForAddon: runnerIdOf,
      onUnownedCall: async (input) => {
        if (input.capName === 'integrations' && input.method === 'list') {
          return [{ id: INTEGRATION, addonId: PROVIDER }]
        }
        if (input.capName !== 'migrations') throw new Error(`unexpected ${input.capName}`)
        const args: object = typeof input.args === 'object' && input.args !== null ? input.args : {}
        const stamped = { ...args, callerAddonId: input.callerAddonId }
        const method: unknown = Reflect.get(provider, input.method)
        if (typeof method !== 'function') throw new Error(`no migrations.${input.method}`)
        return method.call(provider, stamped)
      },
    })
    registry.onReadinessSnapshotRequest(() => [])
    await registry.start()
    const client = new LocalChildClient({
      nodeId: 'hub',
      childId: runnerId,
      caps: [],
      dispatch: async () => {
        throw new Error('no inbound caps')
      },
    })
    await client.start()
    try {
      const declaration: AddonDeclaration = {
        id: EXPORT,
        entry: './index.js',
        execution: { placement: 'hub-only', group: 'integrations' },
      }
      expect(resolveRunnerId(declaration, EXPORT)).toBe(runnerId)
      const ctx = await createUdsAddonContext(client, `hub/${runnerId}`, declaration, h.dir)
      const api = ctx.api.migrations

      const memory = makeInMemoryRecords(EXPORT)
      await memory.records.declare({ 'ha-export-links': haExportLinksKind })
      await memory.records.declare({
        'ha-export-targets': haExportTargetsKind,
      })
      const ports = haExportMigrationPorts({
        readStored: async () => {
          const out: Record<string, unknown> = {}
          for (const row of StoredRows.parse(
            db.prepare('SELECT id, data FROM "addon-settings"').all(),
          )) {
            if (row.id.startsWith(`${EXPORT}.`)) {
              out[row.id.slice(EXPORT.length + 1)] = JSON.parse(row.data).value
            }
          }
          return out
        },
        api: {
          integrations: ctx.api.integrations,
          migrations: api,
        },
        links: memory.records.kind(haExportLinksKind),
        targets: memory.records.kind(haExportTargetsKind),
        clearSettingKeys: async (keys) => {
          const del = db.prepare('DELETE FROM "addon-settings" WHERE id = ?')
          for (const key of keys) del.run(`${EXPORT}.${key}`)
        },
        warn: () => undefined,
      })
      const report = await runAddonMigrations(
        {
          declareOwner: (input) => api.declareOwner.mutate(input),
          startMigration: (input) => api.startMigration.mutate(input),
          finishMigration: (input) => api.finishMigration.mutate(input),
        },
        defineAddonMigrations(ADDON_MIGRATIONS, ports),
        recordingLogger(h.lines, 'Addon'),
      )

      expect(report.declared).toBe(true)
      expect(report.failed).toEqual([])
      expect(report.blocked).toEqual([])
      expect(report.blockOwner).toEqual([])
      // Every migration of the catalogue, not a hand list: applied, or skipped by design.
      const settled = new Set([...report.applied, ...report.skipped])
      expect([...settled].sort()).toEqual(ADDON_MIGRATIONS.map((m) => m.meta.id).sort())
      const ledger = (await provider.listLedger()).entries.filter((e) => e.owner === EXPORT)
      const notApplied = ledger.filter(
        (e) => report.applied.includes(e.id) && e.status !== 'applied',
      )
      expect(notApplied).toEqual([])
    } finally {
      await client.close()
      await registry.close()
      await file.stop()
    }
  })
})
