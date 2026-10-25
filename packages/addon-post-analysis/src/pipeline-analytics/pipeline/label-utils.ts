import type { DetailMacro, FirstLevelMacro, LabelTier, ScoredLabel } from '@camstack/types'
import { linkedStepOf } from '@camstack/types'
// Type-only: `label-tier.ts` imports the two predicates below at runtime, so a
// value import here would be a cycle. The candidate shape has ONE definition,
// and it belongs with the rule that consumes it.
import type { LabelCandidate } from './label-tier.js'

/**
 * Every macro class the pipeline can carry on a detection. A `label` exists to
 * say something FINER than the class — a species, a vehicle type, a plate read,
 * an identity — so a value drawn from this set is by definition not a label,
 * whatever produced it.
 *
 * Typed against the macro unions so a new macro class is a compile error here
 * rather than a silent hole. `package` is a first-level macro of the default
 * detector that predates `FirstLevelMacro`, hence the explicit member.
 */
const MACRO_CLASSES: ReadonlySet<string> = new Set<
  FirstLevelMacro | DetailMacro | 'package' | 'audio'
>(['person', 'vehicle', 'animal', 'package', 'face', 'plate', 'audio'])

/**
 * Whether a class token is a macro class. EXACT match, no case folding: plate
 * OCR text is upper-case and identities are capitalised, so `PLATE` (a real
 * read) and `Person` (a real name) must survive while `plate` / `person` (the
 * taxonomy tokens) must not.
 */
export function isMacroClass(value: string): boolean {
  return MACRO_CLASSES.has(value)
}

/**
 * Opaque internal label markers that carry no human-readable meaning and must
 * never surface on an event/track. The face-embedding (arcface) step pushes a
 * `embedding:<dim>d` marker (score 1.0) onto the parent's labels — it is a
 * vector marker, NOT a recognized identity (there is no enrollment/matching
 * step yet), and its score 1.0 would otherwise outrank real labels.
 */
export function isInternalMarker(label: string): boolean {
  return label.startsWith('embedding:')
}

/**
 * Pick the highest-scoring enrichment label from a detection's `labels` array.
 * Labels equal to `excludeClass` (the macro class, which carries no extra
 * information), internal markers (e.g. `embedding:512d`), and non-positive
 * scores are ignored. Returns `undefined` when no informative label remains.
 *
 * Returns the WHOLE `ScoredLabel`, not its text: since 4g each label carries
 * the tier its producing step DECLARED, plus that step's id and model, and the
 * write rule refuses a candidate that arrives without them.
 */
export function pickTopScoredLabel(
  labels: readonly ScoredLabel[] | undefined,
  excludeClass?: string,
): ScoredLabel | undefined {
  if (!labels || labels.length === 0) return undefined
  let best: ScoredLabel | undefined
  for (const l of labels) {
    if (l.score <= 0) continue
    if (excludeClass && l.label === excludeClass) continue
    if (isInternalMarker(l.label)) continue
    if (!best || l.score > best.score) best = l
  }
  return best
}

/**
 * `stepId` attributed to a label taken from the ROOT detector's raw class
 * (`debug.originalClass`). The debug bag carries no step id — it is the
 * detector's own output by construction — so the attribution names the source
 * rather than pretending to a step id it did not ship.
 */
export const RAW_CLASS_STEP_ID = 'detector:raw-class'

/** Input of {@link resolveDetectionLabelCandidate}. */
export interface DetectionLabelInput {
  readonly className: string
  /** Raw detector class behind the macro — `verbosity: 'full'` only. */
  readonly originalClass?: string
  /** Tier the root step DECLARED for its raw class. Absent ⇒ refused, never guessed. */
  readonly originalClassTier?: LabelTier
  readonly labels?: readonly ScoredLabel[]
  /** Frame timestamp — the candidate's `decidedAt`. */
  readonly decidedAt: number
}

/**
 * Choose the label CANDIDATE a detection offers, and nothing more.
 *
 * An enrichment label (identity, plate text, species, sub-class) takes
 * precedence; otherwise the detector's score-0 linked label (D715); otherwise
 * the root detector's raw class, when it ships at all.
 * Whether the candidate may be WRITTEN — and into which slot — is
 * {@link resolveTieredLabelWrite}'s decision, in `label-tier.ts`. This split is
 * deliberate: the macro-class refusal that shipped on 2026-08-07 used to live
 * here and would now be a second copy of a rule the write path already applies
 * to three other writers.
 *
 * Returns `undefined` when the detection offers nothing at all.
 */
export function resolveDetectionLabelCandidate(
  input: DetectionLabelInput,
): LabelCandidate | undefined {
  const top = pickTopScoredLabel(input.labels, input.className)
  if (top) {
    return {
      text: top.label,
      ...(top.tier !== undefined ? { tier: top.tier } : {}),
      score: top.score,
      stepId: top.stepId ?? RAW_CLASS_STEP_ID,
      ...(top.modelId !== undefined ? { modelId: top.modelId } : {}),
      decidedAt: input.decidedAt,
    }
  }
  // D715: the detector's linked label when it is NOT the authoritative writer
  // of that effect — score 0, the same standing as the raw class below and for
  // the same reason: any scored answer of the step outranks it. It ships at
  // every verbosity, so it is the fallback the raw class only is under `full`.
  const linked = input.labels?.find(
    (l) => l.score === 0 && linkedStepOf(l.stepId) !== undefined && l.label !== input.className,
  )
  if (linked !== undefined && linked.stepId !== undefined) {
    return {
      text: linked.label,
      ...(linked.tier !== undefined ? { tier: linked.tier } : {}),
      score: 0,
      stepId: linked.stepId,
      ...(linked.modelId !== undefined ? { modelId: linked.modelId } : {}),
      decidedAt: input.decidedAt,
    }
  }
  const raw = input.originalClass
  if (raw === undefined || raw === input.className) return undefined
  // `originalClass` ships with no score of its own; it IS the detection, so it
  // inherits the detection's standing rather than inventing a confidence. 0 is
  // deliberate: any scored enrichment of the same tier outranks it.
  return {
    text: raw,
    ...(input.originalClassTier !== undefined ? { tier: input.originalClassTier } : {}),
    score: 0,
    stepId: RAW_CLASS_STEP_ID,
    decidedAt: input.decidedAt,
  }
}
