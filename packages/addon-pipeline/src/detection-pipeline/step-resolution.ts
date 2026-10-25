import type {
  ClusterStepModels,
  ClusterStepSettings,
  ModelFormat,
  PipelineDefaultStep,
  PipelineStepInput,
  StepDefinition,
} from '@camstack/types'
import { overlayClusterStepSettings, stepModelRunsOnFormat } from '@camstack/types'
import { type ClusterModelRefusal, resolveClusterStepModel } from './cluster-model-resolution.js'
import {
  OBJECT_DETECTION_STEP_ID,
  resolveDefaultDetectionModel,
} from './default-detection-model.js'
import { getStepDefinition, resolveModelForFormat } from './registry/step-definitions.js'

/**
 * A step shape carrying an optional (possibly-absent) chosen modelId: `null`
 * from a persisted default tree, ABSENT (`undefined`) from a wire
 * `PipelineStepInput` — both mean "no explicit pick, use the format default".
 */
export interface ResolvableStep {
  readonly addonId: string
  readonly modelId?: string | null
  readonly enabled: boolean
  readonly children?: readonly ResolvableStep[]
  readonly settings?: Readonly<Record<string, unknown>>
}

export interface ResolvedStep extends ResolvableStep {
  readonly modelId: string
  readonly children?: readonly ResolvedStep[]
}

/**
 * Resolve every step's chosen model to a concrete build for `format`,
 * recursing into children. The single runtime path for BOTH the live
 * per-camera dispatch and the persisted default tree. Use
 * {@link isModelSubstituted} to detect whether a given step's chosen model
 * was substituted (chosen ≠ resolved) so the caller can surface it.
 */
export function resolveStepsForFormat(
  steps: readonly ResolvableStep[],
  format: ModelFormat,
): ResolvedStep[] {
  return steps.map((s): ResolvedStep => {
    const modelId = resolveModelForFormat(s.addonId, s.modelId ?? null, format)
    const children = s.children ? resolveStepsForFormat(s.children, format) : undefined
    const { children: _omittedChildren, ...rest } = s
    return { ...rest, modelId, ...(children ? { children } : {}) }
  })
}

/** True when resolving `chosen` for `format` changed the model (a substitution). */
export function isModelSubstituted(
  addonId: string,
  chosen: string | null,
  format: ModelFormat,
): boolean {
  if (chosen === null) return false
  return resolveModelForFormat(addonId, chosen, format) !== chosen
}

/**
 * A step whose chosen model lacked a build for the resolved `format`, so the
 * addon's format default ran instead. Surfaced to operators so a silent
 * model swap ("chose X → running Y") is visible rather than hidden.
 */
export interface ModelSubstitution {
  readonly addonId: string
  readonly chosen: string
  readonly running: string
  readonly format: string
}

/**
 * Walk `steps` (recursing into children) and return exactly the
 * substitutions in effect for `format` — one entry per step whose chosen
 * model differs from its resolved model. Pure and deterministic: the same
 * `(steps, format)` always yields the same result, with no entries left over
 * from a prior format. Callers that cache substitutions (e.g. for a status
 * surface) should REBUILD their cache from this result on every resolve
 * pass rather than merging into it, so a step that becomes compatible again
 * (chosen === resolved) is dropped instead of going stale.
 */
export function collectSubstitutions(
  steps: readonly ResolvableStep[],
  format: ModelFormat,
): ModelSubstitution[] {
  const result: ModelSubstitution[] = []
  for (const step of steps) {
    const chosen = step.modelId
    if (chosen != null) {
      const running = resolveModelForFormat(step.addonId, chosen, format)
      if (running !== chosen) {
        result.push({ addonId: step.addonId, chosen, running, format })
      }
    }
    if (step.children?.length) {
      result.push(...collectSubstitutions(step.children, format))
    }
  }
  return result
}

/**
 * A step whose FULL catalog has no model at all with a build for `format` —
 * even the addon's format default is unloadable. Distinct from
 * {@link ModelSubstitution}, which reports a degraded-but-loadable swap
 * (chosen model missing, format default runs instead); this reports a step
 * that cannot run on this node's engine at all.
 */
export interface ZeroBuildIssue {
  readonly addonId: string
  readonly format: string
}

/**
 * Return one {@link ZeroBuildIssue} per step in `steps` that a pool of `format`
 * cannot run: neither the model it names nor any NON-legacy model of its
 * catalog (via `getStepDef`) ships a build for `format`
 * (`stepModelRunsOnFormat`, D657). `steps` is
 * expected to already be flattened + filtered to the set the caller cares
 * about (e.g. enabled video steps) — this does not recurse into children or
 * filter by `enabled`, unlike {@link collectSubstitutions}.
 *
 * `getStepDef` defaults to the real catalog lookup and is injectable so
 * tests can exercise the zero-build branch with a fabricated
 * `StepDefinition` — the real catalog currently has no step whose EVERY
 * model lacks a given format, so this branch is otherwise unreachable in a
 * black-box test. Unknown/custom addonIds (no registered `StepDefinition`)
 * are skipped, never thrown.
 */
export function collectZeroBuildIssues(
  steps: readonly { readonly addonId: string; readonly modelId?: string | null }[],
  format: ModelFormat,
  getStepDef: (addonId: string) => StepDefinition = getStepDefinition,
): ZeroBuildIssue[] {
  const result: ZeroBuildIssue[] = []
  for (const step of steps) {
    let def: StepDefinition
    try {
      def = getStepDef(step.addonId)
    } catch {
      continue // unknown/custom addon — no catalog to check against
    }
    // The one placement rule (D657): a legacy stub build counts only when the
    // step names it.
    if (!stepModelRunsOnFormat(def.models, step.modelId, format)) {
      result.push({ addonId: step.addonId, format })
    }
  }
  return result
}

/**
 * A step whose `addonId` has no registered `StepDefinition` at all —
 * distinct from {@link ZeroBuildIssue} (a KNOWN addon whose catalog lacks a
 * build for the format). Surfaced by `validatePipeline` (Gate B) as a HARD
 * issue: an unknown addonId can never run regardless of engine format.
 */
export interface UnknownAddonIssue {
  readonly addonId: string
}

/**
 * Walk `steps` (recursing into children, mirroring {@link collectSubstitutions}'
 * recursion — every step in the tree is checked regardless of `enabled`) and
 * return one {@link UnknownAddonIssue} per addonId whose `getStepDef` lookup
 * throws. Pure, deterministic, never throws itself.
 *
 * `getStepDef` defaults to the real catalog lookup and is injectable so
 * tests can exercise the unknown-addon branch with a fabricated resolver
 * without `vi.mock`.
 */
export function collectUnknownAddonIssues(
  steps: readonly ResolvableStep[],
  getStepDef: (addonId: string) => StepDefinition = getStepDefinition,
): UnknownAddonIssue[] {
  const result: UnknownAddonIssue[] = []
  for (const step of steps) {
    try {
      getStepDef(step.addonId)
    } catch {
      result.push({ addonId: step.addonId })
    }
    if (step.children?.length) {
      result.push(...collectUnknownAddonIssues(step.children, getStepDef))
    }
  }
  return result
}

/** Diagnostics produced by {@link resolveInputSteps} — never thrown, always reported. */
export interface StepResolutionDiagnostics {
  /** `addonId`s from the input tree that have no registered `StepDefinition` — dropped from the output tree. */
  readonly unknownAddonIds: readonly string[]
  /** Steps whose explicit `modelId` lacked a build for `format`, so the format default ran instead. */
  readonly substitutions: readonly ModelSubstitution[]
  /**
   * CLUSTER-scoped steps this node REFUSED and dropped, because the
   * cluster-wide model has no build for `format`.
   *
   * A separate list from {@link substitutions} on purpose. A substitution is a
   * degradation the operator did not ask for but that still produces usable
   * work; this is work NOT DONE, and the two must never share a counter — the
   * remedy for one is "pick a compatible model", for the other it is "this node
   * cannot participate in this index at all".
   */
  readonly clusterRefusals: readonly ClusterModelRefusal[]
  /**
   * CLUSTER-scoped steps DROPPED (with their subtree) because the owner has not
   * yet answered which model the cluster runs (D658). Never defaulted: a
   * default run in the owner's boot window made the default the pool's active
   * variant for the whole process.
   */
  readonly clusterUnknown: readonly string[]
}

/** The cluster steps whose model is not known yet — `ClusterModelSource.unknownSteps()`. */
export type UnknownClusterSteps = Pick<ReadonlyMap<string, unknown>, 'has'>

export interface ResolvedInputSteps {
  readonly steps: PipelineDefaultStep[]
  readonly diagnostics: StepResolutionDiagnostics
}

/**
 * The node's resolved inference accelerator, threaded into
 * {@link resolveInputSteps} so an ABSENT `modelId` on the object-detection
 * step resolves to the HARDWARE-AWARE default
 * (`resolveDefaultDetectionModel` — e.g. intel-gpu → `yolo26m-256`) instead
 * of the flat catalog default (`yolo26n`). Optional: callers without engine
 * context (none in production) keep the flat per-format default.
 */
export interface StepResolutionEngine {
  readonly backend: string
  readonly device: string | null
}

/**
 * Enrich `PipelineStepInput[]` (the wire shape a camera pipeline sends) into
 * `PipelineDefaultStep[]` (the catalog-enriched shape the executor consumes),
 * resolving each step's model for `format` via `resolveModelForFormat`.
 *
 * "Auto" model selection (ABSENT `modelId`) is hardware-aware for the
 * object-detection step when `engine` is provided: the default is resolved
 * via `resolveDefaultDetectionModel(engine.backend, engine.device, format)`.
 * A PINNED `modelId` is kept verbatim (subject to the usual format-build
 * substitution); every other step keeps its flat per-format default.
 *
 * Pure and side-effect-free — never throws. This is the seam behind the
 * LIVE per-camera dispatch path (`DetectionPipelineProvider.
 * inputStepsToPipelineSteps`), which runs once per decoded frame (up to
 * detectionFps × N cameras/sec): a bad step config referencing an unknown
 * `addonId` must never become a per-frame throw. Unknown addons are
 * dropped from the returned tree and reported in
 * `diagnostics.unknownAddonIds`; model substitutions are reported in
 * `diagnostics.substitutions` instead of happening silently. The caller
 * (the provider) owns logging + dedup for both.
 */
export function resolveInputSteps(
  steps: readonly PipelineStepInput[],
  format: ModelFormat,
  engine?: StepResolutionEngine,
  clusterModels?: ClusterStepModels,
  clusterSettings?: ClusterStepSettings,
  unknownClusterSteps?: UnknownClusterSteps,
): ResolvedInputSteps {
  const resolvedSteps: PipelineDefaultStep[] = []
  const unknownAddonIds: string[] = []
  const substitutions: ModelSubstitution[] = []
  const clusterRefusals: ClusterModelRefusal[] = []
  const clusterUnknown: string[] = []
  const recurse = (children: readonly PipelineStepInput[]): ResolvedInputSteps => {
    const r = resolveInputSteps(
      children,
      format,
      engine,
      clusterModels,
      clusterSettings,
      unknownClusterSteps,
    )
    unknownAddonIds.push(...r.diagnostics.unknownAddonIds)
    substitutions.push(...r.diagnostics.substitutions)
    clusterRefusals.push(...r.diagnostics.clusterRefusals)
    clusterUnknown.push(...r.diagnostics.clusterUnknown)
    return r
  }

  for (const s of steps) {
    let def: StepDefinition
    try {
      def = getStepDefinition(s.addonId)
    } catch {
      unknownAddonIds.push(s.addonId)
      continue
    }

    // ── The CLUSTER rule ────────────────────────────────────────────────
    //
    // For a step whose definition declares `modelScope: 'cluster'`, the cluster
    // row is the authority and any incoming `modelId` is a leftover of the
    // per-(node,device) layer, so it is overwritten. What the rule FORBIDS is
    // the substitution every other step gets: when the pinned model has no
    // build for `format`, `resolveModelForFormat` would hand back the format's
    // default encoder, and that is how one vector index ends up filled from two
    // encoders with nothing in the data to show it (D52 one level down; D54's
    // rule for `runStatelessStep`, extended to the live plane).
    //
    // The step is KEPT, carrying the pinned id, and the refusal is reported.
    // Keeping it is load-bearing and was learned from an existing test: today a
    // `face-embedding` dispatched at a Coral (tflite) is rescued by the
    // node-local engine fallback in `resolveStepsForDispatch` and by the
    // detail-plane device jump, both of which key off a step whose model has no
    // build for the format. DROPPING it here would silently take that rescue
    // away and stop producing faces on every mixed-accelerator node — a
    // regression dressed as a safety rule. The refusal is therefore a REFUSAL
    // TO SUBSTITUTE, and the placement machinery keeps doing its job.
    // ── Not known yet: refused by name, never defaulted (D658, D49) ─────
    if (def.modelScope === 'cluster' && unknownClusterSteps?.has(s.addonId) === true) {
      clusterUnknown.push(s.addonId)
      continue
    }

    if (clusterModels !== undefined) {
      const verdict = resolveClusterStepModel(s.addonId, clusterModels, format, () => def)
      if (verdict.kind !== 'node-scoped') {
        if (verdict.kind === 'refused') {
          clusterRefusals.push({
            stepId: s.addonId,
            modelId: verdict.modelId,
            format: verdict.format,
            formatsShipped: verdict.formatsShipped,
          })
        }
        const childResult = s.children ? recurse(s.children) : null
        const settings = overlayClusterStepSettings(s.addonId, s.settings, clusterSettings ?? {})
        resolvedSteps.push({
          addonId: s.addonId,
          addonName: def.name,
          slot: def.slot,
          inputClasses: def.inputClasses ?? [],
          outputClasses: def.outputClasses,
          enabled: s.enabled,
          modelId: verdict.modelId,
          children: childResult ? childResult.steps : [],
          ...(settings ? { settings } : {}),
        })
        continue
      }
    }

    const chosenModelId = s.modelId ?? null
    // Hardware-aware "Auto": an absent modelId on the object-detection step
    // resolves against this node's accelerator class when the caller passed
    // its engine. `resolveDefaultDetectionModel` never returns an id without
    // a `format` build, so no further substitution pass is needed for it.
    const runningModelId =
      chosenModelId === null && engine !== undefined && s.addonId === OBJECT_DETECTION_STEP_ID
        ? resolveDefaultDetectionModel(engine.backend, engine.device, format)
        : resolveModelForFormat(s.addonId, chosenModelId, format)
    if (chosenModelId !== null && runningModelId !== chosenModelId) {
      substitutions.push({
        addonId: s.addonId,
        chosen: chosenModelId,
        running: runningModelId,
        format,
      })
    }

    const childResult = s.children ? recurse(s.children) : null

    const settings = overlayClusterStepSettings(s.addonId, s.settings, clusterSettings ?? {})
    resolvedSteps.push({
      addonId: s.addonId,
      addonName: def.name,
      slot: def.slot,
      inputClasses: def.inputClasses ?? [],
      outputClasses: def.outputClasses,
      enabled: s.enabled,
      modelId: runningModelId,
      children: childResult ? childResult.steps : [],
      ...(settings ? { settings } : {}),
    })
  }

  return {
    steps: resolvedSteps,
    diagnostics: { unknownAddonIds, substitutions, clusterRefusals, clusterUnknown },
  }
}
