/**
 * The COMPOSITE variables — phrases assembled from catalog fragments before
 * the one and only render pass.
 *
 * A notification body is not a sentence with slots. "person (John) on Front
 * door in gate" contains three sub-phrases whose SHAPE differs per language
 * and whose presence is conditional: the label parentheses, the zone clause,
 * the plural noun. Expressing that with `{{class}}{{label}}{{zones}}` and
 * three scalars pushes the grammar into the template, where a translator
 * cannot fix it. So each becomes ONE variable — `{{subject}}`, `{{inZones}}`,
 * `{{op}}`, `{{detectionSummary}}` — composed here from its own keys and handed
 * to {@link renderTemplate} as a finished string.
 *
 * **Fragments see the SCALARS only.** Never the composites. That is what makes
 * the depth exactly one and not "one so far": a fragment key edited to say
 * `{{inZones}}` renders empty rather than starting a second round, and
 * `renderTemplate` never re-scans what it inserted, so a composite's own value
 * is printed verbatim whatever it contains.
 *
 * Pure: a catalog in, a string out. No clock, no store, no I/O.
 */

import { eventKindLabel, isEventKindLabelKey } from '@camstack/types'
import type { NcTextCatalog } from './text-catalog.js'

/** One class and how many of it — the input `{{detectionSummary}}` joins. */
export interface NcClassCount {
  readonly className: string
  readonly count: number
}

export interface NcSubjectTextInput {
  readonly className: string
  /** Identity or plate, when the pipeline resolved one. */
  readonly label?: string
  /**
   * WHAT the label is, when the pipeline said so.
   *
   * "Alice è arrivato" and "Veicolo AB123CD" are not the same sentence with
   * a different word slotted in — one is a person and takes a verb, the other
   * is a thing and takes a noun. Italian will not even agree the gender across
   * them. So a recognised subject gets its own key and the operator can word
   * the two independently from the Texts tab.
   *
   * Absent ⇒ the generic `detection.subject.labelled`, which is what every
   * notification said before these keys existed and what an unattributed legacy
   * record still gets.
   */
  readonly labelKind?: 'identity' | 'plate'
}

/** One normalisation, used on both sides of every class lookup — a pipeline
 *  that emitted `Person` must find the key written `class.person`. */
function normaliseClass(className: string): string {
  return className.trim().toLowerCase()
}

/**
 * The noun for a class, in the count's plural category.
 *
 * Lookup order: the NC text catalog (`class.*`, plural-aware) → the shared
 * {@link eventKindLabel} map (viewer filters / EVENT_TAXONOMY) → `class.other`
 * with the RAW wire id. A custom model class must still appear rather than
 * vanish; a missing translation is a smaller defect than a missing detection.
 */
export function ncClassNoun(texts: NcTextCatalog, className: string, count: number): string {
  const normalised = normaliseClass(className)
  const key = `class.${normalised}`
  if (texts.has(key)) return texts.text({ key, count, vars: { name: className } })
  // EVENT_KIND_LABELS ships Title Case for the viewer; NC placeholders stay
  // lowercase — the body capitalises its first letter once, after render.
  if (isEventKindLabelKey(normalised)) {
    return eventKindLabel(normalised, texts.language).toLocaleLowerCase(texts.language)
  }
  return texts.text({ key: 'class.other', count, vars: { name: className } })
}

/**
 * The ONE capitalisation the notification body gets: its first letter, after
 * every catalog fragment and placeholder has already been rendered lowercase.
 * Title, fragments and mid-sentence summaries are never passed through here.
 */
export function ncSentenceCaseBody(body: string): string {
  if (body.length === 0) return body
  const first = body[0]!
  const upper = first.toLocaleUpperCase()
  if (upper === first) return body
  return `${upper}${body.slice(1)}`
}

/**
 * True when `label` is a taxonomy / classification id (species, COCO sub, …)
 * rather than a person name or plate. Those REPLACE the coarse class in the
 * subject — "dog" not "animal (dog)", "cane" not "animale (cane)".
 */
function isClassificationLabel(label: string): boolean {
  return isEventKindLabelKey(label.trim().toLowerCase())
}

/** `person (John)` / `persona (John)` — the thing the notification is about. */
export function ncSubjectText(texts: NcTextCatalog, input: NcSubjectTextInput): string {
  // ONE detection is one subject, so the noun is always singular here. The
  // plural forms exist for `{{detectionSummary}}`, which counts.
  const classNoun = ncClassNoun(texts, input.className, 1)
  if (input.label === undefined)
    return texts.text({ key: 'detection.subject', vars: { classNoun } })
  // A species / sub-class is the subject itself. Wrapping it as
  // "animal (dog)" restates the coarse class the classifier already refined.
  if (
    input.labelKind !== 'identity' &&
    input.labelKind !== 'plate' &&
    isClassificationLabel(input.label)
  ) {
    return texts.text({
      key: 'detection.subject',
      vars: { classNoun: ncClassNoun(texts, input.label, 1) },
    })
  }
  return texts.text({
    key: subjectLabelKey(input.labelKind),
    vars: { classNoun, label: input.label },
  })
}

/**
 * Which labelled-subject key a recognition gets. A kind the catalog does not
 * name falls back to the generic key rather than printing nothing — the same
 * direction `ncClassNoun` degrades in, and for the same reason.
 */
function subjectLabelKey(kind: NcSubjectTextInput['labelKind']): string {
  if (kind === 'identity') return 'detection.subject.identity'
  if (kind === 'plate') return 'detection.subject.plate'
  return 'detection.subject.labelled'
}

/**
 * ` in gate, drive` — INCLUDING its leading space, and empty when there are no
 * zones.
 *
 * The space belongs to the fragment rather than to the body key because the
 * alternative is a body that ends in a trailing space on every zone-less
 * notification. A translator moving the clause moves the space with it.
 */
export function ncInZonesText(texts: NcTextCatalog, zoneLabels: readonly string[]): string {
  if (zoneLabels.length === 0) return ''
  return texts.text({ key: 'detection.inZones', vars: { zones: zoneLabels.join(', ') } })
}

/** The human-readable edge polarity behind `{{op}}` and the occupancy body. */
export function ncOccupancyOp(texts: NcTextCatalog, occupied: boolean): string {
  return texts.text({ key: occupied ? 'occupancy.op.occupied' : 'occupancy.op.free' })
}

/**
 * `1 persona, 2 veicoli e 3 animali` — the language's own conjunction, its own
 * plural rules, and its own nouns.
 *
 * Zero-count classes are dropped: a selected class the window never contained
 * is a legitimate `0` in `{{count_vehicle}}`, but "0 veicoli" inside a summary
 * sentence is a line nobody reads. Order is the caller's (busiest first) and is
 * preserved, so the same night always produces the same sentence.
 */
export function ncDetectionSummary(texts: NcTextCatalog, counts: readonly NcClassCount[]): string {
  const parts = counts
    .filter((entry) => entry.count > 0)
    .map((entry) => `${entry.count} ${ncClassNoun(texts, entry.className, entry.count)}`)
  return texts.join(parts)
}
