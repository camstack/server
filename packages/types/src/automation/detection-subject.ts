/**
 * WHAT a detection-shaped leaf is about: one MACRO class (person, vehicle,
 * animal, package) plus an OPTIONAL label that narrows it.
 *
 * The taxonomy is `COCO_TO_MACRO` (and `CLASS_MAP_MACRO_TARGETS`) — never a
 * second list. The label that fits depends on the macro class:
 *
 *  - `animal`  → a sub-class (`dog`, `cat`, …);
 *  - `person`  → a known face (an identity of the `face-gallery`);
 *  - `vehicle` → a plate (its text) or a sub-class (`car`, `truck`, …);
 *  - `package` → a sub-class.
 *
 * `other` exists only so a class the taxonomy does not know (a custom model's
 * `forklift`) survives the conversion of a stored recipe without widening.
 *
 * A label is decided LATE (D683): face recognition and LPR land after the
 * detection starts. The track-lifecycle `update` event carries the newly
 * resolved `label` / `plateText`, which is why a leaf with a label fires when
 * the subject GETS it — not at the first detection.
 */

import { z } from 'zod'
import { COCO_TO_MACRO } from '../catalogs/coco-classmap.js'

const SubClassLabelSchema = z.object({
  kind: z.literal('sub-class'),
  className: z.string().min(1),
})
const IdentityLabelSchema = z.object({
  kind: z.literal('identity'),
  /** The `face-gallery` identity id (stable across a rename). */
  identityId: z.string().min(1),
  /** The identity's name — what a track-lifecycle event carries as `label`. */
  name: z.string().min(1),
})
const PlateLabelSchema = z.object({
  kind: z.literal('plate'),
  text: z.string().min(1),
})

export type SubClassLabel = z.infer<typeof SubClassLabelSchema>
export type IdentityLabel = z.infer<typeof IdentityLabelSchema>
export type PlateLabel = z.infer<typeof PlateLabelSchema>

function macroOf(className: string): string {
  return COCO_TO_MACRO.mapping[className.toLowerCase()] ?? className.toLowerCase()
}

/** A sub-class label must belong to the macro it is under. */
function subClassBelongs(macro: string, label: SubClassLabel | undefined): boolean {
  return label === undefined || macroOf(label.className) === macro
}

const subClassOf = (macro: string) =>
  SubClassLabelSchema.refine((l) => subClassBelongs(macro, l), {
    message: `that class is not a kind of ${macro} in the detection taxonomy`,
  })

export const DetectionSubjectSchema = z.discriminatedUnion('macro', [
  z.object({ macro: z.literal('animal'), label: subClassOf('animal').optional() }),
  z.object({ macro: z.literal('person'), label: IdentityLabelSchema.optional() }),
  z.object({
    macro: z.literal('vehicle'),
    label: z
      .discriminatedUnion('kind', [
        SubClassLabelSchema.refine((l) => subClassBelongs('vehicle', l), {
          message: 'that class is not a kind of vehicle in the detection taxonomy',
        }),
        PlateLabelSchema,
      ])
      .optional(),
  }),
  z.object({ macro: z.literal('package'), label: subClassOf('package').optional() }),
  z.object({ macro: z.literal('other'), className: z.string().min(1) }),
])
export type DetectionSubject = z.infer<typeof DetectionSubjectSchema>

/**
 * The subject of a PARKED object. The stationary registry's event carries a
 * class and a zone, no face and no plate — an identity or plate label there
 * could never match, so the schema refuses it instead of letting it sit dead.
 */
export const StationarySubjectSchema = DetectionSubjectSchema.refine(
  (s) => s.macro === 'other' || s.label === undefined || s.label.kind === 'sub-class',
  { message: 'a parked object carries no face or plate — only a class can narrow it' },
)

/** What the macro-class picker offers, and where a label's choices come from. */
export type DetectionLabelSource =
  | { readonly kind: 'sub-class' }
  | {
      readonly kind: 'cap'
      readonly cap: string
      readonly method: string
      readonly label: 'identity' | 'plate'
    }

/**
 * Where an editor lists the labels of a macro class. Sub-classes come from the
 * taxonomy (`subClassesOf`); identities and plates come from the galleries'
 * own methods, so a picker reads the cap and never a copy of it.
 */
export const DETECTION_LABEL_SOURCES: Readonly<
  Record<'animal' | 'person' | 'vehicle' | 'package', readonly DetectionLabelSource[]>
> = {
  animal: [{ kind: 'sub-class' }],
  person: [{ kind: 'cap', cap: 'face-gallery', method: 'listIdentities', label: 'identity' }],
  vehicle: [
    { kind: 'cap', cap: 'plate-gallery', method: 'listPlates', label: 'plate' },
    { kind: 'sub-class' },
  ],
  package: [{ kind: 'sub-class' }],
}

/** The raw classes the taxonomy files under a macro class. */
export function subClassesOf(macro: string): readonly string[] {
  return Object.entries(COCO_TO_MACRO.mapping)
    .filter(([, m]) => m === macro)
    .map(([raw]) => raw)
}

/**
 * A stored class string as a subject: a macro name stays a macro; a raw class
 * the taxonomy files under a macro becomes that macro plus the sub-class label
 * (`dog` → animal / dog); anything else is `other`, kept verbatim.
 */
export function subjectFromClassName(className: string): DetectionSubject {
  const name = className.trim().toLowerCase()
  const macro = COCO_TO_MACRO.mapping[name]
  const macros = new Set(Object.values(COCO_TO_MACRO.mapping))
  if (macros.has(name)) return macroOnly(name)
  if (macro === undefined) return { macro: 'other', className }
  const label: SubClassLabel = { kind: 'sub-class', className: name }
  switch (macro) {
    case 'animal':
      return { macro: 'animal', label }
    case 'vehicle':
      return { macro: 'vehicle', label }
    case 'package':
      return { macro: 'package', label }
    default:
      return { macro: 'other', className }
  }
}

function macroOnly(macro: string): DetectionSubject {
  switch (macro) {
    case 'animal':
      return { macro: 'animal' }
    case 'person':
      return { macro: 'person' }
    case 'vehicle':
      return { macro: 'vehicle' }
    case 'package':
      return { macro: 'package' }
    default:
      return { macro: 'other', className: macro }
  }
}

/** What an event says about the subject — all optional, off the bus. */
export interface SubjectObservation {
  readonly className: string
  /** Every class the track was observed as. */
  readonly classes?: readonly string[]
  /** The display label (an identity name, a plate text) once resolved. */
  readonly label?: string
  readonly identityId?: string
  readonly plateText?: string
}

export type SubjectVerdict =
  | { readonly matches: true; readonly label: string }
  | { readonly matches: false; readonly reason: string }

function normalisePlate(text: string): string {
  return text.toUpperCase().replace(/[^A-Z0-9]/g, '')
}

/** A human name for a subject, for a reason line. */
export function describeSubject(subject: DetectionSubject): string {
  if (subject.macro === 'other') return subject.className
  const label = subject.label
  if (label === undefined) return subject.macro
  switch (label.kind) {
    case 'sub-class':
      return `${subject.macro} ${label.className}`
    case 'identity':
      return `${subject.macro} ${label.name}`
    case 'plate':
      return `${subject.macro} plate ${label.text}`
  }
}

/** Does one observation satisfy one subject, and which label did it match? */
export function subjectMatches(
  subject: DetectionSubject,
  observed: SubjectObservation,
): SubjectVerdict {
  const className = observed.className.toLowerCase()
  if (subject.macro === 'other') {
    return className === subject.className.toLowerCase()
      ? { matches: true, label: '' }
      : {
          matches: false,
          reason: `class ${observed.className || 'unknown'} is not ${subject.className}`,
        }
  }
  if (macroOf(className) !== subject.macro) {
    return {
      matches: false,
      reason: `class ${observed.className || 'unknown'} is not a ${subject.macro}`,
    }
  }
  const label = subject.label
  if (label === undefined) return { matches: true, label: '' }
  switch (label.kind) {
    case 'sub-class': {
      const wanted = label.className.toLowerCase()
      const seen = [className, ...(observed.classes ?? []), observed.label ?? ''].map((c) =>
        c.toLowerCase(),
      )
      return seen.includes(wanted)
        ? { matches: true, label: label.className }
        : { matches: false, reason: `${subject.macro} ${label.className} not seen yet` }
    }
    case 'identity': {
      const byId = observed.identityId !== undefined && observed.identityId === label.identityId
      const byName =
        observed.label !== undefined && observed.label.toLowerCase() === label.name.toLowerCase()
      return byId || byName
        ? { matches: true, label: label.name }
        : {
            matches: false,
            reason: `face ${label.name} not recognised yet${
              observed.label === undefined || observed.label === ''
                ? ''
                : ` (seen as ${observed.label})`
            }`,
          }
    }
    case 'plate': {
      const text = observed.plateText ?? observed.label ?? ''
      return text !== '' && normalisePlate(text) === normalisePlate(label.text)
        ? { matches: true, label: label.text }
        : {
            matches: false,
            reason: `plate ${label.text} not read yet${text === '' ? '' : ` (read ${text})`}`,
          }
    }
  }
}

/** The first subject an observation satisfies, else why the last one did not. */
export function anySubjectMatches(
  subjects: readonly DetectionSubject[],
  observed: SubjectObservation,
): SubjectVerdict {
  let lastReason = 'no subject listed'
  for (const subject of subjects) {
    const verdict = subjectMatches(subject, observed)
    if (verdict.matches) return verdict
    lastReason = verdict.reason
  }
  return {
    matches: false,
    reason:
      subjects.length === 1
        ? lastReason
        : `none of [${subjects.map(describeSubject).join(', ')}] matches (${observed.className || 'unknown'})`,
  }
}
