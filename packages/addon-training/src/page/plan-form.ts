/**
 * The new-job form: what the operator picked, turned into the orchestrator's
 * request. Pure, so the "empty means the orchestrator's default" rules are
 * pinned by a spec rather than by whoever edits the component next.
 *
 * Multi-model (advanced): the form holds `baseModelIds`; plan uses the first
 * id (same selection/caps for every model); start uses `startJob` for one id
 * and `startJobBatch` for several.
 */
import type {
  TrainingBaseModel,
  TrainingCorpusSelection,
  TrainingJobRequest,
  TrainingPreset,
  TrainingProviderDescriptor,
} from '@camstack/types'

export type CorpusWorkState = TrainingCorpusSelection['workState']

export interface PlanForm {
  readonly collectionIds: readonly string[]
  readonly workState: CorpusWorkState
  readonly entryId: string
  readonly gpuType: string
  readonly region: string
  /** One or more trainable base models (batch start). */
  readonly baseModelIds: readonly string[]
  readonly preset: TrainingPreset
  /** `''` = the preset's choice. */
  readonly freeze: string
  /** Empty = the orchestrator's default holdout. */
  readonly holdoutCameras: readonly number[]
}

/** The presets, in the order the picker lists them. */
export const PRESETS: readonly TrainingPreset[] = ['quick', 'standard', 'thorough']

/** The work states a job can train on, in the order the picker lists them. */
export const WORK_STATES: readonly CorpusWorkState[] = [
  'complete',
  'annotated_or_complete',
  'any_annotated',
]

/** A request the orchestrator can plan, or `null` while something is still unpicked. */
export function requestOf(form: PlanForm): TrainingJobRequest | null {
  const baseModelId = form.baseModelIds[0]
  if (
    form.collectionIds.length === 0 ||
    form.entryId === '' ||
    form.gpuType === '' ||
    baseModelId === undefined
  ) {
    return null
  }
  const freeze = form.freeze.trim() === '' ? null : Number(form.freeze)
  if (freeze !== null && (!Number.isInteger(freeze) || freeze < 0)) return null
  return {
    selection: {
      collectionIds: [...form.collectionIds],
      workState: form.workState,
    },
    entryId: form.entryId,
    gpuType: form.gpuType,
    region: form.region,
    baseModelId,
    preset: form.preset,
    freeze,
    holdoutCameras: form.holdoutCameras.length > 0 ? [...form.holdoutCameras] : null,
  }
}

/** Fill the provider-dependent fields from its settings when the entry changes. */
export function withProvider(form: PlanForm, provider: TrainingProviderDescriptor): PlanForm {
  return {
    ...form,
    entryId: provider.entryId,
    gpuType: provider.defaults.gpuType,
    region: provider.defaults.region,
  }
}

/** Recommended catalog id, else the first — used before cluster roots are known. */
export function defaultBaseModel(models: readonly TrainingBaseModel[]): string {
  return (models.find((m) => m.recommended) ?? models[0])?.modelId ?? ''
}

export const EMPTY_FORM: PlanForm = {
  collectionIds: [],
  workState: 'complete',
  entryId: '',
  gpuType: '',
  region: '',
  baseModelIds: [],
  preset: 'standard',
  freeze: '',
  holdoutCameras: [],
}
