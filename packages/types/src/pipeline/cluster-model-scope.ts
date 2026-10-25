/**
 * A model choice has a SCOPE, and a scope change has a workflow.
 *
 * ## The two scopes
 *
 * Almost every pipeline step's model is a **node** question: which build runs
 * fastest on THIS accelerator. Two nodes may legitimately answer differently —
 * a Coral runs the tflite SSD, a Mac runs the coreml YOLO — because the answers
 * are compared against nothing. They produce boxes, and a box is a box.
 *
 * Two steps are not like that. `face-embedding` and `clip-embedding` produce
 * **vectors that land in ONE shared index** (`identity_samples`,
 * `vec_object_clip`) and are ranked against each other by cosine similarity.
 * Cosine similarity between two encoders is not a weak signal, it is a
 * meaningless number — and nothing inside a vector can tell you it happened.
 * So for those two steps the model is a **cluster** question with exactly one
 * answer, stored in exactly one row.
 *
 * That is the same argument [D52](../../../../docs/decisions/adr-0052.md) makes
 * for the crop convention (`detail-crop.ts`), one level up: the crop decides
 * WHAT pixels the encoder sees, this decides WHICH encoder sees them. Both are
 * cluster-wide for the same reason and neither may become per-node.
 *
 * ## Why the registry lives here and not in the step catalog
 *
 * The scope itself is declared on the step, in
 * `detection-pipeline/registry/step-definitions.ts` (`StepDefinition.modelScope`)
 * — that is where a new step declares what kind of choice its model is. But the
 * catalog lives inside `addon-pipeline`, and three packages that must NOT
 * import an addon need to know the set: the orchestrator (which renders and
 * stores the row), post-analysis (which pins the row for a re-embed pass) and
 * admin-ui (which mirrors it). So the set is mirrored here, and
 * `scripts/check-cluster-model-scope.ts` fails the build when the two disagree.
 * A hand-copied key that stops matching is exactly how a setting silently stops
 * arriving while both sides still look correct.
 *
 * ## The defaults ARE today's behaviour
 *
 * {@link DEFAULT_CLUSTER_STEP_MODELS} reproduces the catalog `defaultModelId`
 * of both steps. Declaring the scope therefore changes nothing on the day it
 * ships: the cluster row starts out saying what every node was already doing.
 * Changing it is legitimate — that is what the knob is for — but it invalidates
 * the stored vectors of that surface, and must be followed by a re-embed pass
 * (`face-reembed-pass.ts`, `embedding-rebuild.ts`).
 */
import { z } from 'zod'

/**
 * Why the orchestrator cannot say which model the operator chose for a
 * cluster-scoped step (D651).
 */
export const CLUSTER_MODEL_CHOICE_UNREADABLE_REASONS = [
  /** The orchestrator's boot has not settled, or it is shutting down. */
  'owner-not-ready',
  /** Its own store did not answer. */
  'store-read-failed',
  /** This node's settings view cannot tell a failed read from an empty one. */
  'three-way-read-unavailable',
  /** The stored value is not a string (a non-empty string is honoured verbatim, as the runtime does). */
  'invalid-stored',
  /** The step is not cluster-scoped. */
  'not-cluster-scoped',
] as const

/**
 * How a step's model is chosen.
 *
 *  - `'node'` — per (node, device). Free to differ across the fleet.
 *  - `'cluster'` — ONE value for the whole cluster. The step writes into a
 *    shared vector index, so two values would put two incomparable feature
 *    spaces in it with nothing in the data to show it.
 *
 * Absent on a {@link import('../types/pipeline-step.js').StepDefinition} means
 * `'node'`, which is the safe reading: a step that never declared a scope has
 * never had a cluster-wide row to read.
 */
export type StepModelScope = 'node' | 'cluster'

/** One selectable model for a cluster-scoped step. */
export interface ClusterModelOption {
  readonly id: string
  readonly label: string
}

/** One cluster-scoped step, as every non-pipeline package sees it. */
export interface ClusterModelScopedStep {
  readonly stepId: string
  /** Operator-facing label for the settings row. */
  readonly label: string
  /**
   * The model in force when nobody has chosen — the step's catalog
   * `defaultModelId`, so declaring the scope is behaviour-neutral.
   */
  readonly defaultModelId: string
  /** The index a change invalidates, named in the operator-facing description. */
  readonly indexName: string
  /**
   * The choosable models, mirrored from the step's catalog (non-`legacy`
   * entries) and guarded by `scripts/check-cluster-model-scope.ts`.
   *
   * Mirrored rather than derived because the orchestrator renders this dropdown
   * and may not import an addon. A free-text field would have been less code
   * and strictly worse: a typo there is not a validation error, it is a model
   * that every node refuses, cluster-wide, and the symptom is "recognition
   * stopped" with no bad value in sight.
   */
  readonly options: readonly ClusterModelOption[]
}

/**
 * The cluster-scoped steps. Mirrored from the catalog's `modelScope: 'cluster'`
 * declarations and guarded by `scripts/check-cluster-model-scope.ts`.
 */
export const CLUSTER_MODEL_SCOPED_STEPS: readonly ClusterModelScopedStep[] = [
  {
    stepId: 'face-embedding',
    label: 'Face recognition model',
    // D651: AuraFace is the default — and, now, the only entry in the catalog.
    defaultModelId: 'auraface-r100',
    indexName: 'the enrolled face gallery',
    options: [{ id: 'auraface-r100', label: 'AuraFace R100' }],
  },
  {
    stepId: 'clip-embedding',
    label: 'Semantic search model',
    defaultModelId: 'siglip2-b16-224',
    indexName: 'the object semantic-search index',
    options: [{ id: 'siglip2-b16-224', label: 'SigLIP2 B/16 (Apache-2.0)' }],
  },
] as const

/**
 * Store identity of the cluster row inside `pipeline-orchestrator`'s GLOBAL
 * (cluster-wide) settings — the same owner, and for the same reason, as the
 * detail-crop convention: hub-resident and neutral between the addons that
 * read it.
 */
export const CLUSTER_MODEL_SECTION_ID = 'cluster-step-models'

/**
 * The settings key holding one step's cluster model choice.
 *
 * Step-qualified so the keys stay unique across the addon's whole schema, which
 * is what lets {@link pickClusterStepModels} walk every section instead of
 * trusting the section id.
 */
export function clusterModelSettingKey(stepId: string): string {
  return `clusterModel:${stepId}`
}

/** True when this step's model is a cluster-wide choice rather than a per-node one. */
export function isClusterScopedStep(stepId: string): boolean {
  return CLUSTER_MODEL_SCOPED_STEPS.some((s) => s.stepId === stepId)
}

/** `stepId → modelId` for every cluster-scoped step. Total: never missing a key. */
export type ClusterStepModels = Readonly<Record<string, string>>

/** The cluster row when nobody has configured one — today's catalog defaults. */
export const DEFAULT_CLUSTER_STEP_MODELS: ClusterStepModels = Object.freeze(
  Object.fromEntries(CLUSTER_MODEL_SCOPED_STEPS.map((s) => [s.stepId, s.defaultModelId])),
)

/**
 * What ONE stored `clusterModel:<stepId>` value means (D651 fix round 4).
 *
 *  - `absent` — nobody chose. The key was never written, or the settings form
 *    cleared it: a select clears a field with a `null` patch, and `hydrateSchema`
 *    reads a stored `null` as `value ?? default` on every hydrated surface, so
 *    `null` and `''` are the same statement as "never written".
 *  - `chosen` — a non-empty string, taken VERBATIM. Not checked against the
 *    step's `options`: the runtime pins an id the catalog does not list on
 *    purpose (`cluster-model-resolution.ts`: a custom encoder from
 *    `custom-model-registry` is the operator's own compatibility problem), and
 *    the dropdown is guarded separately by `scripts/check-cluster-model-scope.ts`.
 *    An owner that called such an id invalid while the runner ran it would give
 *    the same stored key two meanings — the defect this function removes.
 *  - `invalid` — anything else (a number, an object). The form cannot write it;
 *    it is a hand edit or a corrupted row.
 *
 * Both readers of the key go through this function: the runner's
 * {@link readClusterStepModels} and the owner's `decideClusterModelChoice`
 * (addon-pipeline-orchestrator). They differ only in what they DO with
 * `invalid`: a live row is total, so the runner falls to the catalog default
 * and says so in its log (`ClusterModelSource`); a pass that would rewrite an
 * index on it refuses (`invalid-stored`).
 */
export type StoredClusterModelInterpretation =
  | { readonly kind: 'absent' }
  | { readonly kind: 'chosen'; readonly modelId: string }
  | { readonly kind: 'invalid'; readonly value: unknown }

export function interpretStoredClusterModel(raw: unknown): StoredClusterModelInterpretation {
  if (raw === undefined || raw === null || raw === '') return { kind: 'absent' }
  if (typeof raw === 'string') return { kind: 'chosen', modelId: raw }
  return { kind: 'invalid', value: raw }
}

/** One stored cluster model value the interpretation rejected. */
export interface InvalidClusterStepModelEntry {
  readonly stepId: string
  readonly value: unknown
}

/**
 * The cluster-scoped steps whose stored value is `invalid` under
 * {@link interpretStoredClusterModel} — for the runtime's log line, so the
 * default it runs on such a row is never run in silence.
 */
export function invalidClusterStepModelEntries(
  config: Readonly<Record<string, unknown>>,
): readonly InvalidClusterStepModelEntry[] {
  const out: InvalidClusterStepModelEntry[] = []
  for (const step of CLUSTER_MODEL_SCOPED_STEPS) {
    const read = interpretStoredClusterModel(config[clusterModelSettingKey(step.stepId)])
    if (read.kind === 'invalid') out.push({ stepId: step.stepId, value: read.value })
  }
  return out
}

/**
 * Narrow a FLAT settings record to the cluster row.
 *
 * Per-FIELD fallback, deliberately (same rule as `readDetailCropConvention`): a
 * junk face model must not also discard a valid clip model. An `absent` or
 * `invalid` value ({@link interpretStoredClusterModel}) resolves to the step's
 * catalog default — never to a blank id, because a blank id downstream becomes
 * "substitute the format default", which is precisely the substitution this
 * scope exists to forbid.
 */
export function readClusterStepModels(
  config: Readonly<Record<string, unknown>>,
): ClusterStepModels {
  const out: Record<string, string> = {}
  for (const step of CLUSTER_MODEL_SCOPED_STEPS) {
    const read = interpretStoredClusterModel(config[clusterModelSettingKey(step.stepId)])
    out[step.stepId] = read.kind === 'chosen' ? read.modelId : step.defaultModelId
  }
  return out
}

/** One hydrated field of an `addon-settings.getGlobalSettings` payload. */
interface HydratedClusterField {
  readonly key: unknown
  readonly value?: unknown
}

/** One section of an `addon-settings.getGlobalSettings` payload. */
export interface HydratedClusterSection {
  readonly fields: readonly unknown[]
}

/**
 * Minimal structural view of `ConfigUISchemaWithValues` — only what this walk
 * needs. Structural on purpose: the readers are addons that must not depend on
 * the writer's schema type.
 */
export interface HydratedClusterView {
  readonly sections: readonly HydratedClusterSection[]
}

function isHydratedField(entry: unknown): entry is HydratedClusterField {
  return typeof entry === 'object' && entry !== null && 'key' in entry
}

/**
 * Extract the cluster row from an `addon-settings.getGlobalSettings` payload.
 *
 * Walks EVERY section rather than looking inside {@link CLUSTER_MODEL_SECTION_ID}
 * alone: the keys are unique across the addon's schema, and a section rename
 * must not silently revert the whole cluster to the defaults. A `null` payload
 * (addon mid-boot) is the defaults.
 */
export function pickClusterStepModels(view: HydratedClusterView | null): ClusterStepModels {
  if (view === null) return DEFAULT_CLUSTER_STEP_MODELS
  return readClusterStepModels(flattenHydratedView(view, clusterModelKeys()))
}

/**
 * The `invalid` stored cluster model values a hydrated view carries — what the
 * runtime logs when it runs a default on a row it could not read as a choice.
 * A `null` view (owner mid-boot) carries nothing to judge.
 */
export function pickInvalidClusterStepModels(
  view: HydratedClusterView | null,
): readonly InvalidClusterStepModelEntry[] {
  if (view === null) return []
  return invalidClusterStepModelEntries(flattenHydratedView(view, clusterModelKeys()))
}

function clusterModelKeys(): ReadonlySet<string> {
  return new Set(CLUSTER_MODEL_SCOPED_STEPS.map((s) => clusterModelSettingKey(s.stepId)))
}

/** The `wanted` keys of a hydrated view as one flat record, every section walked. */
function flattenHydratedView(
  view: HydratedClusterView,
  wanted: ReadonlySet<string>,
): Record<string, unknown> {
  const flat: Record<string, unknown> = {}
  for (const section of view.sections) {
    for (const entry of section.fields) {
      if (!isHydratedField(entry) || typeof entry.key !== 'string') continue
      if (wanted.has(entry.key)) flat[entry.key] = entry.value
    }
  }
  return flat
}

/**
 * The cluster model for `stepId`, or `null` when the step is node-scoped.
 *
 * `null` is the signal to LEAVE THE CALLER'S RESOLUTION ALONE — it is not "no
 * model". Returning a default here for a node-scoped step would quietly
 * override every per-(node,device) selection in the fleet.
 */
export function resolveClusterStepModelId(
  stepId: string,
  models: ClusterStepModels,
): string | null {
  const step = CLUSTER_MODEL_SCOPED_STEPS.find((s) => s.stepId === stepId)
  if (step === undefined) return null
  const chosen = models[stepId]
  return chosen !== undefined && chosen !== '' ? chosen : step.defaultModelId
}

/**
 * Operator knobs that travel with a cluster-scoped step — same store, same
 * TTL, same "no nodeId" rule as the model. The model decides WHICH encoder
 * writes the shared index; these knobs decide WHICH crops it is allowed to
 * write. A per-(node,device) copy of `minLandmarkFaceSize` would let two
 * nodes disagree about what is a face, and the gallery would fill from two
 * incompatible admission policies with nothing in a vector to show it.
 *
 * Defaults are mirrored from the step's `getConfigSchema()` so declaring the
 * cluster row is behaviour-neutral. Clip currently has no operator schema.
 */
export interface ClusterStepSettingField {
  readonly stepId: string
  readonly key: string
  readonly label: string
  readonly description: string
  readonly type: 'slider'
  readonly min: number
  readonly max: number
  readonly step: number
  readonly default: number
}

/** Must match `DEFAULT_LANDMARK_PRECISION_FLOOR_PX` in the runner. */
export const DEFAULT_MIN_LANDMARK_FACE_SIZE_PX = 24

export const CLUSTER_STEP_SETTING_FIELDS: readonly ClusterStepSettingField[] = [
  {
    stepId: 'face-embedding',
    key: 'minLandmarkFaceSize',
    label: 'Min face size to embed (detection-frame px)',
    description:
      'Faces smaller than this in the small frame the detector sees are not embedded, so they can never be recognised. Below it the face cannot be aligned reliably and a bad embedding matches everyone. Same value on every node. 0 = no limit.',
    type: 'slider',
    min: 0,
    max: 64,
    step: 2,
    default: DEFAULT_MIN_LANDMARK_FACE_SIZE_PX,
  },
]

export function clusterStepSettingKey(stepId: string, fieldKey: string): string {
  return `clusterStepSetting:${stepId}:${fieldKey}`
}

export function clusterStepSettingFieldsFor(stepId: string): readonly ClusterStepSettingField[] {
  return CLUSTER_STEP_SETTING_FIELDS.filter((field) => field.stepId === stepId)
}

/** `stepId → { fieldKey → value }` for every declared cluster setting. */
export type ClusterStepSettings = Readonly<Record<string, Readonly<Record<string, number>>>>

const ClusterSettingNumberSchema = z.number().finite()

export function readClusterStepSettings(
  config: Readonly<Record<string, unknown>>,
): ClusterStepSettings {
  const out: Record<string, Record<string, number>> = {}
  for (const field of CLUSTER_STEP_SETTING_FIELDS) {
    const parsed = ClusterSettingNumberSchema.safeParse(
      config[clusterStepSettingKey(field.stepId, field.key)],
    )
    const value = parsed.success ? parsed.data : field.default
    const existing = out[field.stepId] ?? {}
    out[field.stepId] = { ...existing, [field.key]: value }
  }
  return out
}

export const DEFAULT_CLUSTER_STEP_SETTINGS: ClusterStepSettings = readClusterStepSettings({})

export function pickClusterStepSettings(view: HydratedClusterView | null): ClusterStepSettings {
  if (view === null) return DEFAULT_CLUSTER_STEP_SETTINGS
  const wanted = new Set(
    CLUSTER_STEP_SETTING_FIELDS.map((field) => clusterStepSettingKey(field.stepId, field.key)),
  )
  return readClusterStepSettings(flattenHydratedView(view, wanted))
}

/**
 * Cluster knobs win over leftover per-device values. The cluster row is the
 * authority; a device-local copy is a leftover of the old per-node editor.
 */
export function overlayClusterStepSettings(
  stepId: string,
  deviceSettings: Readonly<Record<string, unknown>> | undefined,
  cluster: ClusterStepSettings,
): Record<string, unknown> | undefined {
  const overlay = cluster[stepId]
  if (overlay === undefined || Object.keys(overlay).length === 0) {
    return deviceSettings === undefined ? undefined : { ...deviceSettings }
  }
  if (deviceSettings === undefined) return { ...overlay }
  return { ...deviceSettings, ...overlay }
}
