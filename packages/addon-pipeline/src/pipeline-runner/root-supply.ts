/**
 * The runner's half of root-model supply (D715, D730).
 *
 * The runner holds the camera's WHOLE step tree (the attach config), so it is
 * the one place that can answer "does this camera use the root's output for
 * this step?": the root model's declaration (`rootSuppliesOf`) against the
 * step's own `useRootModel` flag, through the one decision `resolveRootSupply`.
 * Four consumers read that answer:
 *
 *  - linked labels — effective ⇒ raised to the detection's score (the root is
 *    the one writer), or DROPPED when the step's class list switched that
 *    class off (the detection stays at its macro); otherwise the score-0
 *    fallback the executor wrote;
 *  - root child boxes — a `plate` / `face` detail the root drew is kept only
 *    when its crop step's supply is effective;
 *  - the `detailSteps` announce — an effective step carries `filledBy` +
 *    `filledAs`, so post-analysis does not infer it;
 *  - `package-detection` — effective ⇒ the package root is not dispatched and
 *    the root's own `package` boxes ARE the package result.
 *
 * Pure: the caller passes the model resolver; no I/O, no clock.
 */
import {
  allowedSuppliedEffect,
  resolveModelBoundSetting,
  type FrameResult,
  linkedStepOf,
  type ModelCatalogEntry,
  type ObjectDetection,
  type PipelineStepInputOutput,
  resolveRootSupply,
  ROOT_SUPPLIABLE_STEP_IDS,
  rootSuppliesOf,
  type RootSuppliableStepId,
  type RootSupplyState,
  type ScoredLabel,
} from '@camstack/types'
import { resolveDefaultDetectionModel } from '../detection-pipeline/default-detection-model.js'
import { resolveDeviceEngine } from '../detection-pipeline/engine/resolve-device-engine.js'
import { getStep, getStepDefinition } from '../detection-pipeline/registry/step-definitions.js'

/** The root step the supplies are read from — the always-on camera root. */
export const ROOT_SUPPLY_ROOT_STEP_ID = 'object-detection'
const PACKAGE_STEP_ID = 'package-detection'
const PACKAGE_THRESHOLD_KEY = 'minConfidencePackage'

/** Resolve the catalog entry (static or custom) a step's model id names. */
export type RootModelResolver = (stepId: string, modelId: string) => ModelCatalogEntry | undefined

/** One step's state plus the settings its class filter reads. */
export interface PlannedRootSupply extends RootSupplyState {
  readonly settings?: Readonly<Record<string, unknown>>
  /**
   * The minimum DETECTION score from which a supplied fine label is taken
   * (D741): the step's `minConfidence` when bound to the ROOT model, else the
   * root's `suppliedLabelFloors` default, else 0. `>= 1` = never.
   */
  readonly labelFloor: number
}

/** The step slider that governs a supplied label — one knob per step (D741). */
const SUPPLIED_LABEL_FLOOR_KEY = 'minConfidence'

/**
 * The floor a supplied label must clear for one step, under the D738 binding
 * rule against the ROOT model: an operator value made for the root applies; one
 * made for the step's own classifier does not (another scale); the root's
 * measured floor is the default, and no floor at all when it declares none.
 */
function suppliedLabelFloor(
  stepId: string,
  settings: Readonly<Record<string, unknown>> | undefined,
  rootModelId: string,
  rootEntry: ModelCatalogEntry | undefined,
): number {
  const state = resolveModelBoundSetting(
    settings,
    SUPPLIED_LABEL_FLOOR_KEY,
    rootModelId,
    rootEntry?.suppliedLabelFloors?.[stepId] ?? 0,
    0,
  )
  return typeof state.value === 'number' ? state.value : 0
}

/** Every suppliable step's state for one camera. */
export interface RootSupplyPlan {
  /** The model the root runs — `filledBy` on an announce. */
  readonly rootModelId?: string
  readonly states: ReadonlyMap<RootSuppliableStepId, PlannedRootSupply>
}

export const EMPTY_ROOT_SUPPLY_PLAN: RootSupplyPlan = { states: new Map() }

/** The step `addonId` when it is in the tree AND switched on — the per-camera gate's answer. */
function findEnabledStep(
  steps: readonly PipelineStepInputOutput[],
  addonId: string,
): PipelineStepInputOutput | undefined {
  for (const step of steps) {
    if (step.enabled === false) continue
    if (step.addonId === addonId) return step
    const nested = step.children !== undefined ? findEnabledStep(step.children, addonId) : undefined
    if (nested !== undefined) return nested
  }
  return undefined
}

/**
 * The model an UNPINNED root runs on the elected device — the executor's own
 * rule (`resolveDefaultDetectionModel` on the device's backend, accelerator and
 * format), so the supplies are read off the model that really runs. Before
 * this, an unpinned root was judged as the step's flat `defaultModelId`
 * (`yolo26n`) on every accelerator, while an Intel GPU ran `yolov9m-320-int8`
 * and a Coral an SSD: `filledBy` named a model that was not running, and a
 * crop supply's input-size gate (D731) measured the wrong model. No elected
 * device (the runner's default pool) or an unknown backend ⇒ the flat default.
 */
function unpinnedRootModelId(deviceKey: string | undefined, flatDefault: string): string {
  if (deviceKey === undefined) return flatDefault
  try {
    const engine = resolveDeviceEngine(deviceKey)
    return resolveDefaultDetectionModel(engine.backend, engine.device ?? null, engine.format)
  } catch {
    return flatDefault
  }
}

/**
 * Plan a camera's root supplies from its configured tree.
 *
 * - The root's model is the one the executor runs: its pin, else the
 *   hardware-aware default of the elected device (`deviceKey`).
 * - Only a step the camera RUNS is planned. A suppliable step that is absent
 *   from the tree or switched off (the per-camera gate) has no state: the
 *   operator switched that function off, so the root's labels are not made
 *   authoritative for it, its root child boxes are removed, and nothing logs
 *   that the root "supplies" it. Before this, a camera whose classifiers were
 *   gated OFF logged `root model supplies a pipeline step` for both of them
 *   and raised the root's labels to the detection score anyway (D736).
 */
export function planRootSupplies(
  steps: readonly PipelineStepInputOutput[] | undefined,
  resolveModel: RootModelResolver,
  deviceKey?: string,
): RootSupplyPlan {
  if (steps === undefined) return EMPTY_ROOT_SUPPLY_PLAN
  const root = steps.find((s) => s.addonId === ROOT_SUPPLY_ROOT_STEP_ID && s.enabled !== false)
  if (root === undefined) return EMPTY_ROOT_SUPPLY_PLAN
  const definition = getStepDefinition(ROOT_SUPPLY_ROOT_STEP_ID)
  const rootModelId = root.modelId ?? unpinnedRootModelId(deviceKey, definition.defaultModelId)
  const rootEntry = resolveModel(ROOT_SUPPLY_ROOT_STEP_ID, rootModelId)
  const supplies = rootSuppliesOf(rootEntry, {
    labels: definition.labels ?? [],
    ...(definition.classMap !== undefined ? { classMap: definition.classMap } : {}),
  })
  const states = new Map<RootSuppliableStepId, PlannedRootSupply>()
  for (const stepId of ROOT_SUPPLIABLE_STEP_IDS) {
    const step = findEnabledStep(steps, stepId)
    if (step === undefined) continue
    const settings = step.settings
    states.set(stepId, {
      ...resolveRootSupply(stepId, settings, supplies),
      ...(settings !== undefined ? { settings } : {}),
      labelFloor: suppliedLabelFloor(stepId, settings, rootModelId, rootEntry),
    })
  }
  return { rootModelId, states }
}

/** How an effective step is supplied — what the announce carries. */
export interface SuppliedStep {
  readonly modelId: string
  readonly kind: 'label' | 'crop'
}

/** The steps whose supply is effective, with the model and the kind. */
export function suppliedSteps(plan: RootSupplyPlan): ReadonlyMap<string, SuppliedStep> {
  const out = new Map<string, SuppliedStep>()
  if (plan.rootModelId === undefined) return out
  for (const [stepId, state] of plan.states) {
    // A mask supply fills a frame-plane step (`segmentation`), which is never
    // announced to the detail plane: `root-mask-supply.ts` owns it (D737).
    if (state.effective && state.supply !== undefined && state.supply.kind !== 'mask') {
      out.set(stepId, { modelId: plan.rootModelId, kind: state.supply.kind })
    }
  }
  return out
}

/** The steps whose supply just BECAME effective between two plans. */
export function newlySuppliedSteps(
  previous: RootSupplyPlan | undefined,
  next: RootSupplyPlan,
): readonly RootSuppliableStepId[] {
  const out: RootSuppliableStepId[] = []
  for (const [stepId, state] of next.states) {
    if (state.effective && previous?.states.get(stepId)?.effective !== true) out.push(stepId)
  }
  return out
}

function authoritativeLabels(
  detection: ObjectDetection,
  plan: RootSupplyPlan,
): readonly ScoredLabel[] | undefined {
  let changed = false
  const labels: ScoredLabel[] = []
  for (const label of detection.labels) {
    const stepId = linkedStepOf(label.stepId)
    const state = stepId !== undefined ? plan.states.get(stepId) : undefined
    if (state === undefined || !state.effective) {
      labels.push(label)
      continue
    }
    // Effective: the root is the one writer — unless the step's class list
    // switched this class off, in which case the detection keeps its macro.
    if (!allowedSuppliedEffect(label.label, state.settings)) {
      changed = true
      continue
    }
    // Below the root's label floor (D741) the root is not sure enough of the
    // FINE class: the label goes, the detection keeps its macro.
    if (state.labelFloor >= 1 || detection.score < state.labelFloor) {
      changed = true
      continue
    }
    if (label.score === detection.score) {
      labels.push(label)
      continue
    }
    changed = true
    labels.push({ ...label, score: detection.score })
  }
  return changed ? labels : undefined
}

/** Whether a root child box survives: only under an effective crop supply. */
function keepsDetection(detection: ObjectDetection, plan: RootSupplyPlan): boolean {
  const supplied = detection.rootSupplied
  if (supplied === undefined || detection.kind !== 'detail') return true
  const stepId = ROOT_SUPPLIABLE_STEP_IDS.find((id) => id === supplied.stepId)
  return stepId !== undefined && plan.states.get(stepId)?.effective === true
}

/**
 * Apply the plan to a frame: linked labels of an effective step become
 * authoritative (or are dropped by its class list), and root child boxes of a
 * crop step that is not effective are removed. Never mutates; returns the
 * input when nothing changes.
 */
export function applyRootSupplyAuthority(result: FrameResult, plan: RootSupplyPlan): FrameResult {
  if (plan.states.size === 0) return result
  let changed = false
  const detections: ObjectDetection[] = []
  for (const d of result.detections) {
    if (!keepsDetection(d, plan)) {
      changed = true
      continue
    }
    const labels = authoritativeLabels(d, plan)
    if (labels === undefined) {
      detections.push(d)
      continue
    }
    changed = true
    detections.push({ ...d, labels })
  }
  return changed ? { ...result, detections } : result
}

/** What {@link applyPackageFill} did to the dispatched tree. */
export interface PackageFillOutcome {
  readonly steps: readonly PipelineStepInputOutput[]
  /** The root's own `package` boxes are this frame's package result. */
  readonly filledByRoot: boolean
}

/** The root step's schema default for its class allow-list. */
function rootDefaultMacroClasses(): readonly unknown[] {
  const field = getStep(ROOT_SUPPLY_ROOT_STEP_ID)
    .getConfigSchema()
    .find((f) => 'key' in f && f.key === 'enabledMacroClasses')
  const value = field !== undefined && 'default' in field ? field.default : undefined
  return Array.isArray(value) ? value : []
}

function withPackageAdmitted(
  root: PipelineStepInputOutput,
  packageStep: PipelineStepInputOutput,
): PipelineStepInputOutput {
  const settings = root.settings ?? {}
  // Absent ⇒ the schema default the tree-builder would hydrate (which does not
  // offer `package`); an explicit EMPTY list means every class already.
  const stored = settings['enabledMacroClasses']
  const enabled = Array.isArray(stored) ? stored : rootDefaultMacroClasses()
  const admitted =
    enabled.length > 0 && !enabled.includes('package')
      ? { enabledMacroClasses: [...enabled, 'package'] }
      : {}
  // ONE package threshold: the package step's own slider, carried onto the
  // root's per-macro gate (`minConfidencePackage` is the key that gate reads).
  const threshold = packageStep.settings?.[PACKAGE_THRESHOLD_KEY]
  const gate = typeof threshold === 'number' ? { [PACKAGE_THRESHOLD_KEY]: threshold } : {}
  return { ...root, settings: { ...settings, ...admitted, ...gate } }
}

/**
 * When the root's `package` supply is effective for this camera, drop the
 * package root from the dispatch and let the camera root report packages: its
 * gate admits `package` at the package step's threshold. Otherwise (the root
 * declares no `package`, or the flag is off) the tree is returned untouched
 * and the package step runs its own model.
 */
export function applyPackageFill(
  steps: readonly PipelineStepInputOutput[],
  plan: RootSupplyPlan,
): PackageFillOutcome {
  if (plan.states.get(PACKAGE_STEP_ID)?.effective !== true) return { steps, filledByRoot: false }
  const packageStep = steps.find((s) => s.addonId === PACKAGE_STEP_ID)
  if (packageStep === undefined || packageStep.enabled === false) {
    return { steps, filledByRoot: false }
  }
  const next = steps
    .filter((s) => s.addonId !== PACKAGE_STEP_ID)
    .map((s) =>
      s.addonId === ROOT_SUPPLY_ROOT_STEP_ID && s.enabled !== false
        ? withPackageAdmitted(s, packageStep)
        : s,
    )
  return { steps: next, filledByRoot: true }
}
