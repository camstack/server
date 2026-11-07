import { z } from 'zod'
import {
  StorageLocationRefSchema,
  StorageDrainProgressSchema,
  StorageLocationSchema,
  StorageLocationTypeSchema,
} from '../interfaces/storage-location.js'
import { StorageLocationDeclarationSchema } from '../interfaces/storage-location-declaration.js'
import { type CapabilityDefinition, type InferProvider, method } from './capability-definition.js'

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

    // ── Location reads ──────────────────────────────────────────────
    // The locations are the instances of this function (`integration-instances`,
    // one kind per declaration): add, edit, test, switch and delete go through
    // that cap, and the forced delete is the orchestrator's `forceDeleteLocation`
    // custom action (D49). What stays here are the reads the pages and the
    // consumers need.
    listLocations: method(
      z.object({ type: StorageLocationTypeSchema.optional() }),
      z.array(StorageLocationSchema).readonly(),
    ),
    // One entry per declared location kind (the instance kinds of this function).
    // Source: the kernel-aggregated `storageLocations` declarations injected
    // into the orchestrator via `setRegistry`. No closed type enum anywhere.
    listLocationDeclarations: method(
      z.void(),
      z.array(StorageLocationDeclarationSchema).readonly(),
    ),
    /**
     * How far each draining location has got (D386). A pure READ of what the
     * last pressure sweep computed — it starts no work, and a location that is
     * not draining simply does not appear.
     */
    listDrainProgress: method(z.void(), z.array(StorageDrainProgressSchema).readonly()),
  },
} as const satisfies CapabilityDefinition

export type IStorageCapProvider = InferProvider<typeof storageCapability>

export { StorageLocationTypeSchema }
