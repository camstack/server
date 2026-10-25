/**
 * D214 — step settings are MODEL-scoped.
 *
 * A step's config schema is static, but whether a knob has any effect depends
 * on which model the step actually runs:
 *
 *  - `nmsIouThreshold` is consumed only by decodes that run NMS themselves
 *    (`yolo`, `yolo-seg`, `yolo-split-dfl`, `rfdetr`, `scrfd`, `yunet`). A plus catalog YOLO-NAS export and
 *    the TFLite SSD builds fuse NMS into the graph — the knob is dead there.
 *  - The per-macro sliders (`minConfidencePerson`…) and the macro allow-list
 *    gate on the macro class AFTER the step's `classMap`. A custom labelmap
 *    reaches only the macros its labels map to; every other slider filters a
 *    class that can never arrive.
 *  - A classifier's `enabledClasses` allow-list matches the MODEL's emitted
 *    label strings — for a custom model the offer must be its own labelmap,
 *    or the operator authors a filter that can never match.
 *  - `rectify` (plate-ocr) only exists for readers whose crop policy deskews
 *    (`ctc`); the fixed-slot reader consumes the raw box.
 *
 * This module computes those per-model facts ONCE, server-side, from the same
 * model union the picker offers (static catalog ∪ custom registry), and
 * attaches them to the schema as `ConfigFieldBase.modelApplicability` so the
 * editors can disable-with-reason instead of rendering silent no-ops. It is
 * pure — `buildSchemaSlots` wires it in.
 */
import type {
  ConfigBooleanField,
  ConfigField,
  ConfigFieldModelApplicability,
  ConfigMultiSelectField,
  ConfigNumberField,
  ConfigOption,
  ConfigSelectField,
  ConfigSliderField,
  ModelCatalogEntry,
  PostprocessorType,
  StepDefinition,
} from '@camstack/types'
import { LABEL_SUPPLY_MACRO, rootSuppliesOf } from '@camstack/types'
import { resolveEffectivePostprocessorForEntry } from './effective-postprocessor.js'
import { getStepDefinition } from './step-definitions.js'

/** Decodes that run NMS in the pipeline (and hence consult `nmsIouThreshold`).
 *  Mirrors the Python postprocessors that read the knob — yolo.py,
 *  yolo_seg.py, rfdetr.py, scrfd.py, yunet.py. */
const NMS_CONSUMING_POSTPROCESSORS: ReadonlySet<PostprocessorType> = new Set([
  'yolo',
  'yolo-seg',
  'yolo-split-dfl',
  'rfdetr',
  'scrfd',
  'yunet',
])

/**
 * Does this decode consult `nmsIouThreshold`?
 *
 * ONE predicate for the whole system: the UI disables the slider through
 * {@link annotateConfigSchemaForModels}, and the runtime refuses to forward a
 * value through `resolvePoolDecodeSettings` — both off this set. Two copies of
 * the matrix would let the UI promise an effect the pool does not deliver,
 * which is the failure D214 exists to remove.
 */
export function postprocessorConsumesNms(postprocessor: PostprocessorType): boolean {
  return NMS_CONSUMING_POSTPROCESSORS.has(postprocessor)
}

const MIN_CONFIDENCE_MACRO_PREFIX = 'minConfidence'

/** `minConfidencePerson` → `person`; bare `minConfidence` → null (generic). */
function macroOfMinConfidenceKey(key: string): string | null {
  if (!key.startsWith(MIN_CONFIDENCE_MACRO_PREFIX)) return null
  const rest = key.slice(MIN_CONFIDENCE_MACRO_PREFIX.length)
  if (rest.length === 0) return null
  return rest.charAt(0).toLowerCase() + rest.slice(1)
}

/**
 * The macro classes a model's OWN labelmap can reach through the step's
 * classMap. `undefined` ⇒ the model declares no labels (catalog default
 * labelmap) — every macro of the step is reachable, nothing to annotate.
 */
function reachableMacros(
  def: StepDefinition,
  entry: ModelCatalogEntry,
): ReadonlySet<string> | undefined {
  if (entry.labels.length === 0) return undefined
  const map = entry.classMap ?? def.classMap
  if (!map) {
    // No classMap — the raw class IS the macro (package-detection).
    return new Set(entry.labels.map((l) => l.id))
  }
  if (map.preserveOriginal) return undefined // unmapped labels pass through
  const macros = new Set<string>()
  for (const label of entry.labels) {
    const mapped = map.mapping[label.id]
    if (mapped !== undefined) macros.add(mapped)
  }
  return macros
}

export interface ClassMapDropWarning {
  /** Labels of the model that the step classMap drops before ANY setting runs. */
  readonly unmappedLabels: readonly string[]
  /** Labels that survive the mapping. */
  readonly mappedCount: number
}

/**
 * The labels a custom model declares that the step's dropping classMap
 * (`preserveOriginal: false`) removes UPSTREAM of every operator setting.
 * `null` when the model declares no labels, the step has no classMap, the map
 * preserves originals, or nothing is dropped. The engine factory logs this at
 * pool-config time — a dropped class must never be silent (CLAUDE.md logging
 * rule; the discard trail alone answers "what", not "why zero forever").
 */
export function collectClassMapDropWarning(
  def: StepDefinition,
  entry: ModelCatalogEntry,
): ClassMapDropWarning | null {
  if (entry.labels.length === 0) return null
  const map = entry.classMap ?? def.classMap
  if (!map || map.preserveOriginal) return null
  const unmapped = entry.labels.filter((l) => map.mapping[l.id] === undefined).map((l) => l.id)
  if (unmapped.length === 0) return null
  return {
    unmappedLabels: unmapped,
    mappedCount: entry.labels.length - unmapped.length,
  }
}

export interface AnnotateConfigSchemaInputs {
  readonly def: StepDefinition
  readonly configSchema: readonly ConfigField[]
  /** The step's OFFERED model union — static catalog ∪ custom registry. */
  readonly models: readonly ModelCatalogEntry[]
  /** Which ids of `models` are operator-registered custom models. */
  readonly customModelIds: ReadonlySet<string>
  /**
   * The step's schema as one model sees it (`getConfigSchema(model)`) — the
   * source of a `bindsToModel` field's per-model default (D738), the same
   * call the runner hydrates its settings from. Absent ⇒ no per-model
   * defaults are reported.
   */
  readonly schemaForModel?: (entry: ModelCatalogEntry) => readonly ConfigField[]
}

interface MutableApplicability {
  inapplicable: Record<string, string>
  optionsByModel: Record<string, readonly ConfigOption[]>
  defaultByModel: Record<string, unknown>
}

function toApplicability(acc: MutableApplicability): ConfigFieldModelApplicability | undefined {
  const hasInapplicable = Object.keys(acc.inapplicable).length > 0
  const hasOptions = Object.keys(acc.optionsByModel).length > 0
  const hasDefaults = Object.keys(acc.defaultByModel).length > 0
  if (!hasInapplicable && !hasOptions && !hasDefaults) return undefined
  return {
    ...(hasInapplicable ? { inapplicable: acc.inapplicable } : {}),
    ...(hasOptions ? { optionsByModel: acc.optionsByModel } : {}),
    ...(hasDefaults ? { defaultByModel: acc.defaultByModel } : {}),
  }
}

/** The `default` of `key` in a schema, groups flattened; `undefined` when absent. */
function defaultOfKey(fields: readonly ConfigField[], key: string): unknown {
  for (const field of fields) {
    if (field.type === 'group') {
      const nested = defaultOfKey(field.fields, key)
      if (nested !== undefined) return nested
      continue
    }
    if ('key' in field && field.key === key && 'default' in field) return field.default
  }
  return undefined
}

/** The field kinds a pipeline step's schema uses — all extend ConfigFieldBase,
 *  so `modelApplicability` can be attached. Everything else passes untouched. */
type AnnotatableField =
  | ConfigSliderField
  | ConfigNumberField
  | ConfigMultiSelectField
  | ConfigSelectField
  | ConfigBooleanField

function isAnnotatable(field: ConfigField): field is AnnotatableField {
  return (
    field.type === 'slider' ||
    field.type === 'number' ||
    field.type === 'multiselect' ||
    field.type === 'select' ||
    field.type === 'boolean'
  )
}

function annotateField(field: ConfigField, inputs: AnnotateConfigSchemaInputs): ConfigField {
  if (!isAnnotatable(field)) return field
  const { def, models, customModelIds, schemaForModel } = inputs
  const acc: MutableApplicability = { inapplicable: {}, optionsByModel: {}, defaultByModel: {} }
  const macroKey = macroOfMinConfidenceKey(field.key)

  for (const entry of models) {
    const postprocessor = resolveEffectivePostprocessorForEntry(def, entry)

    // D738 — a field whose default belongs to the model: report each model's
    // default where it differs from the field's own, so the editor shows the
    // value that model runs at (and "reset" returns to it).
    if (field.bindsToModel === true && schemaForModel !== undefined) {
      const modelDefault = defaultOfKey(schemaForModel(entry), field.key)
      if (modelDefault !== undefined && modelDefault !== field.default) {
        acc.defaultByModel[entry.id] = modelDefault
      }
    }

    if (field.key === 'nmsIouThreshold' && !postprocessorConsumesNms(postprocessor)) {
      acc.inapplicable[entry.id] =
        `NMS is fused inside this model's "${postprocessor}" export — the pipeline IoU threshold is not consulted.`
      continue
    }

    if (field.key === 'rectify' && postprocessor !== 'ctc') {
      acc.inapplicable[entry.id] =
        `The "${postprocessor}" reader consumes the raw plate box — its crop policy never deskews, so this switch has no effect.`
      continue
    }

    if (macroKey !== null) {
      const macros = reachableMacros(def, entry)
      if (macros !== undefined && !macros.has(macroKey)) {
        acc.inapplicable[entry.id] =
          `This model's labelmap cannot produce "${macroKey}" — the slider filters a class that never arrives.`
      }
      continue
    }

    if (field.key === 'enabledMacroClasses' && field.type === 'multiselect') {
      const macros = reachableMacros(def, entry)
      if (macros === undefined) continue
      const reachable = field.options.filter((o) => macros.has(o.value))
      if (reachable.length === 0) {
        acc.inapplicable[entry.id] =
          "None of this model's labels map to a macro class the pipeline tracks — every detection it emits is dropped upstream of this filter."
      } else if (reachable.length < field.options.length) {
        acc.optionsByModel[entry.id] = reachable.map((o) => ({
          value: o.value,
          label: o.label,
        }))
      }
      continue
    }

    if (
      field.key === 'enabledClasses' &&
      field.type === 'multiselect' &&
      customModelIds.has(entry.id) &&
      entry.labels.length > 0
    ) {
      // The allow-list matches the MODEL's emitted label strings — a custom
      // model's offer is its own labelmap, never the catalog's.
      acc.optionsByModel[entry.id] = entry.labels.map((l) => ({
        value: l.id,
        label: l.name,
      }))
      continue
    }
  }

  const applicability = toApplicability(acc)
  if (applicability === undefined) return field
  return { ...field, modelApplicability: applicability }
}

/**
 * Decorate a step's config schema with per-model applicability, computed from
 * the same model union the picker offers. Fields with nothing to say are
 * returned untouched (identity), so a static-only step with fully-consuming
 * models produces a byte-identical schema.
 */
export function annotateConfigSchemaForModels(inputs: AnnotateConfigSchemaInputs): ConfigField[] {
  return inputs.configSchema.map((field) => annotateField(field, inputs))
}

/** The slider that governs a root-supplied fine label (D741) — the step's own threshold. */
const SUPPLIED_LABEL_FLOOR_KEY = 'minConfidence'

/**
 * D741 — when a ROOT detector supplies a step's fine label (species, vehicle
 * type), the step's `minConfidence` slider is the floor on the root's
 * DETECTION score for that label, bound to the root model. So for each root
 * model that supplies `stepId`'s labels, the slider's default under that model
 * is the root's `suppliedLabelFloors[stepId]`, or 0 (no floor beyond the macro
 * floor). Added to `modelApplicability.defaultByModel`, keyed by root model id,
 * so the editor — which shows the slider under the ROOT's id while the root
 * supplies the step — shows the floor the runner applies. A step no root
 * supplies a fine label for is returned untouched.
 */
export function withRootSuppliedLabelDefaults(
  stepId: string,
  configSchema: readonly ConfigField[],
  rootModels: readonly ModelCatalogEntry[],
): ConfigField[] {
  if (!isFineLabelSupplyStep(stepId)) return [...configSchema]
  const rootDef = getStepDefinition(ROOT_STEP_ID)
  const defaults: Record<string, unknown> = {}
  for (const root of rootModels) {
    const supplies = rootSuppliesOf(root, {
      labels: rootDef.labels ?? [],
      ...(rootDef.classMap !== undefined ? { classMap: rootDef.classMap } : {}),
    })
    if (!supplies.some((s) => s.kind === 'label' && s.stepId === stepId)) continue
    defaults[root.id] = root.suppliedLabelFloors?.[stepId] ?? 0
  }
  if (Object.keys(defaults).length === 0) return [...configSchema]
  return configSchema.map((field) => {
    if (field.type !== 'slider' || field.key !== SUPPLIED_LABEL_FLOOR_KEY) return field
    return {
      ...field,
      modelApplicability: {
        ...field.modelApplicability,
        defaultByModel: { ...field.modelApplicability?.defaultByModel, ...defaults },
      },
    }
  })
}

/** The camera root the supplies are read from. */
const ROOT_STEP_ID = 'object-detection'

/**
 * A label-supply step whose effect is FINER than its macro (species, vehicle
 * type). `package-detection` is a label supply too, but its effect IS its
 * macro: it has no fine label and its threshold is `minConfidencePackage`.
 */
function isFineLabelSupplyStep(stepId: string): boolean {
  return Object.keys(LABEL_SUPPLY_MACRO).includes(stepId) && stepId !== 'package-detection'
}
