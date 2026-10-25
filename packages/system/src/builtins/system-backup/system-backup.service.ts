// =============================================================================
// SystemBackupService — stateless primitives for archive creation,
// manifest reading and restore-marker scheduling. The restore itself is the
// launcher's (`server/backend/src/launcher.ts`): it runs before any runner, and
// it is the one place that promotes a database snapshot back (D693).
//
// Owned by the server-backend (not by an addon). Storage policy
// (where to put the archive, retention, schedule) is the
// responsibility of the caller — typically the `local-backup` addon
// or a future `s3-backup` / `rsync-backup`. The primitives below have
// zero state and zero scheduling logic; they're pure I/O.
// =============================================================================

import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import * as zlib from 'node:zlib'
import {
  type ArchiveSqliteSnapshot,
  DATABASE_SNAPSHOT_PARTIAL_SUFFIX,
  DATABASE_SNAPSHOT_SUFFIX,
  type DatabaseSnapshotWritten,
  type DataStoreDatabase,
  type IScopedLogger,
} from '@camstack/types'
import * as tar from 'tar'
import {
  BACKUP_ENCRYPTION_SCHEME,
  createBackupEncryptStream,
  parseBackupPublicKey,
} from './backup-encryption.js'

/**
 * Thrown when an archive build (or a backup run driving one) is
 * stopped via its `AbortSignal`. Callers use `instanceof` to tell a
 * deliberate operator cancel from a real failure — a cancelled run is
 * an outcome, not an error to alert on. (D342)
 */
export class BackupCancelledError extends Error {
  constructor(message = 'backup run cancelled') {
    super(message)
    this.name = 'BackupCancelledError'
  }
}

/**
 * Thrown when an archive would carry a live database and its owner could not
 * produce a verified snapshot of it (D693). Nothing was built: a run that
 * "succeeded" without the database — or with a torn copy of it — would push
 * the oldest good archive out of every destination's retention.
 */
export class BackupSnapshotRefusedError extends Error {
  constructor(reason: string) {
    super(
      `settings database snapshot failed — no archive built, nothing uploaded, retention untouched: ${reason}`,
    )
    this.name = 'BackupSnapshotRefusedError'
  }
}

/** What `writeArchive` tars, and how it reports and stops. */
interface WriteArchiveOptions {
  readonly archivePath: string
  readonly present: readonly string[]
  /** What tar walks; absent = `present`. A snapshots-only archive names its snapshot files. */
  readonly tarRoots?: readonly string[]
  readonly manifest: ArchiveManifest
  readonly excluded: (rel: string) => boolean
  readonly signal?: AbortSignal
  readonly onArchiveBytes?: (bytesWritten: number) => void
  /** Encrypt the gzip stream to this backup public key (see `backup-encryption.ts`). */
  readonly encryptTo?: string
}

/** An owner snapshot placed in an archive: where it is, and how the archive records it. */
interface OwnerSnapshotInArchive {
  readonly absPath: string
  readonly archived: ArchiveSqliteSnapshot
  readonly entry: ArchiveEntry
}

/**
 * Settle with `pending`, or reject with {@link BackupCancelledError} as soon as
 * `signal` fires. A pending call abandoned by the cancel still settles later:
 * `onAbandoned` runs then, to clean up what it produced.
 */
function raceAbort<T>(
  pending: Promise<T>,
  signal: AbortSignal | undefined,
  onAbandoned: () => Promise<void>,
): Promise<T> {
  if (signal === undefined) return pending
  return new Promise<T>((resolve, reject) => {
    let abandoned = false
    const onAbort = (): void => {
      abandoned = true
      reject(new BackupCancelledError())
    }
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
    pending.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        if (abandoned) void onAbandoned()
        else resolve(value)
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort)
        if (abandoned) void onAbandoned()
        else reject(err)
      },
    )
  })
}

/** Throw `BackupCancelledError` when the signal has fired. */
function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new BackupCancelledError()
}

/**
 * Default set of paths considered part of a "system backup". Includes
 * everything that isn't pure backend code — config, sqlite, addons
 * (runtime overlay), addons-data (per-addon private dir), TLS certs,
 * auto-update marker.
 *
 * Anything not listed is excluded by omission — recordings/, media/,
 * models/, logs/, cache/ (too large or fully recreatable). Note this
 * covers only TOP-LEVEL trees: bulk nested INSIDE a listed location
 * is excluded via `DEFAULT_BACKUP_EXCLUDES` + the node_modules rule
 * below, enforced in the walk and the tar filter alike.
 */
// `db` was the legacy location for the sqlite-settings DB
// (`<dataDir>/db/camstack.db`). After the storage-unification refactor
// every addon — including sqlite-settings — keeps its private state
// under `<dataDir>/addons-data/<addonId>/`, which is captured by the
// `addons-data` entry below. The empty orphan `<dataDir>/db/` folder
// is no longer worth checking; dropping it from the default set
// keeps the Create Backup modal honest (operators were seeing
// "0 B · 0 files" on a row that captures nothing).
export const DEFAULT_BACKUP_LOCATIONS = [
  'config.yaml',
  'addons',
  'addons-data',
  'tls',
  'auto-update.json',
] as const

/**
 * Subtrees never captured by a system backup even though they live
 * under a `DEFAULT_BACKUP_LOCATIONS` entry. Paths are dataDir-relative
 * prefixes. Two lessons from the live hub (2026-09-04, D-record
 * "backup excludes"):
 *
 * - `addons-data/backup-orchestrator/staging` — the orchestrator's
 *   LEGACY staging dir (now `<dataDir>/backup-staging`, outside every
 *   location). Before Jul 28 every archive nested all previous
 *   archives (175M → 503M → 4.5G); leaked files from that era must
 *   never be re-swept into new backups.
 * - `addons-data/recorder/exports` — operator-exported clips (8.4 GB
 *   on the hub). Media, not system state; a restore has no use for it.
 */
export const DEFAULT_BACKUP_EXCLUDES = [
  'addons-data/backup-orchestrator/staging',
  'addons-data/recorder/exports',
] as const

/**
 * Directory name excluded wherever it appears in the tree.
 * `AddonInstaller` materialises runtime deps under
 * `addons/@camstack/<addon>/node_modules` (~196 MB on the hub); only
 * built `dist` + package.json + assets are restore-worthy — deps are
 * reinstalled from npm on demand. node_modules is NEVER archived.
 */
const EXCLUDED_DIR_NAME = 'node_modules'

/**
 * True when a dataDir-relative path must be omitted from archives,
 * manifests and location stats. Accepts tar-style paths (`./` prefix,
 * trailing `/`) and backslash separators.
 */
export function isExcludedFromBackup(relPath: string): boolean {
  const norm = normalizeArchivePath(relPath)
  if (norm.length === 0) return false
  const segments = norm.split('/')
  if (segments.includes(EXCLUDED_DIR_NAME)) return true
  // An owner's database snapshot (D693) is archived only when the run that
  // asked for it announces it to `createArchive`; a leftover from a crashed
  // run, or a copy still being written, never is.
  if (segments.some((seg) => seg.endsWith(DATABASE_SNAPSHOT_PARTIAL_SUFFIX))) return true
  if (norm.endsWith(DATABASE_SNAPSHOT_SUFFIX)) return true
  return DEFAULT_BACKUP_EXCLUDES.some((prefix) => norm === prefix || norm.startsWith(`${prefix}/`))
}

/** `./a/b/` and `a\\b` → `a/b`: the one spelling every archive-path comparison uses. */
function normalizeArchivePath(relPath: string): string {
  return relPath.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
}

/** The files SQLite keeps beside a database. A live one is never archived. */
const SQLITE_SIDECAR_SUFFIXES = ['-wal', '-shm', '-journal'] as const

const SQLITE_DATABASE_SUFFIXES = ['.db', '.sqlite', '.sqlite3'] as const

/**
 * The database a `-wal` / `-shm` / `-journal` belongs to, or null for any other
 * path. The base must name a database (`.db` / `.sqlite` / `.sqlite3`): a
 * `build-journal` is not a sidecar, and must not stop every backup as a "live
 * database" that does not exist.
 */
function databaseOfSidecar(relPath: string): string | null {
  for (const suffix of SQLITE_SIDECAR_SUFFIXES) {
    if (!relPath.endsWith(suffix)) continue
    const db = relPath.slice(0, -suffix.length)
    return SQLITE_DATABASE_SUFFIXES.some((dbSuffix) => db.endsWith(dbSuffix)) ? db : null
  }
  return null
}

/** A SQLite database file, or a sidecar of one. */
function isSqlitePath(relPath: string): boolean {
  const db = databaseOfSidecar(relPath) ?? relPath
  return SQLITE_DATABASE_SUFFIXES.some((suffix) => db.endsWith(suffix))
}

/**
 * The OWNER of the live databases in a data root (D693): it says which files
 * it snapshots, and writes the snapshot. `backup-orchestrator` answers it with
 * the `database-snapshot` capability, pinned to its own node.
 */
export interface DatabaseOwner {
  /** EVERY database the owner has open: its id, and its absolute path. */
  listDatabases(): Promise<readonly OwnedDatabase[]>
  /** One verified snapshot of ONE database. */
  writeSnapshot(databaseId: DataStoreDatabase): Promise<DatabaseSnapshotWritten>
}

/** One database file the owner serves. */
export interface OwnedDatabase {
  readonly databaseId: DataStoreDatabase
  readonly livePath: string
}

/**
 * The databases a run carries when it states none: the minimum (D382). A
 * schedule, a manual run and `createArchive` all fall back to this one value.
 */
export const DEFAULT_BACKUP_DATABASES: readonly DataStoreDatabase[] = ['settings']

/** Path of the manifest file embedded inside every archive. */
export const ARCHIVE_MANIFEST_NAME = '.camstack-backup-manifest.json'

export type ArchiveEntryKind = 'file' | 'dir' | 'symlink'

export interface ArchiveEntry {
  /** Path relative to the archive root (== relative to dataDir). */
  readonly path: string
  readonly kind: ArchiveEntryKind
  /** Content bytes. 0 for dirs / symlinks. */
  readonly sizeBytes: number
  /** ms epoch from filesystem mtime. */
  readonly mtime: number
}

export interface ArchiveManifest {
  archiveVersion: 1
  createdAt: number
  dataDir: string
  /**
   * Mutable arrays — same shape as the zod-inferred type returned by
   * `ArchiveManifestSchema.parse()`. `BaseAddon` providers receive
   * this exact type via cap inputs, so making the interface readonly
   * here would force callers to clone before forwarding.
   */
  locations: string[]
  entries: ArchiveEntry[]
  /** Sum of file `sizeBytes` (uncompressed). */
  totalBytes: number
  totalFiles: number
  /**
   * Live databases carried as their owner's verified snapshot instead of as
   * files (D693). Paths are archive-relative.
   */
  sqliteSnapshots?: ArchiveSqliteSnapshot[]
  /**
   * Owned databases this run did NOT select: left out of the tar and of
   * `entries` alike (a live file is never carried anyway). Absent when the
   * run carried every owned database it found.
   */
  omittedDatabases?: DataStoreDatabase[]
}

/** How an archive was encrypted — absent on a plain `.tar.gz`. */
export interface ArchiveEncryption {
  readonly scheme: typeof BACKUP_ENCRYPTION_SCHEME
  /** The backup key the archive needs to be restored. */
  readonly keyId: string
}

export interface CreateArchiveResult {
  archivePath: string
  includedLocations: readonly string[]
  /** Archive size in bytes (compressed — and encrypted, when it is — on disk). */
  sizeBytes: number
  /** Present when the archive is encrypted to a backup key. */
  encryption?: ArchiveEncryption
  /** Embedded manifest — same shape as `getArchiveManifest()`. */
  manifest: ArchiveManifest
}

export interface RestoreMarker {
  archivePath: string
  requestedAt: number
  /** Caller-supplied identifier (e.g. backup id) for traceability. */
  source: string
  /**
   * Optional whitelist of top-level locations to restore from the
   * archive. When omitted the boot-time hook applies everything in
   * the archive (full restore — same as the legacy behavior).
   */
  locations?: readonly string[]
}

export interface LocationStat {
  readonly name: string
  readonly sizeBytes: number
  readonly fileCount: number
  /** False when the location doesn't exist under dataDir. */
  readonly present: boolean
}

export interface SystemBackupServiceOptions {
  /**
   * How long a `statLocations` walk result stays fresh. The `addons`
   * location holds tens of thousands of files; without a cache every
   * admin-UI visit re-walks it.
   */
  readonly statCacheTtlMs?: number
}

interface CachedLocationStat {
  readonly at: number
  readonly value: Promise<LocationStat>
}

const DEFAULT_STAT_CACHE_TTL_MS = 60_000

/**
 * System-level archive primitives. Construct one per server boot;
 * methods are pure I/O.
 */
export class SystemBackupService {
  private readonly statCacheTtlMs: number
  private readonly statCache = new Map<string, CachedLocationStat>()

  constructor(
    private readonly dataDir: string,
    private readonly logger: IScopedLogger,
    opts?: SystemBackupServiceOptions,
  ) {
    this.statCacheTtlMs = opts?.statCacheTtlMs ?? DEFAULT_STAT_CACHE_TTL_MS
  }

  /**
   * Snapshot the current size + file count of each well-known
   * location. Used by the admin UI to render an opt-in checklist
   * before triggering a backup, and by `createArchive` to derive the
   * embedded manifest.
   *
   * The walk is async (yields to the event loop per directory) and
   * per-location results are cached + single-flighted: the service
   * runs in-process in the hub, and a synchronous walk of the 70k+
   * file `addons` location blocked the event loop long enough to kill
   * WS keepalives cluster-wide.
   */
  statLocations(
    locations: readonly string[] = DEFAULT_BACKUP_LOCATIONS,
  ): Promise<readonly LocationStat[]> {
    return Promise.all(locations.map((loc) => this.statLocationCached(loc)))
  }

  private statLocationCached(loc: string): Promise<LocationStat> {
    const now = Date.now()
    const hit = this.statCache.get(loc)
    if (hit && now - hit.at < this.statCacheTtlMs) return hit.value
    const value = this.statLocation(loc)
    this.statCache.set(loc, { at: now, value })
    value.catch(() => this.statCache.delete(loc))
    return value
  }

  private async statLocation(loc: string): Promise<LocationStat> {
    const abs = path.isAbsolute(loc) ? loc : path.join(this.dataDir, loc)
    if (!fs.existsSync(abs)) {
      return { name: loc, sizeBytes: 0, fileCount: 0, present: false }
    }
    const walked = await walkAbs(abs, abs, this.exclusionPredicate())
    const totalBytes = walked.reduce((acc, e) => acc + e.sizeBytes, 0)
    const fileCount = walked.filter((e) => e.kind === 'file').length
    return { name: loc, sizeBytes: totalBytes, fileCount, present: true }
  }

  /**
   * Create a tar.gz of the given locations. Uses the `tar` npm package
   * (used by npm itself) instead of shelling out — gives us:
   *
   *   - Symlink dereference (`follow: true`) so dev mode's
   *     `addons/<name> → packages/<name>` overlay archives content,
   *     not just link stubs.
   *   - Programmatic walk → we build a manifest of every entry while
   *     copying so the archive can self-describe.
   *
   * Locations that don't exist are silently skipped. Throws if zero
   * locations would be included.
   *
   * Cancellation: `signal` aborts the build IN FLIGHT — the manifest
   * walk checks it per filesystem node and the tar phase runs through
   * `stream.pipeline(..., { signal })`, which destroys the pack and
   * the file sink immediately. On abort the half-written archive is
   * deleted here (never left for the caller to remember) and the call
   * rejects with {@link BackupCancelledError}. (D342)
   *
   * Progress: `onArchiveBytes` receives the cumulative compressed
   * bytes written to `archivePath` — the live "how large has staging
   * grown" counter `backup.listRuns` exposes.
   */
  async createArchive(opts: {
    archivePath: string
    locations?: readonly string[]
    signal?: AbortSignal
    onArchiveBytes?: (bytesWritten: number) => void
    /**
     * The OWNER of the data root's live databases (D693). Asked only when the
     * walk finds a SQLite file: which databases it owns (authoritative — a
     * cleanly closed database has no sidecar and is just as owned), then for
     * one verified snapshot. Each owned database in scope is archived as that
     * snapshot in place of its `.db` / `-wal` / `-shm` / `-journal`, and the
     * snapshot is deleted once the archive is built.
     *
     * Nothing is built — {@link BackupSnapshotRefusedError} — when the owner
     * fails, or when a live database (one with a sidecar) has no owner: an
     * archive without the settings database must never reach a destination,
     * because its upload prunes an older archive that HAS it.
     */
    owner?: DatabaseOwner
    /**
     * Which owned databases this run carries as snapshots; the others are left
     * out and listed in `manifest.omittedDatabases`. Absent = `['settings']`
     * ({@link DEFAULT_BACKUP_DATABASES}): an unstated ask is the minimum.
     */
    databases?: readonly DataStoreDatabase[]
    /**
     * A backup PUBLIC key: the gzip stream is encrypted to it as it is
     * written, so no plaintext archive ever touches the staging disk. Parsed
     * before any work — a bad key builds nothing.
     */
    encryptTo?: string
  }): Promise<CreateArchiveResult> {
    throwIfCancelled(opts.signal)
    const recipient = opts.encryptTo !== undefined ? parseBackupPublicKey(opts.encryptTo) : null
    const requested = opts.locations ?? DEFAULT_BACKUP_LOCATIONS
    const selection = new Set<DataStoreDatabase>(opts.databases ?? DEFAULT_BACKUP_DATABASES)
    // A run that does not select settings is a snapshots-only archive (D852):
    // the data-root file walk is the nightly's content, and the weekly must not
    // re-carry it. The archive is the selected snapshots plus the manifest.
    if (!selection.has('settings'))
      return this.createSnapshotsOnlyArchive(opts, selection, recipient)
    const present: string[] = []
    for (const loc of requested) {
      const abs = path.isAbsolute(loc) ? loc : path.join(this.dataDir, loc)
      if (fs.existsSync(abs)) {
        present.push(loc)
      } else {
        this.logger.debug('createArchive: skipping missing location', {
          meta: { location: loc },
        })
      }
    }
    if (present.length === 0) {
      throw new Error(
        `createArchive: no locations from {${requested.join(', ')}} exist under ${this.dataDir}`,
      )
    }
    fs.mkdirSync(path.dirname(opts.archivePath), { recursive: true })

    // 0. No SQLite connection is opened here, and no live database is copied
    //    as files (D679, D693). This service runs in hub-main; the settings
    //    database belongs to the `hub/sqlite-settings` runner. A tar of its
    //    `.db` + `-wal` under write was torn in 6/6 measured archives: tar
    //    reads `.db` before `-wal`, and a checkpoint fold in between loses the
    //    frames that would repair it. So the databases the OWNER declares are
    //    carried as its verified snapshot, and a live database nobody owns
    //    stops the archive rather than travelling torn.

    // 1. Walk every included location and derive the manifest. The
    //    walk observes the abort signal per filesystem node — the
    //    `addons` location alone is 70k+ files and a cancel must not
    //    wait for the full traversal.
    const walked: ArchiveEntry[] = []
    for (const loc of present) {
      throwIfCancelled(opts.signal)
      const abs = path.join(this.dataDir, loc)
      const stat = await fsp.stat(abs)
      if (stat.isDirectory()) {
        for (const e of await walkAbs(abs, this.dataDir, this.exclusionPredicate(), opts.signal)) {
          walked.push(e)
        }
      } else if (!isExcludedFromBackup(path.relative(this.dataDir, abs))) {
        walked.push(toArchiveEntry(abs, this.dataDir, stat))
      }
    }
    const walkedPaths = new Set(walked.map((e) => e.path))
    const ownedById = walked.some((e) => isSqlitePath(e.path))
      ? await this.ownedDatabasesInScope(opts.owner, walkedPaths)
      : new Map<string, DataStoreDatabase>()
    const owned = new Set(ownedById.keys())
    const selected = new Map<string, DataStoreDatabase>()
    const omitted = new Set<DataStoreDatabase>()
    for (const [rel, databaseId] of ownedById) {
      if (selection.has(databaseId)) selected.set(rel, databaseId)
      else omitted.add(databaseId)
    }
    // A database with a sidecar beside it is open, or was left mid-write.
    // Copied as files it is torn; left out, the archive would prune a good one.
    const unowned = new Set<string>()
    for (const e of walked) {
      const db = databaseOfSidecar(e.path)
      if (db !== null && !owned.has(db)) unowned.add(db)
    }
    if (unowned.size > 0) {
      const databases = [...unowned].sort()
      this.logger.error(
        'createArchive: a live SQLite database has no owner snapshot — no archive built',
        {
          meta: { databases, archivePath: opts.archivePath },
        },
      )
      throw new BackupSnapshotRefusedError(
        `live SQLite database ${databases.join(', ')} has no owner that can snapshot it — a copy of its files would be torn; remove its stale -wal/-shm/-journal if nothing has it open, or leave its location out of the backup`,
      )
    }

    const snapshots =
      selected.size > 0 && opts.owner
        ? await this.takeOwnerSnapshots(opts.owner, selected, opts.signal)
        : []
    try {
      const liveFiles = new Set<string>()
      for (const db of owned) {
        liveFiles.add(db)
        for (const suffix of SQLITE_SIDECAR_SUFFIXES) liveFiles.add(db + suffix)
      }
      const entries = walked.filter((e) => !liveFiles.has(e.path))
      for (const snapshot of snapshots) entries.push(snapshot.entry)
      const manifest: ArchiveManifest = {
        archiveVersion: 1,
        createdAt: Date.now(),
        dataDir: this.dataDir,
        locations: present,
        entries,
        totalBytes: entries.reduce((acc, e) => acc + e.sizeBytes, 0),
        totalFiles: entries.filter((e) => e.kind === 'file').length,
        ...(snapshots.length > 0
          ? { sqliteSnapshots: snapshots.map((snapshot) => snapshot.archived) }
          : {}),
        ...(omitted.size > 0 ? { omittedDatabases: [...omitted].toSorted() } : {}),
      }
      if (omitted.size > 0) {
        this.logger.info('createArchive: owned databases left out of this run', {
          meta: { omitted: [...omitted].toSorted(), carried: [...selected.values()] },
        })
      }
      const carriedSnapshots = new Set(snapshots.map((snapshot) => snapshot.archived.snapshotPath))
      return await this.writeArchive({
        archivePath: opts.archivePath,
        present,
        manifest,
        excluded: (rel) => {
          if (carriedSnapshots.has(rel)) return false
          return liveFiles.has(rel) || isExcludedFromBackup(rel)
        },
        ...(opts.signal ? { signal: opts.signal } : {}),
        ...(opts.onArchiveBytes ? { onArchiveBytes: opts.onArchiveBytes } : {}),
        ...(opts.encryptTo !== undefined ? { encryptTo: opts.encryptTo } : {}),
      }).then((result) =>
        recipient === null
          ? result
          : { ...result, encryption: { scheme: BACKUP_ENCRYPTION_SCHEME, keyId: recipient.keyId } },
      )
    } finally {
      // The snapshot is a full copy of the database; it exists for this
      // archive only. Never left for the next run (or the next archive) to find.
      for (const snapshot of snapshots) await this.removeSnapshot(snapshot.absPath)
    }
  }

  /**
   * An archive of the selected databases' owner snapshots and the manifest —
   * no data-root walk, no location, no settings (D852). Refused when the owner
   * has none of the selected files: an archive of nothing must reach no
   * destination, because its upload prunes an older archive that has them.
   */
  private async createSnapshotsOnlyArchive(
    opts: Parameters<SystemBackupService['createArchive']>[0],
    selection: ReadonlySet<DataStoreDatabase>,
    recipient: ReturnType<typeof parseBackupPublicKey> | null,
  ): Promise<CreateArchiveResult> {
    if (opts.owner === undefined) {
      throw new BackupSnapshotRefusedError(
        'a snapshots-only archive needs the database owner, and none was given',
      )
    }
    fs.mkdirSync(path.dirname(opts.archivePath), { recursive: true })
    const ownedById = await this.ownedDatabasesInScope(opts.owner, null)
    const selected = new Map<string, DataStoreDatabase>()
    for (const [rel, databaseId] of ownedById) {
      if (selection.has(databaseId)) selected.set(rel, databaseId)
    }
    if (selected.size === 0) {
      this.logger.warn(
        'createArchive: the owner has none of the selected databases — no archive built',
        {
          meta: { requested: [...selection].toSorted(), archivePath: opts.archivePath },
        },
      )
      throw new BackupSnapshotRefusedError(
        `the owner has none of the selected databases (${[...selection].toSorted().join(', ')})`,
      )
    }
    const snapshots = await this.takeOwnerSnapshots(opts.owner, selected, opts.signal)
    try {
      const entries = snapshots.map((snapshot) => snapshot.entry)
      const manifest: ArchiveManifest = {
        archiveVersion: 1,
        createdAt: Date.now(),
        dataDir: this.dataDir,
        locations: [],
        entries,
        totalBytes: entries.reduce((acc, e) => acc + e.sizeBytes, 0),
        totalFiles: entries.length,
        sqliteSnapshots: snapshots.map((snapshot) => snapshot.archived),
      }
      const carried = snapshots.map((snapshot) => snapshot.archived.snapshotPath)
      const carriedSet = new Set(carried)
      const result = await this.writeArchive({
        archivePath: opts.archivePath,
        present: [],
        tarRoots: carried,
        manifest,
        excluded: (rel) => rel !== ARCHIVE_MANIFEST_NAME && !carriedSet.has(rel),
        ...(opts.signal ? { signal: opts.signal } : {}),
        ...(opts.onArchiveBytes ? { onArchiveBytes: opts.onArchiveBytes } : {}),
        ...(opts.encryptTo !== undefined ? { encryptTo: opts.encryptTo } : {}),
      })
      return recipient === null
        ? result
        : { ...result, encryption: { scheme: BACKUP_ENCRYPTION_SCHEME, keyId: recipient.keyId } }
    } finally {
      for (const snapshot of snapshots) await this.removeSnapshot(snapshot.absPath)
    }
  }

  /**
   * Tar `present` (filtered by `excluded`) plus the staged manifest into
   * `archivePath`.
   */
  private async writeArchive(opts: WriteArchiveOptions): Promise<CreateArchiveResult> {
    const { present, manifest } = opts
    // 2. Stage the manifest as a real file so tar can include it.
    //    The temp file lives next to the archive (same fs, atomic
    //    rename on cleanup) and is removed in `finally`.
    const manifestStagePath = `${opts.archivePath}.${process.pid}.manifest.json`
    fs.writeFileSync(manifestStagePath, JSON.stringify(manifest, null, 2), 'utf-8')

    this.logger.info('createArchive: tarring', {
      meta: {
        archivePath: opts.archivePath,
        locations: [...present],
        totalFiles: manifest.totalFiles,
        totalBytes: manifest.totalBytes,
      },
    })
    try {
      // 3. Tar.create with two roots:
      //    - the staged manifest file (renamed inside the archive
      //      via the `transform`-equivalent: we copy it next to
      //      dataDir under the canonical name first).
      //    - every present location relative to dataDir.
      //
      //    `follow: true` is the npm package's symlink dereference —
      //    matches `tar -h` semantics. `portable: true` strips the
      //    user/group/atime fields so archives are reproducible
      //    across machines.
      const stagedInDataDir = path.join(this.dataDir, ARCHIVE_MANIFEST_NAME)
      fs.copyFileSync(manifestStagePath, stagedInDataDir)
      // Defensive: when a caller stages the archive INSIDE a location
      // being tarred, exclude that staging dir wholesale — tar reading
      // its own growing `.tar.gz` throws "did not encounter expected
      // EOF". The orchestrator's staging dir now lives OUTSIDE every
      // location (`<dataDir>/backup-staging`), so this normally computes
      // to null; it stays for callers that pick their own archivePath.
      // (ADR-0027)
      const stagingRel = path.relative(this.dataDir, path.dirname(opts.archivePath))
      const excludePrefix =
        stagingRel && !stagingRel.startsWith('..') && !path.isAbsolute(stagingRel)
          ? stagingRel
          : null
      try {
        // Stream mode (no `file` option) + `stream.pipeline` instead of
        // tar's own file writer: pipeline is the one primitive that both
        // COUNTS the compressed bytes as they land (live staging-growth
        // progress) and ABORTS mid-write on `signal` — destroying the
        // pack, the counter and the file sink together. tar.create with
        // `file` offers neither. (D342)
        const pack = tar.create(
          {
            gzip: true,
            cwd: this.dataDir,
            follow: true,
            portable: true,
            filter: (entryPath) => {
              const norm = normalizeArchivePath(entryPath)
              if (opts.excluded(norm)) return false
              if (!excludePrefix) return true
              return norm !== excludePrefix && !norm.startsWith(`${excludePrefix}/`)
            },
          },
          [ARCHIVE_MANIFEST_NAME, ...(opts.tarRoots ?? present)],
        )
        const sink = fs.createWriteStream(opts.archivePath, { mode: 0o600 })
        try {
          const streamOpts = opts.signal ? { signal: opts.signal } : {}
          if (opts.encryptTo !== undefined) {
            await pipeline(
              pack,
              createBackupEncryptStream(opts.encryptTo),
              byteCountingPassthrough(opts.onArchiveBytes),
              sink,
              streamOpts,
            )
          } else {
            await pipeline(pack, byteCountingPassthrough(opts.onArchiveBytes), sink, streamOpts)
          }
        } catch (err) {
          // Never leave a half-written archive behind — on abort OR on a
          // tar/write failure the partial file is this method's mess.
          try {
            fs.rmSync(opts.archivePath, { force: true })
          } catch {
            /* best-effort */
          }
          if (opts.signal?.aborted) throw new BackupCancelledError()
          throw err
        }
      } finally {
        try {
          fs.rmSync(stagedInDataDir, { force: true })
        } catch {
          /* best-effort */
        }
      }
    } finally {
      try {
        fs.rmSync(manifestStagePath, { force: true })
      } catch {
        /* best-effort */
      }
    }

    const sizeBytes = fs.statSync(opts.archivePath).size
    return {
      archivePath: opts.archivePath,
      includedLocations: [...present],
      sizeBytes,
      manifest,
    }
  }

  /**
   * without extracting payload files. Streams the tar.gz, parses the
   * one entry we care about, then aborts.
   */
  async readArchiveManifest(archivePath: string): Promise<ArchiveManifest | null> {
    if (!fs.existsSync(archivePath)) {
      throw new Error(`readArchiveManifest: ${archivePath} does not exist`)
    }
    return new Promise<ArchiveManifest | null>((resolve, reject) => {
      const chunks: Buffer[] = []
      let found = false
      let resolved = false
      const parser = new tar.Parser({
        onentry: (entry) => {
          if (entry.path === ARCHIVE_MANIFEST_NAME && !found) {
            found = true
            entry.on('data', (chunk: Buffer) => chunks.push(chunk))
            entry.on('end', () => {
              try {
                const json = Buffer.concat(chunks).toString('utf-8')
                const parsed = JSON.parse(json) as ArchiveManifest
                resolved = true
                resolve(parsed)
              } catch (err) {
                resolved = true
                reject(err instanceof Error ? err : new Error(String(err)))
              }
            })
          } else {
            entry.resume()
          }
        },
      })
      // Errors propagate via the gunzip stream — `tar.Parser`'s public
      // `.on()` types only declare `'entry' | 'close' | 'end'`, but
      // the upstream gunzip emits `'error'` for both gzip and
      // downstream tar parse failures (which it surfaces as an
      // unpipe + error). Catching it there keeps us within the
      // declared API.
      parser.on('end', () => {
        if (!resolved) resolve(found ? null : null)
      })
      const gunzip = zlib.createGunzip()
      gunzip.on('error', (err) => {
        if (!resolved) {
          resolved = true
          reject(err)
        }
      })
      const reader = fs.createReadStream(archivePath)
      reader.on('error', (err) => {
        if (!resolved) {
          resolved = true
          reject(err)
        }
      })
      reader.pipe(gunzip).pipe(parser)
    })
  }

  /**
   * Schedule a restore for the next boot by writing a marker file.
   * `locations` (optional) carries through to the launcher's boot-time
   * restore (`server/backend/src/launcher.ts`, the only restore there is)
   * so the operator's "restore only X and Y" choice survives the process
   * restart.
   */
  scheduleRestoreMarker(opts: {
    archivePath: string
    source: string
    locations?: readonly string[]
  }): string {
    if (!fs.existsSync(opts.archivePath)) {
      throw new Error(`scheduleRestoreMarker: ${opts.archivePath} missing`)
    }
    const markerPath = this.getRestoreMarkerPath()
    const marker: RestoreMarker = {
      archivePath: opts.archivePath,
      requestedAt: Date.now(),
      source: opts.source,
      ...(opts.locations ? { locations: [...opts.locations] } : {}),
    }
    fs.mkdirSync(path.dirname(markerPath), { recursive: true })
    fs.writeFileSync(markerPath, JSON.stringify(marker, null, 2), {
      mode: 0o600,
    })
    return markerPath
  }

  /** Read the pending-restore marker if one is present. */
  readPendingMarker(): RestoreMarker | null {
    const markerPath = this.getRestoreMarkerPath()
    if (!fs.existsSync(markerPath)) return null
    try {
      const raw = fs.readFileSync(markerPath, 'utf-8')
      const parsed: unknown = JSON.parse(raw)
      if (
        typeof parsed === 'object' &&
        parsed != null &&
        typeof (parsed as { archivePath?: unknown }).archivePath === 'string'
      ) {
        return parsed as RestoreMarker
      }
    } catch (err) {
      this.logger.warn('readPendingMarker: malformed marker — ignoring', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
    }
    return null
  }

  /** Drop the marker after a successful boot-time restore. */
  clearPendingMarker(): void {
    const markerPath = this.getRestoreMarkerPath()
    if (fs.existsSync(markerPath)) fs.rmSync(markerPath, { force: true })
  }

  /**
   * The databases the owner declares, archive-relative, that this walk found,
   * with the id of each. One outside this data root is not in scope. An owner
   * that cannot answer stops the archive: without the answer, nothing says
   * which file is live.
   */
  private async ownedDatabasesInScope(
    owner: DatabaseOwner | undefined,
    walked: ReadonlySet<string> | null,
  ): Promise<Map<string, DataStoreDatabase>> {
    if (owner === undefined) return new Map()
    let declared: readonly OwnedDatabase[]
    try {
      declared = await owner.listDatabases()
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      this.logger.error(
        'createArchive: the database owner did not say what it owns — no archive built',
        {
          meta: { error: reason },
        },
      )
      throw new BackupSnapshotRefusedError(`the database owner could not be asked: ${reason}`)
    }
    const inScope = new Map<string, DataStoreDatabase>()
    for (const db of declared) {
      const rel = this.archiveRelative(db.livePath)
      if (rel !== null && (walked === null || walked.has(rel))) inScope.set(rel, db.databaseId)
    }
    return inScope
  }

  /**
   * Ask the owner for one verified snapshot per SELECTED database, one after
   * the other, and place each in this archive. A snapshot must sit on THIS data
   * root — the call is pinned to this node, so a path elsewhere means it
   * reached another host, and that file is not ours to read — beside the very
   * database it was asked for. Anything else is refused, and the run builds
   * nothing: the copies already taken are removed.
   *
   * Only ever DELETED here: `<selected db>.backup-snapshot` under this data
   * root, a name this process derives itself. A path the owner ANSWERS is never
   * deleted on its word — answering the live database as the snapshot would
   * otherwise delete the live database. A file at any other path is left to
   * the owner's own sweep.
   *
   * A cancel is honoured while the owner is still copying; the copy it may
   * finish afterwards is removed when that call settles.
   */
  private async takeOwnerSnapshots(
    owner: DatabaseOwner,
    selected: ReadonlyMap<string, DataStoreDatabase>,
    signal: AbortSignal | undefined,
  ): Promise<OwnerSnapshotInArchive[]> {
    const removeOwnedSnapshots = async (): Promise<void> => {
      for (const db of selected.keys()) {
        await this.removeSnapshot(path.join(this.dataDir, db + DATABASE_SNAPSHOT_SUFFIX))
      }
    }
    const taken: OwnerSnapshotInArchive[] = []
    try {
      for (const [expectedLive, databaseId] of selected) {
        throwIfCancelled(signal)
        taken.push(
          await this.takeOneSnapshot(
            owner,
            databaseId,
            expectedLive,
            signal,
            selected,
            removeOwnedSnapshots,
          ),
        )
      }
    } catch (err) {
      await removeOwnedSnapshots()
      throw err
    }
    return taken
  }

  private async takeOneSnapshot(
    owner: DatabaseOwner,
    databaseId: DataStoreDatabase,
    expectedLive: string,
    signal: AbortSignal | undefined,
    selected: ReadonlyMap<string, DataStoreDatabase>,
    removeOwnedSnapshots: () => Promise<void>,
  ): Promise<OwnerSnapshotInArchive> {
    let result: DatabaseSnapshotWritten
    try {
      result = await raceAbort(owner.writeSnapshot(databaseId), signal, () => {
        this.logger.info(
          'createArchive: run cancelled while the owner copied — its copy is removed when it lands',
          {
            meta: { databases: [...selected.values()], database: databaseId },
          },
        )
        return removeOwnedSnapshots()
      })
    } catch (err) {
      if (err instanceof BackupCancelledError) throw err
      const reason = err instanceof Error ? err.message : String(err)
      this.logger.error(
        'createArchive: the owner could not snapshot its live database — no archive built',
        {
          meta: { databases: [...selected.values()], database: databaseId, error: reason },
        },
      )
      throw new BackupSnapshotRefusedError(`${databaseId}: ${reason}`)
    }
    const livePath = this.archiveRelative(result.livePath)
    const snapshotPath = this.archiveRelative(result.snapshotPath)
    if (livePath === null || snapshotPath === null) {
      this.logger.warn(
        'createArchive: the owner answered a snapshot outside this data root — not touched, left to its sweep',
        {
          meta: { snapshot: result.snapshotPath, dataDir: this.dataDir },
        },
      )
      throw new BackupSnapshotRefusedError(
        `snapshot ${result.snapshotPath} is not under this archive's data root ${this.dataDir}`,
      )
    }
    if (snapshotPath !== livePath + DATABASE_SNAPSHOT_SUFFIX) {
      throw new BackupSnapshotRefusedError(
        `snapshot ${snapshotPath} does not sit beside the database ${livePath} it copies`,
      )
    }
    if (livePath !== expectedLive || result.databaseId !== databaseId) {
      throw new BackupSnapshotRefusedError(
        `snapshot copies ${livePath} (${result.databaseId}), but ${databaseId} (${expectedLive}) was asked for`,
      )
    }
    const absPath = path.join(this.dataDir, snapshotPath)
    const stat = await fsp.stat(absPath)
    this.logger.info('createArchive: carrying the owner snapshot in place of the live database', {
      meta: {
        database: livePath,
        databaseId,
        snapshot: snapshotPath,
        sizeBytes: stat.size,
        tables: result.tables.length,
        copyMs: result.copyMs,
        verifyMs: result.verifyMs,
      },
    })
    return {
      absPath,
      archived: { ...result, livePath, snapshotPath },
      entry: toArchiveEntry(absPath, this.dataDir, stat),
    }
  }

  private async removeSnapshot(absPath: string): Promise<void> {
    try {
      await fsp.rm(absPath, { force: true })
    } catch (err) {
      this.logger.warn('createArchive: owner snapshot could not be removed', {
        meta: { snapshot: absPath, error: err instanceof Error ? err.message : String(err) },
      })
    }
  }

  /** `abs` relative to the data root, or null when it lies outside it. */
  private archiveRelative(abs: string): string | null {
    const rel = path.relative(path.resolve(this.dataDir), path.resolve(abs))
    if (rel.length === 0 || rel.startsWith('..') || path.isAbsolute(rel)) return null
    return normalizeArchivePath(rel)
  }

  private getRestoreMarkerPath(): string {
    return path.join(this.dataDir, '.pending-restore.json')
  }

  /**
   * Absolute-path form of {@link isExcludedFromBackup}, anchored on
   * this service's dataDir. Shared by the manifest walk and the location
   * stats so both agree with the tar filter about what a backup contains.
   */
  private exclusionPredicate(): (abs: string) => boolean {
    return (abs) => isExcludedFromBackup(path.relative(this.dataDir, abs))
  }
}

// ─── helpers ───────────────────────────────────────────────────────────────

/**
 * Recursively walk a directory and produce one `ArchiveEntry` per
 * filesystem node. `dataDir` is used to compute the archive-relative
 * path. Symlinks are dereferenced (matches the `follow: true` flag we
 * pass to tar.create).
 */
async function walkAbs(
  absRoot: string,
  dataDir: string,
  shouldSkip?: (abs: string) => boolean,
  signal?: AbortSignal,
): Promise<ArchiveEntry[]> {
  const out: ArchiveEntry[] = []
  await walkRec(absRoot, dataDir, out, shouldSkip, signal)
  return out
}

// Async on purpose: the service runs in-process in the hub, and large
// locations (addons ≈ 70k+ files) must not block the event loop. Each
// stat/readdir awaits, yielding between filesystem nodes. The signal
// is checked per node so a cancel lands mid-walk, not after it.
async function walkRec(
  abs: string,
  dataDir: string,
  out: ArchiveEntry[],
  shouldSkip?: (abs: string) => boolean,
  signal?: AbortSignal,
): Promise<void> {
  throwIfCancelled(signal)
  if (shouldSkip?.(abs)) return
  let stat: fs.Stats
  try {
    stat = await fsp.stat(abs)
  } catch {
    // Broken symlink target — skip silently.
    return
  }
  out.push(toArchiveEntry(abs, dataDir, stat))
  if (stat.isDirectory()) {
    let children: string[]
    try {
      children = await fsp.readdir(abs)
    } catch {
      return
    }
    for (const child of children) {
      await walkRec(path.join(abs, child), dataDir, out, shouldSkip, signal)
    }
  }
}

/**
 * Pass-through transform that reports the CUMULATIVE bytes flowed so
 * far. Sits between the tar pack and the file sink so the caller's
 * progress counter tracks the compressed archive as it grows on disk.
 */
function byteCountingPassthrough(onBytes?: (total: number) => void): Transform {
  let total = 0
  return new Transform({
    transform(chunk, _encoding, callback) {
      if (Buffer.isBuffer(chunk)) total += chunk.byteLength
      onBytes?.(total)
      callback(null, chunk)
    },
  })
}

function toArchiveEntry(abs: string, dataDir: string, stat: fs.Stats): ArchiveEntry {
  const rel = path.relative(dataDir, abs).replace(/\\/g, '/')
  const kind: ArchiveEntryKind = stat.isDirectory()
    ? 'dir'
    : stat.isSymbolicLink()
      ? 'symlink'
      : 'file'
  return {
    path: rel || path.basename(abs),
    kind,
    sizeBytes: kind === 'file' ? stat.size : 0,
    mtime: stat.mtimeMs,
  }
}
