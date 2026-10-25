/**
 * `storage-orchestrator` builtin — singleton owner of the consumer-
 * facing `storage` cap.
 *
 * Responsibilities:
 *   - Hold the `locationId → StorageLocation` map (in-memory; Task 6
 *     adds persistence).
 *   - Resolve `StorageLocationRef` → concrete `StorageLocation`.
 *   - Dispatch every cap method to the right `storage-provider`
 *     (collection cap, registered by `filesystem-storage` and future
 *     SFTP / S3 / WebDAV addons).
 *   - Track ownership of upload / download sessions so chunked I/O
 *     (which carries no `location` after the first hop) can route
 *     subsequent chunks to the same provider.
 *   - First-boot seed defaults from addon-declared location types (Task 5).
 *     Re-runs on every `capability:provider-registered` event so providers
 *     that register after the orchestrator boots also get seeded — the
 *     `hasAnyLocationOfType` guard makes the operation idempotent.
 *
 * Task 6 will plug a persistence backend in front of the in-memory map.
 * Task 7 will migrate consumers off the legacy storage shim.
 */

import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type {
  IDataStoreProvider,
  IEventBus,
  ISettingsStoreProvider,
  IStorageCapProvider,
  IStorageEvictableProvider,
  IStorageMigrationProvider,
  IStorageOccupancyProvider,
  IStorageProviderImpl,
  ProviderRegistration,
  RecordKindHandle,
  StorageLocation,
  StorageLocationsChangedReason,
} from '@camstack/types'
import {
  BaseAddon,
  EventCategory,
  evictionPolicyOfLocation,
  gbToBytes,
  isSecretMarker,
  mayReadLocation,
  mayWriteToLocation,
  normalizeNodeId,
  resolveSecretMarkers,
  StorageCleanupJobSchema,
  StorageMigrationJobSchema,
  secretTreeFromPaths,
  settingsStoreCapability,
  storageCapability,
  storageMigrationCapability,
  transformSecretWrite,
} from '@camstack/types'
import { z } from 'zod'
import { buildStorageLocationRegistry } from '../../kernel/storage-location-registry.js'
import { LocationRepointer, type RepointTarget } from './location-repointer.js'
import { STORAGE_LOCATIONS } from './location-store.js'
import { canProbeOccupancyLocally, resolveRefusalFor } from './access-guards.js'
import { createDataStoreDispatch } from './data-store-dispatch.js'
import type { DrainProgress } from './drain-ratchet.js'
import { SqliteDrainStateStore } from './drain-state-store.js'
import { nodeOwnsItsDataStore, resolveHubSettingsForward } from './hub-settings-forward.js'
import { probeLocalDirectoryOccupancy } from './location-occupancy.js'
import { LocationOccupancySlice } from './location-occupancy-slice.js'
import { resolveMinFreePercent } from './location-protection.js'
import {
  freePercentOf,
  readLocalVolumeCapacity,
  volumeTotalBytesOf,
} from './location-volume-capacity.js'
import {
  redactLocation,
  restoreRedactedSecrets,
  secretKeysForConfig,
  secretKeysOfProviderInfo,
} from './location-secrets.js'
import { type ILocationStore, SqliteLocationStore } from './location-store.js'
import { storageOrchestratorRecordKinds } from './record-kinds.js'
import type {
  StorageDrainStateBody,
  StorageLocationBody,
  StorageSeedMarkerBody,
} from './record-kinds.js'
import { collectProviderInfos } from './provider-discovery.js'
import { StorageCleanupCoordinator } from './storage-cleanup-coordinator.js'
import { StorageMigrationCoordinator } from './storage-migration-coordinator.js'
import {
  type LocationOccupancy,
  StorageOrchestratorService,
} from './storage-orchestrator.service.js'
import type { DrainPlanEntry } from './storage-pressure-manager.js'
import { StoragePressureManager } from './storage-pressure-manager.js'
import { StorageLocationBandMonitor } from './storage-location-band-monitor.js'
import { LocationHistoryRecorder, type LocationReading } from './location-history-recorder.js'

const STORAGE_PROVIDER_CAP_NAME = 'storage-provider'
const DATA_STORE_PROVIDER_CAP_NAME = 'data-store-provider'
const STORAGE_EVICTABLE_CAP_NAME = 'storage-evictable'
const STORAGE_OCCUPANCY_CAP_NAME = 'storage-occupancy'
/**
 * Single-node default: existing node-local locations live on the hub.
 * The boot backfill (SP1) stamps this on any node-local location seeded
 * before `nodeId` existed.
 */
const HUB_NODE_ID = 'hub'
/** How often the pressure manager re-evaluates free space per location. */
const PRESSURE_SWEEP_INTERVAL_MS = 60_000

/**
 * Raw event category emitted by `CapabilityRegistry.registerProvider` —
 * not in the typed `EventCategory` enum because it lives in the kernel
 * infra layer (every cap-bound event is a custom-shape payload).
 */
const CAP_PROVIDER_REGISTERED_CATEGORY = 'capability:provider-registered'

interface StorageOrchestratorConfig extends Record<string, unknown> {}

export class StorageOrchestratorAddon extends BaseAddon<StorageOrchestratorConfig> {
  private locationsKind: RecordKindHandle<StorageLocationBody> | null = null
  private seedMarkersKind: RecordKindHandle<StorageSeedMarkerBody> | null = null
  private drainStateKind: RecordKindHandle<StorageDrainStateBody> | null = null
  private service: StorageOrchestratorService | null = null
  private pressureManager: StoragePressureManager | null = null
  private readonly locationBandMonitor = new StorageLocationBandMonitor()
  /**
   * How much of each location CamStack itself holds (D388).
   *
   * Built on first use rather than in a field initializer: `this.ctx` does not
   * exist until `initialize()` runs, and a field initializer touching it throws
   * in the constructor.
   */
  private occupancySlice: LocationOccupancySlice | null = null
  private get occupancy(): LocationOccupancySlice {
    if (this.occupancySlice) return this.occupancySlice
    this.occupancySlice = new LocationOccupancySlice({
      logger: this.ctx.logger,
      getProviders: () =>
        this.ctx.kernel.capabilityRegistry?.getCollection<IStorageOccupancyProvider>(
          STORAGE_OCCUPANCY_CAP_NAME,
        ) ?? [],
      locationIds: () => this.service?.listLocations().map((loc) => loc.id) ?? [],
      now: () => Date.now(),
    })
    return this.occupancySlice
  }
  private pressureTimer: ReturnType<typeof setInterval> | null = null
  /** Occupancy over time (device-history). Created with the timer that feeds it. */
  private locationHistory: LocationHistoryRecorder | null = null
  private locationHistoryInFlight = false
  private pressureSweepInFlight = false
  private migration: StorageMigrationCoordinator | null = null
  /** Guards every single-location repoint and arbitrates movers per physical root. */
  private repointer: LocationRepointer | null = null

  /**
   * Cached `providerId → nodeLocal` snapshot (SP1). Backs the orchestrator's
   * synchronous `NodeLocalResolver` — `getProviderInfo()` is async, so we
   * keep a sync cache and refresh it whenever the provider collection
   * changes (alongside the seed pass). Absent providerId → resolver returns
   * `undefined` (treated as node-agnostic).
   */
  private readonly nodeLocalByProvider: Map<string, boolean> = new Map()

  /**
   * Cached `providerId → secret config keys`, derived from each provider's own
   * `configSchema` in the SAME refresh as `nodeLocalByProvider` — one
   * `getProviderInfo()` round trip answers both questions.
   *
   * An absent providerId yields an EMPTY set, which redacts nothing. That is
   * the one direction this cache can be wrong in, so it is worth saying why it
   * is acceptable: the entry is populated at the same moment the provider
   * becomes resolvable at all, so a location whose provider is unknown here
   * cannot be dispatched to either — there is no window in which a credential
   * is readable through a provider the orchestrator can otherwise use.
   */
  private readonly secretKeysByProvider: Map<string, ReadonlySet<string>> = new Map()

  /**
   * Disposers run on `onShutdown` — currently the eventBus subscription
   * for `capability:provider-registered` events used by the lazy seed
   * fallback. Stored separately from the `BaseAddon` disposer chain so
   * it can be inspected in tests.
   */
  private readonly seedSubscriptionDisposers: Array<() => void> = []

  constructor() {
    super({})
  }

  protected async onInitialize(): Promise<ProviderRegistration[]> {
    const localNodeId = normalizeNodeId(this.ctx.kernel.localNodeId)
    const records = localNodeId === HUB_NODE_ID ? this.ctx.records : undefined
    if (records !== undefined) {
      await records.declare(storageOrchestratorRecordKinds)
      this.locationsKind = SqliteLocationStore.recordStoresOf(records)
      this.seedMarkersKind = SqliteLocationStore.seedMarkersOf(records)
      this.drainStateKind = SqliteDrainStateStore.recordStoresOf(records)
    }

    const getProviders = (): readonly IStorageProviderImpl[] => {
      const reg = this.ctx.kernel.capabilityRegistry
      if (!reg) return []
      return reg.getCollection<IStorageProviderImpl>(STORAGE_PROVIDER_CAP_NAME)
    }

    // The row engines behind the data door, read per call so a respawned
    // engine is picked up (see `createDataStoreDispatch`).
    const getEngines = (): readonly IDataStoreProvider[] => {
      const reg = this.ctx.kernel.capabilityRegistry
      if (!reg) return []
      return reg.getCollection<IDataStoreProvider>(DATA_STORE_PROVIDER_CAP_NAME)
    }

    // Wire the persistence backend (Task 6). Skipped if the
    // settings-store cap hasn't registered a provider yet (e.g. early
    // boot tests, or a deployment without the sqlite-settings builtin
    // mounted) — the service falls back to in-memory only.
    const locationStore = this.resolveLocationStore()

    const service = new StorageOrchestratorService(
      this.ctx.logger,
      getProviders,
      locationStore,
      this.ctx.kernel.localNodeId ?? 'hub',
      (nodeId) => {
        const proxy = this.ctx.kernel.resolveNodeCapability?.('storage-provider', nodeId)
        if (!proxy) return null
        // Cross-node type boundary (same pattern as the generated cap
        // routers' remote proxies): the transport proxy forwards every
        // method call verbatim to that node's storage-provider impl.
        return proxy as IStorageProviderImpl
      },
    )
    this.service = service
    // The hub keeps its locations in the records kind: it seeds only after that
    // store ANSWERED a read. A node without one seeds in memory at every boot.
    service.setStoreRequiredForSeed(this.locationsKind !== null)

    // Wire the node-local resolver (SP1) off the cached snapshot so the
    // upsert guard + boot backfill can classify providers synchronously.
    service.setNodeLocalResolver((providerId) => this.nodeLocalByProvider.get(providerId))

    // Wire the delete-time occupancy check. See `locationOccupancy` for what it
    // can and cannot see — and note that everything it cannot see answers
    // `unknown`, which REFUSES, rather than looking empty.
    service.setOccupancyProbe((location) => this.locationOccupancy(location))

    // Hydrate persisted locations BEFORE seeding so re-seeds skip
    // already-persisted defaults (the seed step's
    // `hasAnyLocationOfType` gate looks at the in-memory map).
    await service.initialize()

    const provider: IStorageCapProvider = {
      // ── Location management ─────────────────────────────────────────
      listLocations: async ({ type }) => {
        const rows = type !== undefined ? service.listLocations({ type }) : service.listLocations()
        // Computed capacity (read-time, never persisted): statfs of the backing
        // volume for locations THIS node can reach. Remote-node locations get
        // no capacity (absent) rather than the hub's numbers — honesty over
        // completeness. The single capacity truth every UI surface reads.
        //
        // Credentials are redacted here, not at the caller: this method has no
        // `auth` override, so it is `protected` and every authenticated
        // session reads it. See `location-secrets.ts`.
        // Serve-and-revalidate (D224/D388): this returns immediately from the
        // last completed refresh and kicks a background one when it is stale.
        // A `listLocations` never awaits a provider fan-out.
        this.occupancy.serveAndRevalidate()
        return Promise.all(
          rows.map(async (loc) => ({
            ...this.redacted(loc),
            // ABSENT MEANS UNKNOWN (D315). No `?? 0` on this path, ever — a
            // location nobody reports for must not look like a location that
            // holds nothing.
            ...(this.occupancy.ownedFor(loc.id) !== undefined
              ? { owned: this.occupancy.ownedFor(loc.id) }
              : {}),
            // Capacity is reported for every location this node can still
            // READ. The gate used to be `isLocationEnabled`, written when
            // enabled meant "we write here" and skipping the statfs of a
            // frozen disk was a cheap saving. Under the four states (D385)
            // that reading silently hid the free space of a DRAINING disk —
            // the one state whose entire purpose is watching it empty, and
            // the operator saw "capacity unknown" on the disk they were
            // draining. A `disabled` location is one the system does not
            // touch at all, and that one still reports nothing.
            capacity: mayReadLocation(loc) ? await this.localCapacityOf(loc) : null,
          })),
        )
      },
      listLocationDeclarations: async () => service.listDeclarations(),
      // A pure read of what the last pressure sweep computed (D386).
      listDrainProgress: async () => this.drainProgress(),
      upsertLocation: async (input) => {
        // The sentinel travelling back in means "keep the stored secret" —
        // the wizard round-trips a redacted config whenever the operator edits
        // anything else about a location.
        const stored = service.getLocationById(input.id)
        // The key set is derived from the STORED config, which is what was
        // redacted on the way out — deriving it from the incoming one would
        // ask which keys the caller thinks are secret.
        const config = restoreRedactedSecrets(
          input.config,
          stored?.config,
          this.secretKeysFor(input.providerId, stored?.config ?? {}),
        )
        // The provider's declared secrets are kept in the keychain, never in
        // the location row (D787); a marker is what the row holds.
        const keychained = await this.keepSecretsInKeychain(
          input.id,
          input.providerId,
          config,
          stored?.config ?? {},
        )
        const next = keychained === input.config ? input : { ...input, config: keychained }
        // A SINGLETON that changes root carries its bytes with it. It has no
        // second instance to drain into — the cardinality guard inside
        // `upsertLocation` refuses to create one — so this edit IS the
        // migration, and the only alternative to moving the data is stranding
        // it. On 2026-09-08 the `artifacts` root moved and 320 enrolled gallery
        // blobs stayed behind, invisible until every face in Review answered
        // 404 and a reconcile was one boot from calling them deleted.
        //
        // `multi` kinds are untouched: recordings and friends move through the
        // migration coordinator, explicitly armed, and that stays the only way.
        const saved = await this.upsertCarryingData(stored, next, () =>
          service.upsertLocation(next),
        )
        this.announceLocationsChanged(saved.id, saved.type, 'upsert')
        return this.redacted(saved)
      },
      deleteLocation: async ({ id, force }) => {
        const doomed = service.getLocationById(id)
        await service.deleteLocation(id, { force: force === true })
        this.announceLocationsChanged(id, doomed?.type ?? '', 'delete')
      },
      testLocation: async ({ id }) => {
        const loc = service.getLocationById(id)
        if (!loc) return { ok: false, error: `Location "${id}" not found` }
        try {
          const p = await service.getProviderFor(loc)
          const live = await this.withResolvedSecrets(loc)
          return p.testLocation({ config: live.config })
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) }
        }
      },

      // ── Provider discovery ──────────────────────────────────────────
      // Walk every registered `storage-provider`, collect each one's
      // `getProviderInfo()` blob. Used by the admin-UI "Add location"
      // wizard. Errors from individual providers are isolated — a
      // single misbehaving driver shouldn't deny the whole list.
      listProviders: async () => {
        return collectProviderInfos(getProviders(), (_provider, err, index) => {
          this.ctx.logger.warn('storage-orchestrator: getProviderInfo failed', {
            meta: { providerIndex: index, error: err instanceof Error ? err.message : String(err) },
          })
        })
      },

      // Probe a candidate config against a specific provider WITHOUT
      // persisting. Lets the wizard preflight credentials (SFTP / S3
      // / WebDAV) before the operator commits. Validation errors are
      // returned in `error`; transport errors are caught + reported.
      testConfig: async ({ providerId, locationId, config }) => {
        // Third door the sentinel travels back through, after `upsertLocation`
        // and the modal's own form state. The stored config is only consulted
        // when the named location belongs to the SAME provider — resolving a
        // sentinel against someone else's row would turn a preflight into a
        // way to borrow another location's credential.
        const stored = locationId === undefined ? undefined : service.getLocationById(locationId)
        const base = stored?.providerId === providerId ? stored.config : undefined
        const resolved = restoreRedactedSecrets(
          config,
          base,
          this.secretKeysFor(providerId, base ?? {}),
        )
        const providers = getProviders()
        for (const p of providers) {
          try {
            const info = await p.getProviderInfo()
            if (info.providerId !== providerId) continue
            return p.testLocation({ config: resolved })
          } catch (err) {
            return { ok: false, error: err instanceof Error ? err.message : String(err) }
          }
        }
        return { ok: false, error: `No storage-provider registered for providerId "${providerId}"` }
      },

      // ── Small-file primitives — every method resolves the ref then
      // dispatches the inline-location form to the provider. ──────────
      resolve: async ({ location, relativePath }) => {
        const loc = await this.withResolvedSecrets(service.resolveRef(location))
        // `resolve` is the ONLY method on this cap whose result leaves the
        // storage abstraction. Every caller of it — the recorder's roots, the
        // post-analysis media roots — takes the string and opens it with
        // `node:fs`. A remote provider answers with a path on the REMOTE host,
        // which on this node is either missing or, far worse, an unrelated
        // local directory of the same name.
        //
        // The upsert guard already refuses the configuration that would get
        // here, so this is the second lock: it holds for a row that predates
        // the guard, for one written by a future code path, and for a provider
        // that changes its own `nodeLocal` answer after a location was made.
        // Loud, not silent — the point is that this combination stops being
        // possible rather than being documented as unwise.
        this.refuseRemoteResolve(loc)
        const p = await service.getProviderFor(loc)
        return p.resolve({ location: loc, relativePath })
      },
      write: async ({ location, relativePath, data }) => {
        const loc = await this.withResolvedSecrets(service.resolveRef(location))
        const p = await service.getProviderFor(loc)
        return p.write({ location: loc, relativePath, data })
      },
      read: async ({ location, relativePath }) => {
        const loc = await this.withResolvedSecrets(service.resolveRef(location))
        const p = await service.getProviderFor(loc)
        return p.read({ location: loc, relativePath })
      },
      exists: async ({ location, relativePath }) => {
        const loc = await this.withResolvedSecrets(service.resolveRef(location))
        const p = await service.getProviderFor(loc)
        return p.exists({ location: loc, relativePath })
      },
      list: async ({ location, prefix }) => {
        const loc = await this.withResolvedSecrets(service.resolveRef(location))
        const p = await service.getProviderFor(loc)
        return prefix !== undefined ? p.list({ location: loc, prefix }) : p.list({ location: loc })
      },
      delete: async ({ location, relativePath }) => {
        const loc = await this.withResolvedSecrets(service.resolveRef(location))
        const p = await service.getProviderFor(loc)
        return p.delete({ location: loc, relativePath })
      },
      getAvailableSpace: async ({ location }) => {
        const loc = await this.withResolvedSecrets(service.resolveRef(location))
        const p = await service.getProviderFor(loc)
        return p.getAvailableSpace({ location: loc })
      },

      // ── Chunked upload — the opening call records the routing target
      // (providerId AND node), subsequent calls resolve through it.
      // Cleanup happens in finalize/abort. ────────────────────────────
      beginUpload: async ({ location, relativePath, sizeBytes }) => {
        const loc = await this.withResolvedSecrets(service.resolveRef(location))
        const p = await service.getProviderFor(loc)
        const result =
          sizeBytes !== undefined
            ? await p.beginUpload({ location: loc, relativePath, sizeBytes })
            : await p.beginUpload({ location: loc, relativePath })
        service.rememberSession('upload', result.uploadId, loc)
        return result
      },
      writeChunk: async (input) => {
        const p = await service.getProviderForSession('upload', input.uploadId)
        return p.writeChunk(input)
      },
      finalizeUpload: async (input) => {
        const p = await service.getProviderForSession('upload', input.uploadId)
        try {
          return await p.finalizeUpload(input)
        } finally {
          service.forgetSession('upload', input.uploadId)
        }
      },
      abortUpload: async (input) => {
        const p = await service.getProviderForSession('upload', input.uploadId)
        try {
          return await p.abortUpload(input)
        } finally {
          service.forgetSession('upload', input.uploadId)
        }
      },

      // ── Chunked download (symmetric to upload) ──────────────────────
      beginDownload: async ({ location, relativePath }) => {
        const loc = await this.withResolvedSecrets(service.resolveRef(location))
        const p = await service.getProviderFor(loc)
        const result = await p.beginDownload({ location: loc, relativePath })
        service.rememberSession('download', result.downloadId, loc)
        return result
      },
      readChunk: async (input) => {
        const p = await service.getProviderForSession('download', input.downloadId)
        return p.readChunk(input)
      },
      endDownload: async (input) => {
        const p = await service.getProviderForSession('download', input.downloadId)
        try {
          return await p.endDownload(input)
        } finally {
          service.forgetSession('download', input.downloadId)
        }
      },
    }

    const migration = new StorageMigrationCoordinator({
      locations: service,
      state: this.state('storage-migration', StorageMigrationJobSchema.nullable(), null),
      history: this.state('storage-migration-history', z.array(StorageMigrationJobSchema), []),
      participants: {
        pipeline: {
          pause: async (leaseId) => {
            await this.ctx.api.pipelineOrchestrator.pauseForStorageMigration.mutate({ leaseId })
          },
          resume: async (leaseId) => {
            await this.ctx.api.pipelineOrchestrator.resumeForStorageMigration.mutate({ leaseId })
          },
        },
        recorder: {
          pause: async (leaseId) => {
            await this.ctx.api.recordingArchive.pauseForStorageMigration.mutate({ leaseId })
          },
          resume: async (leaseId) => {
            await this.ctx.api.recordingArchive.resumeForStorageMigration.mutate({ leaseId })
          },
          startMove: (input) =>
            this.ctx.api.recordingArchive.startStorageMigrationMove.mutate(input),
          // The SAME engine, no lease: `draining` runs after every writer has
          // already been resumed, so there is none to present.
          startDrain: (input) => this.ctx.api.recordingArchive.relocateFootage.mutate(input),
          getMove: (jobId) =>
            this.ctx.api.recordingArchive.getStorageMigrationMoveStatus.query({ jobId }),
          // Every mover the recorder knows about, not just this migration's:
          // a drain armed straight against `relocateFootage` is exactly the
          // thing `storageMigration.movers` exists to make visible.
          listMovers: () => this.ctx.api.recordingArchive.listRelocateJobs.query({}),
          residue: (input) => this.ctx.api.recordingArchive.getRelocateResidue.query(input),
          cancelMove: async (jobId) =>
            (await this.ctx.api.recordingArchive.cancelStorageMigrationMove.mutate({ jobId }))
              .cancelled,
          refresh: async (leaseId) => {
            await this.ctx.api.recordingArchive.refreshStorageLocationsForMigration.mutate({
              leaseId,
            })
          },
        },
        analytics: {
          pause: async (leaseId) => {
            await this.ctx.api.pipelineAnalytics.pauseForStorageMigration.mutate({ leaseId })
          },
          resume: async (leaseId) => {
            await this.ctx.api.pipelineAnalytics.resumeForStorageMigration.mutate({ leaseId })
          },
          startMove: (input) =>
            this.ctx.api.pipelineAnalytics.startStorageMigrationMove.mutate(input),
          startDrain: (input) => this.ctx.api.pipelineAnalytics.relocateMedia.mutate(input),
          countUnstamped: () => this.ctx.api.pipelineAnalytics.countUnstampedEventMedia.query({}),
          getMove: (jobId) =>
            this.ctx.api.pipelineAnalytics.getStorageMigrationMoveStatus.query({ jobId }),
          listMovers: () => this.ctx.api.pipelineAnalytics.listRelocateMediaJobs.query({}),
          residue: (input) => this.ctx.api.pipelineAnalytics.countRelocatableMedia.query(input),
          cancelMove: async (jobId) =>
            (await this.ctx.api.pipelineAnalytics.cancelStorageMigrationMove.mutate({ jobId }))
              .cancelled,
          refresh: async (leaseId) => {
            await this.ctx.api.pipelineAnalytics.refreshStorageLocationsForMigration.mutate({
              leaseId,
            })
          },
        },
      },
      now: () => Date.now(),
      newId: () => randomUUID(),
      // The same realpath key the pressure manager dedups shared disks with.
      // See the coordinator's `refuseGalleryOntoRecordingsVolume` for what it
      // catches (symlinks, bind mounts, a literally shared directory) and what
      // it does not (two directories on one filesystem; any location pinned to
      // another node, whose realpath would have to be taken there).
      deviceKeyOf: (locationId) => this.locationDeviceKey(locationId),
    })
    this.migration = migration
    this.repointer = new LocationRepointer({
      logger: this.ctx.logger,
      resolveKey: async (basePath) => {
        try {
          return await fs.realpath(basePath)
        } catch {
          return path.resolve(basePath)
        }
      },
      locationBasePath: (id) => this.locationBasePath(id),
      locationIdsOfType: (type) => service.listLocations({ type }).map((loc) => loc.id),
      listMovers: () => migration.movers(),
      ioFor: async (stored, next) => {
        const target: StorageLocation = { ...stored, config: next.config }
        const [source, destination] = await Promise.all([
          service.getProviderFor(stored),
          service.getProviderFor(target),
        ])
        return {
          list: (prefix) =>
            source.list(prefix === undefined ? { location: stored } : { location: stored, prefix }),
          read: (relativePath) => source.read({ location: stored, relativePath }),
          write: (relativePath, data) =>
            destination.write({ location: target, relativePath, data }),
          readBack: (relativePath) => destination.read({ location: target, relativePath }),
          deleteSource: (relativePath) => source.delete({ location: stored, relativePath }),
        }
      },
    })
    const cleanup = new StorageCleanupCoordinator({
      locations: service,
      state: this.state('storage-cleanup', StorageCleanupJobSchema.nullable(), null),
      participants: {
        startOrphan: async (restart) => {
          const raw: unknown = await this.ctx.api.addons.custom.mutate({
            addonId: 'pipeline-analytics',
            action: 'retention.orphanAudit',
            input: { mode: 'reclaim', restart, maxRowsPerScope: 20_000 },
          })
          return parseStarted(raw)
        },
        orphanStatus: async () => {
          const raw: unknown = await this.ctx.api.addons.custom.mutate({
            addonId: 'pipeline-analytics',
            action: 'retention.orphanAuditStatus',
            input: {},
          })
          return parseOrphanStatus(raw)
        },
        startDebugMedia: () =>
          this.ctx.api.pipelineAnalytics.reclaimDebugMedia.mutate({ mode: 'reclaim' }),
        debugMediaStatus: () => this.ctx.api.pipelineAnalytics.getMediaReclaimStatus.query({}),
        walkLedger: (input) =>
          this.ctx.api.recordingArchive.reconcileLedgerAgainstDisk.mutate(input),
      },
      now: () => Date.now(),
      newId: () => randomUUID(),
    })
    const migrationProvider: IStorageMigrationProvider = {
      plan: (input) => migration.plan(input),
      start: async (input) => ({ jobId: await migration.start(input) }),
      status: ({ jobId }) => migration.status(jobId),
      cancel: async ({ jobId }) => ({ cancelled: await migration.cancel(jobId) }),
      movers: () => migration.movers(),
      moverClearance: async ({ locationIds }) => {
        const verdict = await this.requireRepointer().clearance(locationIds)
        return verdict.clear
          ? { clear: true }
          : { clear: false, repointLocationId: verdict.repointLocationId }
      },
      residue: () => migration.residue(),
      drain: async (input) => ({ jobId: await migration.drain(input) }),
      cleanupStart: async (input) => ({ jobId: await cleanup.start(input) }),
      cleanupStatus: ({ jobId }) => cleanup.status(jobId),
      cleanupCancel: async ({ jobId }) => ({ cancelled: await cleanup.cancel(jobId) }),
      history: () => migration.history(),
    }

    // Eager seed pass — seeds defaults from the addon-declared storage
    // locations the kernel aggregated at boot. Idempotent via the
    // `hasAnyLocationOfType` gate.
    await this.seedFromDeclarations()

    // Lazy pass — `CapabilityRegistry.registerProvider` emits
    // `capability:provider-registered` on the kernel event bus; we
    // re-run the seed step every time the storage-provider collection
    // grows (a newly registered filesystem provider may be needed before
    // the declared defaults can be materialized). `hasAnyLocationOfType`
    // keeps the operation idempotent.
    const eventBus = this.ctx.eventBus as IEventBus | undefined
    if (eventBus) {
      const unsub = eventBus.subscribe({ category: CAP_PROVIDER_REGISTERED_CATEGORY }, (event) => {
        // Any provider registering is a chance the settings-store cap just
        // came up — wire persistence the moment it does (it registers
        // after the orchestrator inits, so the ctor store is usually null).
        void this.ensureStoreWired()
        const data = event.data as { capability?: string } | undefined
        if (data?.capability !== STORAGE_PROVIDER_CAP_NAME) return
        // Fire-and-forget: providers register synchronously but the
        // seed step is async. Errors are scoped to the logger inside
        // `seedFromDeclarations`.
        void this.seedFromDeclarations()
      })
      this.seedSubscriptionDisposers.push(unsub)
    }

    // Catch the race where settings-store registered between the ctor-time
    // resolve and this subscription being installed.
    void this.ensureStoreWired()

    // Disk-pressure trigger (core owns it; addons own the deletion via the
    // `storage-evictable` cap). A no-op until some addon registers an evictable
    // provider AND a guarded location breaches its `minFreePercent`.
    this.pressureManager = new StoragePressureManager({
      logger: this.ctx.logger,
      getFreePercent: (id) => this.locationFreePercent(id),
      getVolumeTotalBytes: (id) => this.locationVolumeTotalBytes(id),
      getEvictableProviders: () =>
        this.ctx.kernel.capabilityRegistry?.getCollection<IStorageEvictableProvider>(
          STORAGE_EVICTABLE_CAP_NAME,
        ) ?? [],
      getLocationThresholds: () => this.resolveLocationThresholds(),
      getLocationMaxUsedBytes: () => this.resolveLocationMaxUsedBytes(),
      getLocationDeviceKey: (id) => this.locationDeviceKey(id),
      // The drain pass (D386). `readonly` takes a location out of pressure
      // eviction; `drain` instead shrinks it, paced to what the ACTIVE
      // locations of its class gained. The plan is rebuilt every sweep, so
      // switching a location back to `readonly` or `active` stops it on the
      // next tick and the ratchet state is dropped.
      getDrainPlan: () => Promise.resolve(this.resolveDrainPlan()),
      drainState: {
        load: async () => (await this.resolveDrainStore()?.load()) ?? [],
        save: async (state) => {
          await this.resolveDrainStore()?.save(state)
        },
        clear: async (locationId) => {
          await this.resolveDrainStore()?.clear(locationId)
        },
      },
    })
    this.locationHistory = new LocationHistoryRecorder({
      deviceHistory: {
        declareSeries: (input) => this.ctx.api.deviceHistory.declareSeries.mutate(input),
        record: (input) => this.ctx.api.deviceHistory.record.mutate({ points: [...input.points] }),
      },
      logger: this.ctx.logger,
    })
    this.pressureTimer = setInterval(() => {
      void this.runPressureSweep()
      void this.recordLocationHistory()
    }, PRESSURE_SWEEP_INTERVAL_MS)

    this.ctx.logger.info('Storage orchestrator initialized')
    return [
      { capability: storageCapability, provider },
      { capability: storageMigrationCapability, provider: migrationProvider },
      // The data door (D44). One addon owns both storage surfaces —
      // bytes through `storage`, rows through `settings-store` — and each
      // dispatches to engines registered behind an internal collection
      // cap. Free here: the engine is an in-process builtin on this node,
      // so the delegation is a function call, not a hop.
      {
        capability: settingsStoreCapability,
        provider: createDataStoreDispatch(getEngines, () => this.hubSettingsForward()),
      },
    ]
  }

  /**
   * The remote behind the data door on a node that owns no engine.
   *
   * `null` on a hub — the hub IS the store, and a hub that forwarded would
   * route its own door back into itself through `$hub-cap-fwd`. `null` too
   * when this process has no cluster broker (a forked worker, or a test
   * harness); the door then behaves exactly as it always did and refuses.
   *
   * Built once and memoised. It is only consulted when `getEngines()` is
   * empty, so on a hub — and on an agent rolled back to a local engine via
   * `CAMSTACK_AGENT_LOCAL_DATA_STORE` — the resolve never runs a second time.
   */
  private hubForward: ISettingsStoreProvider | null = null
  private hubSettingsForward(): ISettingsStoreProvider | null {
    if (this.hubForward) return this.hubForward
    this.hubForward = resolveHubSettingsForward({
      env: process.env,
      broker: this.ctx.kernel.cluster?.broker,
      logger: this.ctx.logger,
    })
    return this.hubForward
  }

  protected async onShutdown(): Promise<void> {
    for (const dispose of this.seedSubscriptionDisposers) {
      try {
        dispose()
      } catch {
        /* noop */
      }
    }
    this.seedSubscriptionDisposers.length = 0
    if (this.pressureTimer) {
      clearInterval(this.pressureTimer)
      this.pressureTimer = null
    }
    this.pressureManager = null
    this.service?.clearSessions()
    this.service = null
    this.migration = null
  }

  override async onHubReachable(): Promise<void> {
    await this.migration?.recover()
  }

  // ── Persistence wiring (Task 6) ─────────────────────────────────────

  /**
   * Resolve the live engine from the capability registry and wrap it in a
   * `SqliteLocationStore`. Returns `null` when no engine has registered
   * yet — the service falls back to in-memory only. On a HUB that is a
   * boot-order window: `data-store-provider` precedes `storage` in
   * `INFRA_CAPABILITIES`, so it is the rare path.
   *
   * On an AGENT it is permanent and intended, and the line says so. An agent
   * boots no engine (`resolveAgentInfraCapabilities`), and this store must NOT
   * be pointed at the hub-forwarding data door: `storage_locations` is keyed by
   * a bare location id (`recordings:default`, `eventMedia:default`, …) which
   * every node in the cluster shares, so an agent writing through the door
   * would land on the HUB's rows. The locations an agent needs are re-seeded
   * from its addon declarations at every boot; the operator's real, node-pinned
   * locations live in the hub's own table (`__nodeId` in the config blob) and
   * are dispatched to the agent's `storage-provider` from there.
   *
   * Reads the ENGINE, not the `settings-store` singleton: since D44 this
   * addon *is* that singleton, so asking the registry for it would hand
   * the orchestrator its own dispatcher and route its location table back
   * through itself.
   */
  private resolveLocationStore(quiet = false): ILocationStore | null {
    const reg = this.ctx.kernel.capabilityRegistry
    if (!reg) return null
    const engine = reg.getCollection<ISettingsStoreProvider>(DATA_STORE_PROVIDER_CAP_NAME)[0]
    if (!engine) {
      if (!quiet) {
        // An agent's answer is not "yet" — it is "never", by design. Saying
        // "until one registers" there describes a wait that will not end, and
        // a log line that describes the wrong design reads as verification.
        if (nodeOwnsItsDataStore(process.env)) {
          this.ctx.logger.warn(
            'storage-orchestrator: no data-store-provider engine yet — running in-memory until one registers',
          )
        } else {
          this.ctx.logger.info(
            'storage-orchestrator: this node boots no data-store engine — storage locations are ' +
              'seeded from addon declarations at every boot, and node-pinned locations live on the hub',
          )
        }
      }
      return null
    }
    return new SqliteLocationStore(engine, this.locationsKind, this.seedMarkersKind)
  }

  /**
   * Late-wire the persistence store once a `data-store-provider` engine
   * registers. Production boot order means the store is usually absent at
   * `onInitialize`; this runs on every `capability:provider-registered`
   * event until it succeeds. Single-flighted + idempotent (the service
   * ignores a second attach). Without this, operator edits (e.g. a
   * location's `minFreePercent`) live only in memory and are wiped on every
   * restart — the service never hydrates from / persists to SQLite.
   */
  private storeWireInFlight: Promise<void> | null = null

  /** True while the locations kind cannot be declared: its empty answer is not authoritative. */
  private async locationsKindNotReady(): Promise<boolean> {
    const records = this.ctx.records
    if (records === undefined || this.locationsKind === null) return false
    try {
      await records.declare(storageOrchestratorRecordKinds)
      return false
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.ctx.logger.warn(
        'storage-orchestrator: persistence NOT wired — the storage-locations kind is not ' +
          'authoritative yet (its declaration failed); seeding is deferred',
        { meta: { error: message } },
      )
      return true
    }
  }
  private async ensureStoreWired(): Promise<void> {
    const service = this.service
    if (!service || service.hasStore()) return
    if (this.storeWireInFlight) return this.storeWireInFlight
    const store = this.resolveLocationStore(true)
    if (!store) return // still not ready — a later provider-registered event retries
    // A kind that could not be declared answers "empty", and an empty answer
    // would read as "no locations" (D49). Stay store-less (no seed, nothing
    // written) until the declaration succeeds.
    if (await this.locationsKindNotReady()) return
    this.ctx.logger.info(
      'storage-orchestrator: data-store engine now available — wiring persistence',
    )
    this.storeWireInFlight = service
      .attachStore(store)
      // Re-run the declaration pass now the store is live: prunes stale
      // undeclared rows hydrated from an older build (and persists the delete)
      // and seeds any still-missing declared default into the store.
      .then(() => this.seedFromDeclarations())
      .catch((err) => {
        this.ctx.logger.error('storage-orchestrator: attachStore failed', {
          meta: { error: err instanceof Error ? err.message : String(err) },
        })
      })
      .finally(() => {
        this.storeWireInFlight = null
      })
    return this.storeWireInFlight
  }

  // ── Disk-pressure trigger (core-owned; deletion via storage-evictable) ──

  private storageProviders(): readonly IStorageProviderImpl[] {
    const reg = this.ctx.kernel.capabilityRegistry
    if (!reg) return []
    return reg.getCollection<IStorageProviderImpl>(STORAGE_PROVIDER_CAP_NAME)
  }

  /** Single-flighted pressure sweep — never overlaps a slow eviction round. */
  private async runPressureSweep(): Promise<void> {
    if (this.pressureSweepInFlight || !this.pressureManager) return
    this.pressureSweepInFlight = true
    try {
      await this.pressureManager.sweep()
      await this.emitLocationBandEvents()
    } catch (err) {
      // `ctxIfReady`: a sweep in flight across `shutdown()` lands here with no
      // context, and a throw from this catch is an unhandled rejection — which
      // exits agent-main (where this addon also boots) with code 1.
      this.ctxIfReady?.logger.warn('storage pressure sweep failed', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
    } finally {
      this.pressureSweepInFlight = false
    }
  }

  /**
   * One occupancy reading per location this node can read, into device-history.
   * The volume figures come from the same probe `listLocations` serves, the
   * held bytes from the occupancy slice; an unknown figure is no point (D393).
   */
  private async recordLocationHistory(): Promise<void> {
    const svc = this.service
    const recorder = this.locationHistory
    if (!svc || !recorder || this.locationHistoryInFlight) return
    this.locationHistoryInFlight = true
    try {
      this.occupancy.serveAndRevalidate()
      const localNode = svc.getLocalNodeId()
      const readings: LocationReading[] = []
      for (const loc of svc.listLocations()) {
        // ONE writer per location: the node it lives on; a node-agnostic one is the hub's.
        if (!mayReadLocation(loc) || (loc.nodeId ?? HUB_NODE_ID) !== localNode) continue
        const capacity = await this.localCapacityOf(loc).catch(() => null)
        readings.push({
          locationId: loc.id,
          nodeId: localNode,
          capacity,
          ownedBytes: this.occupancy.ownedFor(loc.id)?.bytes,
        })
      }
      await recorder.record(readings, Date.now())
    } catch (err) {
      this.ctxIfReady?.logger.warn('storage: location history pass failed', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
    } finally {
      this.locationHistoryInFlight = false
    }
  }

  /**
   * Sample free space for every managed location and emit NC band edges.
   * A failed capacity read stays `null` and changes no band — never folded to 0 (D393).
   */
  private async emitLocationBandEvents(): Promise<void> {
    const svc = this.service
    const ctx = this.ctxIfReady
    if (!svc || !ctx) return
    const thresholds = await this.resolveLocationThresholds()
    const byId = new Map(svc.listLocations().map((loc) => [loc.id, loc]))
    const samples = await Promise.all(
      [...thresholds.keys()].map(async (locationId) => {
        const loc = byId.get(locationId)
        if (loc === undefined || !mayReadLocation(loc)) {
          return { locationId, freePercent: null as number | null }
        }
        const capacity = await this.volumeCapacityOf(locationId).catch(() => null)
        const freePercent = capacity === null ? null : freePercentOf(capacity)
        if (capacity === null) {
          // A failed measurement changes no band (D393) — but say so.
          ctx.logger.debug('storage: location capacity unreadable — band unchanged', {
            meta: { locationId },
          })
        }
        // Every sampled location is under the eviction guard, so its threshold
        // IS the floor the evictor holds it at (see `resolveLocationThresholds`).
        const floorPercent = thresholds.get(locationId)
        return {
          locationId,
          nodeId: loc.nodeId,
          locationName: loc.displayName,
          freePercent,
          ...(floorPercent !== undefined ? { floorPercent } : {}),
          ...(capacity !== null
            ? {
                freeBytes: capacity.availableBytes,
                ...(floorPercent !== undefined
                  ? { floorBytes: Math.round((capacity.totalBytes * floorPercent) / 100) }
                  : {}),
              }
            : {}),
        }
      }),
    )
    for (const edge of this.locationBandMonitor.observe(samples)) {
      const category =
        edge.band === 'low'
          ? EventCategory.StorageLocationLow
          : edge.band === 'critical'
            ? EventCategory.StorageLocationCritical
            : EventCategory.StorageLocationOk
      ctx.logger.info('storage: location band changed', {
        meta: {
          locationId: edge.locationId,
          band: edge.band,
          freePercent: edge.freePercent,
          floorPercent: edge.floorPercent ?? null,
          freeBytes: edge.freeBytes ?? null,
          floorBytes: edge.floorBytes ?? null,
          reason: edge.reason,
        },
      })
      ctx.eventBus.emit({
        id: randomUUID(),
        timestamp: new Date(),
        source: { type: 'addon', id: this.ctx.id },
        category,
        data: {
          locationId: edge.locationId,
          ...(edge.nodeId !== undefined ? { nodeId: edge.nodeId } : {}),
          ...(edge.locationName !== undefined ? { locationName: edge.locationName } : {}),
          freePercent: edge.freePercent,
          reason: edge.reason,
        },
      })
    }
  }

  /**
   * locationId → resolved `minFreePercent`. The policy is intrinsic to the
   * location's provider (`shouldSaveDiskSpace` gates the guard, `minFreePercent`
   * is the default), overridable per-location via `config.minFreePercent`.
   * Locations with the guard off (or threshold 0) are omitted. Moved here from
   * the recorder so disk-pressure is a single core concern.
   */
  private async resolveLocationThresholds(): Promise<ReadonlyMap<string, number>> {
    const out = new Map<string, number>()
    const svc = this.service
    if (!svc) return out
    const infos = await collectProviderInfos(this.storageProviders(), () => {
      /* skip failed provider */
    })
    const byProvider = new Map(infos.map((i) => [i.providerId, i]))
    for (const loc of svc.listLocations()) {
      // ONLY `disabled` is skipped (D385). A `readonly` or `drain` location
      // keeps its threshold: the guard is what the recorder's evictable
      // provider consults, and dropping the entry would make the map say
      // "no policy here" rather than "policy, and eviction refuses".
      if (!mayReadLocation(loc)) continue
      const info = byProvider.get(loc.providerId)
      if (!info || !info.shouldSaveDiskSpace) continue
      const threshold = resolveMinFreePercent(
        loc.config,
        info.minFreePercent ?? 0,
        await this.localCapacityOf(loc),
        (message: string, meta: Record<string, unknown>) =>
          this.logMinFreeRedundancyOnce(loc.id, message, meta),
      )
      if (threshold > 0) out.set(loc.id, threshold)
    }
    return out
  }

  /** Location ids that have already logged the `minFreeGb` / `minFreePercent`
   *  redundancy. The pressure sweep runs on a timer; the notice is worth
   *  exactly one line per location per process, not one per minute. */
  private readonly minFreeRedundancyLogged = new Set<string>()
  private logMinFreeRedundancyOnce(
    locationId: string,
    message: string,
    meta: Record<string, unknown>,
  ): void {
    if (this.minFreeRedundancyLogged.has(locationId)) return
    this.minFreeRedundancyLogged.add(locationId)
    this.ctx.logger.warn(message, { meta: { locationId, ...meta } })
  }

  /**
   * The draining locations and the ACTIVE peers of their class whose growth
   * paces them (D386). Rebuilt every sweep from the live mode of every
   * location, so this is also what STOPS a drain: a location the operator
   * switched back simply stops appearing.
   */
  private drainStore: SqliteDrainStateStore | null = null
  /** The drain ratchet's durable home, once a data-store engine exists. Same
   *  late-wiring window as the location table — on an agent it is never. */
  private resolveDrainStore(): SqliteDrainStateStore | null {
    if (this.drainStore) return this.drainStore
    const engine = this.ctx.kernel.capabilityRegistry?.getCollection<ISettingsStoreProvider>(
      DATA_STORE_PROVIDER_CAP_NAME,
    )[0]
    if (!engine) return null
    this.drainStore = new SqliteDrainStateStore(engine, this.drainStateKind)
    return this.drainStore
  }

  private drainPlanRefusalLogged = false
  private resolveDrainPlan(): readonly DrainPlanEntry[] {
    const svc = this.service
    if (!svc) return []
    // A drain the node cannot PERSIST is refused rather than started: without
    // the durable cap the ratchet would restart at the top of the disk on
    // every boot and delete on a pace nobody chose.
    if (this.resolveDrainStore() === null) {
      const draining = svc.listLocations().filter((l) => evictionPolicyOfLocation(l) === 'drain')
      if (draining.length > 0 && !this.drainPlanRefusalLogged) {
        this.drainPlanRefusalLogged = true
        this.ctx.logger.warn(
          'storage-orchestrator: REFUSING to drain — this node has no data-store engine to persist ' +
            'the drain cap, and a cap recomputed at every boot would delete on a pace nobody chose',
          { meta: { locationIds: draining.map((l) => l.id) } },
        )
      }
      return []
    }
    const locations = svc.listLocations()
    return locations
      .filter((loc) => evictionPolicyOfLocation(loc) === 'drain')
      .map((loc) => ({
        locationId: loc.id,
        activePeerLocationIds: locations
          .filter(
            (peer) => peer.type === loc.type && peer.id !== loc.id && mayWriteToLocation(peer),
          )
          .map((peer) => peer.id),
      }))
  }

  /** Drain progress for every draining location, as of the last sweep. */
  private drainProgress(): readonly DrainProgress[] {
    return this.pressureManager?.drainProgressSnapshot() ?? []
  }

  /**
   * What the provider's own schema declared secret, or `undefined` when this
   * node has never heard from that provider. The distinction is the whole
   * point — see `secretKeysForConfig`, which fails CLOSED on `undefined`.
   */
  private declaredSecretKeys(providerId: string): ReadonlySet<string> | undefined {
    return this.secretKeysByProvider.get(providerId)
  }

  /** Which keys of a given stored config must never leave this process. */
  /**
   * Move a singleton location's bytes when its root changes.
   *
   * Runs BEFORE the row is saved: a copy that fails throws out of the mutation,
   * so the location keeps pointing at the intact original and the operator is
   * told why rather than discovering it in a blank panel weeks later.
   * `moveLocationTree` deletes nothing until every file has been read back from
   * the destination.
   *
   * A no-op for everything else — a rename, a mode change, a `multi` kind, or a
   * location being created for the first time.
   */
  private async upsertCarryingData<T>(
    stored: StorageLocation | undefined,
    next: RepointTarget,
    commit: () => T,
  ): Promise<T> {
    if (stored === undefined) return commit()
    const service = this.service
    if (service === null) return commit()
    const declaration = service.listDeclarations().find((entry) => entry.id === next.type)
    if (declaration?.cardinality !== 'single') return commit()
    const from = stored.config['basePath']
    const to = next.config['basePath']
    if (typeof from !== 'string' || typeof to !== 'string' || from === to) return commit()
    // The copy, the verified delete AND the row save run under one claim on the
    // physical root, and only the location's own class subtree is touched.
    return this.requireRepointer().run(stored, next, commit)
  }

  private requireRepointer(): LocationRepointer {
    if (this.repointer === null) throw new Error('storage-orchestrator: not initialized')
    return this.repointer
  }

  private secretKeysFor(
    providerId: string,
    config: Readonly<Record<string, unknown>>,
  ): ReadonlySet<string> {
    return secretKeysForConfig(config, this.declaredSecretKeys(providerId))
  }

  /**
   * Ring the doorbell: the SET of storage locations changed (D387).
   *
   * A consumer that resolves locations at boot had no way to learn that the
   * operator added, edited or removed one — the recorder kept writing to the
   * disk set it resolved hours ago, and an operator who added a second
   * recordings disk in the admin UI got nothing until something unrelated
   * happened to re-resolve.
   *
   * Telemetry, and deliberately so (D8/D11): it carries no row, it is allowed
   * to be dropped, and every consumer re-reads `listLocations` for itself and
   * converges on its own periodic path anyway. A bulk edit rings it once per
   * row — coalescing is the consumer's job, not this one's.
   *
   * Never throws into the mutation that produced it: the location IS saved,
   * and a bus that will not take a telemetry event must not turn that into a
   * failed upsert.
   */
  private announceLocationsChanged(
    locationId: string,
    locationType: string,
    reason: StorageLocationsChangedReason,
  ): void {
    try {
      this.ctx.eventBus.emit({
        id: randomUUID(),
        timestamp: new Date(),
        source: { type: 'addon', id: this.ctx.id },
        category: EventCategory.StorageLocationsChanged,
        data: { locationId, locationType, reason },
      })
    } catch (err: unknown) {
      this.ctx.logger.warn(
        'storage-orchestrator: could not announce the location change — consumers will converge on their own periodic path',
        {
          meta: {
            locationId,
            reason,
            error: err instanceof Error ? err.message : String(err),
          },
        },
      )
    }
  }

  /** A location with its provider's declared secrets replaced by the sentinel. */
  /**
   * The location as a PROVIDER must see it: every keychain marker in its
   * config resolved (D787). The same object when it holds none — a filesystem
   * location costs nothing. An unresolvable secret is left out and logged by
   * ref; the provider then fails its own connection, by name.
   */
  private async withResolvedSecrets(location: StorageLocation): Promise<StorageLocation> {
    const secrets = this.ctx.secrets
    if (secrets === undefined) return location
    const { value, unresolved } = await resolveSecretMarkers(location.config, secrets)
    if (unresolved.length > 0) {
      this.ctx.logger.error('storage location secret unavailable', {
        meta: {
          locationId: location.id,
          secrets: unresolved.map((u) => ({ ref: u.ref, reason: u.reason })),
        },
      })
    }
    return value === location.config ? location : { ...location, config: value }
  }

  /**
   * Strip the provider's DECLARED secrets (its form schema, by type) out of a
   * location config into the keychain, under `row/storage_locations/<id>`.
   * A provider that has not registered declares nothing: only keys that
   * already hold a marker are handled then — a new plaintext is never guessed
   * at, it stays as sent until the provider is back and the location is saved.
   */
  private async keepSecretsInKeychain(
    locationId: string,
    providerId: string,
    config: Readonly<Record<string, unknown>>,
    stored: Readonly<Record<string, unknown>>,
  ): Promise<Readonly<Record<string, unknown>>> {
    const secrets = this.ctx.secrets
    if (secrets === undefined) return config
    const declared = this.declaredSecretKeys(providerId) ?? new Set<string>()
    const markerKeys = Object.entries(stored)
      .filter(([, v]) => isSecretMarker(v))
      .map(([k]) => k)
    const tree = secretTreeFromPaths([...new Set([...declared, ...markerKeys])])
    if (tree.size === 0) return config
    const result = await transformSecretWrite({
      tree,
      secrets,
      patch: { ...config },
      stored: { ...stored },
      scope: { kind: 'row', collection: STORAGE_LOCATIONS, rowId: locationId },
    })
    // The row is REPLACED by `upsertLocation`, not merged: a key the save path
    // kept must be carried over from the stored config.
    const merged: Record<string, unknown> = { ...result.patch }
    for (const key of tree.keys()) {
      if (!(key in merged) && key in stored) merged[key] = stored[key]
    }
    void result.afterWrite().then(({ orphaned }) => {
      if (orphaned.length > 0) {
        this.ctx.logger.warn('storage location: dropped keychain refs could not be deleted', {
          meta: { locationId, refs: [...orphaned] },
        })
      }
    })
    return merged
  }

  private redacted(location: StorageLocation): StorageLocation {
    return redactLocation(location, this.secretKeysFor(location.providerId, location.config))
  }

  /**
   * Is this location backed by a provider that serves a genuine local
   * filesystem? `true` / `false` / `undefined` — see
   * `StorageOrchestratorService.refuseIncompatibleProvider` for why the
   * unknown case is kept distinct rather than folded into either answer.
   */
  private providerIsNodeLocal(location: StorageLocation): boolean | undefined {
    return this.nodeLocalByProvider.get(location.providerId)
  }

  /** See the call site in the `resolve` dispatch, and `access-guards.ts`. */
  private refuseRemoteResolve(location: StorageLocation): void {
    const refusal = resolveRefusalFor(location, this.providerIsNodeLocal(location))
    if (refusal === null) return
    this.ctx.logger.warn('storage-orchestrator: REFUSED resolve() on a remote-backed location', {
      meta: { id: location.id, type: location.type, providerId: location.providerId },
    })
    throw new Error(refusal)
  }

  /**
   * The volume figures for one location, or `null` when this node cannot take
   * a measurement that is genuinely about it.
   *
   * The decision lives in `location-volume-capacity.ts` — including why a
   * remote-provider location (the SMB share that was reporting the hub's own
   * disk) gets nothing rather than a number. Here we only supply the node id,
   * the provider's declared locality and the real filesystem, and log the
   * reason once per distinct fault: `listLocations` is on the admin UI's poll,
   * so a line per call would be a line per second.
   */
  private async localCapacityOf(
    loc: StorageLocation,
  ): Promise<{ totalBytes: number; availableBytes: number } | null> {
    // Only THIS node can statfs its own volumes. `ctx.nodeId` does not exist
    // (it never did — the comparison was `undefined`, so the check leaned
    // entirely on the `'hub'` literal); the service's resolved local node id
    // is the one authority, and it strips a forked-child suffix.
    const localNode = this.service?.getLocalNodeId() ?? HUB_NODE_ID
    const result = await readLocalVolumeCapacity(loc, this.providerIsNodeLocal(loc), localNode, {
      probe: {
        access: (target: string) => fs.access(target),
        statfs: async (target: string) => fs.statfs(target),
      },
      cwd: path.resolve('.'),
    })
    if (result.kind === 'unknown') {
      this.logCapacityUnknownOnce(loc.id, result.reason)
      return null
    }
    this.clearCapacityUnknown(loc.id, result.path)
    return { totalBytes: result.totalBytes, availableBytes: result.availableBytes }
  }

  /** locationId → the last unmeasurable reason logged for it. */
  private readonly capacityUnknownLogged: Map<string, string> = new Map()

  private logCapacityUnknownOnce(locationId: string, reason: string): void {
    if (this.capacityUnknownLogged.get(locationId) === reason) return
    this.capacityUnknownLogged.set(locationId, reason)
    this.ctx.logger.warn(
      'storage-orchestrator: capacity is UNKNOWN for a location — reporting nothing rather than another volume’s figures',
      { meta: { locationId, reason } },
    )
  }

  private clearCapacityUnknown(locationId: string, measuredPath: string): void {
    if (!this.capacityUnknownLogged.has(locationId)) return
    this.capacityUnknownLogged.delete(locationId)
    this.ctx.logger.info('storage-orchestrator: capacity is measurable again', {
      meta: { locationId, measuredPath },
    })
  }

  /** Per-location cap on EVICTABLE bytes (`config.maxUsedGb`): the operator's
   *  "recordings may use at most N GB in total" — enforced by the pressure
   *  manager alongside the free-percent guard. */
  private async resolveLocationMaxUsedBytes(): Promise<ReadonlyMap<string, number>> {
    const out = new Map<string, number>()
    const svc = this.service
    if (!svc) return out
    for (const loc of svc.listLocations()) {
      // Only `disabled` is skipped (D385) — see `resolveLocationThresholds`.
      if (!mayReadLocation(loc)) continue
      const raw = loc.config['maxUsedGb']
      if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
        // BINARY GB, through the one converter — see `gbToBytes`.
        out.set(loc.id, gbToBytes(raw))
      }
    }
    return out
  }

  private locationBasePath(locationId: string): string | null {
    const loc = this.service?.listLocations().find((l) => l.id === locationId)
    const bp = loc?.config['basePath']
    return typeof bp === 'string' && bp.length > 0 ? bp : null
  }

  /**
   * A stable key for the PHYSICAL storage device behind a location — the
   * `realpath` of its `basePath`, so symlinked / bind-mounted aliases and
   * same-root managed locations (`recordings:default` + `recordingsLow:default`,
   * both at `/recordings`) collapse to one key. Feeds the pressure manager's
   * in-sweep dedup so a shared disk is relieved at most once per tick (closing
   * the bounded over-eviction window; see `getLocationDeviceKey`). Falls back to
   * the lexically-resolved path when realpath throws (root missing at boot),
   * `null` when the location has no basePath — either way dedup degrades to
   * per-location, never merging two distinct disks.
   */
  private async locationDeviceKey(locationId: string): Promise<string | null> {
    const bp = this.locationBasePath(locationId)
    if (!bp) return null
    try {
      return await fs.realpath(bp)
    } catch {
      return path.resolve(bp)
    }
  }

  /**
   * Does this location still hold anything of ITS class?
   *
   * Shared roots (`/recordings` hosting high + low + events) are scored by
   * class subtree (`<camera>/high|mid`, `/low`, `/events`), not by a raw
   * `readdir` of the root — camera dirs and `.camstack-location` would
   * otherwise make every class look occupied. The walk stays shallow: one
   * dirent per camera, then first-entry of the named subtree. A `find` of
   * segments is precisely what must not happen here.
   *
   * **What it cannot see, stated rather than papered over:**
   *
   *  - A location on ANOTHER node, or behind a remote provider (S3 / SFTP /
   *    WebDAV): its bytes are not on this filesystem and this probe answers
   *    `unknown`, never `empty`.
   *  - A location with no `basePath` — same answer.
   *  - The difference between "holds live footage" and "holds one stray
   *    lock-file". It measures ON-DISK entries of this class, not durable
   *    rows, so it refuses a location holding orphan files that no index
   *    names. That direction is the safe one, and `force` is the escape
   *    hatch for it.
   *
   * A missing root (`ENOENT`) is `empty`, not `unknown`: an unmounted disk and
   * a deleted directory are indistinguishable here, and if the record's own
   * path does not exist there is nothing this delete can strand. Every OTHER
   * errno — `EACCES`, `EIO`, a stale NFS handle — is `unknown` and refuses.
   */
  private async locationOccupancy(location: StorageLocation): Promise<LocationOccupancy> {
    // A remote-backed location's bytes are not on this filesystem. The
    // docblock above has always SAID so; the code did not do it, and the two
    // had never disagreed only because no remote location existed. A remote
    // location carries a plain-looking `basePath` (`/backups/camstack`) that
    // `fs.readdir` on the hub answers `ENOENT` for, and ENOENT is read as
    // `empty` two lines down — so a full share, unreachable or simply
    // elsewhere, would have passed D293's delete guard as vacant. A leftover
    // that describes the right design is worse than no comment at all: it
    // reads as verification.
    //
    // `undefined` (provider not yet classified) is `unknown` too: a read that
    // could not be made must not authorise a destruction (D49).
    if (!canProbeOccupancyLocally(this.providerIsNodeLocal(location))) {
      this.ctx.logger.debug(
        'storage-orchestrator: occupancy unknown — location is not backed by a local filesystem',
        { meta: { id: location.id, providerId: location.providerId } },
      )
      return 'unknown'
    }
    const owner =
      location.nodeId === undefined || location.nodeId === '' ? HUB_NODE_ID : location.nodeId
    if (owner !== (this.service?.getLocalNodeId() ?? HUB_NODE_ID)) return 'unknown'
    const basePath = this.locationBasePath(location.id)
    if (basePath === null) return 'unknown'
    const occupancy = await probeLocalDirectoryOccupancy({ type: location.type, basePath })
    if (occupancy === 'unknown') {
      this.ctx.logger.warn('storage-orchestrator: could not read a location root to check it', {
        meta: { id: location.id, basePath, type: location.type },
      })
    }
    return occupancy
  }

  /**
   * The pressure guard's two readings come from the SAME probe the UI's
   * capacity does — one capacity truth per location, not two.
   *
   * They used to `statfs` the raw `basePath` themselves, which on this node
   * answers for whatever local path happens to carry that name: a location
   * owned by another node, or served by a remote provider, could decide
   * eviction from the hub's own disk. Both now degrade exactly as they did
   * when the path was unstattable — `100` (guard inert) and `0` (no byte
   * target) — but they do so for every reading that is not ABOUT the location,
   * not only for the ones that threw.
   */
  private async volumeCapacityOf(
    locationId: string,
  ): Promise<{ totalBytes: number; availableBytes: number } | null> {
    const loc = this.service?.listLocations().find((l) => l.id === locationId)
    if (!loc) return null
    return this.localCapacityOf(loc)
  }

  /** Free capacity (%) on a location's volume; 100 (guard inert) when unmeasurable. */
  private async locationFreePercent(locationId: string): Promise<number> {
    return freePercentOf(await this.volumeCapacityOf(locationId))
  }

  /** Total bytes on a location's volume; 0 when unmeasurable. */
  private async locationVolumeTotalBytes(locationId: string): Promise<number> {
    return volumeTotalBytesOf(await this.volumeCapacityOf(locationId))
  }

  // ── Seeding helpers (declaration-driven) ────────────────────────────

  /**
   * Seed default storage locations from the addon-declared
   * `storageLocations`, aggregated by the kernel into a
   * `StorageLocationRegistry`. Idempotent — re-running on a populated
   * map is a no-op (each declared id's `<id>:default` is already in the
   * service's map).
   *
   * `basePath` is this node's data root (`ctx.nodeDataDir` = `CAMSTACK_DATA`
   * ?? the kernel boot dir). Every declared default is attributed to the
   * `filesystem-storage`
   * provider; operators repoint individual locations (or add remote
   * SFTP/S3/WebDAV instances) through the admin UI afterwards.
   */
  private async seedFromDeclarations(): Promise<void> {
    if (!this.service) return
    // Refresh the node-local snapshot first so the upsert guard fired by
    // `seedDefaults` + the post-seed backfill classify providers correctly.
    await this.refreshNodeLocalCache()
    const perAddon = this.ctx.kernel.listStorageLocationDeclarations?.() ?? []
    const registry = buildStorageLocationRegistry(perAddon)
    this.service.setRegistry(registry)
    // Prune stale system-seeded locations whose type is no longer declared
    // (old defaults left in the SQLite store from before a location type was
    // removed). Must run after `setRegistry` so the declaration check is live.
    this.service.pruneUndeclaredSystemLocations()
    // Default base for configurable destinations = this node's data root.
    // `ctx.nodeDataDir` is already `CAMSTACK_DATA ?? <node root>`, node-correct
    // everywhere. Declarations marked `defaultRoot: 'media'` (recordings,
    // eventMedia) instead seed onto the dedicated media volume
    // (`CAMSTACK_MEDIA_ROOT`) when that env is set, keeping bulky/hot media off
    // the appData disk on a fresh install. Users can still repoint any location.
    const mediaRoot = process.env.CAMSTACK_MEDIA_ROOT?.trim()
    // Backups seed onto their own volume (`CAMSTACK_BACKUP_ROOT`, default
    // `/backups` in the image) so archives never fill the appData disk. Unset
    // → falls back to the data root like everything else.
    const backupRoot = process.env.CAMSTACK_BACKUP_ROOT?.trim()
    this.service.seedDefaults({
      providerId: 'filesystem-storage',
      basePath: this.ctx.nodeDataDir,
      mediaBasePath: mediaRoot && mediaRoot.length > 0 ? mediaRoot : undefined,
      backupBasePath: backupRoot && backupRoot.length > 0 ? backupRoot : undefined,
      declarations: registry.list(),
    })
    // Backfill `nodeId` on node-local locations seeded before the field
    // existed (single-node deployments → `'hub'`). Idempotent: only rows
    // missing `nodeId` are touched. Runs after seeding so freshly-seeded
    // defaults get stamped too. No-op until the filesystem provider's
    // `nodeLocal` snapshot is cached (else nothing resolves as node-local).
    await this.service.backfillNodeIds(HUB_NODE_ID)
  }

  /**
   * Rebuild the `providerId → nodeLocal` cache from every registered
   * `storage-provider`'s `getProviderInfo()`. Cheap registry scan; runs on
   * boot and on every provider-registered reconcile. Failed probes are
   * skipped (the provider stays absent → treated as node-agnostic).
   */
  private async refreshNodeLocalCache(): Promise<void> {
    const reg = this.ctx.kernel.capabilityRegistry
    if (!reg) return
    const providers = reg.getCollection<IStorageProviderImpl>(STORAGE_PROVIDER_CAP_NAME)
    const infos = await collectProviderInfos(providers, (_p, err, index) => {
      this.ctx.logger.warn('storage-orchestrator: getProviderInfo failed (nodeLocal cache)', {
        meta: { providerIndex: index, error: err instanceof Error ? err.message : String(err) },
      })
    })
    for (const info of infos) {
      this.nodeLocalByProvider.set(info.providerId, info.nodeLocal)
      this.secretKeysByProvider.set(info.providerId, secretKeysOfProviderInfo(info))
    }
  }
}

function parseStarted(raw: unknown): { started: boolean; alreadyRunning: boolean } {
  if (raw !== null && typeof raw === 'object') {
    const o = raw as Record<string, unknown>
    if (typeof o['started'] === 'boolean' && typeof o['alreadyRunning'] === 'boolean') {
      return { started: o['started'], alreadyRunning: o['alreadyRunning'] }
    }
  }
  return { started: false, alreadyRunning: false }
}

function parseOrphanStatus(raw: unknown): {
  running: boolean
  complete: boolean | null
  totalReclaimed: number
  totalBytesReclaimed: number
  error: string | null
} {
  if (raw !== null && typeof raw === 'object') {
    const o = raw as Record<string, unknown>
    return {
      running: o['running'] === true,
      complete: typeof o['complete'] === 'boolean' ? o['complete'] : null,
      totalReclaimed: typeof o['totalReclaimed'] === 'number' ? o['totalReclaimed'] : 0,
      totalBytesReclaimed:
        typeof o['totalBytesReclaimed'] === 'number' ? o['totalBytesReclaimed'] : 0,
      error: typeof o['error'] === 'string' ? o['error'] : null,
    }
  }
  return {
    running: false,
    complete: true,
    totalReclaimed: 0,
    totalBytesReclaimed: 0,
    error: 'orphan audit status unreadable',
  }
}

export default StorageOrchestratorAddon
