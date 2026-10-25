/**
 * D693 — through the real addon: a backup run that covers the settings
 * database asks its OWNER which database it owns and for the snapshot (both
 * pinned to this node), and a run whose snapshot failed uploads nothing and
 * says why on every destination.
 *
 * "Uploads nothing" is the point: an upload is what triggers the destination's
 * retention prune, and a run that landed an archive without the database (or
 * with the torn file copy it used to carry, D679) would push the oldest GOOD
 * archive out.
 *
 * Typed throughout: the context is `makeAddonContext` (its one documented type
 * boundary is the generated `AddonApi`), the settings store is the real
 * engine registered in a real `CapabilityRegistry`.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  type AddonContext,
  DATABASE_SNAPSHOT_PARTIAL_SUFFIX,
  DATABASE_SNAPSHOT_SUFFIX,
  type DatabaseSnapshotResult,
  type DatabaseSnapshotTargets,
  type DatabaseSnapshotWritten,
  type DataStoreDatabase,
  type IScopedLogger,
  nodePin,
  type StorageLocation,
  settingsStoreCapability,
} from '@camstack/types'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CapabilityRegistry } from '../../../kernel/capability-registry.js'
import {
  makeAddonContext,
  registrationsOf,
} from '../../device-manager/__tests__/typed-addon-context.js'
import { SqliteSettingsBackend } from '../../sqlite-storage/sqlite-settings-backend.js'
import { takeVerifiedCopy } from '../../sqlite-storage/sqlite-snapshot-worker.js'
import { BackupOrchestratorAddon } from '../backup-orchestrator.addon.js'
import { makeBackupRecords } from './support/backup-records.js'

/** The owner's side: a verified copy of `file`, as the snapshotter writes it. */
async function snapshotFileAt(file: string): Promise<DatabaseSnapshotResult> {
  const workDir = file + DATABASE_SNAPSHOT_PARTIAL_SUFFIX
  fs.mkdirSync(workDir)
  const copy = await takeVerifiedCopy({
    kind: 'sqlite-snapshot',
    livePath: file,
    copyPath: path.join(workDir, 'copy'),
    pagesPerStep: 64,
  })
  const snapshotPath = file + DATABASE_SNAPSHOT_SUFFIX
  fs.renameSync(path.join(workDir, 'copy'), snapshotPath)
  fs.rmSync(workDir, { recursive: true })
  return {
    livePath: file,
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

interface DestinationWire {
  readonly id: string
  readonly lastError?: string
}

interface TriggerResult {
  readonly entries: readonly unknown[]
}

interface BackupProvider {
  readonly trigger: (input?: {
    destinations?: string[]
    locations?: string[]
    databases?: DataStoreDatabase[]
  }) => Promise<TriggerResult>
  readonly listDestinations: () => Promise<readonly DestinationWire[]>
  readonly listRuns: () => Promise<readonly { readonly state: string }[]>
}

function isBackupProvider(value: unknown): value is BackupProvider {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'trigger') === 'function' &&
    typeof Reflect.get(value, 'listDestinations') === 'function' &&
    typeof Reflect.get(value, 'listRuns') === 'function'
  )
}

function quietLogger(): IScopedLogger {
  const logger: IScopedLogger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

function refusing(what: string): () => never {
  return () => {
    throw new Error(`${what} is not part of this test`)
  }
}

const SETTINGS: NonNullable<AddonContext['settings']> = {
  readAddonStore: async () => ({}),
  writeAddonStore: async () => undefined,
  readDeviceStoreBatch: refusing('settings.readDeviceStoreBatch'),
  listDeviceStoreIds: refusing('settings.listDeviceStoreIds'),
  readDeviceStore: refusing('settings.readDeviceStore'),
  writeDeviceStore: refusing('settings.writeDeviceStore'),
  clearDeviceStore: refusing('settings.clearDeviceStore'),
  getSection: refusing('settings.getSection'),
  setSection: refusing('settings.setSection'),
  readDeviceRuntimeState: refusing('settings.readDeviceRuntimeState'),
  writeDeviceRuntimeState: refusing('settings.writeDeviceRuntimeState'),
  clearDeviceRuntimeState: refusing('settings.clearDeviceRuntimeState'),
}

const DEST: StorageLocation = {
  id: 'backups:default',
  type: 'backups',
  displayName: 'backups:default',
  providerId: 'filesystem-storage',
  config: {},
  enabled: true,
  isSystem: false,
  createdAt: 1,
  updatedAt: 1,
}

/** The `database-snapshot` calls the addon made, with the pin each carried. */
interface OwnerCalls {
  readonly listDatabases: unknown[]
  readonly writeSnapshot: unknown[]
}

describe('the settings database enters a backup only as its owner snapshot (D693)', () => {
  let dataDir = ''
  let livePath = ''
  let eventsPath = ''
  let eventsLive: Database.Database
  let askedIds: string[] = []
  let live: Database.Database
  let settings: SqliteSettingsBackend
  let addon: BackupOrchestratorAddon
  let provider: BackupProvider
  let uploads: string[] = []
  let calls: OwnerCalls = { listDatabases: [], writeSnapshot: [] }
  let writeSnapshot: () => Promise<DatabaseSnapshotResult> = async () => {
    throw new Error('unset')
  }

  beforeEach(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'camstack-backup-owner-'))
    const sqliteDir = path.join(dataDir, 'addons-data', 'sqlite-settings')
    fs.mkdirSync(sqliteDir, { recursive: true })
    livePath = path.join(sqliteDir, 'camstack.db')
    live = new Database(livePath)
    live.pragma('journal_mode = WAL')
    live.exec('CREATE TABLE device (id INTEGER PRIMARY KEY, name TEXT)')
    live.prepare('INSERT INTO device (name) VALUES (?)').run('cam')
    askedIds = []
    eventsPath = path.join(sqliteDir, 'events.db')
    eventsLive = new Database(eventsPath)
    eventsLive.pragma('journal_mode = WAL')
    eventsLive.exec('CREATE TABLE ledger (id INTEGER PRIMARY KEY, name TEXT)')
    eventsLive.prepare('INSERT INTO ledger (name) VALUES (?)').run('event')
    uploads = []
    calls = { listDatabases: [], writeSnapshot: [] }
    settings = new SqliteSettingsBackend(':memory:')
    await settings.initialize()
    const registry = new CapabilityRegistry(quietLogger())
    registry.declareCapability(settingsStoreCapability)
    registry.registerProvider('settings-store', 'storage-orchestrator', settings)

    const blobs = new Map<string, Uint8Array>()
    const key = (loc: string, rel: string): string => `${loc}::${rel}`
    const api = {
      databaseSnapshot: {
        listDatabases: {
          query: async (_input: object, opts: unknown): Promise<DatabaseSnapshotTargets> => {
            calls.listDatabases.push(opts)
            return {
              databases: [
                { databaseId: 'settings', livePath },
                { databaseId: 'events', livePath: eventsPath },
              ],
            }
          },
        },
        writeSnapshot: {
          mutate: async (
            input: { databaseId: DataStoreDatabase },
            opts: unknown,
          ): Promise<DatabaseSnapshotWritten> => {
            calls.writeSnapshot.push(opts)
            askedIds.push(input.databaseId)
            if (input.databaseId === 'events') {
              return { ...(await snapshotFileAt(eventsPath)), databaseId: 'events' }
            }
            return { ...(await writeSnapshot()), databaseId: 'settings' }
          },
        },
      },
      storage: {
        listLocations: { query: async () => [DEST] },
        beginUpload: {
          mutate: async (input: { location: string }) => {
            uploads.push(input.location)
            return { uploadId: `up-${uploads.length.toString()}` }
          },
        },
        writeChunk: { mutate: async () => undefined },
        finalizeUpload: { mutate: async () => undefined },
        abortUpload: { mutate: async () => undefined },
        delete: { mutate: async () => undefined },
        exists: {
          query: async (input: { location: string; relativePath: string }) =>
            blobs.has(key(input.location, input.relativePath)),
        },
        read: {
          query: async (input: { location: string; relativePath: string }) =>
            blobs.get(key(input.location, input.relativePath)) ?? new Uint8Array(),
        },
        write: {
          mutate: async (input: { location: string; relativePath: string; data: Uint8Array }) => {
            blobs.set(key(input.location, input.relativePath), input.data)
          },
        },
      },
    }

    addon = new BackupOrchestratorAddon()
    const ctx: AddonContext = {
      ...makeAddonContext({
        id: 'backup-orchestrator',
        logger: quietLogger(),
        settings: SETTINGS,
        api,
        kernel: { localNodeId: 'hub', capabilityRegistry: registry },
      }),
      dataDir,
      nodeDataDir: dataDir,
      records: (await makeBackupRecords()).records,
    }
    const found = registrationsOf(await addon.initialize(ctx)).find((r) =>
      isBackupProvider(r.provider),
    )
    if (found === undefined || !isBackupProvider(found.provider)) {
      throw new Error('backup-orchestrator registered no backup provider')
    }
    provider = found.provider
  })

  afterEach(async () => {
    await addon.shutdown()
    live.close()
    eventsLive.close()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  it('a failed snapshot uploads NOTHING, fails the run, and records why on the destination', async () => {
    writeSnapshot = async () => {
      throw new Error('database snapshot refused (row-count): device: copy 2 ≠ source 1')
    }
    const result = await provider
      .trigger({ destinations: ['backups:default'], locations: ['addons-data'] })
      .catch((): TriggerResult => ({ entries: [] }))

    expect(result.entries).toEqual([])
    expect(uploads).toEqual([])
    const runs = await provider.listRuns()
    expect(runs.map((r) => r.state)).toEqual(['failed'])
    const dest = (await provider.listDestinations()).find((d) => d.id === 'backups:default')
    expect(dest?.lastError).toMatch(/snapshot failed.*row-count/)
  })

  it('asks the owner ON THIS NODE, archives its snapshot, and deletes it afterwards', async () => {
    writeSnapshot = async () => {
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
    const result = await provider.trigger({
      destinations: ['backups:default'],
      locations: ['addons-data'],
    })

    expect(calls.listDatabases).toEqual([nodePin('hub')])
    expect(calls.writeSnapshot).toEqual([nodePin('hub')])
    expect(result.entries).toHaveLength(1)
    expect(uploads).toEqual(['backups:default'])
    expect(fs.existsSync(livePath + DATABASE_SNAPSHOT_SUFFIX)).toBe(false)
  })

  it('a nightly run asks the owner for settings ONLY, though events.db is listed', async () => {
    writeSnapshot = () => snapshotFileAt(livePath)
    await provider.trigger({ destinations: ['backups:default'], locations: ['addons-data'] })
    expect(askedIds).toEqual(['settings'])
    expect(fs.existsSync(eventsPath + DATABASE_SNAPSHOT_SUFFIX)).toBe(false)
  })

  it('a weekly run asks for every database it carries, and leaves no copy behind', async () => {
    writeSnapshot = () => snapshotFileAt(livePath)
    const result = await provider.trigger({
      destinations: ['backups:default'],
      locations: ['addons-data'],
      databases: ['settings', 'events'],
    })
    expect(askedIds.toSorted()).toEqual(['events', 'settings'])
    expect(result.entries).toHaveLength(1)
    expect(fs.existsSync(livePath + DATABASE_SNAPSHOT_SUFFIX)).toBe(false)
    expect(fs.existsSync(eventsPath + DATABASE_SNAPSHOT_SUFFIX)).toBe(false)
  })
})
