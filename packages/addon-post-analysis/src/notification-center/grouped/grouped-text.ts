/**
 * The grouped SENTENCE — `{{subject}}` when one message is about several subjects
 * (D692 §6.4): names first, capped at two (a lock screen truncates), then the
 * remainder COUNTED per class so the sentence agrees with itself in the reader's
 * language:
 *
 *     Person A, Person B e 1 altro animale
 *
 * The members arrive in the §6.2 order (recognised first), so the sentence and the
 * mosaic read in the same order — which is how a reader matches a name to a tile
 * without any text burnt into pixels.
 *
 * A named member is spoken through `ncSubjectText` — an identity reads as its name, a
 * plate through `detection.subject.plate` ("auto AB123CD"), because a person takes a
 * verb and a plate takes a noun.
 *
 * ## Built out of what already ships
 *
 * `ncDetectionSummary` renders *"1 persona, 2 veicoli e 3 animali"* with real CLDR
 * plurals and the language's own conjunction. This module composes THAT function and
 * `ncClassNoun`; it does not become a second sentence builder beside them. The only
 * own vocabulary is the `group.others.*` family, which mirrors `class.*` /
 * `class.other` — Italian needs per-class gender agreement on "altro/altra"
 * [other, masculine/feminine].
 *
 * ## The n=1 rule
 *
 * A group of one renders EXACTLY what `ncSubjectText` renders, by calling it:
 * a grouped window that closes with one member is a plain immediate notification,
 * byte for byte (D692 C7).
 */

import type { LabelKind } from '../../pipeline-analytics/pipeline/label-tier.js'
import type { NcTextCatalog } from '../text-catalog.js'
import {
  type NcClassCount,
  ncClassNoun,
  ncDetectionSummary,
  ncSubjectText,
} from '../text-compose.js'

/** What the sentence needs to know about one member. */
export interface NcGroupTextMember {
  readonly className: string
  /** Identity name or plate text — both read as "a name" in this sentence. */
  readonly label?: string
  readonly labelKind?: LabelKind
}

export interface NcGroupSubjectTextInput {
  readonly members: readonly NcGroupTextMember[]
  /**
   * How many names before the rest become a count. Two by default: a phone's
   * lock screen truncates, and the third name costs more than it carries.
   * Nobody is DROPPED by this — the unnamed remainder is counted, so the number
   * in the sentence is always the number of subjects.
   */
  readonly maxNames?: number
}

const DEFAULT_MAX_NAMES = 2

/**
 * `N altre persone` — the remainder phrase for one class, in its own gender.
 *
 * Mirrors {@link ncClassNoun} byte for byte, including the fallback: a class no
 * locale names falls through to `group.others.other`, which prints the raw class
 * name rather than vanishing. A custom model's class must appear in the sentence.
 */
function ncGroupOthers(texts: NcTextCatalog, className: string, count: number): string {
  const classNoun = ncClassNoun(texts, className, count)
  const key = `group.others.${className.trim().toLowerCase()}`
  if (texts.has(key)) return texts.text({ key, count, vars: { count: `${count}`, classNoun } })
  return texts.text({
    key: 'group.others.other',
    count,
    vars: { count: `${count}`, classNoun },
  })
}

/** Counts per class, in first-seen order so the same burst always reads the same. */
function countByClass(members: readonly NcGroupTextMember[]): readonly NcClassCount[] {
  const counts = new Map<string, number>()
  for (const m of members) counts.set(m.className, (counts.get(m.className) ?? 0) + 1)
  return [...counts].map(([className, count]) => ({ className, count }))
}

/**
 * The finished `{{subject}}` phrase for a group.
 *
 * Pure: a catalog in, a string out. No clock, no store, no I/O — like every
 * other composer in `text-compose.ts`, and for the same reason.
 */
export function ncGroupSubjectText(texts: NcTextCatalog, input: NcGroupSubjectTextInput): string {
  const members = input.members
  // n=1 is TODAY. Delegated rather than reimplemented so it cannot drift.
  const only = members.length === 1 ? members[0] : undefined
  if (only !== undefined) {
    return ncSubjectText(texts, {
      className: only.className,
      ...(only.label !== undefined ? { label: only.label } : {}),
      ...(only.labelKind !== undefined ? { labelKind: only.labelKind } : {}),
    })
  }
  if (members.length === 0) return ''

  const maxNames =
    input.maxNames !== undefined && input.maxNames >= 0 ? input.maxNames : DEFAULT_MAX_NAMES
  // Only a RECOGNITION is a name (identity or plate) — the same test the member order uses
  // (`orderGroupMembers`), so the sentence and the mosaic read in the same order (§6.2). An
  // unattributed label (a tier-1 sub-class) is counted with its class.
  const named = members.filter(
    (m) =>
      (m.labelKind === 'identity' || m.labelKind === 'plate') &&
      m.label !== undefined &&
      m.label.length > 0,
  )
  // Each name through the subject phrase of its kind (an identity is its name, a
  // plate is "auto AB123CD") — the single-member wording, never a bare word.
  const names = named.slice(0, maxNames).map((m) =>
    ncSubjectText(texts, {
      className: m.className,
      ...(m.label !== undefined ? { label: m.label } : {}),
      ...(m.labelKind !== undefined ? { labelKind: m.labelKind } : {}),
    }),
  )

  // Nobody recognised: the plain composition sentence, which already exists.
  if (names.length === 0) return ncDetectionSummary(texts, countByClass(members))

  // Everyone else — including the recognised people past the name cap — is
  // counted. Their names are not lost from the record, only from the sentence.
  const spoken = new Set(named.slice(0, maxNames))
  const remainder = members.filter((m) => !spoken.has(m))
  if (remainder.length === 0) return texts.join(names)

  const others = countByClass(remainder).map((c) => ncGroupOthers(texts, c.className, c.count))
  return texts.join([...names, ...others])
}
