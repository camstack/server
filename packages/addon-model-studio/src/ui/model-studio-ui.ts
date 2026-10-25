/**
 * Pure UI helpers + types for the Model Studio page.
 *
 * Kept side-effect free (no React, no tRPC) so they unit-test in isolation —
 * mirrors the benchmark addon's split between pure derivation logic
 * (`runner/stats.ts`) and the React tab components.
 */
import type { z } from 'zod'
import type {
  ConvertTarget,
  CustomModelDescriptor,
  ModelCatalogEntry,
  ModelFormat,
  ModelFormatPrecision,
  ModelOnDiskState,
  ModelProviderId,
  ModelVariantGroup,
  ModelVariantSource,
  RootStepSupply,
} from '@camstack/types'
import { COCO_TO_MACRO, rootSuppliesOf } from '@camstack/types'
import { resolveModelDisplayName } from '../display-name.js'
import type {
  ModelAvailabilityMapSchema,
  ModelNodeAvailabilitySchema,
} from '../model-studio-actions.js'

// ---------------------------------------------------------------------------
// Availability map — `z.infer` of the addon's `ModelAvailabilityMapSchema`
// (`modelId → nodeId → { formats: { [format]: { sha256, bytes, at } } }`).
// ---------------------------------------------------------------------------

export type NodeAvailability = z.infer<typeof ModelNodeAvailabilitySchema>

export type AvailabilityMap = z.infer<typeof ModelAvailabilityMapSchema>

// ---------------------------------------------------------------------------
// Derived row shown in the model list
// ---------------------------------------------------------------------------

export interface ModelNodePresence {
  readonly nodeId: string
  readonly format: ModelFormat
  readonly bytes: number
}

export interface ModelRow {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly stepId: string
  /** Formats packaged in the registry entry (e.g. `['onnx', 'openvino']`). */
  readonly formats: readonly ModelFormat[]
  /** Aggregate size across declared formats, in megabytes. */
  readonly sizeMB: number
  /** Per-node availability recorded by the distribution / conversion path. */
  readonly nodes: readonly ModelNodePresence[]
  /** Steps this root model can supply (D730). Absent ⇒ none. */
  readonly supplies?: readonly RootStepSupply[]
}

/** The root detection step — the only step whose models supply others (D730). */
const ROOT_DETECTION_STEP_ID = 'object-detection'

/**
 * What a registry row's root model supplies (D730): its stored declaration,
 * or — for a row imported before the declaration carried crop kinds — derived
 * from its own labelmap, with the root step's COCO classMap as the fallback
 * the runner uses too. Any other step supplies nothing.
 */
export function rowSupplies(descriptor: CustomModelDescriptor): readonly RootStepSupply[] {
  if (descriptor.stepId !== ROOT_DETECTION_STEP_ID) return []
  return rootSuppliesOf(descriptor.entry, { labels: [], classMap: COCO_TO_MACRO })
}

const ALL_FORMATS: readonly ModelFormat[] = ['onnx', 'coreml', 'openvino', 'tflite', 'pt']

/** Formats declared on a catalog entry, in stable order. */
export function entryFormats(entry: ModelCatalogEntry): readonly ModelFormat[] {
  return ALL_FORMATS.filter((f) => entry.formats[f] !== undefined)
}

/** Total declared size (MB) summed across an entry's formats. */
export function entrySizeMB(entry: ModelCatalogEntry): number {
  return ALL_FORMATS.reduce((sum, f) => sum + (entry.formats[f]?.sizeMB ?? 0), 0)
}

/** Per-node × format presence for a model id, derived from the availability map. */
export function nodePresence(
  availability: AvailabilityMap,
  modelId: string,
): readonly ModelNodePresence[] {
  const perNode = availability[modelId]
  if (perNode === undefined) return []
  const out: ModelNodePresence[] = []
  for (const [nodeId, node] of Object.entries(perNode)) {
    for (const [format, presence] of Object.entries(node.formats)) {
      out.push({
        nodeId,
        format: format as ModelFormat,
        bytes: presence.bytes,
      })
    }
  }
  return out.toSorted(
    (a, b) => a.nodeId.localeCompare(b.nodeId) || a.format.localeCompare(b.format),
  )
}

export interface NodeFormatGroup {
  readonly nodeId: string
  readonly formats: readonly ModelFormat[]
}

/** Group flat presence into `nodeId → formats[]` for Library "On nodes" chips. */
export function formatsByNode(presence: readonly ModelNodePresence[]): readonly NodeFormatGroup[] {
  const map = new Map<string, ModelFormat[]>()
  for (const p of presence) {
    const list = map.get(p.nodeId) ?? []
    if (!list.includes(p.format)) list.push(p.format)
    map.set(p.nodeId, list)
  }
  return [...map.entries()]
    .map(([nodeId, formats]) => ({
      nodeId,
      formats: ALL_FORMATS.filter((f) => formats.includes(f)),
    }))
    .toSorted((a, b) => a.nodeId.localeCompare(b.nodeId))
}

/** Whether `format` is already recorded on `nodeId` for this row. */
export function formatPresentOnNode(
  presence: readonly ModelNodePresence[],
  nodeId: string,
  format: ModelFormat,
): boolean {
  return presence.some((p) => p.nodeId === nodeId && p.format === format)
}

/**
 * Join the registry descriptors with the availability map into the flat row
 * shape the table renders. Pure — the source of the model list (a custom
 * action) and the availability map (another custom action) are fetched by the
 * caller and passed in.
 */
export function toModelRows(
  models: readonly CustomModelDescriptor[],
  availability: AvailabilityMap,
): readonly ModelRow[] {
  return models
    .map((m) => ({
      id: m.entry.id,
      name: resolveModelDisplayName(m.entry),
      description: m.entry.description,
      stepId: m.stepId,
      formats: entryFormats(m.entry),
      sizeMB: entrySizeMB(m.entry),
      nodes: nodePresence(availability, m.entry.id),
      ...suppliesField(rowSupplies(m)),
    }))
    .toSorted((a, b) => a.name.localeCompare(b.name))
}

// ---------------------------------------------------------------------------
// Step options — the real step ids from the pipeline schema
// ---------------------------------------------------------------------------

export interface StepOption {
  readonly id: string
  readonly name: string
  readonly slot: string
}

/**
 * Structural subset of `pipelineExecutor.getSchema()`'s output — only what the
 * step selector needs, so the page can consume the query result without
 * importing the full cap schema.
 */
export interface StepOptionSchemaLike {
  readonly slots: readonly {
    readonly addons: readonly {
      readonly id: string
      readonly name: string
      readonly slot: string
    }[]
  }[]
}

/**
 * Flatten the pipeline schema's slots into a deduped `(id, name, slot)` option
 * list, preserving schema order. This is what replaces the free-text "step id"
 * field: a typo'd step id registered a model into a bucket NOTHING reads
 * (`groupCustomModelsByStep` buckets by exact id), with no error anywhere.
 */
export function stepOptionsFromSchema(schema: StepOptionSchemaLike): readonly StepOption[] {
  const seen = new Set<string>()
  const options: StepOption[] = []
  for (const slot of schema.slots) {
    for (const addon of slot.addons) {
      if (seen.has(addon.id)) continue
      seen.add(addon.id)
      options.push({ id: addon.id, name: addon.name, slot: addon.slot })
    }
  }
  return options
}

// ---------------------------------------------------------------------------
// Catalog seeds — CamStack pipeline offer from `getSchema`
// ---------------------------------------------------------------------------

export interface CatalogSeedFormat {
  readonly format: string
  readonly sizeMB: number
  readonly downloaded: boolean
  /**
   * What the node holds (D746). A runner that predates the field reports only
   * `downloaded`; {@link catalogFormatEntries} folds that into current/missing.
   */
  readonly onDisk: ModelOnDiskState
  /** The build's precision when the node states it (D746). */
  readonly precision?: ModelFormatPrecision
}

/** One format as `getSchema` reports it (`PipelineModelFormatStatus`, all-optional extras). */
export interface SchemaFormatStatus {
  readonly downloaded: boolean
  readonly sizeMB: number
  readonly onDisk?: ModelOnDiskState
  readonly precision?: ModelFormatPrecision
}

export interface CatalogSeed {
  readonly provider: ModelProviderId
  readonly stepId: string
  readonly stepName: string
  readonly modelId: string
  readonly name: string
  readonly formats: readonly CatalogSeedFormat[]
  /** Present when the catalog entry participates in Family→Tier→Variant UI. */
  readonly group?: ModelVariantGroup
  /** What this root model supplies (D730), as the runner computes it. */
  readonly supplies?: readonly RootStepSupply[]
}

/**
 * Structural subset of `pipelineExecutor.getSchema()` for Catalog — includes
 * `group` / `provider` so the tab can regroup like `GroupedModelSelector`.
 */
export interface CatalogSchemaLike {
  readonly slots: readonly {
    readonly addons: readonly {
      readonly id: string
      readonly name: string
      readonly slot?: string
      readonly defaultModelId?: string
      readonly defaultModelIdByFormat?: Readonly<Record<string, string>>
      readonly models: readonly {
        readonly id: string
        readonly name: string
        readonly legacy?: boolean
        readonly provider?: ModelProviderId
        readonly group?: ModelVariantGroup
        readonly formats: Readonly<Record<string, SchemaFormatStatus>>
        readonly suppliesSteps?: readonly RootStepSupply[]
      }[]
    }[]
  }[]
}

/** Per-step catalog slice for Installed "active" (same fields resolveEffectiveStepModel reads). */
export interface StepCatalogSlice {
  readonly id: string
  readonly slot?: string
  readonly defaultModelId: string
  readonly defaultModelIdByFormat?: Readonly<Record<string, string>>
  readonly models: readonly {
    readonly id: string
    readonly formats: Readonly<Record<string, { readonly sizeMB: number }>>
    readonly legacy?: boolean
  }[]
}

/** `stepId → catalog` from `pipelineExecutor.getSchema` for effective-model checks. */
export function stepCatalogsFromSchema(
  schema: CatalogSchemaLike,
): Readonly<Record<string, StepCatalogSlice>> {
  const out: Record<string, StepCatalogSlice> = {}
  for (const slot of schema.slots) {
    for (const addon of slot.addons) {
      if (typeof addon.defaultModelId !== 'string' || addon.defaultModelId.length === 0) continue
      out[addon.id] = {
        id: addon.id,
        ...(addon.slot !== undefined ? { slot: addon.slot } : {}),
        defaultModelId: addon.defaultModelId,
        ...(addon.defaultModelIdByFormat !== undefined
          ? { defaultModelIdByFormat: addon.defaultModelIdByFormat }
          : {}),
        models: addon.models.map((m) => ({
          id: m.id,
          formats: m.formats,
          ...(m.legacy === true ? { legacy: true } : {}),
        })),
      }
    }
  }
  return out
}

function seedFormat(format: string, info: SchemaFormatStatus): CatalogSeedFormat {
  return {
    format,
    sizeMB: info.sizeMB,
    downloaded: info.downloaded,
    onDisk: info.onDisk ?? (info.downloaded ? 'current' : 'missing'),
    ...(info.precision !== undefined ? { precision: info.precision } : {}),
  }
}

function catalogFormatEntries(
  formats: Readonly<Record<string, SchemaFormatStatus>>,
): readonly CatalogSeedFormat[] {
  const known = ALL_FORMATS.flatMap((f) => {
    const info = formats[f]
    return info === undefined ? [] : [seedFormat(f, info)]
  })
  const extras = Object.entries(formats)
    .filter(([format]) => !ALL_FORMATS.includes(format as ModelFormat))
    .map(([format, info]) => seedFormat(format, info))
  return [...known, ...extras]
}

/**
 * Flatten `pipelineExecutor.getSchema` into Catalog seeds.
 *
 * Catalog shows CamStack seeds AND imported plus catalog / plugin catalog / custom
 * entries (so a downloaded plugin catalog model is visible next to plus catalog). Same
 * `family` across providers must NOT merge chips — plugin catalog YOLOv9 used to
 * fold into the CamStack YOLOv9 card while plus catalog's `ssdlite-mobiledet`
 * stayed visible as its own card. Non-camstack groups are namespaced
 * (`<provider>:<family>`) so each provider keeps a separate card; the tab then
 * sections by `provider`.
 */
export function catalogSeedsFromSchema(schema: CatalogSchemaLike): readonly CatalogSeed[] {
  const seeds: CatalogSeed[] = []
  for (const slot of schema.slots) {
    for (const addon of slot.addons) {
      for (const model of addon.models) {
        if (model.legacy === true) continue
        const provider = model.provider ?? 'camstack'
        seeds.push({
          provider,
          stepId: addon.id,
          stepName: addon.name,
          modelId: model.id,
          name: model.name,
          formats: catalogFormatEntries(model.formats),
          group: catalogGroupForProvider(provider, model.group),
          ...suppliesField(model.suppliesSteps),
        })
      }
    }
  }
  return seeds
}

/** `{ supplies }` when there is anything to show, `{}` otherwise. */
export function suppliesField(supplies: readonly RootStepSupply[] | undefined): {
  readonly supplies?: readonly RootStepSupply[]
} {
  return supplies !== undefined && supplies.length > 0 ? { supplies } : {}
}

/**
 * Namespace non-CamStack families so `buildModelVariantGroups` cannot merge
 * them with first-party chips that share the same architecture name.
 */
export function catalogGroupForProvider(
  provider: ModelProviderId,
  group: ModelVariantGroup | undefined,
): ModelVariantGroup | undefined {
  if (group === undefined) return undefined
  if (provider === 'camstack') return group
  return { ...group, family: `${provider}:${group.family}` }
}

const PROVIDER_SECTION_LABEL: Readonly<Record<ModelProviderId, string>> = {
  camstack: 'CamStack',
  scrypted: 'plugin catalog',
  frigate: 'plus catalog',
  custom: 'Custom',
}

const PROVIDER_SECTION_ORDER: readonly ModelProviderId[] = [
  'camstack',
  'scrypted',
  'frigate',
  'custom',
]

/** Card title for a (possibly namespaced) family key. */
export function catalogFamilyCardTitle(familyKey: string, fallback: string): string {
  const m = /^(plugin catalog|plus catalog|custom):(.+)$/i.exec(familyKey)
  if (m === null) return fallback
  const arch = m[2]!
  const archLabel =
    arch === 'yolov9'
      ? 'YOLOv9'
      : arch === 'yolo26'
        ? 'YOLO26'
        : arch === 'ssdlite-mobiledet'
          ? 'SSDLite MobileDet'
          : arch === 'yolonas'
            ? 'YOLO-NAS'
            : arch.toUpperCase()
  return archLabel
}

/** Provider section headers for Catalog, only for providers that have seeds. */
export function catalogProviderSections(
  seeds: readonly CatalogSeed[],
): readonly { provider: ModelProviderId; label: string; seeds: readonly CatalogSeed[] }[] {
  const byProvider = new Map<ModelProviderId, CatalogSeed[]>()
  for (const seed of seeds) {
    const list = byProvider.get(seed.provider) ?? []
    list.push(seed)
    byProvider.set(seed.provider, list)
  }
  const sections: { provider: ModelProviderId; label: string; seeds: readonly CatalogSeed[] }[] = []
  for (const provider of PROVIDER_SECTION_ORDER) {
    const list = byProvider.get(provider)
    if (list === undefined || list.length === 0) continue
    sections.push({ provider, label: PROVIDER_SECTION_LABEL[provider], seeds: list })
  }
  for (const [provider, list] of byProvider) {
    if (PROVIDER_SECTION_ORDER.includes(provider)) continue
    sections.push({
      provider,
      label: PROVIDER_SECTION_LABEL[provider] ?? provider,
      seeds: list,
    })
  }
  return sections
}

export function catalogStepOptions(
  seeds: readonly CatalogSeed[],
): readonly { id: string; name: string }[] {
  const seen = new Set<string>()
  const options: { id: string; name: string }[] = []
  for (const seed of seeds) {
    if (seen.has(seed.stepId)) continue
    seen.add(seed.stepId)
    options.push({ id: seed.stepId, name: seed.stepName })
  }
  return options
}

export function catalogSeedsForStep(
  seeds: readonly CatalogSeed[],
  stepId: string,
): readonly CatalogSeed[] {
  return seeds.filter((s) => s.stepId === stepId)
}

/** Seeds with a `group` axis — input to `buildModelVariantGroups`. */
export function catalogGroupedSeeds(seeds: readonly CatalogSeed[]): readonly CatalogSeed[] {
  return seeds.filter((s) => s.group !== undefined)
}

/** Seeds without a `group` (Coral SSD, custom, …) — flat cards. */
export function catalogUngroupedSeeds(seeds: readonly CatalogSeed[]): readonly CatalogSeed[] {
  return seeds.filter((s) => s.group === undefined)
}

/** Adapt a catalog seed to the shared `GroupedModelSelector` source shape. */
export function catalogSeedAsVariantSource(seed: CatalogSeed): ModelVariantSource {
  const formats: Record<string, { sizeMB: number }> = {}
  for (const fmt of seed.formats) {
    formats[fmt.format] = { sizeMB: fmt.sizeMB }
  }
  return {
    id: seed.modelId,
    name: seed.name,
    group: seed.group,
    formats,
  }
}

// ---------------------------------------------------------------------------
// Convert-target selection → cap `ConvertTarget[]`
// ---------------------------------------------------------------------------

/**
 * The UI offers four independent checkboxes; this is the form state behind
 * them. `recommendConvertNode` / `convertModel` consume the discriminated
 * `ConvertTarget[]` shape, which this builder produces.
 */
export interface TargetSelection {
  readonly openvinoFp16: boolean
  readonly openvinoInt8: boolean
  readonly coreml: boolean
}

export const EMPTY_TARGET_SELECTION: TargetSelection = {
  openvinoFp16: false,
  openvinoInt8: false,
  coreml: false,
}

/**
 * Build the cap's `ConvertTarget[]` from the checkbox selection. OpenVINO is a
 * single target carrying a non-empty `precisions` array (fp16 and/or int8);
 * CoreML is its own target. Returns `[]` when nothing is selected — callers
 * must guard against an empty conversion request.
 */
export function buildConvertTargets(sel: TargetSelection): readonly ConvertTarget[] {
  const targets: ConvertTarget[] = []
  const precisions: ('fp16' | 'int8')[] = []
  if (sel.openvinoFp16) precisions.push('fp16')
  if (sel.openvinoInt8) precisions.push('int8')
  if (precisions.length > 0) {
    targets.push({ format: 'openvino', precisions })
  }
  if (sel.coreml) {
    targets.push({ format: 'coreml' })
  }
  return targets
}

export function hasAnyTarget(sel: TargetSelection): boolean {
  return sel.openvinoFp16 || sel.openvinoInt8 || sel.coreml
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

export function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const exp = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  const value = bytes / 1024 ** exp
  return `${value.toFixed(value >= 100 || exp === 0 ? 0 : 1)} ${units[exp]}`
}

export function formatMB(sizeMB: number): string {
  if (sizeMB <= 0) return '—'
  if (sizeMB >= 1000) return `${(sizeMB / 1000).toFixed(2)} GB`
  return `${sizeMB.toFixed(sizeMB >= 100 ? 0 : 1)} MB`
}

// ---------------------------------------------------------------------------
// Conversion progress / state — driven by the `model-convert.progress` event
// ---------------------------------------------------------------------------

export type ConvertState = 'idle' | 'running' | 'success' | 'error'

export interface ConvertProgressView {
  readonly phase: string
  readonly pct?: number
  readonly detail?: string
}

export interface ConvertOutcome {
  readonly nodeId: string
  readonly modelId: string
  readonly artifacts: readonly { readonly format: ModelFormat; readonly sizeMB: number }[]
}
