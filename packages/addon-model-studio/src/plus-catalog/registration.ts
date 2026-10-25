/**
 * D214 — the ONE registration builder behind the consolidated Register flow.
 *
 * The former plus catalog tab and the URL-based Register tab were two surfaces over
 * the same operation. This module folds them: a registration names a MODEL
 * TYPE — one of the plus catalog presets (which fill format / decode / input size /
 * base labelmap from the documented plus catalog characteristics) or `custom`
 * (operator declares format and decode explicitly) — and a SOURCE — an
 * uploaded artifact (addressed by the `camstack-local://` convention, D208) or
 * a remote URL / HuggingFace path.
 *
 * Pure domain logic; the Register tab is a thin form over it.
 */
import {
  plusCatalogDefaultClassFloors,
  plusCatalogLabelFields,
  type CustomModelDescriptor,
  type LabelDefinition,
  type ModelCatalogEntry,
  type ModelFormat,
  type PostprocessorType,
} from '@camstack/types'
import {
  PLUS_CATALOG_MODEL_PRESETS,
  type PlusCatalogModelType,
  plusCatalogVariantGroup,
} from './plus-catalog-import.js'

export type RegistrationModelType = PlusCatalogModelType | 'custom'

export type RegistrationSource =
  | {
      readonly kind: 'upload'
      readonly filename: string
      readonly sizeMB: number
    }
  | { readonly kind: 'url'; readonly url: string; readonly sizeMB: number }

export interface RegistrationInput {
  readonly type: RegistrationModelType
  readonly modelId: string
  readonly name: string
  readonly stepId: string
  readonly source: RegistrationSource
  /** Used for `custom`; a plus catalog preset's own format always wins. */
  readonly format: ModelFormat
  /**
   * `custom` only — per-model decode override. `undefined` ⇒ the hosting
   * step's own postprocessor applies. Presets carry their own decode.
   */
  readonly postprocessor?: PostprocessorType
  readonly inputWidth: number
  readonly inputHeight: number
  /** Ordered labelmap (order = logit index). Required for plus catalog presets. */
  readonly labels: readonly string[]
  /** Per-class floor defaults the import states (D738); a preset without them gets the stock defaults. */
  readonly defaultClassFloors?: Readonly<Record<string, number>>
}

/**
 * The decodes an operator may pick for a `custom` registration (the Register
 * tab's Decode select, and a prefill's decode). A decode missing here is
 * DROPPED from the registration, silently falling back to the step default —
 * so a decode the pool ships must be listed for a model that needs it to be
 * importable at all.
 */
export const REGISTRABLE_POSTPROCESSORS: readonly PostprocessorType[] = [
  'yolo',
  'yolonas',
  'ssd',
  'rfdetr',
  'yolo-seg',
  'scrfd',
  'softmax',
  'clip',
  'arcface',
  'ctc',
  'plate-slots',
  'saliency',
  // YOLOv9 TFLite / Edge TPU split heads: box `[1, N, 64]` DFL + class logits
  // `[1, N, C]`, one pair per stride or the strides concatenated (the
  // community plus catalog Coral export). Decoded by `yolo_split_dfl.py`.
  'yolo-split-dfl',
]

/** The registrable decode named `value`; `undefined` ⇒ the step default applies. */
export function registrablePostprocessor(value: string): PostprocessorType | undefined {
  return REGISTRABLE_POSTPROCESSORS.find((p) => p === value)
}

const MODEL_ID_RE = /^[a-zA-Z0-9._-]+$/

/**
 * Build the registrable `CustomModelDescriptor` for the unified Register flow.
 * Throws with an operator-actionable message on invalid input.
 */
export function buildRegistrationDescriptor(input: RegistrationInput): CustomModelDescriptor {
  const preset = input.type === 'custom' ? null : PLUS_CATALOG_MODEL_PRESETS[input.type]

  if (!MODEL_ID_RE.test(input.modelId)) {
    throw new Error(
      `Model id "${input.modelId}" is invalid — letters, digits, dot, underscore, hyphen only`,
    )
  }
  if (!input.name.trim()) throw new Error('Display name is required')
  if (!input.stepId.trim()) throw new Error('Step is required')
  if (!(input.inputWidth > 0) || !(input.inputHeight > 0)) {
    throw new Error('Input size must be positive')
  }
  if (preset !== null && input.labels.length === 0) {
    throw new Error('Label list is required — paste the labelmap shipped with the model')
  }
  if (preset !== null && input.source.kind === 'upload') {
    const extensionOk = preset.fileExtensions.some(
      (ext) => input.source.kind === 'upload' && input.source.filename.endsWith(ext),
    )
    if (!extensionOk) {
      throw new Error(
        `File extension mismatch: a ${preset.label} model must be ${preset.fileExtensions.join(' / ')}`,
      )
    }
  }

  const format: ModelFormat = preset?.format ?? input.format
  const postprocessor: PostprocessorType | undefined =
    preset?.postprocessor ?? (preset ? undefined : input.postprocessor)
  const url =
    input.source.kind === 'upload'
      ? `camstack-local://${input.modelId}/${input.source.filename}`
      : input.source.url.trim()
  if (url.length === 0) throw new Error('Model URL is required')

  const description =
    preset !== null
      ? `plus catalog ${preset.label} — imported via Model Studio`
      : 'Custom model — registered via Model Studio'

  const labels: readonly LabelDefinition[] = input.labels.map((name) => ({
    id: name,
    name,
  }))
  const entry: ModelCatalogEntry = {
    id: input.modelId,
    name: input.name.trim(),
    description,
    formats: {
      [format]: {
        url,
        sizeMB: input.source.sizeMB,
        ...(input.source.kind === 'upload' ? { runtimes: ['python'] as const } : {}),
      },
    },
    inputSize: { width: input.inputWidth, height: input.inputHeight },
    labels,
    ...(input.source.kind === 'upload' || preset !== null
      ? { preprocessMode: 'letterbox' as const }
      : {}),
    ...(postprocessor !== undefined ? { postprocessor } : {}),
    ...(preset !== null
      ? {
          provider: 'frigate' as const,
          group: plusCatalogVariantGroup(input.type, input.inputWidth),
          ...plusCatalogLabelFields(input.labels),
          defaultClassFloors: plusCatalogDefaultClassFloors('stock', input.defaultClassFloors),
        }
      : {
          provider: 'custom' as const,
          ...(input.defaultClassFloors !== undefined
            ? { defaultClassFloors: { ...input.defaultClassFloors } }
            : {}),
        }),
  }
  return { stepId: input.stepId.trim(), entry }
}
