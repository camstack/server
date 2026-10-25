import { z } from 'zod'
import {
  StorageLocationRefSchema,
  StorageDrainProgressSchema,
  StorageLocationSchema,
  StorageLocationTypeSchema,
} from '../interfaces/storage-location.js'
import { StorageLocationDeclarationSchema } from '../interfaces/storage-location-declaration.js'
import { type CapabilityDefinition, type InferProvider, method } from './capability-definition.js'

// One entry of the `listProviders` output. Mirrors `ProviderInfoSchema` in
// storage-provider.cap.ts: a discriminated union on `shouldSaveDiskSpace` so
// the disk-space invariant (true ⇒ number, false ⇒ null) is enforced here too.
const ProviderListEntrySchema = z.discriminatedUnion('shouldSaveDiskSpace', [
  z.object({
    providerId: z.string().min(1),
    displayName: z.string().min(1),
    configSchema: z.unknown(),
    nodeLocal: z.boolean(),
    shouldSaveDiskSpace: z.literal(true),
    minFreePercent: z.number().min(0).max(100),
  }),
  z.object({
    providerId: z.string().min(1),
    displayName: z.string().min(1),
    configSchema: z.unknown(),
    nodeLocal: z.boolean(),
    shouldSaveDiskSpace: z.literal(false),
    minFreePercent: z.literal(null),
  }),
])

/**
 * `storage` — singleton consumer-facing capability owned by the
 * `storage-orchestrator` builtin (Task 4 of the storage-unification
 * refactor). All file I/O across the system flows through this cap;
 * the orchestrator resolves each `location` ref to a concrete
 * `StorageLocation` record and dispatches to the matching
 * `storage-provider` registrant.
 *
 * The `location` parameter on every primitive is a `StorageLocationRef`
 * — either a bare `StorageLocationType` (e.g. `'backups'`, resolves to
 * the default of that type) or a fully-qualified id (`'backups:nas-01'`,
 * addresses a specific instance). Both forms are normalised inside the
 * orchestrator's `resolveRef(ref)` step.
 *
 * Mode: `singleton` (was `collection` pre-Task-3). The cap-router mount
 * uses `requireSingleton(reg, 'storage')` — pointing at the orchestrator
 * once it lands.
 */
export const storageCapability = {
  name: 'storage',
  scope: 'system',
  mode: 'singleton',
  methods: {
    // ── Tiers (D634) ────────────────────────────────────────────────
    // Every method that reads, writes, lists or resolves a path INSIDE a
    // location is `auth: 'admin'`. They were `protected` with the `view`
    // flavour, which every role carries — so a viewer could list `backups`
    // and download an archive holding the live settings database (every
    // notifier token in plaintext). No client reads media through this cap:
    // media reaches a person through the device-scoped caps, and a media
    // location opened here would bypass device scoping (`read` names no
    // device). Addons are unaffected — an addon's `ctx.api` cap call is
    // resolved to the provider directly and never enters the tRPC router.
    // The redacted location list and the free-space number stay open.
    //
    // ── Small-file primitives ────────────────────────────────────────
    // `location` is a ref (type or fully-qualified id). The orchestrator
    // resolves the ref to a concrete `StorageLocation` and dispatches.
    resolve: method(
      z.object({ location: StorageLocationRefSchema, relativePath: z.string() }),
      z.string(),
      { auth: 'admin' },
    ),
    write: method(
      z.object({
        location: StorageLocationRefSchema,
        relativePath: z.string(),
        data: z.instanceof(Uint8Array),
      }),
      z.void(),
      { kind: 'mutation', auth: 'admin' },
    ),
    read: method(
      z.object({ location: StorageLocationRefSchema, relativePath: z.string() }),
      z.instanceof(Uint8Array),
      { auth: 'admin' },
    ),
    exists: method(
      z.object({ location: StorageLocationRefSchema, relativePath: z.string() }),
      z.boolean(),
      { auth: 'admin' },
    ),
    list: method(
      z.object({ location: StorageLocationRefSchema, prefix: z.string().optional() }),
      z.array(z.string()).readonly(),
      { auth: 'admin' },
    ),
    delete: method(
      z.object({ location: StorageLocationRefSchema, relativePath: z.string() }),
      z.void(),
      { kind: 'mutation', auth: 'admin' },
    ),
    getAvailableSpace: method(
      z.object({ location: StorageLocationRefSchema }),
      z.number().nullable(),
    ),

    // ── Chunked I/O ──────────────────────────────────────────────────
    // Same protocol as `storage-provider` but on the consumer side.
    // Sessions are owned by the orchestrator: it forwards each chunk
    // to the provider that backs the resolved location.
    beginUpload: method(
      z.object({
        location: StorageLocationRefSchema,
        relativePath: z.string(),
        sizeBytes: z.number().optional(),
      }),
      z.object({ uploadId: z.string() }),
      { kind: 'mutation', auth: 'admin' },
    ),
    writeChunk: method(
      z.object({ uploadId: z.string(), offset: z.number(), data: z.instanceof(Uint8Array) }),
      z.void(),
      { kind: 'mutation', auth: 'admin' },
    ),
    finalizeUpload: method(z.object({ uploadId: z.string() }), z.void(), {
      kind: 'mutation',
      auth: 'admin',
    }),
    abortUpload: method(z.object({ uploadId: z.string() }), z.void(), {
      kind: 'mutation',
      auth: 'admin',
    }),
    beginDownload: method(
      z.object({ location: StorageLocationRefSchema, relativePath: z.string() }),
      z.object({ downloadId: z.string(), sizeBytes: z.number() }),
      { kind: 'mutation', auth: 'admin' },
    ),
    readChunk: method(
      z.object({ downloadId: z.string(), offset: z.number(), length: z.number() }),
      z.instanceof(Uint8Array),
      { auth: 'admin' },
    ),
    endDownload: method(z.object({ downloadId: z.string() }), z.void(), {
      kind: 'mutation',
      auth: 'admin',
    }),

    // ── Location management ─────────────────────────────────────────
    // The orchestrator's authoritative surface for the admin-UI's
    // storage-locations page. Operators add/edit/test/remove location
    // instances here; `upsertLocation` and `deleteLocation` require
    // superAdmin auth.
    listLocations: method(
      z.object({ type: StorageLocationTypeSchema.optional() }),
      z.array(StorageLocationSchema).readonly(),
    ),
    // The admin-UI Data screen renders one group per declared location
    // (header = `displayName`, "+ Add" shown only for `cardinality:
    // 'multi'`). Source: the kernel-aggregated `storageLocations`
    // declarations injected into the orchestrator via `setRegistry`.
    // No closed type enum in the UI — the screen is fully declaration-
    // driven.
    listLocationDeclarations: method(
      z.void(),
      z.array(StorageLocationDeclarationSchema).readonly(),
    ),
    upsertLocation: method(
      StorageLocationSchema.omit({ createdAt: true, updatedAt: true }),
      StorageLocationSchema,
      { kind: 'mutation', auth: 'admin' },
    ),
    /**
     * Remove a location record. REFUSES a location that still holds data —
     * deleting a drained location whose durable rows still name it is how this
     * hub acquired 2 131 ghost `recordings:high` segments, and playback does
     * not stat, so the operator sees a silent black window rather than an
     * error.
     *
     * `force` exists because the occupancy check is BEST-EFFORT and refuses on
     * "unknown" as well as on "occupied" (a read that fails must not authorise
     * a destruction — D49). A location on a removed disk, on another node, or
     * behind a remote provider answers "unknown" forever, and a refusal an
     * operator cannot override is its own failure mode. `force: true` is
     * logged, loudly, with what the check saw.
     */
    deleteLocation: method(z.object({ id: z.string(), force: z.boolean().optional() }), z.void(), {
      kind: 'mutation',
      auth: 'admin',
    }),
    /**
     * How far each draining location has got (D386). A pure READ of what the
     * last pressure sweep computed — it starts no work, and a location that is
     * not draining simply does not appear.
     */
    listDrainProgress: method(z.void(), z.array(StorageDrainProgressSchema).readonly()),
    testLocation: method(
      z.object({ id: z.string() }),
      z.object({ ok: z.boolean(), error: z.string().optional() }),
      { auth: 'admin' },
    ),

    // ── Provider discovery ──────────────────────────────────────────
    // The admin-UI's "Add location" wizard shows one entry per
    // registered `storage-provider` collection cap. Each entry is the
    // provider's `getProviderInfo()` blob — stable, addon-driven, no
    // hard-coded list in the UI. The orchestrator gathers them by
    // walking the registry on every call (cheap; the list almost
    // never changes after boot).
    listProviders: method(z.void(), z.array(ProviderListEntrySchema).readonly()),

    // Validate a candidate config against a provider BEFORE persisting.
    // Used by the wizard so operators can preflight a connection
    // (e.g. SFTP credentials, S3 bucket access) without leaving an
    // orphan record behind on failure.
    testConfig: method(
      z.object({
        providerId: z.string(),
        /**
         * The location this config is an UNSAVED edit of, when there is one.
         *
         * `listLocations` replaces every declared secret with the redaction
         * sentinel, so the edit modal's form state holds the sentinel for any
         * credential the operator did not retype — and posting that here
         * without a way to resolve it makes the provider try to authenticate
         * as `__camstack_redacted__` and report the operator's own working
         * password as wrong. Given this id, the orchestrator restores each
         * sentinel from the stored config (same rule as `upsertLocation`)
         * before dispatching. Omitted by the "Add location" wizard, where
         * every value was typed just now and nothing is stored yet.
         */
        locationId: z.string().optional(),
        config: z.record(z.string(), z.unknown()),
      }),
      z.object({ ok: z.boolean(), error: z.string().optional() }),
      { auth: 'admin' },
    ),
  },
} as const satisfies CapabilityDefinition

export type IStorageCapProvider = InferProvider<typeof storageCapability>

export { StorageLocationTypeSchema }
