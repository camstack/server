/**
 * The ONE tiered-label write rule (roadmap 4g).
 *
 * Before this file there were four writers and no rule. The frame path stamped
 * a label at track birth; `applyTrackEnrichmentLabel` wrote the classifier /
 * plate answer onto the track AND back-patched every already-emitted event; the
 * face recognizer wrote an identity; the plate gallery wrote a vehicle name.
 * Each of them was a bare `label = text` on a single column, so the LAST writer
 * won — which is how `9c05543f` (592), a `person` track, ended up labelled
 * `animal`, and how `7d1dc71e` (636) could hold `Turdus migratorius` with no
 * way to also say `bird`.
 *
 * The model is two independent slots (see `LabelTierSchema` in
 * `pipeline-analytics.cap.ts`):
 *
 *  - tier 1 (`label`) — the SUB-CLASS: `dog`, `bird`, `van`.
 *  - tier 2 (`subLabel`) — the INSTANCE: `Turdus migratorius`, `Alice`, a plate.
 *
 * **A higher tier is never overwritten by a lower one — structurally.** The two
 * live in different columns, so a tier-1 write physically cannot touch a
 * tier-2 value. That is the whole reason for two scalars rather than one
 * best-effort slot: the guarantee is a consequence of the shape, not of a
 * comparison somebody has to remember to write.
 *
 * **Within a tier, the higher score wins**, strictly — an equal score leaves
 * the incumbent in place, so a step that re-offers the same answer every frame
 * does not churn the row. The one exception is an incumbent attributed to
 * {@link MIGRATION_STEP_ID}: a value the 4g migration moved out of the old
 * single-slot column has no provenance and no comparable score, so ANY
 * properly-attributed write of its tier replaces it.
 *
 * **A candidate whose tier is not DECLARED is refused**, never guessed. The
 * tier is declared on `StepDefinition.labelTier` and travels on the wire
 * (`DetailResult.labelTier`, `ScoredLabel.tier`). Inferring it here from the
 * text or from the step's name is precisely the failure this model exists to
 * remove: the shape of a string cannot tell `Bird` the surname from `bird` the
 * sub-class.
 *
 * Every refusal is RETURNED, not swallowed — a branch that drops work says so
 * (`label write refused`, with `tags: { deviceId }`).
 */

import {
  isLabelSupplyStepId,
  LABEL_SUPPLY_MACRO,
  type LabelAttribution,
  type LabelTier,
  linkedStepOf,
} from '@camstack/types'
import { isInternalMarker, isMacroClass } from './label-utils.js'

/**
 * `stepId` stamped on a tier the 4g migration filled from the pre-4g single
 * `label` column. It marks a value with NO provenance: nothing recorded which
 * step decided it, so its score is unknown and its tier was assigned by the
 * migration's safe-direction rule rather than by a declaration. The write rule
 * lets any declared write of the same tier replace it outright — which is what
 * makes the migration self-healing instead of permanent.
 */
export const MIGRATION_STEP_ID = 'migration:4g'

/** A label offered for one of the two slots. */
export interface LabelCandidate {
  /** The text itself. */
  readonly text: string
  /**
   * The slot it may occupy, as DECLARED by the producing step. `undefined`
   * means the step declared none — the candidate is refused, not placed.
   */
  readonly tier?: LabelTier
  /** Confidence reported by the deciding step. */
  readonly score: number
  /** Step that decided the text. */
  readonly stepId: string
  /** Model that decided the text, when known. */
  readonly modelId?: string
  /** When it was decided (ms). */
  readonly decidedAt: number
  /**
   * Gallery id behind the text — a face `Identity.id` or a plate `Vehicle.id`.
   * Carried onto {@link LabelAttribution.identityId} so a rule can match the id
   * rather than the renameable display name. Absent when the text names no
   * gallery row.
   */
  readonly identityId?: string
  /**
   * OPERATOR authority: this candidate takes its tier unconditionally, without
   * a score comparison.
   *
   * Set ONLY by a hand-made assignment (naming a face in the gallery, binding a
   * plate to a vehicle). Without it an operator who corrects a name would lose
   * to the incumbent whenever the machine had answered at score 1.0 — which
   * arcface routinely does — and the correction would silently do nothing. It
   * still cannot place a macro class or cross a tier: authority is about WHOSE
   * answer wins, not about what a label slot may hold.
   */
  readonly operatorAuthority?: boolean
}

/** The tiered columns as they stand on a row, plus the class that outranks them. */
export interface TieredLabelState {
  readonly className: string
  readonly label?: string
  readonly labelScore?: number
  readonly labelMeta?: LabelAttribution
  readonly subLabel?: string
  readonly subLabelScore?: number
  readonly subLabelMeta?: LabelAttribution
}

/** The columns a write touches. Only ever ONE tier's three fields. */
export interface TieredLabelPatch {
  readonly label?: string
  readonly labelScore?: number
  readonly labelMeta?: LabelAttribution
  readonly subLabel?: string
  readonly subLabelScore?: number
  readonly subLabelMeta?: LabelAttribution
}

/**
 * Why a candidate did not reach a slot. Each carries enough to answer "why is
 * this camera's track unlabelled" from one log line.
 */
export type LabelWriteRefusal =
  /** Blank / whitespace-only text. */
  | { readonly kind: 'empty'; readonly stepId: string }
  /** An opaque internal marker (`embedding:512d`) — never human-visible. */
  | { readonly kind: 'internal-marker'; readonly text: string; readonly stepId: string }
  /** The producing step declares no `labelTier`. Never inferred — see above. */
  | { readonly kind: 'undeclared-tier'; readonly text: string; readonly stepId: string }
  /** A MACRO class offered for a label slot (the 2026-08-07 tier collapse). */
  | { readonly kind: 'macro-class'; readonly text: string; readonly className: string }
  /** The text IS the row's class — it adds nothing the class did not say. */
  | { readonly kind: 'equals-class'; readonly text: string; readonly className: string }
  /**
   * The answering step labels subjects of ANOTHER class (`animal-classifier`
   * or its detector link offering `dog` to a `person` track). A label is
   * computed for one subject; a track whose class is not the step's input class
   * is not that subject.
   */
  | {
      readonly kind: 'class-mismatch'
      readonly text: string
      readonly stepId: string
      readonly className: string
      readonly expectedClass: string
    }
  /** A same-tier incumbent scored at least as high. */
  | {
      readonly kind: 'lower-score'
      readonly text: string
      readonly tier: LabelTier
      readonly incumbent: string
      readonly incumbentScore: number
    }

/** Outcome of {@link resolveTieredLabelWrite}. */
export type TieredLabelDecision =
  | { readonly kind: 'write'; readonly tier: LabelTier; readonly patch: TieredLabelPatch }
  | { readonly kind: 'refused'; readonly reason: LabelWriteRefusal }

/**
 * What a human should be shown: the finest thing known about the subject.
 *
 * Every read surface uses this rather than reading a column, because the answer
 * changed shape at 4g and a surface that reads `label` directly shows nothing
 * on a species-only row.
 */
export function displayLabel(state: {
  readonly label?: string
  readonly subLabel?: string
}): string | undefined {
  return state.subLabel ?? state.label
}

/**
 * The tiered columns a row should carry to AGREE with the track, or `undefined`
 * when the track says nothing yet.
 *
 * The projection is total: whichever tiers the track holds are copied, and a
 * track holding neither yields `undefined` rather than a patch of blanks — the
 * caller then leaves the row exactly as it was.
 */
export function knownTrackLabelPatch(
  state: TieredLabelState | undefined,
): TieredLabelPatch | undefined {
  if (state === undefined) return undefined
  if (state.label === undefined && state.subLabel === undefined) return undefined
  return {
    ...(state.label !== undefined ? { label: state.label } : {}),
    ...(state.labelScore !== undefined ? { labelScore: state.labelScore } : {}),
    ...(state.labelMeta !== undefined ? { labelMeta: state.labelMeta } : {}),
    ...(state.subLabel !== undefined ? { subLabel: state.subLabel } : {}),
    ...(state.subLabelScore !== undefined ? { subLabelScore: state.subLabelScore } : {}),
    ...(state.subLabelMeta !== undefined ? { subLabelMeta: state.subLabelMeta } : {}),
  }
}

/**
 * Does this row already say what the subject IS?
 *
 * The gate behind `DetailDispatcher.hasTrackLabel`: a periodic face-detection
 * refresh on a track that already has an answer runs geometry-only and drops
 * the ArcFace embedding. It reads {@link displayLabel} and not the `label`
 * column, and the difference is the whole point — an identity is a TIER-2
 * value and lands in `subLabel`, so the column read reported "unlabelled" for
 * every track ArcFace had already named and kept re-embedding it forever,
 * while suppressing the face chain on tracks that carried only a tier-1
 * sub-class (`van`). Exactly backwards, in both directions.
 */
export function hasResolvedLabel(
  state: { readonly label?: string; readonly subLabel?: string } | null | undefined,
): boolean {
  if (state === null || state === undefined) return false
  const label = displayLabel(state)
  return label !== undefined && label.length > 0
}

/**
 * The display label of a frame-path tracked detection — the same
 * `subLabel ?? label` question asked of a patch rather than a row. Used by
 * every caller that wants the caption, not the tier (media captions, lifecycle
 * payloads, the update gate's identity memory).
 */
export function patchDisplayLabel(patch: TieredLabelPatch | undefined): string | undefined {
  if (patch === undefined) return undefined
  return patch.subLabel ?? patch.label
}

/**
 * WHAT a tier-2 label is about — a recognised PERSON or a read PLATE.
 *
 * Derived from the deciding step, never stored a second time: the step that
 * wrote the value is already on the attribution, and a second column stating
 * the same thing is a knob that can disagree with the first (D62). Both the
 * machine step and the operator override of each family are listed, because a
 * hand-assigned identity is still an identity.
 *
 * Callers use it to pick a SENTENCE: "Alice è arrivato" and "Veicolo AB123CD"
 * are different keys in the notification text catalog, and a single
 * `{{label}}` slot cannot word both.
 */
export const FACE_LABEL_STEP_IDS: ReadonlySet<string> = new Set([
  'face-recognizer',
  'face-embedding',
  'operator:face-gallery',
])

/**
 * Steps whose tier-2 value is a PLATE / vehicle name. See
 * {@link FACE_LABEL_STEP_IDS}.
 *
 * `plate-detection` is the one that fires. The label candidate is attributed to
 * `detail.stepId` (`applyTrackLabelCandidate` in `pipeline-analytics/index.ts`),
 * and a plate's text rides the detail-subtree ROOT — `plate-detection`, with the
 * OCR model on `modelId` — not its `plate-ocr` leaf. Listing only the leaf, as
 * this set did until 2026-08-20, made {@link labelKindOf} answer `undefined` for
 * every plate the fleet has ever read: measured across seven days and six
 * cameras, all 8 plate attributions are `plate-detection` and NONE is
 * `plate-ocr`. Every plate therefore took the generic labelled sentence instead
 * of the plate one, and every consumer asking "is this tier-2 value a plate"
 * got "no".
 *
 * The leaf stays listed: a runner that attributes the label to the step that
 * produced the text is not wrong, and both spellings mean a plate.
 */
export const PLATE_LABEL_STEP_IDS: ReadonlySet<string> = new Set([
  'plate-detection',
  'plate-ocr',
  'operator:plate-gallery',
])

/** What a tier-2 label names, or `undefined` when the step is neither family. */
export type LabelKind = 'identity' | 'plate'

/**
 * Classify a tier-2 attribution. `undefined` for an unattributed value, a
 * migrated one, or any step outside the two recognition families (a species, a
 * sub-class) — the caller then falls back to the generic labelled sentence.
 */
export function labelKindOf(meta: LabelAttribution | undefined): LabelKind | undefined {
  if (meta === undefined) return undefined
  if (FACE_LABEL_STEP_IDS.has(meta.stepId)) return 'identity'
  if (PLATE_LABEL_STEP_IDS.has(meta.stepId)) return 'plate'
  return undefined
}

/** Whether an attribution came from the 4g migration rather than a real step. */
function isMigrated(meta: LabelAttribution | undefined): boolean {
  return meta?.stepId === MIGRATION_STEP_ID
}

/**
 * Decide whether `candidate` may be written, and into which slot.
 *
 * Pure: the caller performs the write and logs the refusal. Order matters —
 * the cheap universal refusals come first so a malformed candidate is never
 * compared against an incumbent.
 */
export function resolveTieredLabelWrite(
  state: TieredLabelState,
  candidate: LabelCandidate,
): TieredLabelDecision {
  const text = candidate.text.trim()
  if (text.length === 0) {
    return { kind: 'refused', reason: { kind: 'empty', stepId: candidate.stepId } }
  }
  if (isInternalMarker(text)) {
    return {
      kind: 'refused',
      reason: { kind: 'internal-marker', text, stepId: candidate.stepId },
    }
  }
  // The 2026-08-07 rule, unchanged and now in the one place every writer passes
  // through: a label slot exists to say something FINER than the class.
  //
  // BEFORE the tier check, deliberately. A macro class is refused at EVERY
  // tier, so its tier is moot — and this is the common case on the frame path,
  // where outside `verbosity: 'full'` the raw-class candidate is
  // `det.macroClass` with no declaration behind it. Asking the tier question
  // first would report every one of those as `undeclared-tier` and retire the
  // more informative diagnosis (`label tier collapse refused`) that the five
  // live rows on 592/104/103/637 were finally found by.
  if (isMacroClass(text)) {
    return {
      kind: 'refused',
      reason: { kind: 'macro-class', text, className: state.className },
    }
  }
  if (text === state.className) {
    return {
      kind: 'refused',
      reason: { kind: 'equals-class', text, className: state.className },
    }
  }
  const expectedClass = stepInputClass(candidate.stepId)
  if (expectedClass !== undefined && expectedClass !== state.className) {
    return {
      kind: 'refused',
      reason: {
        kind: 'class-mismatch',
        text,
        stepId: candidate.stepId,
        className: state.className,
        expectedClass,
      },
    }
  }
  if (candidate.tier === undefined) {
    return {
      kind: 'refused',
      reason: { kind: 'undeclared-tier', text, stepId: candidate.stepId },
    }
  }

  const meta: LabelAttribution = {
    stepId: candidate.stepId,
    ...(candidate.modelId !== undefined ? { modelId: candidate.modelId } : {}),
    decidedAt: candidate.decidedAt,
    ...(candidate.identityId !== undefined ? { identityId: candidate.identityId } : {}),
  }

  const incumbent = candidate.tier === 1 ? state.label : state.subLabel
  const incumbentScore = candidate.tier === 1 ? state.labelScore : state.subLabelScore
  const incumbentMeta = candidate.tier === 1 ? state.labelMeta : state.subLabelMeta

  if (
    incumbent !== undefined &&
    !isMigrated(incumbentMeta) &&
    candidate.operatorAuthority !== true
  ) {
    // Strictly greater: an equal score leaves the incumbent, so a step that
    // re-offers the same answer on every frame writes once.
    if (!(candidate.score > (incumbentScore ?? 0))) {
      return {
        kind: 'refused',
        reason: {
          kind: 'lower-score',
          text,
          tier: candidate.tier,
          incumbent,
          incumbentScore: incumbentScore ?? 0,
        },
      }
    }
  }

  const patch: TieredLabelPatch =
    candidate.tier === 1
      ? { label: text, labelScore: candidate.score, labelMeta: meta }
      : { subLabel: text, subLabelScore: candidate.score, subLabelMeta: meta }
  return { kind: 'write', tier: candidate.tier, patch }
}

/**
 * The macro class a label-supply step (or its `detector-link:` stand-in) takes
 * as input, or `undefined` for a writer with no class contract (identity, plate
 * text, the raw class).
 */
function stepInputClass(stepId: string): string | undefined {
  const linked = linkedStepOf(stepId)
  if (linked !== undefined) return LABEL_SUPPLY_MACRO[linked]
  return isLabelSupplyStepId(stepId) ? LABEL_SUPPLY_MACRO[stepId] : undefined
}

/** One-line `meta` bag for the refusal log — the shape every caller logs. */
export function refusalLogMeta(reason: LabelWriteRefusal): Readonly<Record<string, unknown>> {
  switch (reason.kind) {
    case 'empty':
      return { refusal: reason.kind, stepId: reason.stepId }
    case 'internal-marker':
    case 'undeclared-tier':
      return { refusal: reason.kind, rejected: reason.text, stepId: reason.stepId }
    case 'class-mismatch':
      return {
        refusal: reason.kind,
        rejected: reason.text,
        stepId: reason.stepId,
        className: reason.className,
        expectedClass: reason.expectedClass,
      }
    case 'macro-class':
    case 'equals-class':
      return { refusal: reason.kind, rejected: reason.text, className: reason.className }
    case 'lower-score':
      return {
        refusal: reason.kind,
        rejected: reason.text,
        tier: reason.tier,
        incumbent: reason.incumbent,
        incumbentScore: reason.incumbentScore,
      }
  }
}
