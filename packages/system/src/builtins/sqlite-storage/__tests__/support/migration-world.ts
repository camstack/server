/**
 * A migration world on REAL SQLite (planning#447): the settings file opened the way the hub
 * opens it, the real MigrationEngine and MigrationsProvider on it, the real records provider
 * and settings door over the same file, and `createMigrationApi` over all of them for any
 * owner. Nothing is faked between a migration body's `MigrationApiV1` and the database except
 * the keychain (in memory) and the caller stamp, which is stated the way the transport states it.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  type AddonMigrationHost,
  createRecordsAccess,
  createSecretsAccess,
  type IMigrationsProvider,
  type MigrationApiV1,
  type RecordsAccess,
} from '@camstack/types'
import Database from 'better-sqlite3'
import { z } from 'zod'
import {
  createMigrationApi,
  type DevicesDoor,
} from '../../../../kernel/moleculer/migration-api-facade.js'
import { createDoorSettingsView } from '../../../../kernel/settings-door-view.js'
import { createDataStoreDispatch } from '../../../storage-orchestrator/data-store-dispatch.js'
import type { PlacementRouter } from '../../placement-router.js'
import { RecordsProvider } from '../../records/records-provider.js'
import {
  installedRunnerResolver,
  installedSiblingResolver,
} from '../../migrations/installed-runner-resolver.js'
import { MigrationEngine } from '../../migrations/migration-engine.js'
import type { HubMigration } from '../../migrations/migration-types.js'
import { MigrationsProvider } from '../../migrations/migrations-provider.js'
import { InlineOwnedFile, openOwnedSqliteFile } from '../../owned-sqlite-file.js'
import { SqliteSnapshotter } from '../../sqlite-snapshotter.js'
import { type LoggedLine, makeHarness, recordingLogger } from './owned-files-harness.js'
import { makeFakeKeychain, stampedRecordsTransport } from './records-world.js'

const SNAPSHOT_WORKER = fileURLToPath(new URL('../../sqlite-snapshot-worker.ts', import.meta.url))
const EXEC_ARGV = ['--import', 'tsx']

/** An installed package: its directory name and the addons its manifest declares. */
export interface InstalledPackage {
  readonly dir: string
  readonly addons: readonly { readonly id: string; readonly group?: string }[]
}

export interface MigrationWorldOptions {
  /** The hub catalogue the engine knows (empty for a spec that only exercises an addon's). */
  readonly hubCatalogue?: readonly HubMigration[]
  readonly installed?: readonly InstalledPackage[]
  /** Write the legacy data into the settings file BEFORE it opens, so the hub catalogue meets it. */
  readonly seedBefore?: (db: Database.Database) => void
}

export interface MigrationWorld {
  /** The settings file's connection: seed and read it directly. */
  readonly db: Database.Database
  readonly lines: LoggedLine[]
  readonly engine: MigrationEngine
  /** Run the hub catalogue over the open file once more (a second boot of the same code). */
  rerunHubCatalogue(): Promise<void>
  readonly provider: MigrationsProvider
  /** Register an integration row so the legacy-rows door knows its owner. */
  addIntegration(row: { id: string; addonId: string; name?: string }): void
  /** Register a device row (the registry stand-in the devices door reads). */
  addDevice(row: {
    id: number
    addonId: string
    integrationId?: string
    parentDeviceId?: number
    name?: string
    alias?: string
    config?: Record<string, unknown>
  }): void
  /** `ctx.settings` of `owner`, to seed its per-device store before a migration reads it. */
  settingsFor(owner: string): ReturnType<typeof createDoorSettingsView>
  /** The migration API as `owner` sees it. */
  apiFor(owner: string): MigrationApiV1
  /** `ctx.records` of `owner`: declare its kinds here before a migration binds one. */
  recordsFor(owner: string): RecordsAccess
  /** The ledger host as the transport presents `owner`. */
  hostFor(owner: string): AddonMigrationHost
  readonly keychain: ReturnType<typeof makeFakeKeychain>
  cleanup(): Promise<void>
}

export async function makeMigrationWorld(
  options: MigrationWorldOptions = {},
): Promise<MigrationWorld> {
  const h = makeHarness()
  const addonsDir = mkdtempSync(path.join(tmpdir(), 'migration-world-addons-'))
  for (const pkg of options.installed ?? []) {
    mkdirSync(path.join(addonsDir, pkg.dir), { recursive: true })
    writeFileSync(
      path.join(addonsDir, pkg.dir, 'package.json'),
      JSON.stringify({
        camstack: {
          addons: pkg.addons.map((a) => ({
            id: a.id,
            execution: {
              placement: 'hub-only',
              ...(a.group === undefined ? {} : { group: a.group }),
            },
          })),
        },
      }),
    )
  }
  const catalogue = options.hubCatalogue ?? []
  const engine = new MigrationEngine({
    logger: recordingLogger(h.lines, 'Migrations'),
    catalogue,
    codeVersion: '1.0.0',
    runnerIdOf: installedRunnerResolver(addonsDir),
    snapshotterFor: (livePath) =>
      new SqliteSnapshotter({
        livePath,
        logger: recordingLogger(h.lines, 'Snapshot'),
        workerPath: SNAPSHOT_WORKER,
        workerExecArgv: EXEC_ARGV,
      }),
  })
  if (options.seedBefore !== undefined) {
    const seed = new Database(h.pathOf('settings'))
    try {
      options.seedBefore(seed)
    } finally {
      seed.close()
    }
  }
  let rerun: () => Promise<void> = async () => undefined
  const file = await openOwnedSqliteFile(h.specOf('settings'), {
    ...h.deps,
    migrationCatalogue: catalogue,
    afterOpen: async (opened) => {
      rerun = () =>
        engine.runFile({
          databaseId: opened.databaseId,
          livePath: opened.livePath,
          call: (op, input) => opened.migrate(op, input),
        })
      await rerun()
    },
  })
  if (!(file instanceof InlineOwnedFile)) throw new Error('settings is served inline')
  const db = file.backend.getDatabase()
  if (db === null) throw new Error('the settings file has no connection')
  db.exec(
    'CREATE TABLE IF NOT EXISTS integrations (id TEXT PRIMARY KEY NOT NULL, addon_id TEXT NOT NULL, name TEXT)',
  )
  db.exec(
    "CREATE TABLE IF NOT EXISTS spec_devices (id INTEGER PRIMARY KEY NOT NULL, addon_id TEXT NOT NULL, integration_id TEXT, parent_device_id INTEGER, name TEXT, config TEXT NOT NULL DEFAULT '{}', alias TEXT)",
  )
  const provider = new MigrationsProvider(engine, {
    database: () => db,
    runnerIdOf: installedRunnerResolver(addonsDir),
    areSiblings: installedSiblingResolver(addonsDir),
  })
  const router = { openFiles: () => [file], recordsFileFor: async () => file }
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- documented type boundary: a two-method stand-in for the router in a spec
  const records = new RecordsProvider(
    router as unknown as PlacementRouter,
    recordingLogger(h.lines),
  )
  await records.init()
  const door = createDataStoreDispatch(() => [file.backend])
  const keychain = makeFakeKeychain()

  const stamp = <T extends object>(owner: string, input: T): T =>
    Object.assign({}, input, { callerAddonId: owner })
  const hostFor = (owner: string): AddonMigrationHost => ({
    declareOwner: (input) => provider.declareOwner(stamp(owner, input)),
    startMigration: (input) => provider.startMigration(stamp(owner, input)),
    finishMigration: (input) => provider.finishMigration(stamp(owner, input)),
  })

  const recordsByOwner = new Map<string, RecordsAccess>()
  const recordsFor = (owner: string): RecordsAccess => {
    const known = recordsByOwner.get(owner)
    if (known !== undefined) return known
    const made = createRecordsAccess({
      owner,
      transport: stampedRecordsTransport(records, owner),
      secrets: createSecretsAccess({ owner, transport: keychain }),
    })
    recordsByOwner.set(owner, made)
    return made
  }

  return {
    db,
    lines: h.lines,
    recordsFor,
    engine,
    rerunHubCatalogue: () => rerun(),
    provider,
    keychain,
    addIntegration: (row) => {
      db.prepare('INSERT INTO integrations (id, addon_id, name) VALUES (?, ?, ?)').run(
        row.id,
        row.addonId,
        row.name ?? row.id,
      )
    },
    addDevice: (row) => {
      db.prepare(
        'INSERT INTO spec_devices (id, addon_id, integration_id, parent_device_id, name, config, alias) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(
        row.id,
        row.addonId,
        row.integrationId ?? null,
        row.parentDeviceId ?? null,
        row.name ?? `device-${row.id}`,
        JSON.stringify(row.config ?? {}),
        row.alias ?? null,
      )
    },
    hostFor,
    settingsFor: (owner) =>
      createDoorSettingsView(owner, door, {
        getSection: async () => ({}),
        setSection: () => undefined,
      }),
    apiFor: (owner) => {
      const secrets = createSecretsAccess({ owner, transport: keychain })
      const legacy: Pick<
        IMigrationsProvider,
        | 'readLegacyIntegrationRows'
        | 'clearLegacyIntegrationRows'
        | 'patchLegacyIntegrationRows'
        | 'deleteLegacyIntegrationRowKeys'
      > = provider
      return createMigrationApi({
        nodeId: 'hub-test',
        logger: recordingLogger(h.lines, owner),
        ledger: hostFor(owner),
        legacy: {
          read: (i) => legacy.readLegacyIntegrationRows(stamp(owner, i)),
          clear: (i) => legacy.clearLegacyIntegrationRows(stamp(owner, i)),
          patch: (i) => legacy.patchLegacyIntegrationRows(stamp(owner, i)),
          deleteKeys: (i) => legacy.deleteLegacyIntegrationRowKeys(stamp(owner, i)),
        },
        devices: devicesDoor(db),
        listIntegrations: async () =>
          db
            .prepare('SELECT id, addon_id AS addonId, name FROM integrations ORDER BY id')
            .all()
            .flatMap((row) =>
              typeof row === 'object' &&
              row !== null &&
              'id' in row &&
              'addonId' in row &&
              'name' in row &&
              typeof row.id === 'string' &&
              typeof row.addonId === 'string' &&
              typeof row.name === 'string'
                ? [{ id: row.id, addonId: row.addonId, name: row.name, info: {} }]
                : [],
            ),
        records: recordsFor(owner),
        secrets,
        settings: createDoorSettingsView(owner, door, {
          getSection: async () => ({}),
          setSection: () => undefined,
        }),
      })
    },
    cleanup: async () => {
      await file.stop()
      h.cleanup()
      rmSync(addonsDir, { recursive: true, force: true })
    },
  }
}

const DeviceRowSchema = z.object({
  id: z.number(),
  integration_id: z.string().nullable(),
  parent_device_id: z.number().nullable(),
  name: z.string(),
  config: z.string(),
  alias: z.string().nullable(),
})

/** The real SQL behind the devices door of the spec world. */
function devicesDoor(db: Database.Database): DevicesDoor {
  const rows = (sql: string, ...args: (string | number)[]) =>
    db
      .prepare(sql)
      .all(...args)
      .map((r) => DeviceRowSchema.parse(r))
  return {
    list: async (addonId) =>
      rows('SELECT * FROM spec_devices WHERE addon_id = ? ORDER BY id', addonId).map((r) => ({
        id: r.id,
        integrationId: r.integration_id,
        parentDeviceId: r.parent_device_id,
        name: r.name,
      })),
    get: async (deviceId) => {
      const found = rows('SELECT * FROM spec_devices WHERE id = ?', deviceId)[0]
      if (found === undefined) return null
      return {
        integrationId: found.integration_id,
        config: z.record(z.string(), z.unknown()).parse(JSON.parse(found.config)),
      }
    },
    setIntegrationId: async (deviceId, integrationId) => {
      db.prepare('UPDATE spec_devices SET integration_id = ? WHERE id = ?').run(
        integrationId,
        deviceId,
      )
    },
    aliasesOf: async (deviceIds) =>
      new Map(
        deviceIds.flatMap((id) => {
          const found = rows('SELECT * FROM spec_devices WHERE id = ?', id)[0]
          return found?.alias == null ? [] : [[id, found.alias] as const]
        }),
      ),
  }
}
