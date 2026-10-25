/**
 * TreeBuilder — converts user pipeline config + step definitions + engines into
 * an executable tree that the PipelineExecutor can traverse.
 */
import type {
  ClassMapDefinition,
  PipelineDefaultStep,
  StepDefinition,
  IInferenceEngine,
  ConfigField,
  ModelCatalogEntry,
  RootStepSupply,
} from '@camstack/types'
import { applyModelBoundSettings, collectModelBoundKeys, rootSuppliesOf } from '@camstack/types'
import { getStep, getStepDefinition } from '../registry/step-definitions.js'

// ---------------------------------------------------------------------------
// Executable tree types
// ---------------------------------------------------------------------------

export interface ExecutableStep {
  readonly stepId: string
  readonly definition: StepDefinition
  readonly engine: IInferenceEngine
  /**
   * The model `engine` RUNS — taken from the resolved pool variant, never from
   * the requested config. The result assembler stamps it on every output
   * (`embeddingModelId`, label `modelId`), so it must be the executed model
   * (D658).
   */
  readonly modelId: string
  readonly inputClasses: readonly string[]
  readonly enabled: boolean
  readonly children: readonly ExecutableStep[]
  readonly settings?: Readonly<Record<string, unknown>>
  /**
   * Class map this root/child actually applies. Resolved per model
   * (`modelEntry.classMap ?? definition.classMap`) so a custom identity map
   * cannot mutate the shared StepDefinition (plus catalog stays COCO_TO_MACRO).
   */
  readonly effectiveClassMap?: ClassMapDefinition
  /**
   * The steps the model that RUNS can supply (D730) — `rootSuppliesOf` the
   * resolved model entry, ROOT steps only. The executor writes a linked label
   * for each label supply and a detail child for each crop supply; whether the
   * camera uses them is decided by the runner (`resolveRootSupply`).
   */
  readonly rootSupplies?: readonly RootStepSupply[]
  // Per-step configurable thresholds live inside `settings` (keyed by whatever
  // name the step declares in its configSchema), hydrated from the schema
  // defaults of the model that runs — see `effective-confidence.ts` (D662).
}

/** Optional lookup for operator-registered models that are not in `definition.models`. */
export type ModelEntryResolver = (stepId: string, modelId: string) => ModelCatalogEntry | undefined

/**
 * Effective class map for `(definition, modelId)` without writing back to the
 * shared StepDefinition. Custom models missing from `definition.models` are
 * resolved through the optional registry callback.
 */
export function resolveEffectiveClassMap(
  definition: StepDefinition,
  modelId: string,
  resolveModel?: ModelEntryResolver,
): ClassMapDefinition | undefined {
  return resolveModelEntry(definition, modelId, resolveModel)?.classMap ?? definition.classMap
}

/** The catalog entry for `(definition, modelId)`: the static catalog, else the custom registry. */
function resolveModelEntry(
  definition: StepDefinition,
  modelId: string,
  resolveModel?: ModelEntryResolver,
): ModelCatalogEntry | undefined {
  return (
    definition.models.find((model) => model.id === modelId) ??
    resolveModel?.(definition.id, modelId)
  )
}

/**
 * The engine for one `(step, model)` pair and the model it actually runs. A
 * lookup that answered by step alone let the tree pair the requested id with
 * whichever variant was active — the D658 incident.
 */
export interface ResolvedStepEngine {
  readonly engine: IInferenceEngine
  readonly modelId: string
}

/** Resolve the engine that runs exactly `modelId` for `stepId`, or throw. */
export type StepEngineLookup = (stepId: string, modelId: string) => ResolvedStepEngine

/**
 * Told when a CHILD step's `(step, model)` variant is not warm at tree-build
 * time. The step and its subtree are dropped from this dispatch and the rest of
 * the tree runs (the per-step rule, D657/D658): one missing enrichment must not
 * cost the frame its root. A ROOT whose variant is missing still throws — there
 * is no frame without it.
 */
export type MissingVariantHandler = (missing: {
  /** The step INSTANCE that left the tree (with its subtree). */
  readonly step: PipelineDefaultStep
  readonly stepId: string
  readonly modelId: string
  readonly parentStepId: string
  readonly droppedSubtree: readonly string[]
  readonly error: string
}) => void

export interface ExecutableTree {
  readonly roots: readonly ExecutableStep[]
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

/**
 * Build an executable tree from user config.
 *
 * @param steps - User-configured pipeline steps (from PipelineDefaultStep[])
 * @param getEngine - Returns the engine that runs exactly `(stepId, modelId)`
 *                    and the model it runs. Throws if that pair is not loaded.
 */
export function buildExecutableTree(
  steps: readonly PipelineDefaultStep[],
  getEngine: StepEngineLookup,
  resolveModel?: ModelEntryResolver,
  onMissingVariant?: MissingVariantHandler,
): ExecutableTree {
  const roots = steps
    .filter((s) => s.enabled)
    // Audio classifier runs independently — not part of the video execution tree
    .filter((s) => s.slot !== 'audio-classifier')
    .map((s) => buildNode(s, getEngine, resolveModel, onMissingVariant))

  return { roots }
}

function subtreeIds(step: PipelineDefaultStep): string[] {
  return [
    step.addonId,
    ...(step.children ?? []).filter((c) => c.enabled).flatMap((c) => subtreeIds(c)),
  ]
}

function buildChild(
  child: PipelineDefaultStep,
  parentStepId: string,
  getEngine: StepEngineLookup,
  resolveModel: ModelEntryResolver | undefined,
  onMissingVariant: MissingVariantHandler | undefined,
): ExecutableStep | null {
  if (onMissingVariant === undefined) {
    return buildNode(child, getEngine, resolveModel, onMissingVariant)
  }
  let variant: ResolvedStepEngine
  try {
    variant = getEngine(child.addonId, child.modelId)
  } catch (err: unknown) {
    onMissingVariant({
      step: child,
      stepId: child.addonId,
      modelId: child.modelId,
      parentStepId,
      droppedSubtree: subtreeIds(child),
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }
  return buildNode(child, getEngine, resolveModel, onMissingVariant, variant)
}

function buildNode(
  step: PipelineDefaultStep,
  getEngine: StepEngineLookup,
  resolveModel?: ModelEntryResolver,
  onMissingVariant?: MissingVariantHandler,
  resolved?: ResolvedStepEngine,
): ExecutableStep {
  const definition = getStepDefinition(step.addonId)
  // The variant that runs THIS model — and its model id is the one the node
  // carries from here on, so the stamp is what ran (D658).
  const variant = resolved ?? getEngine(step.addonId, step.modelId)

  const children = (step.children ?? [])
    .filter((c) => c.enabled)
    .map((c) => buildChild(c, step.addonId, getEngine, resolveModel, onMissingVariant))
    .filter((c): c is ExecutableStep => c !== null)

  // Hydrate the step's configSchema defaults into `settings` so downstream
  // filters (executor.macroFilterVerdict, classifier-children minConfidence,
  // etc.) always have a numeric baseline to compare against.
  //
  // Without this step, a caller that doesn't pass `step.settings` (benchmark
  // runner, first-boot with no per-device overrides, admin UI before first
  // Save) leaves `rootStep.settings === undefined`, and the executor bypass
  // at `macroFilterVerdict` lets every candidate box through the per-macro
  // filter. Combined with the Python postprocessor returning all candidates
  // (Phase 7, "no internal filtering"), this produced ~900 phantom boxes
  // per frame in the benchmark.
  // The schema is asked for the MODEL that runs, so a threshold slider's
  // default is that model's floor when it declares one (D662) — the operator's
  // saved value (`step.settings`) still wins over it.
  //
  // A model-BOUND operator value (D738 — the per-class floors) applies only
  // while the model it was made for runs; for any other model it is dropped
  // here, so that model's default from the schema wins the merge. Checked
  // against `variant.modelId`, the model that RUNS — never a stored pin, which
  // an unpinned root (the elected device's default) does not have.
  const modelEntry = resolveModelEntry(definition, variant.modelId, resolveModel)
  const schema = getStep(step.addonId).getConfigSchema(modelEntry)
  const schemaDefaults = collectSchemaDefaults(schema)
  const operatorSettings = applyModelBoundSettings(
    step.settings,
    collectModelBoundKeys(schema),
    variant.modelId,
  )
  const mergedSettings = { ...schemaDefaults, ...operatorSettings }

  const effectiveClassMap = modelEntry?.classMap ?? definition.classMap

  return {
    stepId: step.addonId,
    definition,
    engine: variant.engine,
    modelId: variant.modelId,
    inputClasses: definition.inputClasses ?? [],
    enabled: step.enabled,
    children,
    ...(Object.keys(mergedSettings).length > 0 ? { settings: mergedSettings } : {}),
    ...(effectiveClassMap !== undefined ? { effectiveClassMap } : {}),
    ...rootSuppliesField(definition, modelEntry),
  }
}

/** A root step's supplies, omitted when it declares none (and for every child step). */
function rootSuppliesField(
  definition: StepDefinition,
  modelEntry: ModelCatalogEntry | undefined,
): { readonly rootSupplies?: readonly RootStepSupply[] } {
  if (definition.inputClasses !== null) return {}
  const supplies = rootSuppliesOf(modelEntry, {
    labels: definition.labels ?? [],
    ...(definition.classMap !== undefined ? { classMap: definition.classMap } : {}),
  })
  return supplies.length > 0 ? { rootSupplies: supplies } : {}
}

/**
 * Collect every field of a step's `getConfigSchema(model)` with a primitive
 * `default` value into a plain record. Group fields are flattened — a nested
 * `{ type: 'group', fields: [...] }` is entered recursively. Fields without a
 * declared default are skipped.
 */
function collectSchemaDefaults(schema: readonly ConfigField[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  walkFieldsForDefaults(schema, out)
  return out
}

function walkFieldsForDefaults(fields: readonly ConfigField[], out: Record<string, unknown>): void {
  for (const field of fields) {
    if ('type' in field && field.type === 'group' && 'fields' in field) {
      walkFieldsForDefaults(field.fields, out)
      continue
    }
    if ('key' in field && 'default' in field && field.default !== undefined) {
      out[field.key] = field.default
    }
  }
}
