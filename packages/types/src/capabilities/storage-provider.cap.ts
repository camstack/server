import { z } from 'zod'
import { method, type CapabilityDefinition, type InferProvider } from './capability-definition.js'
import { StorageLocationSchema } from '../interfaces/storage-location.js'

// ── Provider self-description ───────────────────────────────────────
//
// `getProviderInfo` returns a static description that the orchestrator
// hands to the admin-UI's "Add location" wizard. Operators see one
// entry per provider — its `displayName` and the `configSchema` that
// drives the wizard form.
//
// `configSchema` mirrors `ConfigUISchemaWithValues` (sections[] +
// optional tabs[]). Typed here as `z.unknown()` to avoid a hard import
// from `interfaces/config-ui.ts` (which isn't a Zod schema). The admin
// UI casts it back to the concrete TS interface at consumption time.

// Disk-space management policy, declared per provider implementation so every
// location resolves to a concrete value the recorder can always read. Modelled
// as a discriminated union on `shouldSaveDiskSpace` so the invariant is
// enforced at the schema level (and narrows downstream):
//   true  → finite volume, `minFreePercent` is a concrete 0..100 threshold.
//   false → no local free-space concept (remote/object store), `minFreePercent`
//           is `null`.
const ProviderInfoSchema = z.discriminatedUnion('shouldSaveDiskSpace', [
  z.object({
    providerId: z.string().min(1),
    displayName: z.string().min(1),
    configSchema: z.unknown(),
    /** True = provider serves a node-local volume (filesystem): its locations
     *  bind to a single node and need a node + path. False = reachable from any
     *  node (remote/object store). */
    nodeLocal: z.boolean(),
    // Provider manages a finite volume → declares a default free-space threshold.
    shouldSaveDiskSpace: z.literal(true),
    minFreePercent: z.number().min(0).max(100),
  }),
  z.object({
    providerId: z.string().min(1),
    displayName: z.string().min(1),
    configSchema: z.unknown(),
    /** True = provider serves a node-local volume (filesystem): its locations
     *  bind to a single node and need a node + path. False = reachable from any
     *  node (remote/object store). */
    nodeLocal: z.boolean(),
    // No local free-space concept (remote/object store) → no threshold.
    shouldSaveDiskSpace: z.literal(false),
    minFreePercent: z.literal(null),
  }),
])

const TestLocationResultSchema = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
})

// ── Chunked upload protocol ─────────────────────────────────────────
//
// Large archives (backup snapshots, recordings) flow through a session:
//   beginUpload(location, relativePath, sizeBytes?) → uploadId
//   writeChunk(uploadId, offset, data) × N
//   finalizeUpload(uploadId)            // commit
//   abortUpload(uploadId)               // discard
//
// Each chunk is self-describing (`offset`) so providers can dedupe or
// resume on disconnect. Providers SHOULD enforce a max chunk size and
// reject malformed offsets.

const BeginUploadInputSchema = z.object({
  location: StorageLocationSchema,
  relativePath: z.string(),
  sizeBytes: z.number().optional(),
})
const BeginUploadResultSchema = z.object({ uploadId: z.string() })
const WriteChunkInputSchema = z.object({
  uploadId: z.string(),
  offset: z.number(),
  data: z.instanceof(Uint8Array),
})
const FinalizeUploadInputSchema = z.object({ uploadId: z.string() })
const AbortUploadInputSchema = z.object({ uploadId: z.string() })

// ── Chunked download protocol ───────────────────────────────────────
// Symmetric to upload: open-by-path returns a session + total size,
// reader pulls byte ranges, end closes the session.

const BeginDownloadInputSchema = z.object({
  location: StorageLocationSchema,
  relativePath: z.string(),
})
const BeginDownloadResultSchema = z.object({
  downloadId: z.string(),
  sizeBytes: z.number(),
})
const ReadChunkInputSchema = z.object({
  downloadId: z.string(),
  offset: z.number(),
  length: z.number(),
})
const EndDownloadInputSchema = z.object({ downloadId: z.string() })

/**
 * storage-provider — collection capability for backend-specific storage
 * drivers.
 *
 * Multiple addons register against this cap (filesystem-storage,
 * sftp-storage, s3-storage, webdav-storage, …). The orchestrator
 * (singleton `storage` cap, owned by the storage-orchestrator builtin)
 * routes each call to the right provider by looking up
 * `location.providerId` and dispatching the inline `location` arg.
 *
 * Design notes:
 *   - Stateless dispatch: every primitive carries its own `location`,
 *     so providers don't keep per-location state across calls.
 *   - Session-scoped uploads/downloads: the `uploadId`/`downloadId`
 *     handles let the provider hold open file descriptors / streams
 *     between chunks while keeping the cap surface RPC-friendly.
 *   - `internal: true` — this cap is consumed only by the storage
 *     orchestrator. Public consumers go through the `storage`
 *     singleton cap; they never see `storage-provider` directly.
 */
export const storageProviderCapability = {
  name: 'storage-provider',
  scope: 'system',
  mode: 'collection',
  internal: true,
  methods: {
    /**
     * Every method below except `testLocation` had NO `auth` override —
     * `internal: true` did not gate the mount (see the 2026-08-26 note on
     * `data-store-provider`), so this was reachable on the AppRouter by ANY
     * authenticated session at the default `auth: 'protected'`: arbitrary
     * read/write/delete/list against any storage location the operator has
     * configured, keyed only by a caller-supplied `location` + `relativePath`
     * — the same "public consumers never see this cap" claim that was false
     * for `data-store-provider`, here gating raw file I/O instead of raw
     * settings rows. The only legitimate caller,
     * `addon-registry.service.ts`'s `activeStorageProvider`, calls the
     * provider object directly (in-process) — never tRPC — so `auth: 'admin'`
     * on every method costs it nothing. Public consumers already go through
     * the separate `storage` singleton cap.
     */
    /** Self-description for the "Add location" wizard. */
    getProviderInfo: method(z.void(), ProviderInfoSchema, { auth: 'admin' }),

    /** Validate config + probe connectivity. Called on add and on edit. */
    testLocation: method(
      z.object({ config: z.record(z.string(), z.unknown()) }),
      TestLocationResultSchema,
      { auth: 'admin' },
    ),

    // ── Small-file primitives ────────────────────────────────────────
    // The location is passed inline so the orchestrator dispatches
    // without provider-side location state.
    resolve: method(
      z.object({ location: StorageLocationSchema, relativePath: z.string() }),
      z.string(),
      { auth: 'admin' },
    ),
    write: method(
      z.object({
        location: StorageLocationSchema,
        relativePath: z.string(),
        data: z.instanceof(Uint8Array),
      }),
      z.void(),
      { kind: 'mutation', auth: 'admin' },
    ),
    read: method(
      z.object({ location: StorageLocationSchema, relativePath: z.string() }),
      z.instanceof(Uint8Array),
      { auth: 'admin' },
    ),
    exists: method(
      z.object({ location: StorageLocationSchema, relativePath: z.string() }),
      z.boolean(),
      { auth: 'admin' },
    ),
    list: method(
      z.object({ location: StorageLocationSchema, prefix: z.string().optional() }),
      z.array(z.string()).readonly(),
      { auth: 'admin' },
    ),
    delete: method(
      z.object({ location: StorageLocationSchema, relativePath: z.string() }),
      z.void(),
      { kind: 'mutation', auth: 'admin' },
    ),
    getAvailableSpace: method(
      z.object({ location: StorageLocationSchema }),
      z.number().nullable(),
      { auth: 'admin' },
    ),

    // ── Chunked upload ──────────────────────────────────────────────
    beginUpload: method(BeginUploadInputSchema, BeginUploadResultSchema, {
      kind: 'mutation',
      auth: 'admin',
    }),
    writeChunk: method(WriteChunkInputSchema, z.void(), { kind: 'mutation', auth: 'admin' }),
    finalizeUpload: method(FinalizeUploadInputSchema, z.void(), {
      kind: 'mutation',
      auth: 'admin',
    }),
    abortUpload: method(AbortUploadInputSchema, z.void(), { kind: 'mutation', auth: 'admin' }),

    // ── Chunked download ────────────────────────────────────────────
    beginDownload: method(BeginDownloadInputSchema, BeginDownloadResultSchema, {
      kind: 'mutation',
      auth: 'admin',
    }),
    readChunk: method(ReadChunkInputSchema, z.instanceof(Uint8Array), { auth: 'admin' }),
    endDownload: method(EndDownloadInputSchema, z.void(), { kind: 'mutation', auth: 'admin' }),
  },
} as const satisfies CapabilityDefinition

export type IStorageProviderImpl = InferProvider<typeof storageProviderCapability>

export {
  ProviderInfoSchema,
  TestLocationResultSchema,
  BeginUploadInputSchema,
  BeginUploadResultSchema,
  WriteChunkInputSchema,
  FinalizeUploadInputSchema,
  AbortUploadInputSchema,
  BeginDownloadInputSchema,
  BeginDownloadResultSchema,
  ReadChunkInputSchema,
  EndDownloadInputSchema,
}
