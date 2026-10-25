/**
 * The label vocabulary of the corpus — what the label field suggests.
 *
 * The label is free text on purpose (it is the vocabulary the page exists to
 * teach), which is exactly why it drifts: "postman", "Postman" and "postie" are
 * three labels to a trainer. The field therefore SUGGESTS what the corpus
 * already uses, most used first, without ever constraining a new word.
 *
 * Derived from annotations the page already loaded — no server method.
 */

import type { RetrainMacroClass } from '@camstack/types'

export interface LabelledAnnotation {
  readonly macroClass: RetrainMacroClass
  readonly label?: string
  readonly kind?: 'subject' | 'model_error'
}

export interface VocabularyEntry {
  /** The most common spelling of this label. */
  readonly label: string
  readonly count: number
  /** How many of those uses were under each macro class. */
  readonly byClass: Readonly<Partial<Record<RetrainMacroClass, number>>>
}

/** Suggestions shown at once. */
export const MAX_SUGGESTIONS = 8

function normal(label: string): string {
  return label.trim().toLowerCase()
}

interface Group {
  readonly spellings: Map<string, number>
  count: number
  readonly byClass: Partial<Record<RetrainMacroClass, number>>
}

/** Every distinct label in `annotations`, most used first, then alphabetical. */
export function buildVocabulary(
  annotations: readonly LabelledAnnotation[],
): readonly VocabularyEntry[] {
  const groups = new Map<string, Group>()
  for (const a of annotations) {
    if (a.kind === 'model_error') continue
    const raw = a.label?.trim()
    if (raw === undefined || raw === '') continue
    const key = normal(raw)
    const group: Group = groups.get(key) ?? { spellings: new Map(), count: 0, byClass: {} }
    group.count += 1
    group.spellings.set(raw, (group.spellings.get(raw) ?? 0) + 1)
    group.byClass[a.macroClass] = (group.byClass[a.macroClass] ?? 0) + 1
    groups.set(key, group)
  }
  const entries = [...groups.values()].map((g): VocabularyEntry => {
    const [spelling] = [...g.spellings.entries()].toSorted(
      (x, y) => y[1] - x[1] || x[0].localeCompare(y[0]),
    )
    return { label: spelling?.[0] ?? '', count: g.count, byClass: g.byClass }
  })
  return entries.toSorted((a, b) => b.count - a.count || a.label.localeCompare(b.label))
}

/**
 * What to suggest for what was typed under `macroClass`: labels that contain
 * the text, those already used with this class first, never the exact text
 * itself (a field that suggests what it holds is noise).
 */
export function suggestLabels(
  vocabulary: readonly VocabularyEntry[],
  typed: string,
  macroClass: RetrainMacroClass,
  limit: number = MAX_SUGGESTIONS,
): readonly string[] {
  const needle = normal(typed)
  return vocabulary
    .filter(
      (v) => normal(v.label) !== needle && (needle === '' || normal(v.label).includes(needle)),
    )
    .toSorted((a, b) => (b.byClass[macroClass] ?? 0) - (a.byClass[macroClass] ?? 0))
    .slice(0, limit)
    .map((v) => v.label)
}
