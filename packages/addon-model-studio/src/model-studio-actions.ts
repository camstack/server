/**
 * addon-model-studio — customActions catalog.
 *
 * Driven via `api.addons.custom.mutate({ addonId: 'model-studio', action,
 * input })`. P1 surface is the registry maintenance: register / remove / list
 * custom detection models. The `custom-model-registry` collection cap exposes
 * only the read-array `listModels` (auto-concatenated across providers); the
 * mutations live here so the cap stays a clean collection.
 */
import { z } from 'zod'
import {
  customAction,
  defineCustomActions,
  CustomModelDescriptorSchema,
  MODEL_FORMATS,
  ConvertTargetSchema,
  ModelConvertMetadataSchema,
  ConvertArtifactSchema,
  ModelCatalogEntrySchema,
} from '@camstack/types'

/** One format's presence on a node. */
export const ModelFormatPresenceSchema = z.object({
  sha256: z.string(),
  bytes: z.number(),
  at: z.number(),
})

/**
 * Per-node availability — multi-format. Legacy durable rows were
 * `{ format, sha256, bytes, at }`; preprocess folds them into `formats`.
 */
export const ModelNodeAvailabilitySchema = z.preprocess(
  (raw) => {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return raw
    const rec = raw as Record<string, unknown>
    if (typeof rec.formats === 'object' && rec.formats !== null && !Array.isArray(rec.formats)) {
      return { formats: rec.formats }
    }
    if (typeof rec.format === 'string') {
      return {
        formats: {
          [rec.format]: {
            sha256: typeof rec.sha256 === 'string' ? rec.sha256 : '',
            bytes: typeof rec.bytes === 'number' ? rec.bytes : 0,
            at: typeof rec.at === 'number' ? rec.at : 0,
          },
        },
      }
    }
    return raw
  },
  z.object({ formats: z.partialRecord(z.enum(MODEL_FORMATS), ModelFormatPresenceSchema) }),
)

/** `modelId → nodeId → { formats: { [format]: presence } }`. */
export const ModelAvailabilityMapSchema = z.record(
  z.string(),
  z.record(z.string(), ModelNodeAvailabilitySchema),
)

/** Stable Library id for a plus catalog training (chip id ↔ registry). */
export function plusCatalogPlusRegistryId(plusModelId: string): string {
  return `plus-catalog-${plusModelId}`
}

export const PluginCatalogManifestFileSchema = z.object({
  relativePath: z.string(),
  size: z.number(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
})

export const PluginCatalogManifestEntrySchema = z.object({
  id: z.string(),
  label: z.string(),
  family: z.enum(['yolov9t', 'yolov9s', 'yolov9m', 'yolov9c']),
  variant: z.enum(['relu', 'relu_test']),
  format: z.enum(['coreml', 'onnx', 'openvino', 'tflite']),
  precision: z.string(),
  inputSize: z.object({ width: z.number(), height: z.number() }),
  files: z.array(PluginCatalogManifestFileSchema).readonly(),
  model: ModelCatalogEntrySchema,
})

export const PluginCatalogCatalogDriftSchema = z.object({
  manifestId: z.string(),
  status: z.enum(['ok', 'missing', 'size-changed', 'unavailable']),
  details: z.string().optional(),
})

/**
 * Curated PUBLIC plus catalog catalog entry (D214 addendum). Named + exported so
 * the UI's `listPlusCatalogCatalog` result parses against the SAME schema this
 * action's output is declared with (see `modelStudioActions.listPlusCatalogCatalog`
 * below) — one shape, not a hand-duplicated interface on the UI side.
 */
export const PlusCatalogCatalogEntrySchema = z.object({
  id: z.string(),
  label: z.string(),
  format: z.enum(MODEL_FORMATS),
  sizeMB: z.number(),
  inputSize: z.number(),
  notes: z.string(),
})

/**
 * plus catalog `/v1/model/list` entry (see `plus-catalog-api.ts`). `isBaseModel` is
 * the Base/Custom discriminator plus catalog's own UI groups on. Named + exported
 * for the same reason as {@link PlusCatalogCatalogEntrySchema}.
 */
export const PlusCatalogModelSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  isBaseModel: z.boolean(),
  baseModel: z.string(),
  supportedDetectors: z.array(z.string()).readonly(),
  trainDate: z.string(),
  hailoDevice: z.string().optional(),
  verifiedImages: z.number(),
  width: z.number().optional(),
  height: z.number().optional(),
})

export const modelStudioActions = defineCustomActions({
  registerCustomModel: customAction(
    CustomModelDescriptorSchema,
    z.object({
      ok: z.literal(true),
      conversions: z
        .array(
          z.object({
            format: z.enum(['openvino', 'coreml']),
            ok: z.boolean(),
            nodeId: z.string().optional(),
            error: z.string().optional(),
          }),
        )
        .readonly(),
    }),
    { kind: 'mutation' },
  ),
  /**
   * Ensure OV/CoreML from ONNX when missing, then distribute every declared
   * format to every online agent (hub skipped).
   */
  ensureFormatsThenDistribute: customAction(
    z.object({ modelId: z.string() }),
    z.object({
      conversions: z
        .array(
          z.object({
            format: z.enum(['openvino', 'coreml']),
            ok: z.boolean(),
            nodeId: z.string().optional(),
            error: z.string().optional(),
          }),
        )
        .readonly(),
      distributed: z
        .array(
          z.object({
            nodeId: z.string(),
            format: z.enum(MODEL_FORMATS),
            ok: z.boolean(),
            error: z.string().optional(),
            bytes: z.number().optional(),
          }),
        )
        .readonly(),
    }),
    { kind: 'mutation' },
  ),
  /**
   * Convert missing OpenVINO / CoreML from an already-registered ONNX entry
   * (plus catalog / Custom per-format Import). Only the requested formats run.
   */
  ensureModelFormats: customAction(
    z.object({
      modelId: z.string(),
      formats: z
        .array(z.enum(['openvino', 'coreml']))
        .min(1)
        .readonly(),
    }),
    z.object({
      conversions: z
        .array(
          z.object({
            format: z.enum(['openvino', 'coreml']),
            ok: z.boolean(),
            nodeId: z.string().optional(),
            error: z.string().optional(),
          }),
        )
        .readonly(),
    }),
    { kind: 'mutation' },
  ),
  removeCustomModel: customAction(
    z.object({ modelId: z.string() }),
    z.object({
      removed: z.boolean(),
      deletedNodes: z.array(z.string()).readonly(),
      clearedPins: z.number().int().nonnegative(),
    }),
    { kind: 'mutation' },
  ),
  /**
   * Rename an IMPORTED registry row (plus catalog, plus catalog, plugin catalog, uploads,
   * conversions) in place. Only `entry.name` changes — never the id, so pins
   * and availability are untouched. An empty name restores the name the model
   * was imported with. CamStack catalog models are refused.
   */
  renameCustomModel: customAction(
    z.object({ modelId: z.string().min(1), name: z.string() }),
    z.object({ modelId: z.string(), name: z.string() }),
    { kind: 'mutation' },
  ),
  /**
   * Delete one format of a Library model from one node. Keeps the registry row
   * and sibling formats/nodes; clears only that availability chip.
   */
  removeModelFromNode: customAction(
    z.object({
      modelId: z.string(),
      nodeId: z.string(),
      format: z.enum(MODEL_FORMATS),
    }),
    z.object({
      deleted: z.boolean(),
      clearedAvailability: z.boolean(),
    }),
    { kind: 'mutation' },
  ),
  /**
   * Wipe one CamStack seed format from a node's modelsDir (Installed Remove).
   * Routes via `nodePin` — `pipelineExecutor.deleteModel` has no `nodeId` in
   * its input schema, so a bare tRPC mutate always hit the hub.
   */
  deleteSeedFromNode: customAction(
    z.object({
      addonId: z.string(),
      modelId: z.string(),
      format: z.enum(MODEL_FORMATS),
      nodeId: z.string(),
    }),
    z.object({ success: z.literal(true) }),
    { kind: 'mutation' },
  ),
  listCustomModels: customAction(z.void(), z.array(CustomModelDescriptorSchema).readonly()),

  /**
   * Distribute a registered model's FORMAT (resident on the hub) to a target
   * node, via the `model-distributor` cap. On success the node is recorded in
   * the availability map.
   */
  distributeModel: customAction(
    z.object({
      modelId: z.string(),
      nodeId: z.string(),
      format: z.enum(MODEL_FORMATS),
    }),
    z.object({ ok: z.boolean(), sha256: z.string(), bytes: z.number() }),
    { kind: 'mutation' },
  ),
  listAvailability: customAction(z.void(), ModelAvailabilityMapSchema),

  /**
   * Chunked model-file upload (plus catalog import). One tRPC mutation cannot
   * carry a model file (hub HTTP body limit ~1 MB), so the page streams
   * base64 chunks: begin → append× → commit. Commit lands the artifact in the
   * hub's shared modelsDir, where the `camstack-local://` catalog-URL
   * convention resolves it by basename and `model-distributor` can ship it to
   * agents. Abort (or an oversize chunk) discards the staging file.
   */
  beginModelUpload: customAction(
    z.object({ filename: z.string(), totalBytes: z.number().int().positive() }),
    z.object({ uploadId: z.string() }),
    { kind: 'mutation' },
  ),
  appendModelUpload: customAction(
    z.object({ uploadId: z.string(), chunkBase64: z.string() }),
    z.object({ received: z.number() }),
    { kind: 'mutation' },
  ),
  commitModelUpload: customAction(
    z.object({ uploadId: z.string() }),
    z.object({ filename: z.string(), bytes: z.number(), sha256: z.string() }),
    { kind: 'mutation' },
  ),
  abortModelUpload: customAction(
    z.object({ uploadId: z.string() }),
    z.object({ ok: z.literal(true) }),
    { kind: 'mutation' },
  ),

  /**
   * Curated PUBLIC plus catalog model catalog (D214 addendum). Import registers the
   * descriptor with its public URL (Library only). Optional `targetNodeId`
   * downloads on that node — no hub staging disk.
   */
  listPlusCatalogCatalog: customAction(z.void(), z.array(PlusCatalogCatalogEntrySchema).readonly()),
  importPlusCatalogCatalogModel: customAction(
    z.object({
      catalogId: z.string(),
      modelId: z.string().optional(),
      name: z.string().optional(),
      targetNodeId: z.string().optional(),
    }),
    z.object({ ok: z.literal(true), modelId: z.string(), bytes: z.number() }),
    { kind: 'mutation' },
  ),

  /**
   * Local plugin catalog YOLO catalog (Task 7B). Listing is a projection of the
   * revision-pinned manifesto plus a read-only HF drift check. Import accepts
   * `manifestId` (+ optional land-on-node) — host/repo/revision/path/labels/
   * checksum stay server-owned.
   */
  listPluginCatalogCatalog: customAction(
    z.void(),
    z.object({
      entries: z.array(PluginCatalogManifestEntrySchema).readonly(),
      drift: z.array(PluginCatalogCatalogDriftSchema).readonly(),
    }),
  ),
  importPluginCatalogCatalogModel: customAction(
    z.object({
      manifestId: z.string(),
      /** Optional display name typed on the import card. */
      name: z.string().optional(),
      targetNodeId: z.string().optional(),
    }),
    CustomModelDescriptorSchema,
    { kind: 'mutation' },
  ),

  /**
   * plus catalog personal models. The API key lives in the addon's SETTINGS
   * (password field) and never leaves the hub: list / test / import all run
   * server-side against api.frigate.video. Status deliberately reveals only
   * booleans — never the key.
   */
  /**
   * Nodes whose engine can actually LOAD a tflite artifact (the pool's only
   * tflite runtime binds the Coral EdgeTPU delegate — no Coral, no tflite).
   * Empty object — `addons.custom` cannot carry zod `void`.
   */
  tfliteSupport: customAction(
    z.object({}).optional(),
    z.object({ nodes: z.array(z.string()).readonly() }),
  ),

  plusCatalogPlusStatus: customAction(
    z.void(),
    z.object({ configured: z.boolean(), keyFormatValid: z.boolean() }),
  ),
  plusCatalogPlusTest: customAction(
    z.void(),
    z.object({ ok: z.boolean(), error: z.string().optional() }),
    { kind: 'mutation' },
  ),
  plusCatalogPlusListModels: customAction(z.void(), z.array(PlusCatalogModelSchema).readonly()),
  importPlusCatalogModel: customAction(
    z.object({
      plusModelId: z.string(),
      /** Ignored for identity — registry id is always `plus-catalog-<plusModelId>`. */
      modelId: z.string().optional(),
      name: z.string().optional(),
      /**
       * Native artifact class of the chosen build (`plusImportLane`: neural →
       * onnx, coral → tflite). The
       * model-detail API does not always carry `supportedDetectors`, so the
       * browser passes what the catalog already knew (fixes ssd/yolo-generic
       * EdgeTPU rows that `plusTypeTraits` alone would call onnx).
       */
      format: z.enum(['onnx', 'tflite']).optional(),
      /**
       * Engine formats to convert after the native artifact lands. Empty =
       * download + register only (per-format Import clicks OV/CoreML later).
       */
      ensureFormats: z
        .array(z.enum(['openvino', 'coreml']))
        .readonly()
        .optional(),
    }),
    z.object({
      ok: z.literal(true),
      modelId: z.string(),
      bytes: z.number(),
      // Per-engine conversion outcomes (D54: independent, explicit — a
      // failed format never hides its siblings). Empty for non-ONNX
      // artifacts (mobiledet tflite: conversion does not apply).
      conversions: z
        .array(
          z.object({
            format: z.enum(['openvino', 'coreml']),
            ok: z.boolean(),
            nodeId: z.string().optional(),
            error: z.string().optional(),
          }),
        )
        .readonly(),
    }),
    { kind: 'mutation' },
  ),

  /**
   * Rank nodes for model conversion based on hardware capabilities.
   * CoreML targets require darwin; OpenVINO targets require an OpenVINO-capable node.
   */
  recommendConvertNode: customAction(
    z.object({ targets: z.array(ConvertTargetSchema).min(1).readonly() }),
    z
      .array(z.object({ nodeId: z.string(), reason: z.string(), supported: z.boolean() }))
      .readonly(),
  ),

  /**
   * Convert a source ONNX model to the requested formats on the best-fit node,
   * then register the resulting entry in the custom-model registry (P1) and
   * record format availability (P2).
   */
  convertModel: customAction(
    z.object({
      sourceUrl: z.string(),
      metadata: ModelConvertMetadataSchema,
      targets: z.array(ConvertTargetSchema).min(1).readonly(),
      targetNodeId: z.string().optional(),
      calibrationRef: z.string().optional(),
    }),
    z.object({
      entry: ModelCatalogEntrySchema,
      nodeId: z.string(),
      artifacts: z.array(ConvertArtifactSchema).readonly(),
    }),
    { kind: 'mutation' },
  ),
})

export type ModelStudioActions = typeof modelStudioActions
