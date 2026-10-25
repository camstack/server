import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import type { DataStoreDatabase, ProviderRegistration } from '@camstack/types'
import {
  BaseAddon,
  bareAddonId,
  databaseSnapshotCapability,
  dataStoreProviderCapability,
  recordsCapability,
  errMsg,
  RECORD_SWEEP_INTERVAL_MS,
  RUNTIME_DEFAULTS,
  storageAdminCapability,
  vectorStoreCapability,
} from '@camstack/types'
import {
  InlineOwnedFile,
  type OwnedFileDeps,
  type OwnedSqliteFile,
  type OwnedSqliteFileSpec,
  openOwnedSqliteFile,
} from './owned-sqlite-file.js'
import { DatabaseSnapshotProvider } from './database-snapshot-provider.js'
import { PlacementRouter } from './placement-router.js'
import { RecordsProvider } from './records/records-provider.js'
import { StorageAdminProvider } from './storage-admin-provider.js'
import { purgeRetiredSettingsKeys, retiredKeyStoreOf } from './retired-settings-keys.js'
import type { SqliteSettingsBackend } from './sqlite-settings-backend.js'
import type { SqliteVecVectorIndex } from './vector-index-vec.js'
import { vectorProviderOfOwnedFile } from './vector-provider.js'

/** The file name of each database inside the addon's private directory. */
const DATABASE_FILE_NAMES: Readonly<Record<DataStoreDatabase, string>> = {
  settings: 'camstack.db',
  events: 'events.db',
  history: 'history.db',
}

/**
 * SQLite Settings addon — the relational ENGINE behind the data door.
 *
 * Capability: `data-store-provider` (collection, internal). It does not
 * serve `settings-store`: that is the public door, owned by
 * storage-orchestrator, which dispatches here
 * ([D44](../../../../../docs/decisions/adr-0044.md)). Callers reach this
 * engine only through the door — which is the point, because it is what
 * makes the engine replaceable.
 *
 * ONE engine process, SEVERAL owned files ([D851](../../../../../docs/decisions/adr-0851-one-sqlite-engine-serves-several-owned-files-one-thread-per-file.md)):
 * `camstack.db` (settings) is served on this thread exactly as it always was;
 * `events.db` and `history.db`, when a collection names them, are each served
 * by a worker thread. A {@link PlacementRouter} is the provider the door sees.
 * The layout of the files is documented in `docs/architecture/storage-files.md`.
 *
 * It also serves `database-snapshot` (singleton, internal): the verified copy
 * of its database that the nightly backup archives in place of the live files
 * (D693).
 *
 * It ALSO serves `vector-store` (singleton, internal), from the **events**
 * file's worker thread (sqlite-vec loaded there). The capability is what keeps
 * the backend swappable; the package never was.
 */
export class SqliteSettingsAddon extends BaseAddon {
  private settingsFile: InlineOwnedFile | null = null
  private router: PlacementRouter | null = null
  private sweepTimer: NodeJS.Timeout | null = null
  private sweepStart: NodeJS.Timeout | null = null

  constructor() {
    super({})
  }

  /**
   * The engine behind `settings-store` cannot read that door during
   * `initialize()`. `BaseAddon` always `await`s `resolveConfig()` first;
   * on an isolated sqlite that round-trip is a UDS call to the parent,
   * and the parent is waiting for THIS child's post-init handshake before
   * it builds the door (D233). Live 1.2.152: 30 s hang, timeout, every
   * in-process builtin skipped, then this addon finished one second later.
   * Constructor defaults (`{}`) are the whole config this addon has.
   */
  protected override async resolveConfig(): Promise<void> {
    return
  }

  protected async onInitialize(): Promise<ProviderRegistration[]> {
    const addonId = bareAddonId(this.ctx.id)
    // Boot-order constraint: sqlite-settings is the ENGINE behind `settings-store`,
    // which the storage cap's orchestrator (and every BaseAddon's `resolveConfig`)
    // depends on. Asking `ctx.api.storage.resolve.query(...)` here would deadlock —
    // the storage singleton is owned by `storage-orchestrator`, which itself
    // initializes after sqlite-settings to read its location table. Resolve the
    // path directly from `dataDir` (the deterministic `<dataDir>/addons-data/<addonId>/camstack.db`
    // layout the filesystem-storage default also uses).
    //
    // The addon may run isolated (`execution.isolate`). That does not change this
    // path: `ctx.dataDir` is still this addon's private dir, just in a child
    // process. Isolated infra builtins spawn BEFORE in-process builtins so the
    // door is not answering against a missing engine.
    const dir = this.ctx.dataDir ?? path.join('camstack-data', 'addons-data', addonId)
    const pathSource = this.ctx.dataDir ? 'dataDir' : 'fallback (hardcoded)'
    const livePathOf = (databaseId: DataStoreDatabase): string =>
      path.join(dir, DATABASE_FILE_NAMES[databaseId])
    const settingsPath = livePathOf('settings')

    const dbExists = existsSync(settingsPath)
    if (!dbExists) {
      try {
        await mkdir(dir, { recursive: true })
      } catch (err) {
        this.ctx.logger.warn('Failed to check/create DB directory', {
          meta: { error: errMsg(err) },
        })
      }
    }
    this.ctx.logger.info('DB path resolved', { meta: { pathSource, dbPath: settingsPath } })
    this.ctx.logger.info('DB file status', { meta: { dbExists } })

    const deps: OwnedFileDeps = {
      logger: this.ctx.logger,
      // A serving thread that dies fails the RUNNER; CrashSupervisor respawns
      // it (D5, D6). There is no in-process thread restart.
      onFatal: () => process.exit(1),
      runtimeDefaults: { ...RUNTIME_DEFAULTS },
      afterOpen: (file) => this.purgeBeforeServing(file),
    }

    // `camstack.db` first, on this thread. Vectors live in `events.db` (P5).
    const settings = await openOwnedSqliteFile(
      {
        databaseId: 'settings',
        livePath: settingsPath,
        thread: 'main',
        autoVacuum: 'none',
        loadVectorExtension: false,
      },
      deps,
    )
    if (!(settings instanceof InlineOwnedFile)) {
      throw new Error('sqlite-settings: the settings file must be served on the main thread')
    }
    this.settingsFile = settings

    // Every other file that EXISTS is opened at boot. A file that does not
    // exist is created by the first declaration that names it — so a hub on
    // which nothing does grows no new file.
    const open = (databaseId: DataStoreDatabase): Promise<OwnedSqliteFile> =>
      openOwnedSqliteFile(workerSpec(databaseId, livePathOf(databaseId)), deps)
    const existing: OwnedSqliteFile[] = [settings]
    for (const databaseId of ['events', 'history'] as const) {
      if (existsSync(livePathOf(databaseId))) existing.push(await open(databaseId))
    }
    const router = new PlacementRouter({
      files: existing,
      open,
      logger: this.ctx.logger.child('Placement'),
    })
    this.router = router

    const vectorProvider = vectorProviderOfOwnedFile(() => router.recordsFileFor('events'))

    const records = new RecordsProvider(router, this.ctx.logger.child('Records'))
    await records.init()
    this.startRecordsSweep(records)

    this.ctx.logger.info('Initialized successfully')
    return [
      { capability: dataStoreProviderCapability, provider: router },
      { capability: recordsCapability, provider: records },
      { capability: vectorStoreCapability, provider: vectorProvider },
      {
        capability: databaseSnapshotCapability,
        provider: new DatabaseSnapshotProvider(router),
      },
      {
        capability: storageAdminCapability,
        provider: new StorageAdminProvider(
          settings.backend,
          this.ctx.logger.child('StorageAdmin'),
          records,
          async () => router.openFiles().filter((file) => file.databaseId !== 'settings'),
        ),
      },
    ]
  }

  /**
   * Housekeeping that must happen BEFORE anything can read a file: the
   * retired-key purge (settings file only).
   */
  private async purgeBeforeServing(file: OwnedSqliteFile): Promise<void> {
    // Delete configuration keys whose feature was removed. A dead key that
    // survives still LOOKS like live configuration — `detection-pipeline`'s
    // `pipelineSteps` blob sent an audit chasing a model no node was running.
    // A hand DELETE cleans one machine once; this runs on every HUB boot, so a
    // restored backup converges too.
    //
    // Hub-only by design: the addon settings store is hub-central
    // (`settings-store` is a singleton cap), so this is the one copy of the data
    // that exists — an agent has no `<addon>:addon-settings` rows to clean and
    // skips silently. Idempotent and silent when the store is already clean.
    // See `retired-settings-keys.ts` ([D78](../../../../../docs/decisions/adr-0078.md)).
    if (file instanceof InlineOwnedFile && file.databaseId === 'settings') {
      try {
        await purgeRetiredSettingsKeys(
          retiredKeyStoreOf(file.backend),
          this.ctx.logger.child('RetiredKeys'),
        )
        // Retired whole ROWS are NOT purged here. Their gate is the successor
        // collection being populated, and no addon has declared one yet at this
        // point in boot — so the owning addon runs `purgeRetiredSettingsRows`
        // itself, right after its own `declareCollection`.
      } catch (err) {
        // Never block boot on housekeeping — the keys are dead either way.
        this.ctx.logger.warn('Retired-key purge failed', { meta: { error: errMsg(err) } })
      }
    }
  }

  /**
   * The engine's TTL sweep (D881): every 10 minutes, off the boot path (the
   * first run a minute after boot), batched and yielding. A failed pass is
   * warned about and the next one retries; it never blocks anything.
   */
  private startRecordsSweep(records: RecordsProvider): void {
    const run = (): void => {
      records
        .sweepExpired()
        .then((deleted) => {
          if (deleted > 0) {
            this.ctx.logger.info('records: expired rows swept', { meta: { deleted } })
          }
        })
        .catch((err: unknown) => {
          this.ctx.logger.warn('records: expiry sweep failed', { meta: { error: errMsg(err) } })
        })
    }
    this.sweepStart = setTimeout(() => {
      run()
      this.sweepTimer = setInterval(run, RECORD_SWEEP_INTERVAL_MS)
      this.sweepTimer.unref()
    }, 60_000)
    this.sweepStart.unref()
  }

  protected async onShutdown(): Promise<void> {
    if (this.sweepStart !== null) clearTimeout(this.sweepStart)
    if (this.sweepTimer !== null) clearInterval(this.sweepTimer)
    this.sweepStart = null
    this.sweepTimer = null
    const files = this.router?.openFiles() ?? []
    // Settings stops last: the others are the ones with threads to join.
    for (const file of files.toReversed()) {
      try {
        await file.stop()
      } catch (err) {
        this.ctx.logger.warn('Database file did not stop cleanly', {
          tags: { database: file.databaseId },
          meta: { error: errMsg(err) },
        })
      }
    }
    this.router = null
    this.settingsFile = null
  }

  getBackend(): SqliteSettingsBackend | null {
    return this.settingsFile?.backend ?? null
  }

  /** The placement router; null before `onInitialize`. */
  getRouter(): PlacementRouter | null {
    return this.router
  }

  /** Exposed for tests; vectors are served from the events file (P5). */
  getVectorIndex(): SqliteVecVectorIndex | null {
    return null
  }
}

/** How a non-settings file is opened: its own worker; `events` loads sqlite-vec. */
function workerSpec(databaseId: DataStoreDatabase, livePath: string): OwnedSqliteFileSpec {
  return {
    databaseId,
    livePath,
    thread: 'worker',
    autoVacuum: 'incremental',
    loadVectorExtension: databaseId === 'events',
  }
}

export default SqliteSettingsAddon
