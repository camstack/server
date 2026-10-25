/**
 * plus catalog API client — the REAL api.frigate.video contract, verified against
 * plus-catalog/plus.py (dev branch, 2026-08-21):
 *
 *  - key format: `[uuid]:[40 hex]` (plus catalog validates
 *    `[a-z0-9]{8}-…-[a-z0-9]{12}:[a-z0-9]{40}`)
 *  - GET /v1/auth/token with HTTP basic auth (key split on `:`) →
 *    `{ accessToken, expires }`
 *  - GET /v1/model/list with `Authorization: Bearer <accessToken>` → model list
 *  - GET /v1/model/{id} → model info (`type`, `width`, `height`, `labelMap`,
 *    `supportedDetectors`, …)
 *  - GET /v1/model/{id}/signed_url → `{ url }` (presigned, plain GET)
 *
 * SECURITY: everything here runs SERVER-SIDE on the hub. The key comes from
 * the addon's settings store, is sent only to api.frigate.video, and is never
 * logged, never echoed in errors, never shipped to the browser. The fetch
 * function is injected so the contract is unit-testable offline.
 */
import {
  plusCatalogDefaultClassFloors,
  plusCatalogLabelFields,
  type CustomModelDescriptor,
  type ModelCatalogEntry,
  type ModelFormat,
  type PostprocessorType,
} from '@camstack/types'
import { plusCatalogVariantGroup } from './plus-catalog-import.js'
import { resolvePlusDecode } from './plus-decode.js'

export const PLUS_API_HOST = 'https://api.frigate.video'

const PLUS_KEY_RE = /^[a-z0-9]{8}-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{12}:[a-z0-9]{40}$/

export function isValidPlusApiKey(key: string): boolean {
  return PLUS_KEY_RE.test(key)
}

/** Minimal fetch surface — injected (global fetch in production, fake in tests). */
export interface PlusFetchResponse {
  readonly ok: boolean
  readonly status: number
  json(): Promise<unknown>
  text(): Promise<string>
}
export type PlusFetch = (
  url: string,
  init?: { headers?: Record<string, string> },
) => Promise<PlusFetchResponse>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Exchange the API key for an access token. The key never appears in errors. */
export async function fetchPlusAccessToken(fetchFn: PlusFetch, apiKey: string): Promise<string> {
  if (!isValidPlusApiKey(apiKey)) {
    throw new Error(
      'plus catalog API key is malformed — expected the "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx:40-hex" shape shown in your plus catalog account settings',
    )
  }
  const [user, pass] = apiKey.split(':')
  const basic = Buffer.from(`${user}:${pass}`).toString('base64')
  const res = await fetchFn(`${PLUS_API_HOST}/v1/auth/token`, {
    headers: { authorization: `Basic ${basic}` },
  })
  if (!res.ok) {
    throw new Error(
      `plus catalog authentication failed (HTTP ${res.status}) — check the API key in the Model Studio addon settings`,
    )
  }
  const body = await res.json()
  const token = isRecord(body) && typeof body.accessToken === 'string' ? body.accessToken : null
  if (token === null) throw new Error('plus catalog auth response carried no accessToken')
  return token
}

async function plusGet(fetchFn: PlusFetch, token: string, path: string): Promise<unknown> {
  const res = await fetchFn(`${PLUS_API_HOST}/v1/${path}`, {
    headers: { authorization: `Bearer ${token}` },
  })
  if (!res.ok) {
    throw new Error(
      `plus catalog request "${path}" failed (HTTP ${res.status}): ${await res.text()}`,
    )
  }
  return res.json()
}

/**
 * One entry of `GET /v1/model/list` — the REAL contract, verified 2026-08-21
 * against plus-catalog/api/app.py (`plus_api.get_models()["list"]`, filtered on
 * `type`/`supportedDetectors`, sorted by `trainDate`) and the plus catalog web
 * UI's `PlusCatalogModel` type (DetectorsAndModelSettingsView.tsx), which
 * splits the account view on `isBaseModel` — exactly the Base/Custom
 * grouping this addon renders.
 */
export interface PlusModelSummary {
  readonly id: string
  readonly name: string
  /** Decode family (`yolo-generic` | `yolonas` | `ssd`) — the POSTPROCESSOR,
   *  derived from the chosen entry; never a selector level. */
  readonly type: string
  readonly isBaseModel: boolean
  /** plus catalog RELEASE ("2024.0" … "2026.1") — NOT an architecture family. */
  readonly baseModel: string
  readonly supportedDetectors: readonly string[]
  readonly trainDate: string
  /** Only on hailo entries — the sole difference between otherwise-identical rows. */
  readonly hailoDevice?: string
  /** Verified training images, normalised from all three API shapes. */
  readonly verifiedImages: number
  readonly width?: number
  readonly height?: number
}

/**
 * `verifiedCounts` has THREE real shapes and none may break the parse:
 *   -1                                → base model ("not applicable") ⇒ 0
 *   { "11": 199 }                     → legacy custom (flat label→count)
 *   { camera: { label: n, … }, … }    → recent custom (per camera)
 */
export function verifiedImageCount(raw: unknown): number {
  if (typeof raw === 'number') return raw > 0 ? raw : 0
  if (!isRecord(raw)) return 0
  let total = 0
  for (const value of Object.values(raw)) {
    if (typeof value === 'number') total += value > 0 ? value : 0
    else if (isRecord(value)) {
      for (const inner of Object.values(value)) {
        if (typeof inner === 'number' && inner > 0) total += inner
      }
    }
  }
  return total
}

function toModelSummary(m: Record<string, unknown>): PlusModelSummary | null {
  if (typeof m.id !== 'string') return null
  return {
    id: m.id,
    name: typeof m.name === 'string' ? m.name : m.id,
    type: typeof m.type === 'string' ? m.type : 'unknown',
    isBaseModel: m.isBaseModel === true,
    baseModel: typeof m.baseModel === 'string' ? m.baseModel : '',
    supportedDetectors: Array.isArray(m.supportedDetectors)
      ? m.supportedDetectors.filter((d): d is string => typeof d === 'string')
      : [],
    trainDate: typeof m.trainDate === 'string' ? m.trainDate : '',
    ...(typeof m.hailoDevice === 'string' ? { hailoDevice: m.hailoDevice } : {}),
    verifiedImages: verifiedImageCount(m.verifiedCounts),
    ...(typeof m.width === 'number' ? { width: m.width } : {}),
    ...(typeof m.height === 'number' ? { height: m.height } : {}),
  }
}

/** Parse a raw `/v1/model/list` body (`{list:[…]}`, or a bare array). */
export function toPlusModelSummaries(raw: unknown): readonly PlusModelSummary[] {
  const list = Array.isArray(raw) ? raw : isRecord(raw) && Array.isArray(raw.list) ? raw.list : []
  return list
    .filter(isRecord)
    .map(toModelSummary)
    .filter((m): m is PlusModelSummary => m !== null)
}

/**
 * EVERYTHING the account has access to — base AND custom models. The real
 * response wraps the array: `{ "list": [...] }` (a bare array is tolerated
 * for forward compatibility).
 */
export async function listPlusModels(
  fetchFn: PlusFetch,
  apiKey: string,
): Promise<readonly PlusModelSummary[]> {
  const token = await fetchPlusAccessToken(fetchFn, apiKey)
  return toPlusModelSummaries(await plusGet(fetchFn, token, 'model/list'))
}

// ---------------------------------------------------------------------------
// Incremental selectors — the REAL discriminants, in the operator's order:
//   1 kind (isBaseModel) → 2 release (baseModel) → 3 detector
//   (supportedDetectors[]) → 4 architecture + 5 weight (both parsed out of
//   `name`) → 6 dimensions → the concrete training (trainDate).
//
// `type` is NOT a level: it is the decode (yolo-generic / yolonas / ssd),
// derived from whichever entry the selection lands on.
//
// Modelled as FACETS rather than a nested tree: each level's options are
// recomputed from the entries surviving the levels above it, so every offered
// option has at least one entry behind it and an impossible combination is
// unreachable by construction.
// ---------------------------------------------------------------------------

/** Weight vocabulary shared with our own catalog (`YOLOV9_TIER_NAME`). */
const WEIGHT_LABELS: Readonly<Record<string, string>> = {
  n: 'Nano',
  t: 'Tiny',
  s: 'Small',
  m: 'Medium',
  c: 'Compact',
  l: 'Large',
  x: 'Extra large',
}

export interface ParsedModelName {
  readonly architecture: string
  /** Weight suffix (`t`, `s`, …); empty when the architecture has no ladder. */
  readonly weight: string
  readonly weightLabel: string
}

/**
 * Split a plus catalog `name` into architecture + weight — `yolov9t` is the
 * YOLOv9 architecture at the Tiny weight, exactly how our own catalog
 * expresses `yolov9t` (family `yolov9`, tier `t`). Weightless names
 * (`yolonas`, `mobiledet`) stay whole.
 */
export function parseModelName(name: string): ParsedModelName {
  const match = /^(yolov\d+)([a-z])$/.exec(name)
  if (match !== null) {
    const weight = match[2]!
    return {
      architecture: match[1]!,
      weight,
      weightLabel: WEIGHT_LABELS[weight] ?? weight.toUpperCase(),
    }
  }
  return { architecture: name, weight: '', weightLabel: '' }
}

export type DetectorSupportKind = 'supported' | 'coral-only' | 'unsupported'

export interface DetectorSupport {
  readonly kind: DetectorSupportKind
  readonly reason: string
}

/**
 * What OUR cluster can do with a plus catalog `supportedDetectors[]` label.
 * Kept for diagnostics — the Import UI no longer asks the operator to pick
 * a detector: plus catalog downloads ONE artifact per training (`type` → onnx
 * or tflite), and OpenVINO/CoreML are CamStack converts from ONNX.
 */
export function detectorSupport(detector: string): DetectorSupport {
  switch (detector) {
    case 'onnx':
    case 'openvino':
      return {
        kind: 'supported',
        reason: 'ONNX artifact — runs here, and is converted for the cluster engines.',
      }
    case 'edgetpu':
      return {
        kind: 'coral-only',
        reason: 'EdgeTPU tflite — loadable only on a node with a Coral.',
      }
    case 'cpu':
      return {
        kind: 'unsupported',
        reason:
          'CPU tflite — our tflite runtime binds the Coral delegate, so there is no engine for it.',
      }
    case 'hailo8':
    case 'hailo8l':
    case 'hailo8r':
      return {
        kind: 'unsupported',
        reason: 'Hailo build — no Hailo accelerator support in this cluster.',
      }
    case 'rknn':
      return { kind: 'unsupported', reason: 'Rockchip NPU build — not supported here.' }
    case 'rocm':
      return { kind: 'unsupported', reason: 'AMD ROCm build — not supported here.' }
    case 'zmq':
      return {
        kind: 'unsupported',
        reason: 'ZMQ remote-detector build — not applicable to this cluster.',
      }
    default:
      return { kind: 'unsupported', reason: `Unknown detector "${detector}" — not supported here.` }
  }
}

/**
 * Which CamStack engine can run a plus catalog build, or `null` when none can.
 *
 *  - `neural`: an ONNX artifact (`onnx` / `openvino` detectors share it). It
 *    runs on onnxruntime and is converted to OpenVINO / CoreML here.
 *  - `coral`: an EdgeTPU-compiled tflite (`edgetpu`). The pool's ONLY tflite
 *    runtime binds the libedgetpu delegate, so it loads only on a Coral node.
 *  - `null`: everything else. A `cpu` build is a plain tflite meant for
 *    plus catalog's CPU detector — CamStack has no CPU tflite engine (the tflite
 *    runtime refuses to start without a Coral, and on a Coral node it would
 *    run on the host CPU through the single serialised EdgeTPU lane, starving
 *    the real Coral models), so it is never offered. Hailo, RKNN, ROCm-only and
 *    ZMQ builds have no engine here at all.
 *
 * The `type` fallback applies only to a row that carries NO detector list —
 * a row that names its detectors is judged by them, which is what keeps a
 * `cpu` MobileDet (`type: ssd`) out of the Coral lane.
 */
export type PlusLane = 'neural' | 'coral'

export function plusImportLane(m: {
  readonly type: string
  readonly supportedDetectors: readonly string[]
}): PlusLane | null {
  const dets = m.supportedDetectors
  if (dets.includes('onnx') || dets.includes('openvino')) return 'neural'
  if (dets.includes('edgetpu')) return 'coral'
  if (dets.length === 0) return plusTypeTraits(m.type).format === 'tflite' ? 'coral' : 'neural'
  return null
}

export interface PlusSelection {
  readonly kind?: 'base' | 'custom'
  readonly release?: string
  /** plus catalog detector label (diagnostics only — the catalog cards never filter on it). */
  readonly detector?: string
  readonly architecture?: string
  readonly weight?: string
  readonly dimensions?: string
}

export interface FacetOption {
  readonly value: string
  readonly label: string
  readonly count: number
}

export interface DetectorFacetOption extends FacetOption {
  readonly support: DetectorSupport
}

export interface PlusFacets {
  readonly kind: readonly FacetOption[]
  readonly release: readonly FacetOption[]
  /** Always empty — the catalog never asks the operator to pick a detector. */
  readonly detector: readonly DetectorFacetOption[]
  readonly architecture: readonly FacetOption[]
  readonly weight: readonly FacetOption[]
  readonly dimensions: readonly FacetOption[]
  /** Entries surviving the FULL selection, newest training first. */
  readonly entries: readonly PlusModelSummary[]
}

export function dimensionsOf(m: PlusModelSummary): string {
  return m.width !== undefined && m.height !== undefined ? `${m.width}x${m.height}` : ''
}

const byDateDesc = (a: PlusModelSummary, b: PlusModelSummary) =>
  b.trainDate.localeCompare(a.trainDate)

function tally(
  models: readonly PlusModelSummary[],
  keys: (m: PlusModelSummary) => readonly string[],
): Map<string, number> {
  const counts = new Map<string, number>()
  for (const m of models) {
    for (const k of keys(m)) {
      if (k === '') continue
      counts.set(k, (counts.get(k) ?? 0) + 1)
    }
  }
  return counts
}

function matchesThrough(
  m: PlusModelSummary,
  sel: PlusSelection,
  upTo: 'kind' | 'release' | 'detector' | 'architecture' | 'weight' | 'dimensions',
): boolean {
  const order = ['kind', 'release', 'detector', 'architecture', 'weight', 'dimensions'] as const
  const limit = order.indexOf(upTo)
  const parsed = parseModelName(m.name)
  for (let i = 0; i <= limit; i++) {
    const level = order[i]!
    if (level === 'kind' && sel.kind !== undefined) {
      if ((sel.kind === 'base') !== m.isBaseModel) return false
    }
    if (level === 'release' && sel.release !== undefined && m.baseModel !== sel.release)
      return false
    if (
      level === 'detector' &&
      sel.detector !== undefined &&
      !m.supportedDetectors.includes(sel.detector)
    ) {
      return false
    }
    if (
      level === 'architecture' &&
      sel.architecture !== undefined &&
      parsed.architecture !== sel.architecture
    ) {
      return false
    }
    if (level === 'weight' && sel.weight !== undefined && parsed.weight !== sel.weight) return false
    if (
      level === 'dimensions' &&
      sel.dimensions !== undefined &&
      dimensionsOf(m) !== sel.dimensions
    ) {
      return false
    }
  }
  return true
}

/**
 * Options for every level given a (possibly partial) selection.
 * Cascade: kind → release → architecture → weight → dimensions. The catalog
 * UI uses only kind and release; the cards below them come from
 * `buildPlusCatalog` and show every runnable build at once.
 */
export function plusFacets(models: readonly PlusModelSummary[], sel: PlusSelection): PlusFacets {
  const kindCounts = tally(models, (m) => [m.isBaseModel ? 'base' : 'custom'])
  const kindOrder: readonly ('custom' | 'base')[] = ['custom', 'base']
  const kind: FacetOption[] = kindOrder
    .filter((k) => (kindCounts.get(k) ?? 0) > 0)
    .map((k) => ({
      value: k,
      label: k === 'custom' ? 'My trainings' : 'Official base',
      count: kindCounts.get(k)!,
    }))

  const afterKind = models.filter((m) => matchesThrough(m, sel, 'kind'))
  const releaseCounts = tally(afterKind, (m) => [m.baseModel])
  const release: FacetOption[] = [...releaseCounts.entries()]
    .toSorted((a, b) => b[0].localeCompare(a[0], undefined, { numeric: true }))
    .map(([value, count]) => ({ value, label: value, count }))

  const afterDetector = models.filter((m) => matchesThrough(m, sel, 'detector'))
  const architectureCounts = tally(afterDetector, (m) => [parseModelName(m.name).architecture])
  const architecture: FacetOption[] = [...architectureCounts.entries()]
    .toSorted((a, b) => a[0].localeCompare(b[0]))
    .map(([value, count]) => ({ value, label: value, count }))

  const afterArchitecture = models.filter((m) => matchesThrough(m, sel, 'architecture'))
  const weightCounts = tally(afterArchitecture, (m) => [parseModelName(m.name).weight])
  const weight: FacetOption[] = [...weightCounts.entries()]
    .toSorted((a, b) => a[0].localeCompare(b[0]))
    .map(([value, count]) => ({
      value,
      label: WEIGHT_LABELS[value] ?? value.toUpperCase(),
      count,
    }))

  const afterWeight = models.filter((m) => matchesThrough(m, sel, 'weight'))
  const dimensionCounts = tally(afterWeight, (m) => [dimensionsOf(m)])
  const dimensions: FacetOption[] = [...dimensionCounts.entries()]
    .toSorted((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }))
    .map(([value, count]) => ({ value, label: value.replace('x', '×'), count }))

  const entries = models.filter((m) => matchesThrough(m, sel, 'dimensions')).toSorted(byDateDesc)

  return { kind, release, detector: [], architecture, weight, dimensions, entries }
}

export interface PlusModelInfo {
  readonly id: string
  readonly type: string
  readonly width: number
  readonly height: number
  /** `index → label` map as the API ships it. */
  readonly labelMap: Readonly<Record<string, string>>
  readonly supportedDetectors?: readonly string[]
}

function toModelInfo(raw: unknown, modelId: string): PlusModelInfo {
  if (!isRecord(raw)) throw new Error('plus catalog model info: unexpected response shape')
  const labelMap: Record<string, string> = {}
  if (isRecord(raw.labelMap)) {
    for (const [k, v] of Object.entries(raw.labelMap)) {
      if (typeof v === 'string') labelMap[k] = v
    }
  }
  const supportedDetectors: string[] = []
  if (Array.isArray(raw.supportedDetectors)) {
    for (const d of raw.supportedDetectors) {
      if (typeof d === 'string') supportedDetectors.push(d)
    }
  }
  return {
    id: typeof raw.id === 'string' ? raw.id : modelId,
    type: typeof raw.type === 'string' ? raw.type : 'unknown',
    width: typeof raw.width === 'number' ? raw.width : 320,
    height: typeof raw.height === 'number' ? raw.height : 320,
    labelMap,
    supportedDetectors,
  }
}

export interface PlusModelDownload {
  readonly info: PlusModelInfo
  /** Presigned URL — plain GET, no auth header. */
  readonly downloadUrl: string
}

/** Resolve one model's metadata + presigned artifact URL. */
export async function requestPlusModelDownload(
  fetchFn: PlusFetch,
  apiKey: string,
  plusModelId: string,
): Promise<PlusModelDownload> {
  const token = await fetchPlusAccessToken(fetchFn, apiKey)
  const info = toModelInfo(await plusGet(fetchFn, token, `model/${plusModelId}`), plusModelId)
  const signed = await plusGet(fetchFn, token, `model/${plusModelId}/signed_url`)
  const url = isRecord(signed) && typeof signed.url === 'string' ? signed.url : null
  if (url === null) throw new Error('plus catalog signed_url response carried no url')
  return { info, downloadUrl: url }
}

/** plus catalog model type → our format + decode. Mirrors the plus catalog presets. */
const PLUS_TYPE_MAP: Readonly<
  Record<string, { format: ModelFormat; postprocessor?: PostprocessorType; extension: string }>
> = {
  mobiledet: { format: 'tflite', postprocessor: 'ssd', extension: '.tflite' },
  /** List API uses `ssd` for MobileDet rows. */
  ssd: { format: 'tflite', postprocessor: 'ssd', extension: '.tflite' },
  yolonas: { format: 'onnx', postprocessor: 'yolonas', extension: '.onnx' },
  yolov9: { format: 'onnx', extension: '.onnx' },
  'yolo-generic': { format: 'onnx', extension: '.onnx' },
}

export function plusTypeTraits(type: string): {
  format: ModelFormat
  postprocessor?: PostprocessorType
  extension: string
} {
  return PLUS_TYPE_MAP[type] ?? { format: 'onnx', extension: '.onnx' }
}

/** Ordered labels from the API's `index → label` map; holes keep alignment. */
function orderedLabels(labelMap: Readonly<Record<string, string>>): readonly string[] {
  const indices = Object.keys(labelMap)
    .map((k) => Number.parseInt(k, 10))
    .filter((n) => Number.isInteger(n) && n >= 0)
  if (indices.length === 0) return []
  const max = Math.max(...indices)
  const out: string[] = []
  for (let i = 0; i <= max; i++) {
    out.push(labelMap[String(i)] ?? `unknown-${i}`)
  }
  return out
}

/**
 * Build the registrable descriptor for a downloaded plus catalog model. The
 * artifact is hub-local (landed by the server-side download), so the URL uses
 * the `camstack-local://` convention (D208) — other nodes get it via
 * Distribute.
 */
export function plusInfoToDescriptor(
  info: PlusModelInfo,
  opts: {
    readonly modelId: string
    readonly name: string
    readonly filename: string
    readonly sizeMB: number
    /** Override when the list row already classified the artifact (D: formatHint). */
    readonly format?: ModelFormat
  },
): CustomModelDescriptor {
  const decode = resolvePlusDecode(info, opts.format)
  const labels = orderedLabels(info.labelMap)
  const entry: ModelCatalogEntry = {
    id: opts.modelId,
    name: opts.name,
    description: `plus catalog personal model (${info.type}) — imported via Model Studio`,
    formats: {
      [decode.format]: {
        url: `camstack-local://${opts.modelId}/${opts.filename}`,
        sizeMB: opts.sizeMB,
        runtimes: ['python'] as const,
      },
    },
    inputSize: { width: info.width, height: info.height },
    labels: labels.map((name) => ({ id: name, name })),
    ...plusCatalogLabelFields(labels),
    defaultClassFloors: plusCatalogDefaultClassFloors('plus'),
    preprocessMode: 'letterbox',
    provider: 'frigate',
    group: plusCatalogVariantGroup(info.type, info.width),
    postprocessor: decode.postprocessor,
  }
  return { stepId: 'object-detection', entry }
}
