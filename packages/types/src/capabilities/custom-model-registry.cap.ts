import { z } from 'zod'
import { method, type CapabilityDefinition, type InferProvider } from './capability-definition.js'
import { PeerBytesTicketSchema } from '../interfaces/addon-peer-bytes.js'
import { MODEL_FORMATS, ModelCatalogEntrySchema } from '../types/models.js'

/**
 * `custom-model-registry` — collection cap exposing operator-registered
 * custom detection models. Each provider (today: `addon-model-studio`)
 * contributes a list of `CustomModelDescriptor`s; the hub auto-concatenates
 * them across providers (`concatCollection`).
 *
 * The detection-pipeline is *aware* of this cap: when at least one provider
 * exists it unions these descriptors into the per-step model picker and the
 * runtime model-resolution path, alongside the static catalog. When no
 * provider exists the consumer no-ops entirely (identical to the catalog-only
 * behaviour).
 *
 * A descriptor carries a full `ModelCatalogEntry` directly — the same shape
 * the static catalog uses — so the existing download/resolution code consumes
 * it unchanged. `stepId` is the detection step the model targets
 * (e.g. `'object-detection'`).
 */
export const CustomModelDescriptorSchema = z.object({
  stepId: z.string(),
  entry: ModelCatalogEntrySchema,
})

export type CustomModelDescriptor = z.infer<typeof CustomModelDescriptorSchema>

/** One regular file of an imported bundle, as the producer measured it. */
export const ModelBundleFileSchema = z.object({
  /** Relative path inside the bundle tar; an mlpackage member is `<x>.mlpackage/<member>`. */
  path: z.string().min(1),
  bytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
})
export type ModelBundleFile = z.infer<typeof ModelBundleFileSchema>

export const ImportModelBundleInputSchema = z.object({
  /** The registry provider that keeps the model (Model Studio). */
  addonId: z.string(),
  stepId: z.string().min(1),
  /**
   * The catalog rows to register, complete, every format URL already
   * `camstack-local://<modelId>/<file>` naming a file of the bundle. One
   * bundle may carry several rows (a base and its INT8 variant).
   */
  entries: z.array(ModelCatalogEntrySchema).min(1).max(4),
  /** The bundle tar, offered by the producer over `ctx.peerBytes` (same host). */
  bundle: z.object({
    ticket: PeerBytesTicketSchema,
    bytes: z.number().int().positive(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  }),
  /** Every file the tar must hold; anything missing, extra or different is refused. */
  files: z.array(ModelBundleFileSchema).min(1).max(64),
  /** Convert missing engine formats and push the model to every agent afterwards. */
  distribute: z.boolean(),
})
export type ImportModelBundleInput = z.infer<typeof ImportModelBundleInputSchema>

export const ImportModelBundleResultSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('imported'),
    modelIds: z.array(z.string()).readonly(),
    distributed: z
      .array(
        z.object({
          modelId: z.string(),
          nodeId: z.string(),
          format: z.enum(MODEL_FORMATS),
          ok: z.boolean(),
          error: z.string().optional(),
        }),
      )
      .readonly(),
  }),
  z.object({
    kind: z.literal('refused'),
    reason: z.enum([
      'transfer-failed',
      'checksum-mismatch',
      'bundle-mismatch',
      'invalid-entry',
      'id-taken',
    ]),
    detail: z.string(),
  }),
])
export type ImportModelBundleResult = z.infer<typeof ImportModelBundleResultSchema>

export const customModelRegistryCapability = {
  name: 'custom-model-registry',
  scope: 'system',
  mode: 'collection',
  internal: true,
  methods: {
    /**
     * `internal: true` did not gate the mount (see the 2026-08-26 note on
     * `data-store-provider`) — this was reachable on the AppRouter by ANY
     * authenticated session at the default `auth: 'protected'`. The only
     * consumer, the detection-pipeline's model resolution
     * (`addon-pipeline/src/detection-pipeline/provider.ts`), calls
     * `ctx.api.customModelRegistry.listModels.query()` — UDS/Moleculer,
     * never tRPC — so `auth: 'admin'` costs it nothing.
     */
    listModels: method(z.void(), z.array(CustomModelDescriptorSchema).readonly(), {
      auth: 'admin',
    }),
    /**
     * Register a model whose files arrive as ONE bundle tar (D806): the tar
     * is taken over `ctx.peerBytes`, checked against `bundle.sha256` and
     * every row of `files`, unpacked into the hub's flat modelsDir (directory
     * formats included), each format's `.revision` record written, the rows
     * upserted under the operator's name, the hub marked available and —
     * when asked — engine formats converted and the model distributed. A
     * model id already registered by another source is refused, never
     * overwritten.
     */
    importModelBundle: method(ImportModelBundleInputSchema, ImportModelBundleResultSchema, {
      kind: 'mutation',
      auth: 'admin',
      timeoutMs: 30 * 60_000,
    }),
  },
} as const satisfies CapabilityDefinition

export type ICustomModelRegistryProvider = InferProvider<typeof customModelRegistryCapability>
