/**
 * `backup-orchestrator` builtin — singleton owner of the `backup` cap.
 *
 * Responsibilities:
 *   - Schedule (cron-like timer at top of hour, daily/weekly cadence)
 *   - Per-destination policy (enable/disable, retention count, label)
 *     persisted in the `destination-policies` records kind (this builtin
 *     owns the kind).
 *   - Archive build (one tar.gz with embedded manifest, fanned out to
 *     every selected `backups`-typed `StorageLocation` via the
 *     consumer-facing `storage` cap's chunked upload protocol).
 *   - Aggregate listing/restore/delete across destinations — operates
 *     on the per-location `manifests.json` index file, not the
 *     archives directly.
 *
 * Storage routing: destinations are
 * `api.storage.listLocations({ type: 'backups' })` — every operator-
 * visible `backups` location IS a destination. The orchestrator joins
 * that list with the `destination-policies` records to surface
 * `enabled` / `retentionCount` / `label`. The actual archive bytes
 * travel through `api.storage.beginUpload` / `writeChunk` /
 * `finalizeUpload`, with the staging archive built into
 * `<nodeDataDir>/backup-staging` (outside every backed-up location —
 * see staging-paths.ts).
 */
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import type {
  DataStoreDatabase,
  ISettingsStoreProvider,
  IStorageOccupancyProvider,
  ProviderRegistration,
  StorageLocation,
  StorageOccupancyReport,
} from '@camstack/types'
import {
  BaseAddon,
  backupCapability,
  EventCategory,
  mayWriteToLocation,
  nodePin,
  storageOccupancyCapability,
  toNodeId,
} from '@camstack/types'

/** The `storage-occupancy` request shape, derived from the cap's provider
 *  interface — never an inline object type on a signature. */
type StorageOccupancyInput = Parameters<IStorageOccupancyProvider['getOccupancy']>[0]

import {
  type ArchiveManifest,
  BackupCancelledError,
  BackupSnapshotRefusedError,
  DEFAULT_BACKUP_DATABASES,
  type DatabaseOwner,
  SystemBackupService,
} from '../system-backup/system-backup.service.js'
import {
  databasesOfSchedule,
  hasNothingBeyondSettings,
  seedWeeklySchedule,
} from './backup-databases.js'
import {
  backupOrchestratorRecordKinds,
  backupRecordStoresOf,
  type BackupRecordStores,
} from './record-kinds.js'
import { BackupSeedMarkerStore } from './seed-marker-store.js'
import { computeNextDue, isValidCron, previewNextRuns } from './cron-helpers.js'
import {
  type BackupDestinationPolicy,
  BackupDestinationPolicyService,
} from './destination-policy.js'
import {
  BackupKeyFormatError,
  ENCRYPTED_BACKUP_SUFFIX,
  generateBackupKeyPair,
  parseBackupSecretKey,
} from '../system-backup/backup-encryption.js'
import { downloadArchiveToCache } from './download-helpers.js'
import { BackupEncryptionKeyStore } from './encryption-key-store.js'
import {
  applyRetention,
  buildArchiveEntry,
  type LocationBackupManifest,
  LocationManifestLock,
  type ManifestArchiveEncryption,
  type ManifestArchiveEntry,
  type ManifestStorageApi,
  readLocationManifest,
  retentionClassOf,
  writeLocationManifest,
} from './manifest-store.js'
import {
  type BackupRunProgress,
  BackupRunQueue,
  type BackupRunRequest,
  type BackupRunSnapshot,
} from './run-queue.js'
import { precheckRestoreKey, prepareRestoreArchive } from './restore-archive.js'
import { type BackupSchedule, BackupScheduleService } from './schedule-store.js'
import { measureDirectoryFootprint, resolveStagingDir, sweepStagingDir } from './staging-paths.js'
import { selectBackupTargets } from './write-targets.js'

/**
 * Hardcoded seed for newly-discovered `backups` locations. Operators
 * tune retention per-destination after creation via the destinations
 * table. Promoted from a configurable global to a constant when the
 * orchestrator's settings panel was retired (per-destination cron +
 * inline retention input on the destinations row replaces every knob
 * the panel used to expose).
 */
const DEFAULT_RETENTION_COUNT = 7

const SCHEDULE_TICK_MS = 60_000

/**
 * Build the human-facing archive label. Every archive always carries
 * the destination id and the creation date — useful in restore wizards
 * + cross-destination listings where UUIDs are unreadable.
 *
 * Format: `${destinationId} · ${YYYY-MM-DD HH:mm}[${suffix}]`. Suffix is
 * an optional operator-provided tag (e.g. "before-migration") appended
 * after another middot. UTC is intentional — labels are also written
 * into the per-location manifest which travels across timezones with
 * the backup.
 */
function formatArchiveLabel(destinationId: string, createdAt: number, suffix?: string): string {
  const d = new Date(createdAt)
  const pad = (n: number): string => String(n).padStart(2, '0')
  const stamp = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
  const trimmed = suffix?.trim()
  return trimmed ? `${destinationId} · ${stamp} · ${trimmed}` : `${destinationId} · ${stamp}`
}

/**
 * Chunk size for the read-stream that feeds the chunked upload pipe.
 * 8 MiB is well under the WS frame limit (16 MiB on tRPC) with headroom.
 */
const UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024

interface BackupEntryWire {
  readonly id: string
  readonly destinationId?: string
  readonly label?: string
  readonly createdAt: number
  readonly sizeBytes: number
  readonly locations?: string[]
  readonly encryption?: ManifestArchiveEncryption
}

/** Wire shape of `backup.getEncryption` — public keys only. */
interface BackupEncryptionStatusWire {
  readonly enabled: boolean
  readonly active: { keyId: string; publicKey: string; createdAt: number } | null
  readonly keys: readonly { keyId: string; createdAt: number; retiredAt: number | null }[]
}

/**
 * Wire shape returned by `backup.listDestinations`. Defined locally
 * (not imported from the cap module) because this addon is the
 * authoritative producer of the shape — keeping the literal here makes
 * the field set obvious at the producer site. Stays in lockstep with
 * `BackupDestinationInfoSchema` in `backup.cap.ts`.
 */
interface BackupDestinationInfoWire {
  readonly id: string
  readonly addonId: string
  readonly subId: string
  readonly displayName: string
  readonly kind: string
  readonly triggerSupported: boolean
  readonly restoreSupported: boolean
  /** Per-destination policy from the `destination-policies` records kind. */
  readonly enabled: boolean
  readonly retentionCount: number
  readonly label?: string
  /** Newest-archive metadata from `manifests.json` (when one exists). */
  readonly lastSuccessAt?: number
  readonly lastSuccessSizeBytes?: number
  /**
   * Cadence(s) of the ENABLED schedules that fan out here, comma-joined.
   * Absent when nothing is scheduled to write to this destination. Never
   * the legacy `backup_destination_policies.cron` column — see D384.
   */
  readonly cron?: string
  /** Earliest next firing across those schedules. */
  readonly nextRunAt?: number
  /** ms-epoch of the last ATTEMPTED write here, success or failure. */
  readonly lastAttemptAt?: number
  /** Why the last attempt failed, verbatim. Absent when it landed. */
  readonly lastError?: string
}

/**
 * Wire shape of one run in `backup.listRuns`. Stays in lockstep with
 * `BackupRunSchema` in `backup.cap.ts` — this addon is the producer.
 * Structurally identical to `BackupRunSnapshot` from run-queue.ts.
 */
type BackupRunWire = BackupRunSnapshot

/**
 * Wire shape returned by `backup.trigger`. Stays in lockstep with
 * `BackupTriggerResultSchema` in `backup.cap.ts`.
 */
interface BackupTriggerResultWire {
  readonly runId: string
  readonly queued: boolean
  readonly joined: boolean
  readonly cancelled: boolean
  readonly entries: readonly BackupEntryWire[]
}

interface BackupArchiveEntryWire {
  readonly id: string
  readonly filename: string
  readonly createdAt: number
  readonly sizeBytes: number
  readonly label?: string
  readonly locations: readonly string[]
  readonly encryption?: ManifestArchiveEncryption
  readonly databases?: readonly DataStoreDatabase[]
}

/**
 * The cadence one `backups` location is subject to, joined from the enabled
 * schedules that fan out to it. Empty map entry = nothing writes here on a
 * timer.
 */
interface DestinationCadence {
  readonly crons: readonly string[]
  readonly nextRunAt?: number
}

interface BackupScheduleWire {
  readonly id: string
  readonly label: string
  readonly cron: string
  readonly enabled: boolean
  readonly locationIds: readonly string[]
  readonly retentionCount: number
  readonly dataSources?: readonly string[]
  readonly databases?: readonly DataStoreDatabase[]
  readonly lastAttemptAt?: number
  readonly lastSuccessAt?: number
  readonly lastError?: string
  readonly nextRunAt?: number
}

interface OrchestratorProvider {
  listDestinations(): Promise<readonly BackupDestinationInfoWire[]>
  list(): Promise<readonly BackupEntryWire[]>
  listLocations(): Promise<readonly unknown[]>
  trigger(input?: {
    destinations?: string[]
    locations?: string[]
    label?: string
    retentionCount?: number
  }): Promise<BackupTriggerResultWire>
  listRuns(): Promise<readonly BackupRunWire[]>
  cancel(input: { runId: string }): Promise<{ cancelled: boolean }>
  getEntries(input: { destinationId: string; backupId: string }): Promise<unknown>
  restore(input: {
    destinationId: string
    backupId: string
    locations?: string[]
    backupSecretKey?: string
  }): Promise<void>
  getEncryption(): Promise<BackupEncryptionStatusWire>
  setupEncryption(): Promise<{
    keyId: string
    secretKey: string
    publicKey: string
    createdAt: number
    replacedKeyId: string | null
  }>
  disableEncryption(): Promise<{ disabledKeyId: string | null }>
  checkBackupKey(input: { backupSecretKey: string }): Promise<{
    valid: boolean
    keyId: string | null
    known: boolean
    active: boolean
    error?: string
  }>
  delete(input: { destinationId: string; backupId: string }): Promise<void>
  listArchives(input: { destinationId: string }): Promise<readonly BackupArchiveEntryWire[]>
  upsertDestinationPolicy(input: {
    locationId: string
    enabled: boolean
    retentionCount: number
    label?: string
    cron?: string
  }): Promise<void>
  previewSchedule(input: {
    cron: string
    count?: number
  }): Promise<{ ok: boolean; error?: string; nextRuns: readonly number[] }>
  listSchedules(): Promise<readonly BackupScheduleWire[]>
  listAvailableDatabases(): Promise<{
    answered: boolean
    databases: readonly DataStoreDatabase[]
  }>
  upsertSchedule(input: {
    id?: string
    label: string
    cron: string
    enabled: boolean
    locationIds: readonly string[]
    retentionCount: number
    dataSources?: readonly string[]
    databases?: readonly DataStoreDatabase[]
  }): Promise<BackupScheduleWire>
  deleteSchedule(input: { id: string }): Promise<void>
}

/** Manifest id this addon registers under (must match `package.json`). */
const ORCHESTRATOR_ADDON_ID = 'backup-orchestrator'

export class BackupOrchestratorAddon extends BaseAddon<Record<string, never>> {
  private systemBackup: SystemBackupService | null = null
  private backupRecords: BackupRecordStores | null = null
  private policies: BackupDestinationPolicyService | null = null
  private schedules: BackupScheduleService | null = null
  /** Backup encryption keys — PUBLIC keys only (see encryption-key-store.ts). */
  private encryptionKeys: BackupEncryptionKeyStore | null = null
  private warnedNoEncryptionStore = false
  private dataDir = ''
  /**
   * Transient build buffer for archive fan-out. The tar is built here
   * ONCE, streamed to every destination via the storage cap's chunked
   * upload, then removed. Lives at `<nodeDataDir>/backup-staging` —
   * OUTSIDE every backed-up location, so a backup can never contain a
   * backup (the old `ctx.dataDir/staging` sat inside `addons-data` and
   * compounded 175M → 4.5G before Jul 28), and distinct from
   * `<nodeDataDir>/backups` where the default `backups` destination
   * seeds when `CAMSTACK_BACKUP_ROOT` is unset. See staging-paths.ts.
   */
  private stagingDir = ''
  private scheduleTimer: NodeJS.Timeout | null = null
  /** Guards the disarmed-scheduler complaint to once per process. */
  private warnedSchedulerDisarmed = false
  /**
   * Baseline used as the "after" anchor when a schedule has a cron but
   * has never fired yet (no `lastAttemptAt`). Set on orchestrator boot so a
   * pattern that fires every minute doesn't immediately replay every
   * historical "missed" run from epoch 0.
   */
  private scheduleBaselineAt = Date.now()
  private readonly manifestLock = new LocationManifestLock()
  /**
   * Global execution queue — at most ONE archive build at a time,
   * cluster-node-wide (D342). Replaces the earlier invisible
   * single-flight `buildLock`: same serialisation guarantee (two
   * schedules due one tick apart built 8.2 GB + 3.7 GB side by side on
   * the hub, 2026-09-04), but every run is now observable via
   * `listRuns`, joinable when identical, and cancellable mid-stream.
   */
  private runQueue: BackupRunQueue<readonly BackupEntryWire[]> | null = null

  constructor() {
    super({})
  }

  protected async onInitialize(): Promise<ProviderRegistration[]> {
    const records = this.ctx.records
    if (records !== undefined) {
      await records.declare(backupOrchestratorRecordKinds)
      this.backupRecords = backupRecordStoresOf(records)
    }

    // The node-local data root (`CAMSTACK_DATA` ?? kernel boot dir). Never the
    // hub-singleton `storage` cap. Backup *destinations* stay configurable via
    // the `backups` storage location; this is only the local source root.
    this.dataDir = this.ctx.nodeDataDir
    this.stagingDir = resolveStagingDir(this.ctx.nodeDataDir)
    this.systemBackup = new SystemBackupService(this.dataDir, this.ctx.logger)
    this.runQueue = new BackupRunQueue((request, signal, progress) =>
      this.runBackupBuild(request, signal, progress),
    )

    // Staging is transient by contract; anything found at init is a
    // leak (crashed fan-out, consumed restore download) — except an
    // archive a pending-restore marker still points at.
    await this.cleanStagingArea()

    // The per-destination policies and the schedules (the N:M "entry"
    // store) are records kinds only (D902). Without `ctx.records` nothing
    // persists, and that is said once here rather than discovered later.
    const backupRecords = this.backupRecords
    if (backupRecords === null) {
      this.ctx.logger.warn(
        'backup-orchestrator: no ctx.records — schedules and destination policies will not persist',
      )
    } else {
      this.policies = new BackupDestinationPolicyService(backupRecords.destinationPolicies)
      this.schedules = new BackupScheduleService(backupRecords.schedules)
    }
    await this.seedWeekly()

    const settingsStore =
      this.ctx.kernel.capabilityRegistry?.getSingleton<ISettingsStoreProvider>('settings-store')
    this.encryptionKeys = settingsStore
      ? new BackupEncryptionKeyStore(
          settingsStore,
          Date.now,
          this.backupRecords?.encryptionKeys ?? null,
        )
      : null

    const provider: OrchestratorProvider = {
      listDestinations: () => this.listDestinations(),
      list: () => this.aggregatedList(),
      listLocations: () => this.systemBackup!.statLocations(),
      trigger: (input) => this.triggerBackup(input),
      listRuns: () => this.listRuns(),
      cancel: (input) => this.cancelRun(input),
      getEntries: (input) => this.getEntries(input),
      restore: (input) => this.scheduleRestore(input),
      getEncryption: () => this.getEncryption(),
      setupEncryption: () => this.setupEncryption(),
      disableEncryption: () => this.disableEncryption(),
      checkBackupKey: (input) => this.checkBackupKey(input),
      delete: (input) => this.deleteArchive(input),
      listArchives: (input) => this.listArchives(input),
      upsertDestinationPolicy: (input) => this.upsertDestinationPolicy(input),
      previewSchedule: (input) => this.previewSchedule(input),
      listSchedules: () => this.listSchedules(),
      listAvailableDatabases: () => this.listAvailableDatabases(),
      upsertSchedule: (input) => this.upsertSchedule(input),
      deleteSchedule: (input) => this.deleteSchedule(input),
    }

    this.startScheduleTimer()

    this.ctx.logger.info('Backup orchestrator initialized', {
      meta: {
        dataDir: this.dataDir,
        policies: this.policies !== null,
      },
    })
    return [
      { capability: backupCapability, provider: provider as never },
      // How many bytes the archives hold on each `backups` location (D388).
      // Backups register NO `storage-evictable` provider — nothing here is
      // evictable under disk pressure, retention is by COUNT — which is
      // exactly why occupancy needed its own cap rather than reusing that one.
      {
        capability: storageOccupancyCapability,
        provider: {
          getOccupancy: async (input: StorageOccupancyInput) =>
            this.backupOccupancy(input.locationIds),
        },
      },
    ]
  }

  protected async onShutdown(): Promise<void> {
    this.stopScheduleTimer()
    // Abort every non-terminal run so tar/upload streams close and the
    // in-flight run's own cleanup deletes its staging archive — a
    // shutdown must not depend on the next boot's sweep to reclaim
    // gigabytes it knew about.
    if (this.runQueue) {
      for (const run of this.runQueue.listRuns()) {
        if (run.state === 'queued' || run.state === 'running') {
          this.runQueue.cancel(run.id)
        }
      }
    }
    this.runQueue = null
    this.systemBackup = null
    this.policies = null
    this.schedules = null
  }

  // ─── Public surface ─────────────────────────────────────────────────

  /**
   * Aggregate destinations from `api.storage.listLocations({ type: 'backups' })`
   * joined with the per-destination policy table. New locations get an
   * `ensureDefault` policy seeded transparently (enabled=true,
   * retentionCount=defaultRetentionCount). Pre-existing operator-edited
   * policies are preserved by the `ensureDefault` idempotency.
   */
  private async listDestinations(): Promise<readonly BackupDestinationInfoWire[]> {
    const locations = await this.fetchBackupLocations()
    const policies = await this.loadPoliciesIndexed(locations.map((l) => l.id))
    // Hydrate lastSuccess from each location's manifest. Failures are
    // logged inside readLocationManifest's caller — `latestArchiveOf`
    // tolerates missing/corrupt manifests by returning undefined so
    // the table still renders the destination row.
    const lastSuccess = await Promise.all(
      locations.map(async (loc): Promise<readonly [string, ManifestArchiveEntry | undefined]> => {
        try {
          const manifest = await readLocationManifest(this.storageApi(), loc.id)
          return [loc.id, latestArchiveOf(manifest)]
        } catch {
          return [loc.id, undefined]
        }
      }),
    )
    const lastSuccessByLoc = new Map(lastSuccess)
    // The cadence a destination advertises comes from the SCHEDULES that
    // target it — the only thing that fires a backup since 2026-07-28. A
    // destination reached by no enabled schedule shows no cron and no next
    // run, which is the truth `backups:default` hid for six weeks (D384).
    const cadence = await this.cadenceByLocation()
    return locations.map((loc) =>
      this.toDestinationWire(
        loc,
        policies.get(loc.id),
        lastSuccessByLoc.get(loc.id),
        cadence.get(loc.id),
      ),
    )
  }

  /**
   * Join the enabled schedules by the locations they fan out to.
   * Comma-joined crons (a location can be targeted by several schedules),
   * earliest next firing. Computed from `Date.now()` — an operator asking
   * "when next" means from now, never from a stale run cursor.
   */
  private async cadenceByLocation(): Promise<Map<string, DestinationCadence>> {
    const out = new Map<string, DestinationCadence>()
    if (!this.schedules) return out
    const schedules = await this.schedules.list().catch((err): readonly BackupSchedule[] => {
      this.ctx.logger.warn('backup-orchestrator: schedule list failed — cadence unknown', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
      return []
    })
    const now = Date.now()
    for (const s of schedules) {
      if (!s.enabled || s.cron.trim().length === 0) continue
      const next = this.safeNextDue(s.cron, now)
      for (const id of s.locationIds) {
        const prev = out.get(id)
        const crons = prev ? [...prev.crons, s.cron] : [s.cron]
        const nextRunAt =
          next === undefined
            ? prev?.nextRunAt
            : prev?.nextRunAt === undefined
              ? next
              : Math.min(prev.nextRunAt, next)
        out.set(id, { crons, ...(nextRunAt !== undefined ? { nextRunAt } : {}) })
      }
    }
    return out
  }

  private async fetchBackupLocations(): Promise<readonly StorageLocation[]> {
    try {
      const out = await this.ctx.api.storage.listLocations.query({
        type: 'backups',
      })
      return out
    } catch (err) {
      this.ctx.logger.error('backup-orchestrator: listLocations failed', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
      return []
    }
  }

  /**
   * Load every persisted policy and key it by `locationId`, while
   * lazily seeding a default for any `locationId` we haven't seen
   * before. Idempotent — `ensureDefault` no-ops on already-persisted
   * rows. Falls back to the in-memory default policy when the policy
   * service isn't wired (no `ctx.records`).
   */
  private async loadPoliciesIndexed(
    locationIds: readonly string[],
  ): Promise<ReadonlyMap<string, BackupDestinationPolicy>> {
    const out = new Map<string, BackupDestinationPolicy>()
    if (!this.policies) {
      // No persistence available — fabricate enabled defaults so the UI
      // still surfaces every backups location as a destination.
      for (const id of locationIds) {
        out.set(id, this.fallbackPolicy(id))
      }
      return out
    }
    const persisted = await this.policies
      .list()
      .catch((err): readonly BackupDestinationPolicy[] => {
        this.ctx.logger.warn('backup-orchestrator: policy list failed — using defaults', {
          meta: { error: err instanceof Error ? err.message : String(err) },
        })
        return []
      })
    for (const p of persisted) {
      out.set(p.locationId, p)
    }
    // Seed defaults for previously-unseen locations.
    for (const id of locationIds) {
      if (out.has(id)) continue
      try {
        const fresh = await this.policies.ensureDefault(id, {
          retentionCount: DEFAULT_RETENTION_COUNT,
        })
        out.set(id, fresh)
      } catch (err) {
        this.ctx.logger.warn('backup-orchestrator: ensureDefault failed', {
          meta: {
            locationId: id,
            error: err instanceof Error ? err.message : String(err),
          },
        })
        out.set(id, this.fallbackPolicy(id))
      }
    }
    return out
  }

  private fallbackPolicy(locationId: string): BackupDestinationPolicy {
    return {
      locationId,
      enabled: true,
      retentionCount: DEFAULT_RETENTION_COUNT,
    }
  }

  private toDestinationWire(
    loc: StorageLocation,
    policy: BackupDestinationPolicy | undefined,
    latest: ManifestArchiveEntry | undefined,
    cadence: DestinationCadence | undefined,
  ): BackupDestinationInfoWire {
    const effective = policy ?? this.fallbackPolicy(loc.id)
    const subId = extractSlug(loc.id)
    const displayName =
      effective.label && effective.label.length > 0 ? effective.label : loc.displayName
    return {
      id: loc.id,
      // The orchestrator builtin is now the addon-of-record for every
      // `backups` location — there's no per-destination addon owner.
      // The Settings button on a destination card opens the
      // orchestrator's panel.
      addonId: ORCHESTRATOR_ADDON_ID,
      subId,
      displayName,
      kind: kindFromProviderId(loc.providerId),
      // What the fan-out will ACTUALLY do with this destination, both gates
      // applied: the per-destination policy opt-in AND the operator's
      // `StorageLocation.enabled`. D62 clause 4 — a function switched off is
      // reported off, so a card cannot claim a destination is live while
      // `resolveTargets` skips it.
      triggerSupported: effective.enabled && mayWriteToLocation(loc),
      restoreSupported: true,
      enabled: effective.enabled,
      retentionCount: effective.retentionCount,
      ...(effective.label !== undefined ? { label: effective.label } : {}),
      ...(latest !== undefined ? { lastSuccessAt: latest.createdAt } : {}),
      ...(latest !== undefined ? { lastSuccessSizeBytes: latest.sizeBytes } : {}),
      ...(cadence !== undefined ? { cron: cadence.crons.join(', ') } : {}),
      ...(cadence?.nextRunAt !== undefined ? { nextRunAt: cadence.nextRunAt } : {}),
      ...(effective.lastAttemptAt !== undefined ? { lastAttemptAt: effective.lastAttemptAt } : {}),
      ...(effective.lastError !== undefined ? { lastError: effective.lastError } : {}),
    }
  }

  /**
   * Compute next-due ms-epoch for a cron, or `undefined` on parse error.
   * Catches so a single malformed cron doesn't blank out the whole
   * destinations list at the cap surface.
   */
  private safeNextDue(cron: string, after: number | undefined): number | undefined {
    try {
      const next = computeNextDue(cron, after ?? this.scheduleBaselineAt)
      return next ?? undefined
    } catch {
      return undefined
    }
  }

  /**
   * Aggregate listing — read every `backups` location's `manifests.json`
   * and return one wire entry per archive, tagged with `destinationId`.
   * Failures on individual locations are logged and skipped so a single
   * unreachable destination doesn't blank out the whole UI.
   */
  /**
   * Bytes the archives occupy on each named location (D388).
   *
   * Summed from each location's own manifest — the record the uploader writes
   * — so this never walks a filesystem and never stats a remote destination.
   * A manifest that cannot be read contributes NOTHING and is logged: a
   * destination that is temporarily unreachable must read back as unknown, not
   * as an empty disk. A location holding no archives is omitted for the same
   * reason it is omitted everywhere else — only the orchestrator can tell
   * "nobody reported" from "reported nothing".
   */
  private async backupOccupancy(
    locationIds: readonly string[],
  ): Promise<readonly StorageOccupancyReport[]> {
    const measuredAtMs = Date.now()
    const out: StorageOccupancyReport[] = []
    for (const locationId of locationIds) {
      let manifest: LocationBackupManifest
      try {
        manifest = await readLocationManifest(this.storageApi(), locationId)
      } catch {
        // Not a warning per sweep: `listLocations` asks for EVERY location and
        // most of them are not `backups` at all, so a missing manifest is the
        // common, expected case.
        continue
      }
      const ownedBytes = manifest.archives.reduce((sum, a) => sum + a.sizeBytes, 0)
      if (ownedBytes <= 0) continue
      out.push({ locationId, ownedBytes, measuredAtMs })
    }
    return out
  }

  private async aggregatedList(): Promise<readonly BackupEntryWire[]> {
    const locations = await this.fetchBackupLocations()
    const out: BackupEntryWire[] = []
    for (const loc of locations) {
      let manifest: LocationBackupManifest
      try {
        manifest = await readLocationManifest(this.storageApi(), loc.id)
      } catch (err) {
        this.ctx.logger.warn('backup list: manifest read failed', {
          meta: {
            locationId: loc.id,
            error: err instanceof Error ? err.message : String(err),
          },
        })
        continue
      }
      for (const a of manifest.archives) {
        const entry: BackupEntryWire = {
          id: a.id,
          destinationId: loc.id,
          createdAt: a.createdAt,
          sizeBytes: a.sizeBytes,
          ...(a.label !== undefined ? { label: a.label } : {}),
          locations: [...a.manifest.locations],
          ...(a.encryption !== undefined ? { encryption: a.encryption } : {}),
        }
        out.push(entry)
      }
    }
    return out
  }

  private async stagingPath(filename: string): Promise<string> {
    await fsp.mkdir(this.stagingDir, { recursive: true })
    return path.join(this.stagingDir, filename)
  }

  /**
   * Boot-time staging hygiene. Sweeps the staging dir (sparing an
   * archive a pending-restore marker references — the boot hook has
   * not consumed it yet), then reports — without touching — the LEGACY
   * staging dir inside `addons-data`, where pre-move leaks live. The
   * legacy dir held 5.1 GB on the hub; deleting operator-visible
   * gigabytes silently is not this addon's call, so it warns with the
   * footprint instead.
   */
  private async cleanStagingArea(): Promise<void> {
    const marker = this.systemBackup?.readPendingMarker() ?? null
    const keepPaths = marker ? [marker.archivePath] : []
    try {
      const swept = await sweepStagingDir({
        stagingDir: this.stagingDir,
        keepPaths,
        logger: this.ctx.logger,
      })
      if (swept.removedCount > 0) {
        this.ctx.logger.info('backup staging swept — leaked transient files removed', {
          meta: {
            stagingDir: this.stagingDir,
            removedCount: swept.removedCount,
            freedBytes: swept.freedBytes,
            keptForPendingRestore: swept.keptCount,
          },
        })
      }
    } catch (err) {
      this.ctx.logger.warn('backup staging sweep failed — continuing', {
        meta: {
          stagingDir: this.stagingDir,
          error: err instanceof Error ? err.message : String(err),
        },
      })
    }
    const legacyDir = path.join(this.ctx.dataDir, 'staging')
    try {
      const legacy = await measureDirectoryFootprint(legacyDir)
      if (legacy.present && legacy.fileCount > 0) {
        this.ctx.logger.warn(
          'legacy backup staging dir still holds files inside addons-data — excluded from archives, but the disk space is only reclaimed by deleting it',
          {
            meta: {
              legacyDir,
              fileCount: legacy.fileCount,
              totalBytes: legacy.totalBytes,
            },
          },
        )
      }
    } catch {
      /* diagnostics only — never blocks init */
    }
  }

  /**
   * Trigger a backup run through the global execution queue (D342):
   * at most one archive build at a time, a trigger that arrives while
   * one is in flight WAITS (or joins an identical queued run), and the
   * result says which happened. The call still resolves when the run
   * terminates; a cancelled run resolves with `cancelled: true` and
   * whatever entries landed before the stop — a deliberate operator
   * cancel is an outcome, not an error.
   */
  private async triggerBackup(input?: {
    destinations?: string[]
    locations?: string[]
    label?: string
    retentionCount?: number
    databases?: DataStoreDatabase[]
  }): Promise<BackupTriggerResultWire> {
    if (!this.runQueue) throw new Error('orchestrator not initialized')
    const request: BackupRunRequest = {
      ...(input?.destinations ? { destinations: input.destinations } : {}),
      ...(input?.locations ? { locations: input.locations } : {}),
      ...(input?.label !== undefined ? { label: input.label } : {}),
      ...(input?.retentionCount !== undefined ? { retentionCount: input.retentionCount } : {}),
      ...(input?.databases ? { databases: input.databases } : {}),
    }
    const submitted = this.runQueue.submit(request)
    if (submitted.queued) {
      this.ctx.logger.info(
        submitted.joined
          ? 'backup trigger: identical run already queued — joined it'
          : 'backup trigger: a run is in flight — enqueued behind it',
        { meta: { runId: submitted.runId } },
      )
    }
    let entries: readonly BackupEntryWire[]
    try {
      entries = await submitted.result
    } catch (err) {
      if (!(err instanceof BackupCancelledError)) throw err
      entries = []
    }
    const finalState = this.runQueue?.getRun(submitted.runId)?.state
    return {
      runId: submitted.runId,
      queued: submitted.queued,
      joined: submitted.joined,
      cancelled: finalState === 'cancelled',
      entries,
    }
  }

  /** Wire `backup.listRuns` — queued + active + bounded history. */
  private async listRuns(): Promise<readonly BackupRunWire[]> {
    return this.runQueue?.listRuns() ?? []
  }

  /**
   * Wire `backup.cancel`. Delegates to the queue: a queued run is
   * removed before it starts; the running run's abort signal fires and
   * `runBackupBuild` stops the tar/upload streams and deletes its
   * staging archive on the way out.
   */
  private async cancelRun(input: { runId: string }): Promise<{ cancelled: boolean }> {
    const cancelled = this.runQueue?.cancel(input.runId) ?? false
    if (cancelled) {
      this.ctx.logger.info('backup run cancel requested', { meta: { runId: input.runId } })
    } else {
      this.ctx.logger.warn('backup cancel: run unknown or already terminal', {
        meta: { runId: input.runId },
      })
    }
    return { cancelled }
  }

  /**
   * Execute ONE backup run — only ever called by the queue, never
   * directly (the queue is the single serialisation authority).
   * Builds the archive in the private staging dir, then pushes it to
   * every selected destination via the storage cap's chunked upload
   * protocol. Per-destination errors are logged and recorded on the
   * run — one bad sink doesn't kill the run.
   *
   * Cleanup contract (D342): the staging file is deleted in `finally`,
   * which covers success, per-destination failure, build failure AND
   * cancellation alike. The only leak this cannot cover — the process
   * dying inside the run — is reclaimed by the boot sweep in
   * `cleanStagingArea`.
   */
  private async runBackupBuild(
    input: BackupRunRequest,
    signal: AbortSignal,
    progress: BackupRunProgress,
  ): Promise<readonly BackupEntryWire[]> {
    if (!this.systemBackup) throw new Error('orchestrator not initialized')
    const targets = await this.resolveTargets(
      input.destinations !== undefined ? [...input.destinations] : undefined,
    )
    if (targets.length === 0) {
      this.ctx.logger.warn(
        'backup trigger: no destinations selected — this archive is being dropped',
        {
          meta: {
            requestedDestinationIds:
              input.destinations !== undefined ? [...input.destinations] : [],
            label: input.label ?? null,
          },
        },
      )
      return []
    }
    progress.setDestinations(targets.map((t) => t.id))
    // Load per-destination retention up-front so each upload doesn't
    // re-walk the policy table. The policy index is keyed by
    // locationId; missing entries fall back to defaultRetentionCount.
    const policies = await this.loadPoliciesIndexed(targets.map((t) => t.id))
    // Fail closed: a setting that cannot be read is never taken for "off".
    const encryptTo = await this.activeEncryptionKey()
    const archiveId = randomUUID()
    const archiveFilename =
      encryptTo === null ? `${archiveId}.tar.gz` : `${archiveId}.tar.gz${ENCRYPTED_BACKUP_SUFFIX}`
    const cachePath = await this.stagingPath(archiveFilename)
    let result: Awaited<ReturnType<SystemBackupService['createArchive']>>
    try {
      result = await this.systemBackup.createArchive({
        archivePath: cachePath,
        ...(input.locations ? { locations: [...input.locations] } : {}),
        signal,
        onArchiveBytes: (bytes) => progress.setStagedBytes(bytes),
        // The settings database enters the archive only as its owner's
        // verified snapshot, never as a copy of its live files (D693).
        owner: this.databaseOwner(),
        ...(input.databases ? { databases: input.databases } : {}),
        ...(encryptTo !== null ? { encryptTo: encryptTo.publicKey } : {}),
      })
    } catch (err) {
      if (err instanceof BackupSnapshotRefusedError) {
        // Nothing was built, so nothing is uploaded and no destination prunes.
        // The refusal must still outlive this process on every destination it
        // denied (D384).
        for (const dest of targets) {
          progress.destinationFailed(dest.id)
          await this.recordDestinationOutcome(dest.id, Date.now(), err.message)
        }
      }
      throw err
    }
    progress.setArchiveSize(result.sizeBytes)
    progress.setPhase('uploading')
    try {
      const entries: BackupEntryWire[] = []
      // Stamp creation time ONCE for the whole fan-out so every
      // destination's label carries the same date — the archive bytes
      // are identical across destinations, the label should match.
      const createdAt = Date.now()
      // Fan out sequentially — destinations are typically few (≤ 5)
      // and the read-stream feeds each destination's chunked upload
      // back-to-back. Parallelizing risks blowing the WS frame budget.
      for (const dest of targets) {
        if (signal.aborted) {
          // A branch that drops work logs it: the remaining
          // destinations never receive this archive.
          this.ctx.logger.info('backup run cancelled — skipping remaining destinations', {
            meta: {
              runCancelledAfter: entries.length,
              skippedDestinationIds: targets.slice(targets.indexOf(dest)).map((t) => t.id),
            },
          })
          break
        }
        try {
          const policy = policies.get(dest.id) ?? this.fallbackPolicy(dest.id)
          const stored = await this.uploadAndIndex({
            locationId: dest.id,
            archiveId,
            archiveFilename,
            cachePath,
            sizeBytes: result.sizeBytes,
            archiveManifest: result.manifest,
            retentionCount: input.retentionCount ?? policy.retentionCount,
            databases: input.databases ?? DEFAULT_BACKUP_DATABASES,
            createdAt,
            label: formatArchiveLabel(dest.id, createdAt, input.label),
            ...(result.encryption !== undefined ? { encryption: result.encryption } : {}),
            signal,
            onUploadedBytes: (bytes) => progress.setUploadedBytes(bytes),
          })
          entries.push(stored)
          progress.destinationCompleted(dest.id)
          await this.recordDestinationOutcome(dest.id, createdAt)
          this.ctx.eventBus.emit({
            id: randomUUID(),
            timestamp: new Date(),
            source: { type: 'addon', id: 'backup-orchestrator' },
            category: EventCategory.BackupCompleted,
            data: {
              destinationId: dest.id,
              backupId: stored.id,
              sizeMB: Math.round((stored.sizeBytes ?? 0) / (1024 * 1024)),
            },
          })
        } catch (err) {
          if (err instanceof BackupCancelledError) {
            // The in-flight chunked upload was aborted server-side
            // (partial discarded at the destination); the aborted-loop
            // check above logs the remaining skips on the next pass.
            continue
          }
          progress.destinationFailed(dest.id)
          const message = err instanceof Error ? err.message : String(err)
          this.ctx.logger.error('backup trigger: destination failed', {
            meta: { destinationId: dest.id, error: message },
          })
          // The failure must OUTLIVE this process. The hub restarts many
          // times a day and `listRuns` is in-memory; a 03:00 refusal that
          // lived only there was gone before anyone looked (D384).
          await this.recordDestinationOutcome(dest.id, Date.now(), message)
        }
      }
      // The RUN is over — every destination attempted. One event, whatever the
      // destination count, carrying how many won and how many did not: see
      // `EventCategory.BackupRunCompleted` for why a bare "completed" would be
      // a lie on a partial run.
      this.ctx.eventBus.emit({
        id: randomUUID(),
        timestamp: new Date(),
        source: { type: 'addon', id: 'backup-orchestrator' },
        category: EventCategory.BackupRunCompleted,
        data: {
          destinationsOk: entries.length,
          destinationsFailed: Math.max(0, targets.length - entries.length),
          destinationsTotal: targets.length,
          sizeMB: Math.round(
            entries.reduce((acc, e) => acc + (e.sizeBytes ?? 0), 0) / (1024 * 1024),
          ),
          ...(entries[0]?.id === undefined ? {} : { backupId: entries[0].id }),
        },
      })
      return entries
    } finally {
      // Every termination path — success, failure, cancel — removes
      // the staged archive. `createArchive` already deleted its own
      // partial when the BUILD phase aborted; this `force: true` rm is
      // a no-op then.
      try {
        await fsp.rm(cachePath, { force: true })
      } catch {
        /* best-effort */
      }
    }
  }

  /**
   * THIS node's database owner (D693), reached through `database-snapshot`
   * pinned to the local node: the paths it answers must be on this host,
   * because this process archives them. No local node id means no pin, and an
   * unpinned singleton call could be answered by another host — refuse.
   */
  private databaseOwner(): DatabaseOwner {
    const pin = (): ReturnType<typeof nodePin> => {
      const localNodeId = this.ctx.kernel.localNodeId
      if (localNodeId === undefined || localNodeId.length === 0) {
        throw new Error('no local node id — the database owner cannot be pinned to this host')
      }
      return nodePin(toNodeId(localNodeId))
    }
    return {
      listDatabases: async () => {
        const answer = await this.ctx.api.databaseSnapshot.listDatabases.query({}, pin())
        return answer.databases
      },
      writeSnapshot: async (databaseId) =>
        this.ctx.api.databaseSnapshot.writeSnapshot.mutate({ databaseId }, pin()),
    }
  }

  /**
   * Push the staged archive to a single destination via chunked
   * upload, then update the per-location manifest. Applies the
   * destination's retention policy as part of the same lock-protected
   * manifest mutation so the deletes never race with a concurrent
   * append.
   *
   * Throws on upload / manifest failure — caller logs and continues to
   * the next destination so a single bad sink doesn't fail the run.
   */
  private async uploadAndIndex(input: {
    locationId: string
    archiveId: string
    archiveFilename: string
    cachePath: string
    sizeBytes: number
    archiveManifest: ArchiveManifest
    retentionCount: number
    /** What the run asked to carry — the cadence its retention is counted in. */
    databases: readonly DataStoreDatabase[]
    /**
     * Shared across destinations — the same archive lives at multiple
     * sinks; stamping a per-destination `Date.now()` would let the
     * labels drift by the per-destination upload duration (often
     * minutes on slow remote sinks).
     */
    createdAt: number
    label: string
    /** The archive is encrypted to this backup key. */
    encryption?: ManifestArchiveEncryption
    /**
     * Cancel signal for the run driving this upload. Checked per
     * chunk; on abort the upload is aborted server-side (the storage
     * provider discards the partial) and `BackupCancelledError`
     * propagates so the caller stops the fan-out instead of logging a
     * destination failure.
     */
    signal?: AbortSignal
    /** Cumulative bytes pushed to this destination so far. */
    onUploadedBytes?: (bytes: number) => void
  }): Promise<BackupEntryWire> {
    const { uploadId } = await this.ctx.api.storage.beginUpload.mutate({
      location: input.locationId,
      relativePath: input.archiveFilename,
      sizeBytes: input.sizeBytes,
    })
    try {
      let offset = 0
      const stream = fs.createReadStream(input.cachePath, {
        highWaterMark: UPLOAD_CHUNK_BYTES,
      })
      for await (const rawChunk of stream) {
        if (input.signal?.aborted) {
          stream.destroy()
          throw new BackupCancelledError(
            `backup upload to ${input.locationId} cancelled mid-stream`,
          )
        }
        // `createReadStream` (no `encoding` option) yields `Buffer`,
        // which is a `Uint8Array` subclass. We copy into a tight
        // `Uint8Array<ArrayBuffer>` because `Buffer.buffer` may be
        // backed by `SharedArrayBuffer` in some Node configurations
        // and the cap input schema requires a non-shared backing
        // buffer.
        const chunk = toBufferChunk(rawChunk)
        const data = new Uint8Array(chunk.byteLength)
        data.set(chunk)
        await this.ctx.api.storage.writeChunk.mutate({
          uploadId,
          offset,
          data,
        })
        offset += data.byteLength
        input.onUploadedBytes?.(offset)
      }
      await this.ctx.api.storage.finalizeUpload.mutate({ uploadId })
    } catch (err) {
      // Best-effort abort — surface the original error to the caller.
      try {
        await this.ctx.api.storage.abortUpload.mutate({ uploadId })
      } catch {
        /* ignore */
      }
      throw err
    }

    const entry: ManifestArchiveEntry = buildArchiveEntry({
      id: input.archiveId,
      filename: input.archiveFilename,
      createdAt: input.createdAt,
      sizeBytes: input.sizeBytes,
      label: input.label,
      manifest: input.archiveManifest,
      ...(input.encryption !== undefined ? { encryption: input.encryption } : {}),
      databases: input.databases,
    })

    await this.manifestLock.run(input.locationId, async () => {
      const manifest = await readLocationManifest(this.storageApi(), input.locationId)
      const appended = [...manifest.archives, entry]
      const { keep, drop } = applyRetention(appended, input.retentionCount, retentionClassOf(entry))
      // Best-effort delete of overflow files before rewriting the
      // manifest. We tolerate per-file failures (logged) so a missing
      // archive on a remote sink doesn't block the manifest update —
      // the manifest is the source of truth for "what's kept".
      for (const stale of drop) {
        try {
          await this.ctx.api.storage.delete.mutate({
            location: input.locationId,
            relativePath: stale.filename,
          })
        } catch (err) {
          this.ctx.logger.warn('backup retention: storage delete failed (continuing)', {
            meta: {
              destinationId: input.locationId,
              backupId: stale.id,
              filename: stale.filename,
              error: err instanceof Error ? err.message : String(err),
            },
          })
        }
      }
      const next: LocationBackupManifest = { version: 1, archives: keep }
      await writeLocationManifest(this.storageApi(), input.locationId, next)
    })

    return {
      id: input.archiveId,
      destinationId: input.locationId,
      createdAt: input.createdAt,
      sizeBytes: input.sizeBytes,
      label: input.label,
      locations: [...input.archiveManifest.locations],
      ...(input.encryption !== undefined ? { encryption: input.encryption } : {}),
    }
  }

  /**
   * List archives at a single destination — newest-first. Reads only
   * the per-location `manifests.json` (no per-archive tarball read);
   * the orchestrator already snapshots each archive's locations into
   * the manifest at upload time.
   */
  private async listArchives(input: {
    destinationId: string
  }): Promise<readonly BackupArchiveEntryWire[]> {
    let manifest: LocationBackupManifest
    try {
      manifest = await readLocationManifest(this.storageApi(), input.destinationId)
    } catch (err) {
      this.ctx.logger.warn('backup listArchives: manifest read failed', {
        meta: {
          destinationId: input.destinationId,
          error: err instanceof Error ? err.message : String(err),
        },
      })
      return []
    }
    const sorted = [...manifest.archives].toSorted((a, b) => b.createdAt - a.createdAt)
    return sorted.map(
      (a): BackupArchiveEntryWire => ({
        id: a.id,
        filename: a.filename,
        createdAt: a.createdAt,
        sizeBytes: a.sizeBytes,
        ...(a.label !== undefined ? { label: a.label } : {}),
        locations: [...a.manifest.locations],
        ...(a.encryption !== undefined ? { encryption: a.encryption } : {}),
        ...(a.databases !== undefined ? { databases: [...a.databases] } : {}),
      }),
    )
  }

  /**
   * Upsert the per-destination policy row. Used by the admin-UI
   * destinations table — toggle enabled / change retention / set
   * label. No-ops with a logged warning if the
   * settings backend lacks structured-table support (no persistence
   * available).
   *
   * There is deliberately NO cadence here. A destination does not run on
   * its own timer — a schedule fans out to it — and the `cron` this method
   * used to accept had scheduled nothing since 2026-07-28 while still being
   * rendered as "daily at 03:00" (D384, and D62's "a switch that writes a
   * store nobody reads").
   */
  private async upsertDestinationPolicy(input: {
    locationId: string
    enabled: boolean
    retentionCount: number
    label?: string
  }): Promise<void> {
    if (!this.policies) {
      this.ctx.logger.warn(
        'backup upsertDestinationPolicy: no ctx.records — change will not persist',
        {
          meta: { locationId: input.locationId },
        },
      )
      return
    }
    // Preserve the attempt history across edits — an operator changing the
    // label must not erase why last night's write failed.
    const existing = await this.policies.get(input.locationId).catch(() => null)
    await this.policies.upsert({
      locationId: input.locationId,
      enabled: input.enabled,
      retentionCount: input.retentionCount,
      ...(input.label !== undefined ? { label: input.label } : {}),
      ...(existing?.lastAttemptAt !== undefined ? { lastAttemptAt: existing.lastAttemptAt } : {}),
      ...(existing?.lastError !== undefined ? { lastError: existing.lastError } : {}),
    })
  }

  /**
   * Validate a cron expression and peek the next N firing times. The
   * admin UI's CronEditor calls this on every keystroke (debounced)
   * to render a live "next-run" preview — invalid expressions surface
   * the parse error inline instead of waiting for save.
   */
  private async previewSchedule(input: {
    cron: string
    count?: number
  }): Promise<{ ok: boolean; error?: string; nextRuns: readonly number[] }> {
    const trimmed = input.cron.trim()
    if (trimmed.length === 0) {
      return { ok: false, error: 'Cron expression is empty', nextRuns: [] }
    }
    try {
      const count = input.count ?? 5
      const nextRuns = previewNextRuns(trimmed, count)
      return { ok: true, nextRuns }
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : 'Invalid cron expression',
        nextRuns: [],
      }
    }
  }

  private async getEntries(input: { destinationId: string; backupId: string }): Promise<unknown> {
    try {
      const manifest = await readLocationManifest(this.storageApi(), input.destinationId)
      const found = manifest.archives.find((a) => a.id === input.backupId)
      return found?.manifest ?? null
    } catch (err) {
      this.ctx.logger.warn('backup getEntries: manifest read failed', {
        meta: {
          destinationId: input.destinationId,
          backupId: input.backupId,
          error: err instanceof Error ? err.message : String(err),
        },
      })
      return null
    }
  }

  private async deleteArchive(input: { destinationId: string; backupId: string }): Promise<void> {
    await this.manifestLock.run(input.destinationId, async () => {
      const manifest = await readLocationManifest(this.storageApi(), input.destinationId)
      const target = manifest.archives.find((a) => a.id === input.backupId)
      if (!target) {
        throw new Error(
          `backup delete: backup "${input.backupId}" not found at "${input.destinationId}"`,
        )
      }
      try {
        await this.ctx.api.storage.delete.mutate({
          location: input.destinationId,
          relativePath: target.filename,
        })
      } catch (err) {
        this.ctx.logger.warn('backup delete: storage delete failed (continuing manifest cleanup)', {
          meta: {
            destinationId: input.destinationId,
            filename: target.filename,
            error: err instanceof Error ? err.message : String(err),
          },
        })
      }
      const next: LocationBackupManifest = {
        version: 1,
        archives: manifest.archives.filter((a) => a.id !== input.backupId),
      }
      await writeLocationManifest(this.storageApi(), input.destinationId, next)
    })
  }

  /**
   * Schedule a restore for the next boot. Pulls the archive bytes
   * down from the destination's storage location via the chunked-
   * download protocol into the private staging dir, then writes the
   * usual restore marker against the staged path so the boot-time
   * apply hook (in server-backend launcher) extracts before any
   * addon starts.
   *
   * `locations` (optional) is propagated into the marker as a
   * whitelist — only those top-level locations get extracted.
   */
  private async scheduleRestore(input: {
    destinationId: string
    backupId: string
    locations?: string[]
    backupSecretKey?: string
  }): Promise<void> {
    if (!this.systemBackup) throw new Error('orchestrator not initialized')
    const manifest = await readLocationManifest(this.storageApi(), input.destinationId)
    const entry = manifest.archives.find((a) => a.id === input.backupId)
    if (!entry) {
      throw new Error(
        `backup restore: backup "${input.backupId}" not found at location "${input.destinationId}"`,
      )
    }
    // A missing or wrong key is refused BEFORE gigabytes are downloaded.
    precheckRestoreKey(entry.encryption?.keyId, input.backupSecretKey)

    const downloaded = await this.stagingPath(`restore-${input.backupId}.download`)
    const cachePath = await this.stagingPath(`restore-${input.backupId}.tar.gz`)
    await downloadArchiveToCache({
      api: this.ctx.api.storage,
      locationId: input.destinationId,
      filename: entry.filename,
      cachePath: downloaded,
      chunkBytes: UPLOAD_CHUNK_BYTES,
      logger: this.ctx.logger,
    })
    // The header is the authority (a manifest can be lost or stale): an
    // encrypted archive is decrypted here, into private staging, because the
    // boot-time restore runs before anything could ask for a key.
    const prepared = await prepareRestoreArchive({
      downloaded,
      target: cachePath,
      ...(input.backupSecretKey !== undefined ? { secretKey: input.backupSecretKey } : {}),
    })
    if (prepared.encrypted) {
      this.ctx.logger.info('backup restore: encrypted archive decrypted into staging', {
        meta: { backupId: input.backupId, keyId: prepared.keyId },
      })
    }

    this.systemBackup.scheduleRestoreMarker({
      archivePath: cachePath,
      source: input.backupId,
      ...(input.locations ? { locations: input.locations } : {}),
    })
    this.ctx.eventBus.emit({
      id: randomUUID(),
      timestamp: new Date(),
      source: { type: 'addon', id: 'backup-orchestrator' },
      category: EventCategory.BackupRestored,
      data: { backupId: input.backupId, destinationId: input.destinationId },
    })
  }

  // ─── Encryption ─────────────────────────────────────────────────────

  private requireEncryptionKeys(): BackupEncryptionKeyStore {
    if (this.encryptionKeys === null) {
      throw new Error('backup encryption: no settings-store — the setting cannot be read or saved')
    }
    return this.encryptionKeys
  }

  /**
   * The key a run encrypts to; `null` = encryption off. THROWS when the
   * setting cannot be read — a run must fail rather than ship a plain archive
   * an operator asked to be encrypted.
   */
  private async activeEncryptionKey(): Promise<{ keyId: string; publicKey: string } | null> {
    const store = this.encryptionKeys
    if (store === null) {
      // No settings-store on this node: encryption could never have been set
      // up here (setup needs the store), so there is no setting to honour.
      // A store that is present but fails to answer is the case that fails closed.
      if (!this.warnedNoEncryptionStore) {
        this.warnedNoEncryptionStore = true
        this.ctx.logger.warn(
          'backup encryption unavailable on this node (no settings-store) — archives are plain',
        )
      }
      return null
    }
    try {
      const active = await store.active()
      return active === null ? null : { keyId: active.keyId, publicKey: active.publicKey }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      throw new Error(
        `backup encryption setting unreadable — no archive built, so none leaves unencrypted: ${message}`,
        { cause: err },
      )
    }
  }

  private async getEncryption(): Promise<BackupEncryptionStatusWire> {
    const keys = await this.requireEncryptionKeys().list()
    const active = keys.find((k) => k.retiredAt === null) ?? null
    return {
      enabled: active !== null,
      active:
        active === null
          ? null
          : { keyId: active.keyId, publicKey: active.publicKey, createdAt: active.createdAt },
      keys: keys.map((k) => ({ keyId: k.keyId, createdAt: k.createdAt, retiredAt: k.retiredAt })),
    }
  }

  private async setupEncryption(): Promise<{
    keyId: string
    secretKey: string
    publicKey: string
    createdAt: number
    replacedKeyId: string | null
  }> {
    const store = this.requireEncryptionKeys()
    const previous = await store.active()
    const pair = generateBackupKeyPair()
    const record = await store.activate({ publicKey: pair.publicKey })
    this.ctx.logger.warn('backup encryption key generated — new archives are encrypted to it', {
      meta: { keyId: record.keyId, replacedKeyId: previous?.keyId ?? null },
    })
    return {
      keyId: record.keyId,
      secretKey: pair.secretKey,
      publicKey: record.publicKey,
      createdAt: record.createdAt,
      replacedKeyId: previous?.keyId ?? null,
    }
  }

  private async disableEncryption(): Promise<{ disabledKeyId: string | null }> {
    const store = this.requireEncryptionKeys()
    const previous = await store.active()
    await store.disable()
    if (previous !== null) {
      this.ctx.logger.warn('backup encryption turned OFF — new archives are plain', {
        meta: { disabledKeyId: previous.keyId },
      })
    }
    return { disabledKeyId: previous?.keyId ?? null }
  }

  private async checkBackupKey(input: { backupSecretKey: string }): Promise<{
    valid: boolean
    keyId: string | null
    known: boolean
    active: boolean
    error?: string
  }> {
    let keyId: string
    try {
      keyId = parseBackupSecretKey(input.backupSecretKey).keyId
    } catch (err) {
      if (!(err instanceof BackupKeyFormatError)) throw err
      return { valid: false, keyId: null, known: false, active: false, error: err.message }
    }
    const keys = await this.requireEncryptionKeys().list()
    const match = keys.find((k) => k.keyId === keyId)
    return {
      valid: true,
      keyId,
      known: match !== undefined,
      active: match !== undefined && match.retiredAt === null,
    }
  }

  // ─── Destination resolution ─────────────────────────────────────────

  /**
   * Resolve a target destination set — see {@link selectBackupTargets} for the
   * rule. Caller-provided list wins over the per-destination policy flag;
   * NEITHER wins over `StorageLocation.enabled`, which is the operator's
   * switch on the storage screen and the only one that means "this disk takes
   * no writes" (D62).
   *
   * Reads locations + policies directly rather than going through
   * `listDestinations()`: that method also reads every destination's
   * `manifests.json` to hydrate `lastSuccess`, which target resolution has no
   * use for and which cost one round-trip per destination on every trigger.
   */
  private async resolveTargets(requested?: string[]): Promise<readonly { id: string }[]> {
    const locations = await this.fetchBackupLocations()
    const policies = await this.loadPoliciesIndexed(locations.map((l) => l.id))
    const selection = selectBackupTargets({
      candidates: locations.map((l) => ({
        id: l.id,
        // THE policy (D385): only an `active` location receives archives. It
        // folds the legacy `enabled` / `config.readOnly` pair for a row that
        // predates the stamp, so a hub mid-upgrade behaves identically.
        locationEnabled: mayWriteToLocation(l),
        policyEnabled: (policies.get(l.id) ?? this.fallbackPolicy(l.id)).enabled,
      })),
      ...(requested && requested.length > 0 ? { requested: [...requested] } : {}),
    })
    // A dropped destination is never silent: an operator who disabled a disk
    // and then wonders why last night's archive is thinner needs this line.
    if (selection.skippedDisabled.length > 0) {
      this.ctx.logger.warn(
        'backup: destination skipped — its storage location is disabled by the operator',
        {
          meta: {
            destinationIds: [...selection.skippedDisabled],
            requestedExplicitly: requested !== undefined && requested.length > 0,
          },
        },
      )
    }
    // Refusing beats writing to a retired disk: an archive that lands where the
    // operator said not to write is false safety, and `backups` is the one
    // class the system does not need a write target for. Only raised when the
    // emptiness was CAUSED by the flag — "every policy is off" stays the legal,
    // quiet configuration it has always been.
    if (selection.targets.length === 0 && selection.skippedDisabled.length > 0) {
      throw new Error(
        `every selected backup destination is disabled (${selection.skippedDisabled.join(', ')}) — ` +
          'enable its storage location on the Storage screen, or choose another destination. ' +
          'Refusing to write an archive to a location the operator turned off.',
      )
    }
    return selection.targets.map((t) => ({ id: t.id }))
  }

  /**
   * Persist the outcome of one attempted write to one destination.
   *
   * Best-effort by design: an unavailable settings backend must not turn a
   * successful backup into a failed one. But it is LOGGED when it cannot be
   * written — a status field that silently stops being updated is the whole
   * defect this method exists to close.
   */
  private async recordDestinationOutcome(
    destinationId: string,
    attemptAt: number,
    error?: string,
  ): Promise<void> {
    if (!this.policies) return
    try {
      await this.policies.recordAttempt(
        destinationId,
        { attemptAt, ...(error !== undefined ? { error } : {}) },
        { retentionCount: DEFAULT_RETENTION_COUNT },
      )
    } catch (err) {
      this.ctx.logger.warn('backup: could not persist the destination outcome', {
        meta: {
          destinationId,
          outcome: error === undefined ? 'succeeded' : 'failed',
          error: err instanceof Error ? err.message : String(err),
        },
      })
    }
  }

  // ─── Schedule timer ─────────────────────────────────────────────────

  private startScheduleTimer(): void {
    if (this.scheduleTimer) return
    this.scheduleTimer = setInterval(() => {
      void this.onScheduleTick()
    }, SCHEDULE_TICK_MS)
  }

  private stopScheduleTimer(): void {
    if (!this.scheduleTimer) return
    clearInterval(this.scheduleTimer)
    this.scheduleTimer = null
  }

  /**
   * Schedule-driven backup scheduling. Walks every enabled backup
   * SCHEDULE (the N:M entry), computes the next due time after
   * `lastAttemptAt` (or the orchestrator's first-tick baseline if never
   * run), and fires a SINGLE archive fanned out to ALL of the
   * schedule's `locationIds` when due — with the schedule's per-entry
   * retention applied to each. Each schedule keeps its own cadence.
   *
   * Errors per schedule are isolated; one misconfigured cron doesn't
   * block the others. The schedule's `lastAttemptAt` is updated BEFORE the
   * trigger to dedupe (the tick runs every SCHEDULE_TICK_MS — without
   * the up-front update a long-running upload could overlap with the
   * next tick's same-due check).
   */
  private async onScheduleTick(): Promise<void> {
    if (!this.schedules) {
      // Nothing fires, ever, until the process is restarted with a working
      // settings backend. Silence here reads exactly like "no backup was
      // due", so say it — once per tick is noisy, so it is said once.
      if (!this.warnedSchedulerDisarmed) {
        this.warnedSchedulerDisarmed = true
        this.ctx.logger.error(
          'backup scheduler is DISARMED — no settings backend, so no schedule can fire',
        )
      }
      return
    }
    const schedules = await this.schedules.list()
    const now = Date.now()
    for (const s of schedules) {
      if (!s.enabled || !s.cron || s.cron.trim().length === 0) continue
      if (s.locationIds.length === 0) continue
      let due: number | null
      try {
        due = computeNextDue(s.cron, s.lastAttemptAt ?? this.scheduleBaselineAt)
      } catch (err) {
        this.ctx.logger.warn('Invalid cron — skipping schedule', {
          meta: {
            scheduleId: s.id,
            cron: s.cron,
            error: err instanceof Error ? err.message : String(err),
          },
        })
        continue
      }
      if (due === null || due > now) continue
      // Stamp the ATTEMPT before firing — dedupes if the upload outlives
      // the tick. This is not a success stamp and must never be rendered as
      // one: the schedule that fired at 03:00:26 on 2026-09-07 stamped this
      // and then delivered nothing (D384).
      const stamped: BackupSchedule = { ...s, lastAttemptAt: now }
      try {
        await this.schedules.upsert(stamped)
      } catch (err) {
        this.ctx.logger.warn('Failed to persist scheduled-run timestamp', {
          meta: {
            scheduleId: s.id,
            scheduleLabel: s.label,
            destinationIds: [...s.locationIds],
            error: err instanceof Error ? err.message : String(err),
          },
        })
      }
      this.ctx.logger.info('Scheduled backup firing', {
        meta: {
          scheduleId: s.id,
          label: s.label,
          destinationIds: [...s.locationIds],
          cron: s.cron,
          dueAt: due,
        },
      })
      await this.runScheduledBackup(stamped, now)
    }
  }

  /**
   * A schedule that asks for events/history while the owner has neither open
   * would only repeat the nightly archive (D852: the weekly schedule has
   * nothing to carry until those files exist). Said on the record, no archive
   * built, no outcome stamped. An owner that cannot answer never skips: the
   * run goes ahead and fails — or succeeds — in the open.
   */
  private async nothingToCarry(schedule: BackupSchedule): Promise<boolean> {
    const requested = databasesOfSchedule(schedule)
    if (!requested.some((id) => id !== 'settings')) return false
    let owned: readonly DataStoreDatabase[]
    try {
      owned = (await this.databaseOwner().listDatabases()).map((d) => d.databaseId)
    } catch (err) {
      this.ctx.logger.warn('Scheduled backup: the database owner did not answer — running anyway', {
        meta: {
          scheduleId: schedule.id,
          label: schedule.label,
          error: err instanceof Error ? err.message : String(err),
        },
      })
      return false
    }
    if (!hasNothingBeyondSettings(requested, owned)) return false
    this.ctx.logger.info('Scheduled backup skipped — no database it carries exists yet', {
      meta: { scheduleId: schedule.id, label: schedule.label, requested: [...requested], owned },
    })
    return true
  }

  /**
   * Seed the weekly "events & history" schedule (D852) — once, and never over
   * anything the operator has: see `planWeeklySeed`.
   */
  private async seedWeekly(): Promise<void> {
    const markers = this.backupRecords?.seedMarkers
    if (!this.schedules || markers === undefined) return
    try {
      const seed = await seedWeeklySchedule(this.schedules, new BackupSeedMarkerStore(markers))
      if (seed === null) return
      this.ctx.logger.info('backup: seeded the weekly events & history schedule', {
        meta: { scheduleId: seed.id, destinationIds: [...seed.locationIds] },
      })
    } catch (err) {
      this.ctx.logger.warn('backup: the weekly schedule could not be seeded', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
    }
  }

  /**
   * Fire one schedule and RECORD what happened to it, naming every
   * destination. Three outcomes, three different persisted states —
   * because "fired" and "backed up" were the same field until D384:
   *
   *   - archive landed somewhere → `lastSuccessAt`, `lastError` cleared;
   *   - the run threw, or landed nowhere → `lastError`, no success stamp;
   *   - the stamp could not be written → logged, named, not swallowed.
   */
  private async runScheduledBackup(schedule: BackupSchedule, firedAt: number): Promise<void> {
    const destinationIds = [...schedule.locationIds]
    if (await this.nothingToCarry(schedule)) return
    let failure: string | undefined
    try {
      const result = await this.triggerBackup({
        destinations: destinationIds,
        ...(schedule.dataSources && schedule.dataSources.length > 0
          ? { locations: [...schedule.dataSources] }
          : {}),
        label: schedule.label,
        retentionCount: schedule.retentionCount,
        ...(schedule.databases ? { databases: [...schedule.databases] } : {}),
      })
      if (result.entries.length === 0 && !result.cancelled) {
        failure = `no destination accepted the archive (${destinationIds.join(', ')})`
      }
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err)
    }
    if (failure === undefined) {
      this.ctx.logger.info('Scheduled backup completed', {
        meta: { scheduleId: schedule.id, label: schedule.label, destinationIds },
      })
    } else {
      this.ctx.logger.error('Scheduled backup failed', {
        meta: {
          scheduleId: schedule.id,
          label: schedule.label,
          destinationIds,
          error: failure,
        },
      })
    }
    if (!this.schedules) return
    const { lastError: _cleared, ...carried } = schedule
    try {
      await this.schedules.upsert({
        ...carried,
        ...(failure === undefined ? { lastSuccessAt: firedAt } : { lastError: failure }),
      })
    } catch (err) {
      this.ctx.logger.warn('Failed to persist the scheduled-run outcome', {
        meta: {
          scheduleId: schedule.id,
          label: schedule.label,
          destinationIds,
          error: err instanceof Error ? err.message : String(err),
        },
      })
    }
  }

  // ─── Schedules (N:M entries) ─────────────────────────────────────────

  /**
   * The database files the owner has open right now, for the selection UI. An
   * owner that cannot answer is `answered: false` — never an empty list, which
   * the UI would read as "none exists yet".
   */
  private async listAvailableDatabases(): Promise<{
    answered: boolean
    databases: readonly DataStoreDatabase[]
  }> {
    try {
      const owned = await this.databaseOwner().listDatabases()
      return { answered: true, databases: owned.map((d) => d.databaseId) }
    } catch (err) {
      this.ctx.logger.warn('Backup database list: the database owner did not answer', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
      return { answered: false, databases: [] }
    }
  }

  private async listSchedules(): Promise<readonly BackupScheduleWire[]> {
    if (!this.schedules) return []
    const rows = await this.schedules.list()
    return rows.map((s) => {
      let nextRunAt: number | undefined
      if (s.enabled && s.cron.trim().length > 0) {
        try {
          const next = computeNextDue(s.cron, Date.now())
          if (next !== null) nextRunAt = next
        } catch {
          /* invalid cron — leave nextRunAt undefined */
        }
      }
      return {
        id: s.id,
        label: s.label,
        cron: s.cron,
        enabled: s.enabled,
        locationIds: [...s.locationIds],
        retentionCount: s.retentionCount,
        ...(s.dataSources !== undefined ? { dataSources: [...s.dataSources] } : {}),
        ...(s.databases !== undefined ? { databases: [...s.databases] } : {}),
        ...(s.lastAttemptAt !== undefined ? { lastAttemptAt: s.lastAttemptAt } : {}),
        ...(s.lastSuccessAt !== undefined ? { lastSuccessAt: s.lastSuccessAt } : {}),
        ...(s.lastError !== undefined ? { lastError: s.lastError } : {}),
        ...(nextRunAt !== undefined ? { nextRunAt } : {}),
      }
    })
  }

  private async upsertSchedule(input: {
    id?: string
    label: string
    cron: string
    enabled: boolean
    locationIds: readonly string[]
    retentionCount: number
    dataSources?: readonly string[]
    databases?: readonly DataStoreDatabase[]
  }): Promise<BackupScheduleWire> {
    if (!this.schedules) {
      throw new Error('backup upsertSchedule: no ctx.records — schedule cannot be persisted')
    }
    const cron = input.cron.trim()
    if (cron.length > 0 && !isValidCron(cron)) {
      throw new Error(`Invalid cron expression: "${cron}"`)
    }
    const id = input.id && input.id.length > 0 ? input.id : randomUUID()
    const existing = await this.schedules.get(id).catch(() => null)
    const next: BackupSchedule = {
      id,
      label: input.label,
      cron,
      enabled: input.enabled,
      locationIds: [...input.locationIds],
      retentionCount: input.retentionCount,
      ...(input.dataSources && input.dataSources.length > 0
        ? { dataSources: [...input.dataSources] }
        : {}),
      ...(input.databases && input.databases.length > 0 ? { databases: [...input.databases] } : {}),
      ...(existing?.lastAttemptAt !== undefined ? { lastAttemptAt: existing.lastAttemptAt } : {}),
      ...(existing?.lastSuccessAt !== undefined ? { lastSuccessAt: existing.lastSuccessAt } : {}),
      ...(existing?.lastError !== undefined ? { lastError: existing.lastError } : {}),
    }
    await this.schedules.upsert(next)
    let nextRunAt: number | undefined
    if (next.enabled && cron.length > 0) {
      try {
        const due = computeNextDue(cron, Date.now())
        if (due !== null) nextRunAt = due
      } catch {
        /* ignore */
      }
    }
    return {
      id: next.id,
      label: next.label,
      cron: next.cron,
      enabled: next.enabled,
      locationIds: [...next.locationIds],
      retentionCount: next.retentionCount,
      ...(next.dataSources !== undefined ? { dataSources: [...next.dataSources] } : {}),
      ...(next.databases !== undefined ? { databases: [...next.databases] } : {}),
      ...(next.lastAttemptAt !== undefined ? { lastAttemptAt: next.lastAttemptAt } : {}),
      ...(next.lastSuccessAt !== undefined ? { lastSuccessAt: next.lastSuccessAt } : {}),
      ...(next.lastError !== undefined ? { lastError: next.lastError } : {}),
      ...(nextRunAt !== undefined ? { nextRunAt } : {}),
    }
  }

  private async deleteSchedule(input: { id: string }): Promise<void> {
    if (!this.schedules) return
    await this.schedules.delete(input.id)
  }

  /**
   * Narrow `ctx.api.storage` to the subset the manifest helpers need.
   * Lets the helpers be unit-tested with a Map-backed fake without
   * pulling in the full `AddonApi` shape.
   */
  private storageApi(): ManifestStorageApi {
    return this.ctx.api.storage
  }

  // The orchestrator has no operator-tunable global settings: every
  // knob (enabled, retention, cron) lives per-destination on each
  // policy row. The settings panel has been retired.
}

// ── helpers ──────────────────────────────────────────────────────────────

/**
 * Map a `storage-provider` providerId to an operator-friendly `kind`
 * the admin UI uses for destination cards. Falls back to the raw
 * provider id so unknown providers still surface (operator sees
 * `webdav-storage` instead of a blank slot).
 */
function kindFromProviderId(providerId: string): string {
  switch (providerId) {
    case 'filesystem-storage':
      return 'local'
    case 's3-storage':
      return 's3'
    case 'sftp-storage':
      return 'sftp'
    case 'webdav-storage':
      return 'webdav'
    default:
      return providerId
  }
}

/**
 * Extract the slug part of a `<type>:<slug>` storage-location id.
 * Defensive: if the id doesn't contain a colon (shouldn't happen given
 * the regex on `StorageLocationSchema.id`) we return the whole string.
 */
function extractSlug(id: string): string {
  const colon = id.indexOf(':')
  return colon < 0 ? id : id.slice(colon + 1)
}

/**
 * Narrow a `for await` chunk from `fs.createReadStream` to a
 * `Buffer`. The stream yields `string | Buffer` per its public type
 * even though the no-encoding overload always emits `Buffer`. The
 * runtime check + clear error keeps eslint's no-unsafe-* rules happy
 * without resorting to `as Buffer`.
 */
function toBufferChunk(value: unknown): Uint8Array {
  if (Buffer.isBuffer(value)) return value
  if (value instanceof Uint8Array) return value
  throw new Error('backup upload: unexpected non-binary chunk from read stream')
}

/**
 * Return the most-recent archive in a location manifest, or undefined
 * when the location has no archives yet. Pure transform — no I/O.
 */
function latestArchiveOf(manifest: LocationBackupManifest): ManifestArchiveEntry | undefined {
  if (manifest.archives.length === 0) return undefined
  let newest = manifest.archives[0]!
  for (const a of manifest.archives) {
    if (a.createdAt > newest.createdAt) newest = a
  }
  return newest
}

export default BackupOrchestratorAddon
