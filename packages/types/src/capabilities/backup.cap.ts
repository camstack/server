import { z } from 'zod'
import { type CapabilityDefinition, type InferProvider, method } from './capability-definition.js'
import { ArchiveSqliteSnapshotSchema } from './database-snapshot.cap.js'
import { DataStoreDatabaseSchema } from './settings-store.cap.js'

/**
 * Per-destination metadata returned by `backup-destination.listDestinations`.
 * Defined here (not in `backup-destination.cap.ts`) because both caps need
 * it and `backup` is the foundation — the destination cap imports from us.
 */
/**
 * Provider-side destination metadata. The addon returns a SHORT id
 * (`subId`) — orchestrator-internal-only routing prepends the addon's
 * manifest id to produce the externally-visible globally-unique id.
 *
 * Why split: the addon shouldn't have to know its own manifest id.
 * That id is owned by `package.json` and the kernel's registry; making
 * the addon repeat it leaks framework state into addon code and
 * breaks if the manifest is ever renamed.
 */
const BackupSubDestinationInfoSchema = z.object({
  /**
   * Sub-id within this addon. Convention `default` for single-
   * destination addons; addons that host many (S3 with N buckets)
   * pick stable per-bucket strings. The orchestrator stitches
   * `<manifestId>:<subId>` for the wire format.
   */
  subId: z.string(),
  displayName: z.string(),
  description: z.string().optional(),
  kind: z.string(),
  triggerSupported: z.boolean(),
  restoreSupported: z.boolean(),
})

/**
 * Orchestrator-side destination metadata. The orchestrator computes
 * `id = <addonId>:<subId>` from its provider lookup so consumers
 * (admin UI, restore flow) see one canonical key.
 *
 * Phase 4 (admin UI redesign) adds the per-destination policy fields
 * (`enabled`, `retentionCount`, `label`) so the destinations table can
 * render the joined view without a follow-up round-trip. The backend
 * already joins these in `listDestinations` — we now surface them on
 * the wire.
 *
 * `lastSuccessAt` / `lastSuccessSizeBytes` are computed from each
 * location's `manifests.json` (newest archive). Optional — locations
 * with no archives yet leave them undefined.
 */
const BackupDestinationInfoSchema = BackupSubDestinationInfoSchema.extend({
  /** `<addonId>:<subId>` — globally-unique dispatch key. */
  id: z.string(),
  /**
   * Manifest id of the owning addon. The Settings button on the
   * destination card opens that addon's `globalSettingsSchema` panel.
   */
  addonId: z.string(),
  /** Operator-toggled enable flag from the destination-policy table. */
  enabled: z.boolean(),
  /** Operator-defined retention count (archives kept per destination). */
  retentionCount: z.number(),
  /** Operator-defined display label (overrides storage location displayName). */
  label: z.string().optional(),
  /** Newest-archive timestamp from `manifests.json`, or undefined. */
  lastSuccessAt: z.number().optional(),
  /** Newest-archive size from `manifests.json`, or undefined. */
  lastSuccessSizeBytes: z.number().optional(),
  /**
   * Cron cadence(s) of the ENABLED schedules that fan out to this
   * destination, comma-joined. Absent when no enabled schedule targets it
   * — a destination nothing is scheduled to write to must not advertise a
   * cadence (D384). This is never the `backup_destination_policies.cron`
   * column: that per-location cron has scheduled nothing since 2026-07-28
   * and reading it made a destination with a DISABLED schedule claim a
   * nightly run.
   */
  cron: z.string().optional(),
  /** ms-epoch of the next firing across those schedules (earliest), if any. */
  nextRunAt: z.number().optional(),
  /**
   * ms-epoch of the last time a run ATTEMPTED to write here — success or
   * failure. Never a success stamp: pair it with `lastSuccessAt` (the
   * newest archive that actually landed) and `lastError`.
   */
  lastAttemptAt: z.number().optional(),
  /**
   * Why the last attempt failed, verbatim. Absent when the last attempt
   * landed the archive. A destination that has never been written to has
   * neither this nor `lastAttemptAt`.
   */
  lastError: z.string().optional(),
})

/**
 * How an archive is encrypted (operator decision 2026-10-09): to a backup
 * PUBLIC key the hub holds, so only the operator's secret key opens it.
 * Absent on a plain `.tar.gz` — every archive made before encryption, or
 * with it off — which restores without a key.
 */
const BackupArchiveEncryptionSchema = z.object({
  /** `x25519-hkdf-aes256gcm-stream-v1`. */
  scheme: z.string(),
  /** 16 hex — the backup key whose secret restores this archive. */
  keyId: z.string(),
})

/**
 * The backup encryption setting. The hub keeps PUBLIC keys only: the active
 * one new archives are encrypted to, and the retired ones older archives
 * still need. The secret key is shown once, at `setupEncryption`.
 */
const BackupEncryptionStatusSchema = z.object({
  enabled: z.boolean(),
  active: z.object({ keyId: z.string(), publicKey: z.string(), createdAt: z.number() }).nullable(),
  /** Every key ever set up, newest first. */
  keys: z
    .array(z.object({ keyId: z.string(), createdAt: z.number(), retiredAt: z.number().nullable() }))
    .readonly(),
})

/**
 * Per-archive entry returned by `backup.listArchives({ destinationId })`.
 * Same shape the destination drill-in renders. Sourced from the per-
 * location `manifests.json` (no per-archive tarball read required).
 */
const BackupArchiveEntrySchema = z.object({
  id: z.string(),
  filename: z.string(),
  createdAt: z.number(),
  sizeBytes: z.number(),
  label: z.string().optional(),
  /** Top-level locations included in the archive (db, addons, tls, …). */
  locations: z.array(z.string()).readonly(),
  /** Present when the archive is encrypted; restore then needs that key. */
  encryption: BackupArchiveEncryptionSchema.optional(),
  /**
   * The databases the run asked to carry (its retention class). Absent on an
   * archive made before several files were owned: that was `['settings']`.
   */
  databases: z.array(DataStoreDatabaseSchema).readonly().optional(),
})

const BackupEntrySchema = z.object({
  id: z.string(),
  /** Addon id of the destination that owns this backup (e.g. `local-backup`, `s3-backup`). */
  destinationId: z.string().optional(),
  label: z.string().optional(),
  createdAt: z.number(),
  sizeBytes: z.number(),
  locations: z.array(z.string()).optional(),
  encryption: BackupArchiveEncryptionSchema.optional(),
})

const ArchiveEntrySchema = z.object({
  path: z.string(),
  kind: z.enum(['file', 'dir', 'symlink']),
  sizeBytes: z.number(),
  mtime: z.number(),
})

const ArchiveManifestSchema = z.object({
  archiveVersion: z.literal(1),
  createdAt: z.number(),
  dataDir: z.string(),
  locations: z.array(z.string()),
  entries: z.array(ArchiveEntrySchema),
  totalBytes: z.number(),
  totalFiles: z.number(),
  /**
   * Live SQLite databases this archive carries as their OWNER's verified
   * snapshot instead of as files (D693). Absent on archives made before.
   */
  sqliteSnapshots: z.array(ArchiveSqliteSnapshotSchema).optional(),
  /**
   * Owned database files the run did NOT carry (not selected): left out of the
   * tar and the entry list alike. Absent when every owned file was carried.
   */
  omittedDatabases: z.array(DataStoreDatabaseSchema).optional(),
})

const LocationStatSchema = z.object({
  name: z.string(),
  sizeBytes: z.number(),
  fileCount: z.number(),
  present: z.boolean(),
})

/** Lifecycle of a backup run. Terminal states: succeeded / failed / cancelled. */
const BackupRunStateSchema = z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled'])

/**
 * Where a running backup currently is. `queued` before it starts,
 * `building` while the tar.gz is being staged, `uploading` during the
 * per-destination fan-out, `done` once terminal.
 */
const BackupRunPhaseSchema = z.enum(['queued', 'building', 'uploading', 'done'])

/**
 * Observable state of one backup run — readable WHILE it runs via
 * `backup.listRuns`. This is what makes the execution queue and
 * `backup.cancel` usable: the 2026-09-04 incident (two concurrent
 * multi-GB builds, staging 5.1 GB → 18 GB, load 62) was only
 * diagnosable with `du` because nothing reported that runs existed or
 * how large the staged archive had grown.
 */
const BackupRunSchema = z.object({
  /** Stable run id — the handle `backup.cancel` takes. */
  id: z.string(),
  state: BackupRunStateSchema,
  phase: BackupRunPhaseSchema,
  /**
   * Resolved destination location ids. Empty while queued (targets are
   * resolved when the run starts, against the then-current policies).
   */
  destinationIds: z.array(z.string()).readonly(),
  label: z.string().optional(),
  /** ms-epoch when the run was submitted (trigger call / schedule fire). */
  requestedAt: z.number(),
  /** ms-epoch when the run left the queue and started building. */
  startedAt: z.number().optional(),
  /** ms-epoch when the run reached a terminal state. */
  finishedAt: z.number().optional(),
  /** Compressed bytes of the staging archive written so far. */
  stagedBytes: z.number(),
  /** Final staged archive size, once the build phase completes. */
  archiveSizeBytes: z.number().optional(),
  /** Bytes pushed to the destination currently uploading. */
  uploadedBytes: z.number(),
  /** Destinations where the archive fully landed (uploaded + indexed). */
  completedDestinationIds: z.array(z.string()).readonly(),
  /** Destinations that failed during the fan-out. */
  failedDestinationIds: z.array(z.string()).readonly(),
  /** Failure message when `state === 'failed'`. */
  error: z.string().optional(),
  /**
   * 1-based place in the execution queue — 1 = runs next. Present only
   * while `state === 'queued'`. Stamped by the orchestrator from the
   * queue's OWN pending order, never derived from timestamps, so the
   * UI cannot show an order the executor will not honour.
   */
  queuePosition: z.number().int().min(1).optional(),
})

/**
 * Result of `backup.trigger`. The call still resolves when the run
 * terminates (compat with schedule-driven runs and the admin UI), but
 * it now names the run and says whether it had to WAIT: a trigger that
 * arrives while another run is in flight is enqueued (or joined onto
 * an identical already-queued run), never started concurrently.
 */
const BackupTriggerResultSchema = z.object({
  /** The run this trigger mapped to — poll it via `listRuns`, stop it via `cancel`. */
  runId: z.string(),
  /** True when the run waited behind an in-flight run instead of starting immediately. */
  queued: z.boolean(),
  /** True when this trigger was coalesced onto an identical already-queued run. */
  joined: z.boolean(),
  /** True when the run was cancelled before completing every destination. */
  cancelled: z.boolean(),
  /** One entry per destination the archive landed at (partial on cancel). */
  entries: z.array(BackupEntrySchema).readonly(),
})

/**
 * A backup schedule — the N:M "entry" that binds one cron cadence to a
 * SET of destination locations. Supersedes the per-location cron on
 * `BackupDestinationPolicy`: an operator creates a schedule, picks the
 * `backups` locations it should write to, and the orchestrator fans a
 * single archive out to all of them when the cron fires.
 *
 * `retentionCount` is per-schedule (D-decision 2026-07-28): every
 * location targeted by this schedule keeps this many archives from
 * this schedule's runs.
 *
 * `dataSources` optionally narrows which top-level state locations
 * (db, addons, tls, …) are archived; omitted = the orchestrator's
 * default full set.
 */
const BackupScheduleSchema = z.object({
  /** Stable id. Generated by the orchestrator on first upsert if absent. */
  id: z.string(),
  /** Operator-facing display name. */
  label: z.string(),
  /** 5-field POSIX cron. Empty = disabled cadence (kept for editing). */
  cron: z.string(),
  /** Master on/off toggle for the whole schedule. */
  enabled: z.boolean(),
  /** `backups`-location ids this schedule writes to (fan-out set). */
  locationIds: z.array(z.string()).readonly(),
  /** Archives kept per targeted location for this schedule. */
  retentionCount: z.number().int().min(1).max(1000),
  /** Optional subset of source locations to include; omitted = all. */
  dataSources: z.array(z.string()).readonly().optional(),
  /**
   * Which database files this schedule carries. Absent = `['settings']`
   * (an unstated ask is the minimum, D382). Events and history run weekly,
   * settings nightly (D852).
   */
  databases: z.array(DataStoreDatabaseSchema).readonly().optional(),
  /**
   * ms-epoch of the last tick that FIRED this schedule. Stamped before the
   * archive runs (it is the dedupe anchor), so it says "attempted", never
   * "succeeded" — a run refused by every destination stamps it too.
   */
  lastAttemptAt: z.number().optional(),
  /** ms-epoch of the last run of this schedule that landed at ≥1 destination. */
  lastSuccessAt: z.number().optional(),
  /** Why the last fired run failed, verbatim. Absent when it succeeded. */
  lastError: z.string().optional(),
  /** ms-epoch of next computed firing (read-only, filled on list). */
  nextRunAt: z.number().optional(),
})

/**
 * backup — singleton capability for backup management.
 *
 * Implemented by `local-backup` addon. Future providers (S3, rsync)
 * can replace it by registering the same capability.
 */
export const backupCapability = {
  name: 'backup',
  scope: 'system',
  mode: 'singleton',
  methods: {
    /**
     * Flat aggregate of every destination across every registered
     * `backup-destination` provider. This is the orchestrator-side
     * surface; it expands per-addon `listDestinations()` results into
     * one list the UI can render directly.
     */
    listDestinations: method(z.void(), z.array(BackupDestinationInfoSchema).readonly(), {
      auth: 'admin',
    }),
    /**
     * Trigger a backup. Without `destinations` the orchestrator fans
     * out to every destination flagged as enabled in the routing
     * config; with it, only the listed addons receive the archive.
     *
     * At most ONE backup run executes at a time — the source tree and
     * the staging disk are shared by every run, so a second trigger
     * while one is in flight is enqueued (or joined onto an identical
     * queued run) and the result says so. See D342.
     */
    trigger: method(
      z
        .object({
          /** Subset of registered `backup-destination` addon ids to write to. */
          destinations: z.array(z.string()).optional(),
          locations: z.array(z.string()).optional(),
          label: z.string().optional(),
          /**
           * Per-run retention override applied to every targeted
           * destination. Used by schedule-driven runs (per-entry
           * retention). Omitted = each destination's own policy
           * retention (manual runs).
           */
          retentionCount: z.number().int().min(1).max(1000).optional(),
          /** Database files to carry; omitted = `['settings']`. */
          databases: z.array(DataStoreDatabaseSchema).optional(),
        })
        .optional(),
      BackupTriggerResultSchema,
      { kind: 'mutation', auth: 'admin' },
    ),
    /**
     * Every run the orchestrator knows about, in EXECUTION order: the
     * running run first, then queued runs in the exact order they will
     * execute (each with `queuePosition`, 1 = next), then the bounded
     * finished history newest-first. Only one run executes at a time
     * (D342) — the queued section IS the line. Each run carries live
     * phase + byte counters so a runaway build is visible in seconds,
     * not via `du`.
     */
    listRuns: method(z.void(), z.array(BackupRunSchema).readonly(), { auth: 'admin' }),
    /**
     * Stop a backup run. Mirrors `storage-migration.cancel` semantics:
     * id in, `{ cancelled }` out — `false` when the run is unknown or
     * already terminal. A QUEUED run is removed before it ever starts;
     * the RUNNING run has its tar/upload stream actually aborted, the
     * half-written staging archive is deleted, and the in-flight
     * destination upload is aborted server-side (partial discarded).
     * Destinations that already completed keep their archive.
     */
    cancel: method(z.object({ runId: z.string() }), z.object({ cancelled: z.boolean() }), {
      kind: 'mutation',
      auth: 'admin',
    }),
    /** Union of every destination's archives, each tagged with `destinationId`. */
    list: method(z.void(), z.array(BackupEntrySchema).readonly(), { auth: 'admin' }),
    /**
     * Pre-backup snapshot of the well-known locations on disk — sizes
     * + file counts. Powers the opt-in checklist that lets the
     * operator pick which subsections of state get archived.
     */
    listLocations: method(z.void(), z.array(LocationStatSchema).readonly(), { auth: 'admin' }),
    /**
     * Read the embedded `.camstack-backup-manifest.json` from a
     * previously-created archive. The manifest carries the full
     * file/dir listing with sizes + mtimes — the readdir snapshot
     * the UI shows in the "Contents" panel. Returns `null` when the
     * archive predates manifests (created before this feature
     * shipped).
     */
    getEntries: method(
      z.object({ destinationId: z.string(), backupId: z.string() }),
      ArchiveManifestSchema.nullable(),
      { auth: 'admin' },
    ),
    restore: method(
      z.object({
        destinationId: z.string(),
        backupId: z.string(),
        /**
         * Optional whitelist — only restore these top-level locations
         * from the archive. Default = every location the archive
         * carries (full restore). The boot-time apply hook reads
         * this list and skips entries whose path doesn't start with
         * any of them.
         */
        locations: z.array(z.string()).optional(),
        /**
         * The backup SECRET key, for an encrypted archive (ignored for a plain
         * one). The archive is decrypted into the hub's private staging
         * before the restart; the key is not stored. A wrong or missing key
         * is refused before the archive is downloaded.
         */
        backupSecretKey: z.string().optional(),
      }),
      z.void(),
      { kind: 'mutation', auth: 'admin' },
    ),
    /** The encryption setting — public keys only. */
    getEncryption: method(z.void(), BackupEncryptionStatusSchema, { auth: 'admin' }),
    /**
     * Turn encryption on, or replace the key: generates a new key pair, keeps
     * the PUBLIC key, and returns the SECRET key — once. It is never stored
     * on the hub and cannot be shown again; archives made from now on need
     * it to be restored. A previous key is retired: archives made with it
     * still need IT.
     */
    setupEncryption: method(
      z.object({}),
      z.object({
        keyId: z.string(),
        secretKey: z.string(),
        publicKey: z.string(),
        createdAt: z.number(),
        replacedKeyId: z.string().nullable(),
      }),
      { kind: 'mutation', auth: 'admin' },
    ),
    /** New archives are plain again. Existing encrypted archives keep needing their key. */
    disableEncryption: method(z.object({}), z.object({ disabledKeyId: z.string().nullable() }), {
      kind: 'mutation',
      auth: 'admin',
    }),
    /**
     * Does this secret key parse, and which backup key is it? A mutation so
     * the key never travels in a URL. Nothing is stored.
     */
    checkBackupKey: method(
      z.object({ backupSecretKey: z.string() }),
      z.object({
        valid: z.boolean(),
        keyId: z.string().nullable(),
        /** The hub knows this key (active or retired). */
        known: z.boolean(),
        /** It is the key new archives are encrypted to. */
        active: z.boolean(),
        error: z.string().optional(),
      }),
      { kind: 'mutation', auth: 'admin' },
    ),
    delete: method(z.object({ destinationId: z.string(), backupId: z.string() }), z.void(), {
      kind: 'mutation',
      auth: 'admin',
    }),
    /**
     * List archives at a single destination. Reads the per-location
     * `manifests.json` and returns one entry per archive (newest
     * first). Powers the destinations-table drill-in in admin UI.
     */
    listArchives: method(
      z.object({ destinationId: z.string() }),
      z.array(BackupArchiveEntrySchema).readonly(),
      { auth: 'admin' },
    ),
    /**
     * Upsert a per-destination policy row. The `locationId` MUST be
     * the id of an existing `backups`-typed `StorageLocation`. Used
     * by the admin-UI destinations table (enable toggle + retention
     * input + optional label).
     */
    upsertDestinationPolicy: method(
      z.object({
        locationId: z.string(),
        enabled: z.boolean(),
        retentionCount: z.number().int().min(1).max(1000),
        label: z.string().optional(),
      }),
      z.void(),
      { kind: 'mutation', auth: 'admin' },
    ),

    /**
     * Validate a cron expression and peek the next N firing times.
     * Used by the admin-UI CronEditor to render a live "next-run"
     * preview as the operator edits the pattern.
     */
    previewSchedule: method(
      z.object({
        cron: z.string(),
        count: z.number().int().min(1).max(20).optional(),
      }),
      z.object({
        ok: z.boolean(),
        error: z.string().optional(),
        nextRuns: z.array(z.number()).readonly(),
      }),
    ),

    /**
     * List every backup schedule (the N:M entries), each with its
     * computed `nextRunAt`. Powers the Schedules section of the
     * admin-UI Backups page.
     */
    listSchedules: method(z.void(), z.array(BackupScheduleSchema).readonly(), { auth: 'admin' }),
    /**
     * The database files that exist on this hub right now (the owner's open
     * files), so the selection UI can offer all of them and mark a file that
     * is not created yet. `answered: false` = the owner did not answer, which
     * is not the same as "none exist".
     */
    listAvailableDatabases: method(
      z.void(),
      z.object({ answered: z.boolean(), databases: z.array(DataStoreDatabaseSchema).readonly() }),
      { auth: 'admin' },
    ),
    /**
     * Create or replace a schedule. An empty / absent `id` mints a new
     * one; a present `id` replaces in place. `cron` is validated
     * server-side; `locationIds` must reference existing `backups`
     * locations (unknown ids are dropped with a warning).
     */
    upsertSchedule: method(
      z.object({
        id: z.string().optional(),
        label: z.string(),
        cron: z.string(),
        enabled: z.boolean(),
        locationIds: z.array(z.string()).readonly(),
        retentionCount: z.number().int().min(1).max(1000),
        dataSources: z.array(z.string()).readonly().optional(),
        databases: z.array(DataStoreDatabaseSchema).readonly().optional(),
      }),
      BackupScheduleSchema,
      { kind: 'mutation', auth: 'admin' },
    ),
    /** Delete a schedule by id. Does not touch the target locations. */
    deleteSchedule: method(z.object({ id: z.string() }), z.void(), {
      kind: 'mutation',
      auth: 'admin',
    }),
  },
} as const satisfies CapabilityDefinition

export type IBackupProvider = InferProvider<typeof backupCapability>

export {
  ArchiveEntrySchema,
  ArchiveManifestSchema,
  BackupArchiveEncryptionSchema,
  BackupArchiveEntrySchema,
  BackupEncryptionStatusSchema,
  BackupDestinationInfoSchema,
  BackupEntrySchema,
  BackupRunPhaseSchema,
  BackupRunSchema,
  BackupRunStateSchema,
  BackupScheduleSchema,
  BackupSubDestinationInfoSchema,
  BackupTriggerResultSchema,
  LocationStatSchema,
}

export type BackupArchiveEncryption = z.infer<typeof BackupArchiveEncryptionSchema>
export type BackupEncryptionStatus = z.infer<typeof BackupEncryptionStatusSchema>
export type BackupRunState = z.infer<typeof BackupRunStateSchema>
export type BackupRunPhase = z.infer<typeof BackupRunPhaseSchema>
export type BackupRun = z.infer<typeof BackupRunSchema>
export type BackupTriggerResult = z.infer<typeof BackupTriggerResultSchema>
