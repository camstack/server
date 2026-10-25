/**
 * Plus-catalog model import — pure domain logic.
 *
 * The plus catalog ships three detector generations, and their characteristics are
 * encoded here as PRESETS so the operator fills in only what the docs cannot
 * know (the exact label ORDER of their trained model, and the file itself):
 *
 *  - `mobiledet` — SSDLite MobileDet, EdgeTPU-compiled full-integer TFLite,
 *    320×320, `TFLite_Detection_PostProcess` 4-tensor output → the existing
 *    `ssd` decode. Runs on a Coral (`tflite` format).
 *  - `yolonas` — YOLO-NAS ONNX exported with fused batched NMS in FLAT
 *    format: one `[N, 7]` output of `(batch_idx, x1, y1, x2, y2, score,
 *    class_id)` rows in input pixel space → the dedicated `yolonas` decode.
 *    Typically 320×320 (plus catalog default).
 *  - `yolov9` — plain YOLOv9 ONNX (`[1, 4+nc, anchors]` raw output) → the
 *    step-default `yolo` decode. Typically 320×320 for plus catalog.
 *
 * The LABEL LIST is load-bearing: the model's logit index maps into it, so it
 * must match the labelmap shipped with the trained model (order included).
 * `PLUS_CATALOG_BASE_LABELS` is the documented plus catalog base set offered as a
 * prefill convenience — the operator's own labelmap always wins.
 */
import {
  plusCatalogDefaultClassFloors,
  plusCatalogLabelFields,
  type CustomModelDescriptor,
  type LabelDefinition,
  type ModelCatalogEntry,
  type ModelFormat,
  type ModelVariantGroup,
  type PostprocessorType,
} from '@camstack/types'

export const PLUS_CATALOG_MODEL_TYPES = ['yolov9', 'yolonas', 'mobiledet'] as const
export type PlusCatalogModelType = (typeof PLUS_CATALOG_MODEL_TYPES)[number]

/**
 * Variant-selector axes for an imported plus catalog / plus catalog detector. Family
 * follows the generation (`ssdlite-mobiledet` / `yolonas` / `yolov9`); a
 * single-model import uses tier `default` so the stepper still gets a grouped
 * picker under the plus catalog provider.
 */
export function plusCatalogVariantGroup(type: string, resolution: number): ModelVariantGroup {
  const family = type === 'mobiledet' ? 'ssdlite-mobiledet' : type
  return { family, tier: 'default', resolution }
}

export interface PlusCatalogModelPreset {
  readonly type: PlusCatalogModelType
  readonly label: string
  readonly format: ModelFormat
  /** Square input side (px) — the plus catalog default for this generation. */
  readonly inputSize: number
  /**
   * Per-model decode override. `undefined` ⇒ the hosting step's own
   * postprocessor applies (yolov9 raw output is what `yolo` already decodes).
   */
  readonly postprocessor?: PostprocessorType
  readonly fileExtensions: readonly string[]
  readonly notes: string
}

export const PLUS_CATALOG_MODEL_PRESETS: Record<PlusCatalogModelType, PlusCatalogModelPreset> = {
  yolov9: {
    type: 'yolov9',
    label: 'YOLOv9 (ONNX)',
    format: 'onnx',
    inputSize: 320,
    postprocessor: undefined,
    fileExtensions: ['.onnx'],
    notes:
      'plus catalog current generation. Plain YOLOv9 ONNX export — raw [1, 4+classes, anchors] output, decoded by the standard yolo postprocessor. Input 320×320 (plus catalog default; match your export).',
  },
  yolonas: {
    type: 'yolonas',
    label: 'YOLO-NAS (ONNX)',
    format: 'onnx',
    inputSize: 320,
    postprocessor: 'yolonas',
    fileExtensions: ['.onnx'],
    notes:
      'YOLO-NAS exported with fused batched NMS in FLAT format (super-gradients / plus catalog notebook): one [N,7] output of (batch, x1, y1, x2, y2, score, class) rows. Input 320×320 (plus catalog default).',
  },
  mobiledet: {
    type: 'mobiledet',
    label: 'MobileDet (EdgeTPU TFLite)',
    format: 'tflite',
    inputSize: 320,
    postprocessor: 'ssd',
    fileExtensions: ['.tflite'],
    notes:
      'SSDLite MobileDet, EdgeTPU-compiled full-integer TFLite (the plus catalog default-model architecture). TFLite_Detection_PostProcess 4-tensor output, decoded by the ssd postprocessor. Requires a Coral (tflite format node).',
  },
}

/**
 * The documented plus catalog base label set (docs.frigate.video/plus, verified
 * 2026-08-21). Offered as a PREFILL — the labelmap shipped with the operator's
 * model is authoritative, including its order.
 */
export const PLUS_CATALOG_BASE_LABELS: readonly string[] = [
  // People
  'person',
  'face',
  'baby',
  // Vehicles
  'car',
  'motorcycle',
  'bicycle',
  'boat',
  'school_bus',
  'garbage_truck',
  'license_plate',
  // Delivery logos
  'amazon',
  'usps',
  'ups',
  'fedex',
  'dhl',
  'an_post',
  'purolator',
  'postnl',
  'nzpost',
  'postnord',
  'gls',
  'dpd',
  'canada_post',
  'royal_mail',
  // Animals
  'dog',
  'cat',
  'deer',
  'horse',
  'bird',
  'raccoon',
  'fox',
  'bear',
  'cow',
  'squirrel',
  'goat',
  'rabbit',
  'skunk',
  'kangaroo',
  'possum',
  'rodent',
  // Other
  'package',
  'waste_bin',
  'bbq_grill',
  'robot_lawnmower',
  'umbrella',
  'baby_stroller',
]

/**
 * Parse a labelmap in any of the shapes plus catalog users actually have on disk:
 * one label per line, `index label` lines (tflite labelmap style), or a
 * comma-separated list. Order is preserved — it IS the logit index.
 */
export function parsePlusCatalogLabelmap(text: string): readonly string[] {
  const rawParts = text.includes('\n') || !text.includes(',') ? text.split('\n') : text.split(',')
  const labels: string[] = []
  for (const rawPart of rawParts) {
    const trimmed = rawPart.trim()
    if (!trimmed) continue
    // `0 person` / `12  license_plate` → strip the leading index token.
    const indexed = /^\d+\s+(.+)$/.exec(trimmed)
    labels.push((indexed?.[1] ?? trimmed).trim())
  }
  return labels
}

const MODEL_ID_RE = /^[a-zA-Z0-9._-]+$/

export interface PlusCatalogImportInput {
  readonly type: PlusCatalogModelType
  readonly modelId: string
  readonly name: string
  readonly stepId: string
  /** Uploaded artifact filename (already sanitized by the upload store). */
  readonly filename: string
  readonly sizeMB: number
  readonly inputWidth: number
  readonly inputHeight: number
  /** Ordered label list — the model's labelmap. */
  readonly labels: readonly string[]
  /** Per-class floor defaults the import states (D738); absent ⇒ the stock defaults. */
  readonly defaultClassFloors?: Readonly<Record<string, number>>
}

/**
 * Build the registrable `CustomModelDescriptor` for an imported plus catalog model.
 * The format URL uses the `camstack-local://<modelId>/<filename>` convention:
 * the artifact already sits in the hub's modelsDir (landed by the upload
 * store), and `ensureModel` resolves it by URL basename without fetching.
 * Throws with an operator-actionable message on invalid input.
 */
export function buildPlusCatalogDescriptor(input: PlusCatalogImportInput): CustomModelDescriptor {
  const preset = PLUS_CATALOG_MODEL_PRESETS[input.type]
  if (!MODEL_ID_RE.test(input.modelId)) {
    throw new Error(
      `Model id "${input.modelId}" is invalid — letters, digits, dot, underscore, hyphen only`,
    )
  }
  if (!input.name.trim()) throw new Error('Display name is required')
  if (!input.stepId.trim()) throw new Error('Step is required')
  if (input.labels.length === 0) {
    throw new Error('Label list is required — paste the labelmap shipped with the model')
  }
  if (!(input.inputWidth > 0) || !(input.inputHeight > 0)) {
    throw new Error('Input size must be positive')
  }
  const extensionOk = preset.fileExtensions.some((ext) => input.filename.endsWith(ext))
  if (!extensionOk) {
    throw new Error(
      `File extension mismatch: a ${preset.label} model must be ${preset.fileExtensions.join(' / ')}`,
    )
  }

  const labels: readonly LabelDefinition[] = input.labels.map((name) => ({ id: name, name }))
  const entry: ModelCatalogEntry = {
    id: input.modelId,
    name: input.name.trim(),
    description: `plus catalog ${preset.label} — imported via Model Studio`,
    formats: {
      [preset.format]: {
        url: `camstack-local://${input.modelId}/${input.filename}`,
        sizeMB: input.sizeMB,
        runtimes: ['python'],
      },
    },
    inputSize: { width: input.inputWidth, height: input.inputHeight },
    labels,
    ...plusCatalogLabelFields(input.labels),
    defaultClassFloors: plusCatalogDefaultClassFloors('stock', input.defaultClassFloors),
    preprocessMode: 'letterbox',
    provider: 'frigate',
    group: plusCatalogVariantGroup(input.type, input.inputWidth),
    ...(preset.postprocessor !== undefined ? { postprocessor: preset.postprocessor } : {}),
  }
  return { stepId: input.stepId, entry }
}

// ---------------------------------------------------------------------------
// Template — a downloadable JSON pre-filled with the real plus catalog
// characteristics, usable as the base for an upload (and re-importable).
// ---------------------------------------------------------------------------

export interface PlusCatalogTemplate {
  readonly kind: 'camstack-plus-catalog-model-template'
  readonly version: 1
  readonly type: PlusCatalogModelType
  readonly format: ModelFormat
  readonly inputSize: { readonly width: number; readonly height: number }
  readonly preprocessMode: 'letterbox'
  readonly postprocessor?: PostprocessorType
  readonly labels: readonly string[]
  readonly notes: string
}

export function buildPlusCatalogTemplate(type: PlusCatalogModelType): PlusCatalogTemplate {
  const preset = PLUS_CATALOG_MODEL_PRESETS[type]
  return {
    kind: 'camstack-plus-catalog-model-template',
    version: 1,
    type,
    format: preset.format,
    inputSize: { width: preset.inputSize, height: preset.inputSize },
    preprocessMode: 'letterbox',
    ...(preset.postprocessor !== undefined ? { postprocessor: preset.postprocessor } : {}),
    labels: PLUS_CATALOG_BASE_LABELS,
    notes: preset.notes,
  }
}

export interface ParsedPlusCatalogTemplate {
  readonly type: PlusCatalogModelType
  readonly inputWidth: number
  readonly inputHeight: number
  readonly labels: readonly string[]
  /** Per-class floor defaults the template states (D738) — valid entries only. */
  readonly defaultClassFloors?: Readonly<Record<string, number>>
}

/** The template's `defaultClassFloors`, keeping only scores in [0, 1]; `undefined` when none. */
function parseTemplateFloors(value: unknown): Readonly<Record<string, number>> | undefined {
  if (!isRecord(value)) return undefined
  const floors = Object.fromEntries(
    Object.entries(value).filter(
      (pair): pair is [string, number] =>
        typeof pair[1] === 'number' && pair[1] >= 0 && pair[1] <= 1,
    ),
  )
  return Object.keys(floors).length > 0 ? floors : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Parse + validate a template JSON. Throws with a clear message on foreign input. */
export function parsePlusCatalogTemplate(text: string): ParsedPlusCatalogTemplate {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('Not a valid plus catalog model template: file is not JSON')
  }
  if (!isRecord(parsed) || parsed.kind !== 'camstack-plus-catalog-model-template') {
    throw new Error('Not a valid plus catalog model template (missing kind marker)')
  }
  const type = PLUS_CATALOG_MODEL_TYPES.find((t) => t === parsed.type)
  if (type === undefined) {
    throw new Error(
      `Not a valid plus catalog model template: unknown type "${String(parsed.type)}" — expected ${PLUS_CATALOG_MODEL_TYPES.join(' | ')}`,
    )
  }
  const inputSize = isRecord(parsed.inputSize) ? parsed.inputSize : {}
  const width = typeof inputSize.width === 'number' ? inputSize.width : NaN
  const height = typeof inputSize.height === 'number' ? inputSize.height : NaN
  if (!(width > 0) || !(height > 0)) {
    throw new Error('Not a valid plus catalog model template: inputSize.width/height missing')
  }
  const labels = Array.isArray(parsed.labels)
    ? parsed.labels.filter((l): l is string => typeof l === 'string' && l.length > 0)
    : []
  if (labels.length === 0) {
    throw new Error('Not a valid plus catalog model template: labels missing')
  }
  const defaultClassFloors = parseTemplateFloors(parsed.defaultClassFloors)
  return {
    type,
    inputWidth: width,
    inputHeight: height,
    labels,
    ...(defaultClassFloors !== undefined ? { defaultClassFloors } : {}),
  }
}
