/**
 * Root-model supply — the ONE place that says which pipeline steps a root
 * detector can supply from its own output, how, and whether the camera uses it.
 *
 * A root detector's labels can already be the effect a step exists to produce:
 * a plus catalog model emits `deer`, `car`, `package`, a COCO model emits `dog`,
 * `bus`. Some also emit the CHILD boxes a detail step exists to find: a
 * plus catalog `license_plate` inside a car, a `face` inside a person. Every root
 * model DECLARES what it can supply (`ModelCatalogEntry.suppliesSteps`),
 * derived from its own labelmap and classMap by {@link deriveRootSupplies} —
 * never assumed per family. Whether a camera USES that is the step's own
 * `useRootModel` flag, an operator intent kept beside the step's `modelId`
 * and never touching it (D730). {@link resolveRootSupply} is the one decision
 * the runner, the detail dispatcher and the admin UI all read.
 *
 * Three kinds of supply:
 * - `label` — the root's raw class IS the step's answer (`deer` for the animal
 *   classifier). The detection carries it as a linked label.
 * - `crop` — the root draws the box the step would have found (a plate inside
 *   a vehicle). The box becomes a detail child of the parent that contains it,
 *   never a track of its own (D683).
 * - `mask` — the root's decode emits an instance mask per detection (a
 *   YOLO26-seg root), which IS the `segmentation` step's result (D737).
 *
 * Pure — no I/O, no clock.
 */
import type { ModelCatalogEntry, RootStepSupply } from '../types/models.js'
import type { PostprocessorType } from '../types/pipeline-step.js'

/** Steps whose effect a root label can BE. */
export const LABEL_SUPPLY_STEP_IDS = [
  'animal-classifier',
  'vehicle-classifier',
  'package-detection',
] as const
export type LabelSupplyStepId = (typeof LABEL_SUPPLY_STEP_IDS)[number]

/** Steps whose box a root detection can BE. */
export const CROP_SUPPLY_STEP_IDS = ['plate-detection', 'face-detection'] as const
export type CropSupplyStepId = (typeof CROP_SUPPLY_STEP_IDS)[number]

/**
 * Steps whose per-detection MASK a root detection can carry (D737). The live
 * mask step is `segmentation` — a frame-plane refiner that runs its own model
 * once per detection crop. (`instance-segmentation` is a dormant step id that
 * no camera tree carries.)
 */
export const MASK_SUPPLY_STEP_IDS = ['segmentation'] as const
export type MaskSupplyStepId = (typeof MASK_SUPPLY_STEP_IDS)[number]

/** Every step a root model can supply. */
export const ROOT_SUPPLIABLE_STEP_IDS = [
  ...LABEL_SUPPLY_STEP_IDS,
  ...CROP_SUPPLY_STEP_IDS,
  ...MASK_SUPPLY_STEP_IDS,
] as const
export type RootSuppliableStepId = LabelSupplyStepId | CropSupplyStepId | MaskSupplyStepId

/** Narrow a step id to a suppliable one — type guard, not a cast. */
export function isRootSuppliableStepId(value: string): value is RootSuppliableStepId {
  return ROOT_SUPPLIABLE_STEP_IDS.some((id) => id === value)
}

/** Narrow a step id to a label-kind one. */
export function isLabelSupplyStepId(value: string): value is LabelSupplyStepId {
  return LABEL_SUPPLY_STEP_IDS.some((id) => id === value)
}

/**
 * The EFFECT vocabulary of each label-kind step: exactly the strings the step
 * itself emits, in its own spelling. A linked label is one of these and nothing
 * else, so a tier-1 value means the same thing whichever writer produced it.
 *
 * - `animal-classifier`: the PRIMARY model's `-labels.json` (Open Images V7,
 *   8 classes) — also the species allow-list the step offers.
 * - `vehicle-classifier`: the classifier's labels, capitalised as it emits them
 *   (it writes `winner.class` verbatim).
 * - `package-detection`: its one output class.
 *
 * `scripts/check-label-link-vocabulary.ts` fails the build if a declared
 * `labelToEffect` names anything outside this table.
 */
export const LABEL_SUPPLY_VOCABULARIES: Readonly<Record<LabelSupplyStepId, readonly string[]>> = {
  'animal-classifier': ['bird', 'cat', 'cow', 'deer', 'dog', 'horse', 'sheep', 'squirrel'],
  'vehicle-classifier': [
    'Ambulance',
    'Bicycle',
    'Bus',
    'Car',
    'Motorcycle',
    'Taxi',
    'Truck',
    'Van',
  ],
  'package-detection': ['package'],
}

/** The macro a detection must carry for a label-kind step to apply to it. */
export const LABEL_SUPPLY_MACRO: Readonly<Record<LabelSupplyStepId, string>> = {
  'animal-classifier': 'animal',
  'vehicle-classifier': 'vehicle',
  'package-detection': 'package',
}

/**
 * Raw detector labels that name a vocabulary entry under another spelling.
 * Case-insensitive equality covers the rest (`car` → `Car`).
 */
const EFFECT_ALIASES: Readonly<Record<LabelSupplyStepId, Readonly<Record<string, string>>>> = {
  'animal-classifier': {},
  'vehicle-classifier': { school_bus: 'Bus', garbage_truck: 'Truck' },
  'package-detection': {},
}

/** What a crop-kind supply is made of. */
export interface CropSupplySource {
  /** Raw root labels that ARE this step's box. */
  readonly rootLabels: readonly string[]
  /** The macro of the parent the box must lie inside. */
  readonly parentMacro: 'vehicle' | 'person'
  /** The detail class the box becomes. */
  readonly childClass: 'plate' | 'face'
  /**
   * The step's own children that still run on the root's box: `plate-ocr`
   * reads a root plate, `face-embedding` embeds a refined root face.
   */
  readonly servedChildSteps: readonly string[]
  /**
   * How the root's box stands in for the step's inference.
   * - `as-output`: the box IS the step's output (a plate box goes straight to
   *   the reader).
   * - `refine`: the box is only a LOCATION. The step's own detector re-finds
   *   the subject inside a square around it (`deriveRootFaceRefineRect`) so
   *   its children get what they need — a face's landmarks — and nothing
   *   unaligned ever reaches the embedder. No face found ⇒ nothing.
   */
  readonly use: 'as-output' | 'refine'
  /**
   * The root's smallest input side for the supply to be in force. A root that
   * sees the frame smaller than this misses too many of these boxes to be the
   * source (a 320 px root loses ~60% of the faces a 640 one finds on 4K
   * cameras). Absent ⇒ any root.
   */
  readonly minRootInputPx?: number
}

export const CROP_SUPPLY_SOURCES: Readonly<Record<CropSupplyStepId, CropSupplySource>> = {
  'plate-detection': {
    rootLabels: ['license_plate'],
    parentMacro: 'vehicle',
    childClass: 'plate',
    servedChildSteps: ['plate-ocr'],
    use: 'as-output',
  },
  'face-detection': {
    rootLabels: ['face'],
    parentMacro: 'person',
    childClass: 'face',
    servedChildSteps: ['face-embedding'],
    use: 'refine',
    minRootInputPx: 640,
  },
}

/**
 * Whether an operator intends a step to take the root's output when the
 * root declares it — the default of the `useRootModel` flag. The label kinds
 * default ON: the detector's answer is the cheaper one and the classifier
 * keeps its model for the day the root changes. The animal and vehicle
 * classifiers are also ENABLED by default (their catalog `enabledByDefault`,
 * D736), so out of the box a root that declares them names animals and
 * vehicles and a root that does not runs the classifier; `package-detection`
 * stays zone-driven and takes this default whenever a zone switches it on.
 * The crop kinds default OFF: a
 * root plate box has an uncalibrated OCR margin, and root-face refinement has
 * not run on live traffic yet.
 */
export const USE_ROOT_MODEL_DEFAULTS: Readonly<Record<RootSuppliableStepId, boolean>> = {
  'animal-classifier': true,
  'vehicle-classifier': true,
  'package-detection': true,
  'plate-detection': false,
  'face-detection': false,
  // The mask kind defaults ON like the label kinds (D737): a seg root's masks
  // cost nothing more once it runs, while the step's own model runs once per
  // detection crop. The `segmentation` step itself stays opt-in — the flag only
  // decides where its masks come from.
  segmentation: true,
}

/** The step-settings key the flag is stored under (DeviceStepConfig.settings, camera overrides). */
export const USE_ROOT_MODEL_SETTING_KEY = 'useRootModel'

/**
 * The retired D715 policy key. A `skip-when-filled` / `run` value still
 * stored under it reads as the flag (`true` / `false`) when no flag is stored
 * — the normal read path, not a migration.
 */
const RETIRED_LABEL_LINK_KEY = 'labelLink'

/** `ScoredLabel.stepId` prefix of a label the detector wrote for a step. */
export const LINKED_LABEL_STEP_PREFIX = 'detector-link:'

/** `detector-link:<stepId>` — the attribution of a linked label. */
export function linkedLabelStepId(stepId: LabelSupplyStepId): string {
  return `${LINKED_LABEL_STEP_PREFIX}${stepId}`
}

/** The step a linked label stands in for, or `undefined` for any other attribution. */
export function linkedStepOf(attributionStepId: string | undefined): LabelSupplyStepId | undefined {
  if (attributionStepId === undefined) return undefined
  if (!attributionStepId.startsWith(LINKED_LABEL_STEP_PREFIX)) return undefined
  const stepId = attributionStepId.slice(LINKED_LABEL_STEP_PREFIX.length)
  return isLabelSupplyStepId(stepId) ? stepId : undefined
}

function effectFor(stepId: LabelSupplyStepId, label: string): string | undefined {
  const alias = EFFECT_ALIASES[stepId][label]
  if (alias !== undefined) return alias
  const folded = label.toLowerCase()
  return LABEL_SUPPLY_VOCABULARIES[stepId].find((v) => v.toLowerCase() === folded)
}

/** The classMap shape the derivation reads. */
export interface SupplyClassMap {
  readonly mapping: Readonly<Record<string, string>>
}

/**
 * Which steps a root detector can supply, from its labelmap and classMap.
 *
 * - label kind: a label counts for a step only when the classMap sends it to
 *   that step's macro AND it names a vocabulary entry. Every root is judged
 *   the same way — a COCO model supplies the animal classifier with the six
 *   species COCO names, exactly as a plus catalog model supplies seven.
 * - crop kind: the labelmap carries one of the step's root labels. Those
 *   labels are deliberately left out of the classMap, so they never make a
 *   track of their own.
 *
 * No classMap ⇒ no label supply (nothing says which macro a label lives under).
 */
export function deriveRootSupplies(
  labels: readonly string[],
  classMap: SupplyClassMap | undefined,
): readonly RootStepSupply[] {
  const supplies: RootStepSupply[] = []
  if (classMap !== undefined) {
    for (const stepId of LABEL_SUPPLY_STEP_IDS) {
      const labelToEffect: Record<string, string> = {}
      for (const label of labels) {
        if (classMap.mapping[label] !== LABEL_SUPPLY_MACRO[stepId]) continue
        const effect = effectFor(stepId, label)
        if (effect !== undefined) labelToEffect[label] = effect
      }
      const covered = new Set(Object.values(labelToEffect))
      if (covered.size === 0) continue
      const uncovered = LABEL_SUPPLY_VOCABULARIES[stepId].filter((v) => !covered.has(v))
      supplies.push({ kind: 'label', stepId, labelToEffect, uncovered })
    }
  }
  const present = new Set(labels)
  for (const stepId of CROP_SUPPLY_STEP_IDS) {
    const source = CROP_SUPPLY_SOURCES[stepId]
    const rootLabels = source.rootLabels.filter((l) => present.has(l))
    if (rootLabels.length === 0) continue
    supplies.push({
      kind: 'crop',
      stepId,
      rootLabels,
      parentMacro: source.parentMacro,
      childClass: source.childClass,
    })
  }
  return supplies
}

/**
 * The decodes that emit an instance mask with every detection — a fact of the
 * model's OUTPUT, read from its postprocessor (`yolo-seg`: per-instance mask
 * coefficients times the prototype masks), never assumed per family.
 */
export const MASK_EMITTING_POSTPROCESSORS: readonly PostprocessorType[] = ['yolo-seg']

/**
 * The mask supplies a root declares from its decode: `segmentation` when the
 * postprocessor emits a mask per detection, nothing otherwise.
 */
export function deriveMaskSupplies(
  postprocessor: PostprocessorType | undefined,
): readonly RootStepSupply[] {
  if (postprocessor === undefined || !MASK_EMITTING_POSTPROCESSORS.includes(postprocessor)) {
    return []
  }
  return MASK_SUPPLY_STEP_IDS.map((stepId) => ({ kind: 'mask', stepId }))
}

/** What a step definition contributes when a model entry carries no labels/classMap of its own. */
export interface RootSupplyStepDefaults {
  readonly labels: readonly string[]
  readonly classMap?: SupplyClassMap
}

/**
 * The supplies a root model declares. A row registered with a declaration
 * carries it (`suppliesSteps`, computed at import from the model's own
 * labelmap); a row without one — a built-in entry, or a custom row registered
 * before the field existed — is derived here, on read, from the same inputs.
 */
export function rootSuppliesOf(
  entry:
    | Pick<
        ModelCatalogEntry,
        'labels' | 'classMap' | 'suppliesSteps' | 'inputSize' | 'postprocessor'
      >
    | undefined,
  stepDefaults: RootSupplyStepDefaults,
): readonly RootStepSupply[] {
  const fromLabels =
    entry?.suppliesSteps ??
    deriveRootSupplies(
      entry !== undefined && entry.labels.length > 0
        ? entry.labels.map((l) => l.id)
        : stepDefaults.labels,
      entry?.classMap ?? stepDefaults.classMap,
    )
  // A mask supply is a fact of the model's DECODE, not of its labelmap, so it
  // is derived on read from the entry's postprocessor — for a stored
  // declaration too, which an import computes from labels alone.
  const masks = deriveMaskSupplies(entry?.postprocessor).filter(
    (m) => !fromLabels.some((s) => s.stepId === m.stepId),
  )
  const declared = masks.length > 0 ? [...fromLabels, ...masks] : fromLabels
  // A crop supply carries the root's input side — what a `minRootInputPx`
  // gate judges. It is a fact of the MODEL, so it is stamped here, on read,
  // from the entry, never stored apart from it.
  const inputPx =
    entry !== undefined ? Math.min(entry.inputSize.width, entry.inputSize.height) : undefined
  if (inputPx === undefined) return declared
  return declared.map((s) => (s.kind === 'crop' ? { ...s, rootInputPx: inputPx } : s))
}

/** The supply a root declares for one step, if any. */
export function supplyFor(
  supplies: readonly RootStepSupply[] | undefined,
  stepId: string,
): RootStepSupply | undefined {
  return supplies?.find((s) => s.stepId === stepId)
}

/**
 * Read the `useRootModel` flag off a step's settings bag. Absent ⇒ the
 * retired `labelLink` value if one is stored, else the step's default.
 */
export function readUseRootModel(
  stepId: RootSuppliableStepId,
  settings: Readonly<Record<string, unknown>> | undefined,
): boolean {
  const raw = settings?.[USE_ROOT_MODEL_SETTING_KEY]
  if (typeof raw === 'boolean') return raw
  const retired = settings?.[RETIRED_LABEL_LINK_KEY]
  if (retired === 'skip-when-filled') return true
  if (retired === 'run') return false
  return USE_ROOT_MODEL_DEFAULTS[stepId]
}

/** One step's root-supply state for one camera (or one node/device column). */
export interface RootSupplyState {
  readonly stepId: RootSuppliableStepId
  /** What the current root declares for this step, if anything. */
  readonly supply: RootStepSupply | undefined
  /** The operator's `useRootModel` intent (stored or default). */
  readonly intent: boolean
  /**
   * The root's output IS this step's result: the step's own inference does
   * not run and the root's linked label / child box is authoritative.
   * `intent && supply && nothing blocks it`.
   */
  readonly effective: boolean
  /** Intent is on but the current root cannot supply the step. */
  readonly inactive: boolean
  /** Why an intended supply is not in force — present iff `inactive`. */
  readonly inactiveReason?: RootSupplyInactiveReason
}

/**
 * Why an intended root supply is not in force.
 * - `root-does-not-declare`: the root's labels cannot supply the step.
 * - `root-input-too-small`: they can, but the root sees the frame smaller than
 *   the step's `minRootInputPx` (or its input size is unknown).
 */
export type RootSupplyInactiveReason = 'root-does-not-declare' | 'root-input-too-small'

/** Why a DECLARED supply is still not usable, or `undefined` when it is. */
function supplyBlocker(supply: RootStepSupply): RootSupplyInactiveReason | undefined {
  if (supply.kind !== 'crop') return undefined
  const min = CROP_SUPPLY_SOURCES[supply.stepId].minRootInputPx
  if (min === undefined) return undefined
  return supply.rootInputPx !== undefined && supply.rootInputPx >= min
    ? undefined
    : 'root-input-too-small'
}

/**
 * THE decision. Effective = the operator intends it AND the current root
 * declares it. It never looks at, changes or clears the step's `modelId`: a
 * root that cannot supply the step leaves the step running its own model, and
 * switching back to a root that can re-activates the supply by itself.
 */
export function resolveRootSupply(
  stepId: RootSuppliableStepId,
  settings: Readonly<Record<string, unknown>> | undefined,
  rootSupplies: readonly RootStepSupply[] | undefined,
): RootSupplyState {
  const supply = supplyFor(rootSupplies, stepId)
  const intent = readUseRootModel(stepId, settings)
  const blocker = supply === undefined ? ('root-does-not-declare' as const) : supplyBlocker(supply)
  return {
    stepId,
    supply,
    intent,
    effective: intent && blocker === undefined,
    inactive: intent && blocker !== undefined,
    ...(intent && blocker !== undefined ? { inactiveReason: blocker } : {}),
  }
}

/**
 * The fine label a supplied root class becomes for a step whose supply is
 * effective, or `undefined` when the step's `enabledClasses` switched it off —
 * the detection then stays at its macro (`animal`). Empty / absent allow-list
 * = every class.
 */
export function allowedSuppliedEffect(
  effect: string,
  settings: Readonly<Record<string, unknown>> | undefined,
): boolean {
  const raw = settings?.['enabledClasses']
  if (!Array.isArray(raw) || raw.length === 0) return true
  return raw.some((v) => v === effect)
}

/** The child steps of a crop-kind step that still run on the root's box. */
export function rootSupplyServes(stepId: CropSupplyStepId): readonly string[] {
  return CROP_SUPPLY_SOURCES[stepId].servedChildSteps
}

/** Minimum fraction of a child box's area that must lie inside its parent. */
export const ROOT_CHILD_CONTAINMENT_MIN = 0.9

/** An axis-aligned box in one pixel space. */
export interface SupplyBox {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

/**
 * The parent a root child box belongs to: among `parents`, the SMALLEST whose
 * box holds at least {@link ROOT_CHILD_CONTAINMENT_MIN} of the child's area
 * (a plate inside the car, not inside the bus behind it). `-1` when none does
 * — the box then belongs to nobody and makes nothing.
 */
export function containingParentIndex(child: SupplyBox, parents: readonly SupplyBox[]): number {
  const childArea = child.w * child.h
  if (!(childArea > 0)) return -1
  let best = -1
  let bestArea = Number.POSITIVE_INFINITY
  parents.forEach((p, i) => {
    const ix = Math.max(0, Math.min(child.x + child.w, p.x + p.w) - Math.max(child.x, p.x))
    const iy = Math.max(0, Math.min(child.y + child.h, p.y + p.h) - Math.max(child.y, p.y))
    if ((ix * iy) / childArea < ROOT_CHILD_CONTAINMENT_MIN) return
    const area = p.w * p.h
    if (area < bestArea) {
      best = i
      bestArea = area
    }
  })
  return best
}

const SUPPLY_NOUN: Readonly<Record<RootSuppliableStepId, string>> = {
  'animal-classifier': 'animals',
  'vehicle-classifier': 'vehicles',
  'package-detection': 'packages',
  'plate-detection': 'plates',
  'face-detection': 'faces',
  segmentation: 'masks',
}

/** One short phrase per supply — `animals 6/8`, `plates`, `masks`. */
export function describeRootSupply(supply: RootStepSupply): string {
  const noun = SUPPLY_NOUN[supply.stepId]
  if (supply.kind !== 'label') return noun
  const total = LABEL_SUPPLY_VOCABULARIES[supply.stepId].length
  if (total <= 1) return noun
  return `${noun} ${String(total - supply.uncovered.length)}/${String(total)}`
}

/** `animals 6/8 · vehicles 5/8 · plates · faces · masks` — empty string for none. */
export function describeRootSupplies(supplies: readonly RootStepSupply[] | undefined): string {
  return (supplies ?? []).map(describeRootSupply).join(' · ')
}
