/**
 * Typed bridge between the Model Studio page and the addon's backend caps.
 *
 * Registry maintenance (register / remove / list), distribution, conversion,
 * and node recommendation are exposed as `customActions` (see
 * `model-studio-actions.ts`) and dispatched through
 * `trpc.addons.custom.mutate({ addonId: 'model-studio', action, input })` —
 * the same channel the benchmark page uses for its own actions.
 *
 * Live conversion progress arrives over `trpc.live.onEvent` on the
 * `model-convert.progress` category, mirroring how the benchmark Pipeline tab
 * subscribes to `pipeline.trace`.
 */
import type { AddonPageProps } from '@camstack/ui-library'
import { z } from 'zod'
import type {
  ConvertArtifact,
  ConvertTarget,
  CustomModelDescriptor,
  ModelCatalogEntry,
  ModelConvertMetadata,
  ModelFormat,
  NodeInferenceDevice,
  PipelineAddonSchema,
  PipelineSchema,
} from '@camstack/types'
import {
  ConvertArtifactSchema,
  CustomModelDescriptorSchema,
  ModelCatalogEntrySchema,
  pickClusterStepModels,
  pipelineExecutorCapability,
  type ClusterStepModels,
  type HydratedClusterView,
} from '@camstack/types'
import { normalizePluginCatalogDrift } from '../plugin-catalog/plugin-catalog-tree-drift.js'
import {
  PlusCatalogCatalogEntrySchema,
  PlusCatalogModelSchema,
  ModelNodeAvailabilitySchema,
  PluginCatalogManifestEntrySchema,
} from '../model-studio-actions.js'
import type {
  AvailabilityMap,
  CatalogSchemaLike,
  CatalogSeed,
  NodeAvailability,
  StepCatalogSlice,
  StepOption,
  StepOptionSchemaLike,
} from './model-studio-ui.js'
import {
  catalogSeedsFromSchema,
  stepCatalogsFromSchema,
  stepOptionsFromSchema,
} from './model-studio-ui.js'

const ADDON_ID = 'model-studio'

type Trpc = AddonPageProps['trpc']

interface CustomActionCaller {
  mutate(input: { addonId: string; action: string; input: unknown }): Promise<unknown>
}

/**
 * The tRPC surfaces this page talks to, narrowed by `requireTrpcMember` (no
 * cast): each call site checks the one member it calls and gets this typed
 * surface back. tRPC proxies are callable at every level — see
 * `hasCallableMember` for why the check walks `typeof 'function'` levels.
 */
interface AddonSettingsUpdateCaller {
  mutate(input: { addonId: string; patch: Record<string, unknown> }): Promise<unknown>
}

interface AddonSettingsGetCaller {
  query(input: { addonId: string }): Promise<unknown>
}

interface PipelineDownloadCaller {
  mutate(input: {
    addonId: string
    modelId: string
    format: ModelFormat
    nodeId?: string
  }): Promise<unknown>
}

interface LoadedEnginesCaller {
  query(input: { nodeId: string }): Promise<unknown>
}

interface PipelineOrchestratorSurface {
  getNodeInferenceDevices: {
    query(input: { nodeId: string }): Promise<unknown>
  }
  setAgentInferenceDevices: {
    mutate(input: {
      agentNodeId: string
      inferenceDevices: Record<
        string,
        {
          enabled: boolean
          weight: number
          maxSessions?: number
          steps?: Record<string, { modelId?: string; settings?: Record<string, unknown> }>
        }
      >
    }): Promise<unknown>
  }
}

interface StructuralTrpcSurface {
  addons: { custom: CustomActionCaller }
  addonSettings: {
    updateGlobalSettings: AddonSettingsUpdateCaller
    getGlobalSettings: AddonSettingsGetCaller
  }
  pipelineExecutor: {
    getSchema: PipelineSchemaCaller
    downloadModel: PipelineDownloadCaller
    listLoadedEngines: LoadedEnginesCaller
  }
  pipelineOrchestrator: PipelineOrchestratorSurface
  live: { onEvent: LiveOnEvent }
}

/**
 * Every member of the host's client this page calls — the page's half of the
 * `AddonPageProps.trpc` contract (a `TRPCClient<AppRouter>`). Each call site
 * names the one member it uses, so a client without it fails with that name.
 */
export const MODEL_STUDIO_TRPC_CONTRACT = [
  'addons.custom.mutate',
  'addonSettings.updateGlobalSettings.mutate',
  'addonSettings.getGlobalSettings.query',
  'pipelineExecutor.getSchema.query',
  'pipelineExecutor.downloadModel.mutate',
  'pipelineExecutor.listLoadedEngines.query',
  'pipelineOrchestrator.getNodeInferenceDevices.query',
  'pipelineOrchestrator.setAgentInferenceDevices.mutate',
  'live.onEvent.subscribe',
] as const

export type ModelStudioTrpcMember = (typeof MODEL_STUDIO_TRPC_CONTRACT)[number]

/**
 * A tRPC client is a tree of Proxies over FUNCTION targets: every level is
 * `typeof 'function'` and an `in` check is always false. A level is therefore
 * "present" when it is an object or a function, and the leaf when it is
 * callable — which holds for the real client and for a plain-object fake.
 */
function isTraversable(value: unknown): value is object {
  return (typeof value === 'object' && value !== null) || typeof value === 'function'
}

function hasCallableMember(
  trpc: unknown,
  member: ModelStudioTrpcMember,
): trpc is Trpc & StructuralTrpcSurface {
  let node: unknown = trpc
  for (const segment of member.split('.')) {
    if (!isTraversable(node)) return false
    node = Reflect.get(node, segment)
  }
  return typeof node === 'function'
}

/** The client, once it is known to carry `member`; otherwise an error naming it. */
export function requireTrpcMember(
  trpc: unknown,
  member: ModelStudioTrpcMember,
): StructuralTrpcSurface {
  if (!hasCallableMember(trpc, member)) {
    throw new Error(
      `model-studio page: the tRPC client from the host has no callable ${member} ` +
        '(AddonPageProps.trpc must be a TRPCClient<AppRouter>)',
    )
  }
  return trpc
}

function customCaller(trpc: Trpc): CustomActionCaller {
  return requireTrpcMember(trpc, 'addons.custom.mutate').addons.custom
}

async function callAction(trpc: Trpc, action: string, input: unknown): Promise<unknown> {
  return customCaller(trpc).mutate({ addonId: ADDON_ID, action, input })
}

// ---------------------------------------------------------------------------
// Result narrowing — custom-action outputs arrive as `unknown` over the proxy.
//
// Every response is parsed against the SAME zod schema the addon action
// declares its output with (`model-studio-actions.ts`) — no field is trusted
// on the strength of a TypeScript annotation alone. Two failure shapes:
//
//  - a LIST degrades per row: a malformed row is dropped and logged, the rest
//    of the list survives (`parseListDegrading`).
//  - a single object throws a readable error naming the field that failed
//    (`parseObjectOrThrow`), so a caller can surface WHY instead of a generic
//    "unexpected response shape".
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Parse each item of `items` against `schema`; a row that fails is dropped
 * and logged (never silently, never failing the whole list) — see D8-style
 * repo rule: a branch that drops work stays silent only at the cost of the
 * next 3-hour debugging session.
 */
function parseListDegrading<T>(
  schema: z.ZodType<T>,
  items: readonly unknown[],
  context: string,
): readonly T[] {
  const out: T[] = []
  for (const [index, item] of items.entries()) {
    const parsed = schema.safeParse(item)
    if (parsed.success) {
      out.push(parsed.data)
    } else {
      console.warn(
        `[model-studio] ${context}: dropping row ${index} — ${parsed.error.issues
          .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
          .join('; ')}`,
        item,
      )
    }
  }
  return out
}

/** Parse a single object; throws a readable, field-naming error on failure. */
function parseObjectOrThrow<T>(schema: z.ZodType<T>, value: unknown, context: string): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ')
    throw new Error(`${context}: ${detail}`)
  }
  return parsed.data
}

function asModelList(value: unknown): readonly CustomModelDescriptor[] {
  if (!Array.isArray(value)) return []
  return parseListDegrading(CustomModelDescriptorSchema, value, 'listCustomModels')
}

/**
 * `modelId → nodeId → availability`. Degrades one level deeper than
 * `parseListDegrading` — a malformed per-node entry is dropped without
 * discarding the rest of that model's nodes, or the rest of the map.
 */
function asAvailabilityMap(value: unknown): AvailabilityMap {
  if (!isRecord(value)) return {}
  const out: Record<string, Record<string, NodeAvailability>> = {}
  for (const [modelId, perNode] of Object.entries(value)) {
    if (!isRecord(perNode)) {
      console.warn(
        `[model-studio] listAvailability: dropping "${modelId}" — not an object`,
        perNode,
      )
      continue
    }
    const nodes: Record<string, NodeAvailability> = {}
    for (const [nodeId, entry] of Object.entries(perNode)) {
      const parsed = ModelNodeAvailabilitySchema.safeParse(entry)
      if (parsed.success) {
        nodes[nodeId] = parsed.data
      } else {
        console.warn(
          `[model-studio] listAvailability: dropping ${modelId}/${nodeId} — ${parsed.error.issues
            .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
            .join('; ')}`,
        )
      }
    }
    out[modelId] = nodes
  }
  return out
}

// ---------------------------------------------------------------------------
// Action wrappers
// ---------------------------------------------------------------------------

export async function listCustomModels(trpc: Trpc): Promise<readonly CustomModelDescriptor[]> {
  return asModelList(await callAction(trpc, 'listCustomModels', undefined))
}

export async function listAvailability(trpc: Trpc): Promise<AvailabilityMap> {
  return asAvailabilityMap(await callAction(trpc, 'listAvailability', undefined))
}

export interface PlusConversionOutcomeView {
  readonly format: 'openvino' | 'coreml'
  readonly ok: boolean
  readonly nodeId?: string
  readonly error?: string
}

function parseConversionOutcomes(raw: unknown): PlusConversionOutcomeView[] {
  if (!Array.isArray(raw)) return []
  return raw.filter(isRecord).flatMap((c) => {
    const format = c.format === 'openvino' || c.format === 'coreml' ? c.format : null
    if (format === null) return []
    return [
      {
        format,
        ok: c.ok === true,
        ...(typeof c.nodeId === 'string' ? { nodeId: c.nodeId } : {}),
        ...(typeof c.error === 'string' ? { error: c.error } : {}),
      },
    ]
  })
}

export interface RegisterModelInput {
  readonly stepId: string
  readonly entry: ModelCatalogEntry
}

export interface RegisterCustomModelResult {
  readonly conversions: readonly PlusConversionOutcomeView[]
}

export async function registerCustomModel(
  trpc: Trpc,
  input: RegisterModelInput,
): Promise<RegisterCustomModelResult> {
  const raw = await callAction(trpc, 'registerCustomModel', input)
  if (!isRecord(raw)) return { conversions: [] }
  return { conversions: parseConversionOutcomes(raw.conversions) }
}

export async function removeCustomModel(trpc: Trpc, modelId: string): Promise<void> {
  await callAction(trpc, 'removeCustomModel', { modelId })
}

/** Rename an imported model in place; an empty name restores its imported name. */
export async function renameCustomModel(
  trpc: Trpc,
  input: { modelId: string; name: string },
): Promise<{ modelId: string; name: string }> {
  const raw = await callAction(trpc, 'renameCustomModel', input)
  if (!isRecord(raw)) throw new Error('renameCustomModel: unexpected response shape')
  return {
    modelId: expectString(raw, 'modelId'),
    name: expectString(raw, 'name'),
  }
}

export async function removeModelFromNode(
  trpc: Trpc,
  input: { modelId: string; nodeId: string; format: ModelFormat },
): Promise<void> {
  await callAction(trpc, 'removeModelFromNode', input)
}

export interface EnsureDistributeResult {
  readonly conversions: readonly PlusConversionOutcomeView[]
  readonly distributed: readonly {
    readonly nodeId: string
    readonly format: string
    readonly ok: boolean
    readonly error?: string
    readonly bytes?: number
  }[]
}

export async function ensureFormatsThenDistribute(
  trpc: Trpc,
  modelId: string,
): Promise<EnsureDistributeResult> {
  const raw = await callAction(trpc, 'ensureFormatsThenDistribute', { modelId })
  if (!isRecord(raw)) return { conversions: [], distributed: [] }
  const distributed = Array.isArray(raw.distributed)
    ? raw.distributed.filter(isRecord).map((d) => ({
        nodeId: typeof d.nodeId === 'string' ? d.nodeId : '',
        format: typeof d.format === 'string' ? d.format : '',
        ok: d.ok === true,
        ...(typeof d.error === 'string' ? { error: d.error } : {}),
        ...(typeof d.bytes === 'number' ? { bytes: d.bytes } : {}),
      }))
    : []
  return { conversions: parseConversionOutcomes(raw.conversions), distributed }
}

export async function ensureModelFormats(
  trpc: Trpc,
  modelId: string,
  formats: readonly ('openvino' | 'coreml')[],
): Promise<{ conversions: readonly PlusConversionOutcomeView[] }> {
  const raw = await callAction(trpc, 'ensureModelFormats', { modelId, formats })
  if (!isRecord(raw)) return { conversions: [] }
  return { conversions: parseConversionOutcomes(raw.conversions) }
}

export interface NodeRecommendationView {
  readonly nodeId: string
  readonly reason: string
  readonly supported: boolean
}

export async function recommendConvertNode(
  trpc: Trpc,
  targets: readonly ConvertTarget[],
): Promise<readonly NodeRecommendationView[]> {
  const raw = await callAction(trpc, 'recommendConvertNode', { targets })
  if (!Array.isArray(raw)) return []
  return raw.filter(isRecord).map((r) => ({
    nodeId: typeof r.nodeId === 'string' ? r.nodeId : '',
    reason: typeof r.reason === 'string' ? r.reason : '',
    supported: r.supported === true,
  }))
}

export interface ConvertModelInput {
  readonly sourceUrl: string
  readonly metadata: ModelConvertMetadata
  readonly targets: readonly ConvertTarget[]
  readonly targetNodeId?: string
}

export interface ConvertModelResult {
  readonly entry: ModelCatalogEntry
  readonly nodeId: string
  readonly artifacts: readonly ConvertArtifact[]
}

export async function convertModel(
  trpc: Trpc,
  input: ConvertModelInput,
): Promise<ConvertModelResult> {
  const raw = await callAction(trpc, 'convertModel', input)
  if (!isRecord(raw) || typeof raw.nodeId !== 'string') {
    throw new Error('convertModel: unexpected response shape')
  }
  const entry = parseObjectOrThrow(ModelCatalogEntrySchema, raw.entry, 'convertModel.entry')
  const artifacts = Array.isArray(raw.artifacts)
    ? parseListDegrading(ConvertArtifactSchema, raw.artifacts, 'convertModel.artifacts')
    : []
  return {
    entry,
    nodeId: raw.nodeId,
    artifacts,
  }
}

// ---------------------------------------------------------------------------
// Step options — real step ids from the pipeline schema
// ---------------------------------------------------------------------------

interface PipelineSchemaCaller {
  query(input?: { nodeId?: string }): Promise<unknown>
}

function pipelineSchemaCaller(trpc: Trpc): PipelineSchemaCaller {
  return requireTrpcMember(trpc, 'pipelineExecutor.getSchema.query').pipelineExecutor.getSchema
}

function isStepOptionSchema(value: unknown): value is StepOptionSchemaLike {
  return isRecord(value) && Array.isArray(value.slots)
}

/**
 * The real pipeline step ids, from `pipelineExecutor.getSchema`. Replaces the
 * free-text "step id" field — a typo'd id registered a model into a bucket no
 * step ever reads, with no error anywhere. Throws when the schema is
 * unavailable so the UI can show WHY the selector is empty instead of
 * silently offering nothing.
 */
export async function listStepOptions(trpc: Trpc): Promise<readonly StepOption[]> {
  const raw = await pipelineSchemaCaller(trpc).query()
  if (!isStepOptionSchema(raw)) {
    throw new Error('pipeline schema unavailable — cannot enumerate step ids')
  }
  return stepOptionsFromSchema(raw)
}

function isCatalogSchema(value: unknown): value is CatalogSchemaLike {
  return isRecord(value) && Array.isArray(value.slots)
}

/**
 * CamStack seeds for Catalog, scoped to a node so `downloaded` is that
 * node's disk, not the hub's. Same `getSchema` the pipeline pickers use.
 */
export async function listPipelineCatalog(
  trpc: Trpc,
  nodeId?: string,
): Promise<readonly CatalogSeed[]> {
  const bundle = await listPipelineCatalogBundle(trpc, nodeId)
  return bundle.seeds
}

/** Seeds + per-step catalogs from one getSchema (Installed active resolution). */
export async function listPipelineCatalogBundle(
  trpc: Trpc,
  nodeId?: string,
): Promise<{
  readonly seeds: readonly CatalogSeed[]
  readonly stepCatalogs: Readonly<Record<string, StepCatalogSlice>>
}> {
  const raw = await pipelineSchemaCaller(trpc).query(nodeId !== undefined ? { nodeId } : undefined)
  if (!isCatalogSchema(raw)) {
    throw new Error('pipeline schema unavailable — cannot list CamStack seeds')
  }
  return {
    seeds: catalogSeedsFromSchema(raw),
    stepCatalogs: stepCatalogsFromSchema(raw),
  }
}

export async function downloadPipelineModel(
  trpc: Trpc,
  input: { addonId: string; modelId: string; format: ModelFormat; nodeId: string },
): Promise<void> {
  await requireTrpcMember(
    trpc,
    'pipelineExecutor.downloadModel.mutate',
  ).pipelineExecutor.downloadModel.mutate(input)
}

/** Wipe one CamStack seed format from a node's modelsDir (Installed Remove).
 *  Goes through model-studio `deleteSeedFromNode` so the call is `nodePin`'d —
 *  a bare `pipelineExecutor.deleteModel.mutate` always hit the hub. */
export async function deletePipelineModel(
  trpc: Trpc,
  input: { addonId: string; modelId: string; format: ModelFormat; nodeId: string },
): Promise<void> {
  const raw = await callAction(trpc, 'deleteSeedFromNode', input)
  if (!isRecord(raw) || raw.success !== true) {
    throw new Error('deleteSeedFromNode: unexpected response')
  }
}

// ---------------------------------------------------------------------------
// Distribution
// ---------------------------------------------------------------------------

export interface DistributeModelResult {
  readonly ok: boolean
  readonly sha256: string
  readonly bytes: number
}

export async function distributeModel(
  trpc: Trpc,
  input: { modelId: string; nodeId: string; format: ModelFormat },
): Promise<DistributeModelResult> {
  const raw = await callAction(trpc, 'distributeModel', input)
  if (!isRecord(raw)) throw new Error('distributeModel: unexpected response shape')
  return {
    ok: raw.ok === true,
    sha256: typeof raw.sha256 === 'string' ? raw.sha256 : '',
    bytes: typeof raw.bytes === 'number' ? raw.bytes : 0,
  }
}

// ---------------------------------------------------------------------------
// Chunked model-file upload (plus catalog import)
// ---------------------------------------------------------------------------

/** 512 KiB raw per chunk → ~683 KiB base64, safely under the hub's ~1 MB body limit. */
const UPLOAD_CHUNK_BYTES = 512 * 1024

export interface UploadedModelFile {
  readonly filename: string
  readonly bytes: number
  readonly sha256: string
}

function expectString(value: Record<string, unknown>, key: string): string {
  const v = value[key]
  if (typeof v !== 'string') throw new Error(`upload: missing "${key}" in response`)
  return v
}

/**
 * Drive the begin → append× → commit upload protocol for a browser `File`.
 * `onProgress` receives uploaded/total bytes. Aborts the staged upload on any
 * chunk failure so a retry starts clean.
 */
export async function uploadModelFile(
  trpc: Trpc,
  file: { name: string; size: number; arrayBuffer(): Promise<ArrayBuffer> },
  onProgress?: (uploaded: number, total: number) => void,
): Promise<UploadedModelFile> {
  const beginRaw = await callAction(trpc, 'beginModelUpload', {
    filename: file.name,
    totalBytes: file.size,
  })
  if (!isRecord(beginRaw)) throw new Error('beginModelUpload: unexpected response shape')
  const uploadId = expectString(beginRaw, 'uploadId')

  try {
    const bytes = new Uint8Array(await file.arrayBuffer())
    for (let offset = 0; offset < bytes.length; offset += UPLOAD_CHUNK_BYTES) {
      const chunk = bytes.subarray(offset, offset + UPLOAD_CHUNK_BYTES)
      await callAction(trpc, 'appendModelUpload', {
        uploadId,
        chunkBase64: base64FromBytes(chunk),
      })
      onProgress?.(Math.min(offset + UPLOAD_CHUNK_BYTES, bytes.length), bytes.length)
    }
    const commitRaw = await callAction(trpc, 'commitModelUpload', { uploadId })
    if (!isRecord(commitRaw)) throw new Error('commitModelUpload: unexpected response shape')
    return {
      filename: expectString(commitRaw, 'filename'),
      bytes: typeof commitRaw.bytes === 'number' ? commitRaw.bytes : file.size,
      sha256: expectString(commitRaw, 'sha256'),
    }
  } catch (err) {
    // Best-effort staging cleanup; the original failure is what the caller sees.
    await callAction(trpc, 'abortModelUpload', { uploadId }).catch(() => undefined)
    throw err
  }
}

/** Browser-safe chunked base64 encoder (avoids call-stack limits of one big apply). */
function base64FromBytes(bytes: Uint8Array): string {
  let binary = ''
  const step = 0x8000
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step))
  }
  return btoa(binary)
}

// ---------------------------------------------------------------------------
// Live conversion-progress subscription (model-convert.progress)
// ---------------------------------------------------------------------------

export interface LiveSubscription {
  unsubscribe(): void
}

interface LiveOnEvent {
  subscribe(
    input: { category: string },
    opts: { onData: (event: Record<string, unknown>) => void; onError?: (err: unknown) => void },
  ): LiveSubscription
}

function liveOnEvent(trpc: Trpc): LiveOnEvent {
  return requireTrpcMember(trpc, 'live.onEvent.subscribe').live.onEvent
}

export interface ConvertProgressEvent {
  readonly phase: string
  readonly pct?: number
  readonly detail?: string
  readonly log?: string
  readonly sessionId?: string
}

/**
 * Subscribe to `model-convert.progress` events. Each event payload carries the
 * `{ phase, pct, detail, log, sessionId }` block the addon emits from its convert
 * provider. Returns null if the live channel is unavailable.
 *
 * NOTE: must NOT use optional chaining on `.subscribe()` — Vite compiles it
 * into `.call()` which breaks the tRPC proxy's internal `this` binding (same
 * caveat the benchmark page documents).
 */
export function subscribeConvertProgress(
  trpc: Trpc,
  onProgress: (event: ConvertProgressEvent) => void,
  onError?: (err: unknown) => void,
): LiveSubscription | null {
  const onEvent = liveOnEvent(trpc)
  try {
    return onEvent.subscribe(
      { category: 'model-convert.progress' },
      {
        onData: (rawEvent) => {
          const data = isRecord(rawEvent.data) ? rawEvent.data : undefined
          if (data === undefined) return
          onProgress({
            phase: typeof data.phase === 'string' ? data.phase : 'working',
            pct: typeof data.pct === 'number' ? data.pct : undefined,
            detail: typeof data.detail === 'string' ? data.detail : undefined,
            log: typeof data.log === 'string' ? data.log : undefined,
            sessionId: typeof data.sessionId === 'string' ? data.sessionId : undefined,
          })
        },
        onError,
      },
    )
  } catch (err) {
    onError?.(err)
    return null
  }
}

// ---------------------------------------------------------------------------
// plus catalog public catalog + plus catalog personal models (D214 addendum)
// ---------------------------------------------------------------------------

export type PlusCatalogCatalogView = z.infer<typeof PlusCatalogCatalogEntrySchema>

export async function listPlusCatalogCatalog(
  trpc: Trpc,
): Promise<readonly PlusCatalogCatalogView[]> {
  const raw = await callAction(trpc, 'listPlusCatalogCatalog', undefined)
  if (!Array.isArray(raw)) return []
  return parseListDegrading(PlusCatalogCatalogEntrySchema, raw, 'listPlusCatalogCatalog')
}

export interface ImportedModelResult {
  readonly modelId: string
  readonly bytes: number
}

export async function importPlusCatalogCatalogModel(
  trpc: Trpc,
  input: { catalogId: string; modelId?: string; name?: string; targetNodeId?: string },
): Promise<ImportedModelResult> {
  const raw = await callAction(trpc, 'importPlusCatalogCatalogModel', input)
  if (!isRecord(raw)) throw new Error('importPlusCatalogCatalogModel: unexpected response shape')
  return {
    modelId: expectString(raw, 'modelId'),
    bytes: typeof raw.bytes === 'number' ? raw.bytes : 0,
  }
}

export interface PlusCatalogStatusView {
  readonly configured: boolean
  readonly keyFormatValid: boolean
}

export async function plusCatalogPlusStatus(trpc: Trpc): Promise<PlusCatalogStatusView> {
  const raw = await callAction(trpc, 'plusCatalogPlusStatus', undefined)
  if (!isRecord(raw)) return { configured: false, keyFormatValid: false }
  return { configured: raw.configured === true, keyFormatValid: raw.keyFormatValid === true }
}

export async function plusCatalogPlusTest(
  trpc: Trpc,
): Promise<{ readonly ok: boolean; readonly error?: string }> {
  const raw = await callAction(trpc, 'plusCatalogPlusTest', undefined)
  if (!isRecord(raw)) return { ok: false, error: 'unexpected response' }
  return {
    ok: raw.ok === true,
    ...(typeof raw.error === 'string' ? { error: raw.error } : {}),
  }
}

/** The Base/Custom discriminator (`isBaseModel`) is the split plus catalog's own
 *  UI renders on; `verifiedImages` is normalised from all three API shapes. */
export type PlusCatalogModelView = z.infer<typeof PlusCatalogModelSchema>

export async function plusCatalogPlusListModels(
  trpc: Trpc,
): Promise<readonly PlusCatalogModelView[]> {
  const raw = await callAction(trpc, 'plusCatalogPlusListModels', undefined)
  if (!Array.isArray(raw)) return []
  return parseListDegrading(PlusCatalogModelSchema, raw, 'plusCatalogPlusListModels')
}

export interface PlusImportResult extends ImportedModelResult {
  /** Per-engine conversion outcomes (empty for non-ONNX artifacts). */
  readonly conversions: readonly PlusConversionOutcomeView[]
}

export async function importPlusCatalogModel(
  trpc: Trpc,
  input: {
    plusModelId: string
    modelId?: string
    name?: string
    format?: 'onnx' | 'tflite'
    ensureFormats?: readonly ('openvino' | 'coreml')[]
  },
): Promise<PlusImportResult> {
  const raw = await callAction(trpc, 'importPlusCatalogModel', input)
  if (!isRecord(raw)) throw new Error('importPlusCatalogModel: unexpected response shape')
  return {
    modelId: expectString(raw, 'modelId'),
    bytes: typeof raw.bytes === 'number' ? raw.bytes : 0,
    conversions: parseConversionOutcomes(raw.conversions),
  }
}

export { plusCatalogPlusRegistryId } from '../model-studio-actions.js'

/**
 * Save the plus catalog API key INLINE from the Register form — through the SAME
 * authority the addon Settings panel writes (D62: one authority):
 * `addonSettings.updateGlobalSettings` on addonId `model-studio`, key
 * `plusCatalogPlusApiKey`. Write-only: nothing here ever reads the key back.
 */
export async function savePlusCatalogApiKey(trpc: Trpc, apiKey: string): Promise<void> {
  await requireTrpcMember(
    trpc,
    'addonSettings.updateGlobalSettings.mutate',
  ).addonSettings.updateGlobalSettings.mutate({
    addonId: ADDON_ID,
    patch: { plusCatalogPlusApiKey: apiKey },
  })
}

// ---------------------------------------------------------------------------
// Installed → Activate on inference devices (same store as Pipeline matrix)
// ---------------------------------------------------------------------------

function isNodeInferenceDevicesPayload(
  value: unknown,
): value is { devices: readonly NodeInferenceDevice[] } {
  return isRecord(value) && Array.isArray(value.devices)
}

export async function listNodeInferenceDevices(
  trpc: Trpc,
  nodeId: string,
): Promise<readonly NodeInferenceDevice[]> {
  const raw = await requireTrpcMember(
    trpc,
    'pipelineOrchestrator.getNodeInferenceDevices.query',
  ).pipelineOrchestrator.getNodeInferenceDevices.query({
    nodeId,
  })
  if (!isNodeInferenceDevicesPayload(raw)) return []
  return raw.devices
}

/** One resident pool of a node, as `pipelineExecutor.listLoadedEngines` reports it. */
export type LoadedEngine = z.infer<
  typeof pipelineExecutorCapability.methods.listLoadedEngines.output
>[number]

/**
 * The pools resident on `nodeId` and the models each holds — what "in use"
 * means on the Installed tab. Parsed against the cap's own output schema;
 * throws a field-naming error so the caller can show the load state as
 * UNKNOWN instead of "not loaded".
 */
export async function listLoadedEngines(
  trpc: Trpc,
  nodeId: string,
): Promise<readonly LoadedEngine[]> {
  const raw = await requireTrpcMember(
    trpc,
    'pipelineExecutor.listLoadedEngines.query',
  ).pipelineExecutor.listLoadedEngines.query({ nodeId })
  return parseObjectOrThrow(
    pipelineExecutorCapability.methods.listLoadedEngines.output,
    raw,
    'listLoadedEngines',
  )
}

export async function setAgentInferenceDevices(
  trpc: Trpc,
  input: {
    agentNodeId: string
    inferenceDevices: Record<
      string,
      {
        enabled: boolean
        weight: number
        maxSessions?: number
        steps?: Record<string, { modelId?: string; settings?: Record<string, unknown> }>
      }
    >
  },
): Promise<void> {
  await requireTrpcMember(
    trpc,
    'pipelineOrchestrator.setAgentInferenceDevices.mutate',
  ).pipelineOrchestrator.setAgentInferenceDevices.mutate(input)
}

export async function listClusterStepModels(trpc: Trpc): Promise<ClusterStepModels> {
  const raw = await requireTrpcMember(
    trpc,
    'addonSettings.getGlobalSettings.query',
  ).addonSettings.getGlobalSettings.query({
    addonId: 'pipeline-orchestrator',
  })
  return pickClusterStepModels(raw as HydratedClusterView | null)
}

export async function setClusterStepModel(
  trpc: Trpc,
  patch: Record<string, string>,
): Promise<void> {
  await requireTrpcMember(
    trpc,
    'addonSettings.updateGlobalSettings.mutate',
  ).addonSettings.updateGlobalSettings.mutate({
    addonId: 'pipeline-orchestrator',
    patch,
  })
}

function isPipelineSchema(value: unknown): value is PipelineSchema {
  return isRecord(value) && Array.isArray(value.slots)
}

/** Full pipeline step addon (models + configSchema) for AgentStepEditor. */
export async function listPipelineAddon(
  trpc: Trpc,
  stepId: string,
  nodeId?: string,
): Promise<PipelineAddonSchema | null> {
  const raw = await pipelineSchemaCaller(trpc).query(nodeId !== undefined ? { nodeId } : undefined)
  if (!isPipelineSchema(raw)) return null
  for (const slot of raw.slots) {
    for (const addon of slot.addons) {
      if (addon.id === stepId) return addon
    }
  }
  return null
}

/** Nodes able to LOAD tflite (Coral EdgeTPU delegate) — the UI gates tflite
 *  imports on this instead of offering a button that fails at load time. */
export async function tfliteSupportNodes(trpc: Trpc): Promise<readonly string[]> {
  const raw = await callAction(trpc, 'tfliteSupport', {})
  if (!isRecord(raw) || !Array.isArray(raw.nodes)) return []
  return raw.nodes.filter((n): n is string => typeof n === 'string')
}

// ---------------------------------------------------------------------------
// plugin catalog local YOLO catalog (Task 7B) — listing + import by manifesto id
// ---------------------------------------------------------------------------

export type PluginCatalogCatalogEntryView = z.infer<typeof PluginCatalogManifestEntrySchema>

export interface PluginCatalogCatalogDriftView {
  readonly manifestId: string
  readonly status: 'ok' | 'missing' | 'size-changed' | 'unavailable'
  readonly details?: string
}

export async function listPluginCatalogCatalog(trpc: Trpc): Promise<{
  readonly entries: readonly PluginCatalogCatalogEntryView[]
  readonly drift: readonly PluginCatalogCatalogDriftView[]
}> {
  const raw = await callAction(trpc, 'listPluginCatalogCatalog', undefined)
  if (!isRecord(raw) || !Array.isArray(raw.entries) || !Array.isArray(raw.drift)) {
    return { entries: [], drift: [] }
  }
  return {
    entries: parseListDegrading(
      PluginCatalogManifestEntrySchema,
      raw.entries,
      'listPluginCatalogCatalog.entries',
    ),
    drift: raw.drift.filter(isRecord).map((row) => {
      const normalized = normalizePluginCatalogDrift({
        manifestId: typeof row.manifestId === 'string' ? row.manifestId : '',
        status: typeof row.status === 'string' ? row.status : '',
        ...(typeof row.details === 'string' ? { details: row.details } : {}),
      })
      return {
        manifestId: normalized.manifestId,
        status: normalized.status,
        ...(normalized.details !== undefined ? { details: normalized.details } : {}),
      }
    }),
  }
}

export async function importPluginCatalogCatalogModel(
  trpc: Trpc,
  input: { manifestId: string; name?: string; targetNodeId?: string },
): Promise<CustomModelDescriptor> {
  const raw = await callAction(trpc, 'importPluginCatalogCatalogModel', {
    manifestId: input.manifestId,
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.targetNodeId !== undefined ? { targetNodeId: input.targetNodeId } : {}),
  })
  return parseObjectOrThrow(CustomModelDescriptorSchema, raw, 'importPluginCatalogCatalogModel')
}
