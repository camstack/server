/**
 * The three annotation TIERS, and the guard that keeps them apart.
 *
 * `macroClass` is what the detector predicts. `label` is what the frame
 * actually is inside that class. `subLabel` is the identity underneath the
 * label. `person` / `postman` / `Marco` — three tiers, three columns.
 *
 * ## Why this is a guard and not a comment
 *
 * A UI that lets a macro class be typed into the label field produces a
 * taxonomy that CANNOT be exported per model. Once `person` exists as a label
 * on some rows and as a macro class on others, "every person box" is no longer
 * answerable without knowing every string anyone ever typed, and the export has
 * to guess which tier a row meant. The damage is retroactive and silent, so the
 * refusal happens at the write, not at the export.
 *
 * The guard is one-directional on purpose: a macro class may never appear as a
 * label or sub-label, but a label is free to be any other string. Constraining
 * the label vocabulary too would make the page unusable for exactly the classes
 * it exists to teach — the ones the model does not know yet.
 */

import type { RetrainMacroClass as CapMacroClass } from '@camstack/types'

/**
 * The macro classes a retrain annotation may carry.
 *
 * A closed set, because this is the tier the exported detector predicts and a
 * typo here is a new class with one example in it. `package` is present for the
 * package model; `face` and `plate` are the detail tiers.
 */
const RETRAIN_MACRO_CLASSES = ['person', 'vehicle', 'animal', 'package', 'face', 'plate'] as const

export type RetrainMacroClass = (typeof RETRAIN_MACRO_CLASSES)[number]

/**
 * Pin: this list and the cap's `RetrainMacroClassSchema` are the SAME set.
 *
 * A type-only assignment in both directions, so adding a class on one side and
 * not the other fails the build here rather than at the first row that carries
 * it. The alternative — importing the cap enum and deriving from it — would put
 * a zod schema in the hot path of a pure string check for no gain.
 */
export type MacroClassesAgree = [
  RetrainMacroClass extends CapMacroClass ? true : never,
  CapMacroClass extends RetrainMacroClass ? true : never,
]

const MACRO_SET: ReadonlySet<string> = new Set<string>(RETRAIN_MACRO_CLASSES)

export function isRetrainMacroClass(value: string): value is RetrainMacroClass {
  return MACRO_SET.has(value)
}

/** Why a tier assignment was refused — named so the UI can say which field. */
export type TierViolation =
  | { readonly field: 'label'; readonly value: string }
  | { readonly field: 'subLabel'; readonly value: string }

/**
 * Check the label tiers of one annotation. `null` when it is well-formed.
 *
 * Case-insensitive and whitespace-trimmed: `Person` typed into the label field
 * is the same mistake as `person`, and a guard that only catches the exact
 * spelling teaches the operator to work around it.
 */
export function checkTierSeparation(input: {
  readonly label?: string
  readonly subLabel?: string
}): TierViolation | null {
  const label = input.label?.trim().toLowerCase()
  if (label !== undefined && label !== '' && isRetrainMacroClass(label)) {
    return { field: 'label', value: input.label ?? '' }
  }
  const subLabel = input.subLabel?.trim().toLowerCase()
  if (subLabel !== undefined && subLabel !== '' && isRetrainMacroClass(subLabel)) {
    return { field: 'subLabel', value: input.subLabel ?? '' }
  }
  return null
}
