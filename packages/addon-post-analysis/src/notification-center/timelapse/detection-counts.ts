/**
 * What the closed window CONTAINED, counted per class.
 *
 * The operator's ask: the timelapse card should say how many people, vehicles
 * and animals the night held — *"lo supportiamo già?"* [do we already support it?] — for the classes he
 * selects (`TimelapseRule.reportClasses`).
 *
 * **The counts are aggregated from the SAME tracks the dense-range plan was
 * built from.** Not a second query: a count that came from its own read could
 * disagree with the video it captions — say "3 persone" over a render whose
 * fast-cadence stretches were cut from a different four tracks — and that
 * contradiction is unfalsifiable from the outside. One read, two derivations.
 *
 * Pure: no clock, no store, no I/O.
 */

import type { NcTextCatalog } from '../text-catalog.js'
import { ncDetectionSummary } from '../text-compose.js'
import type { TimelapseTrackInterval } from './dense-ranges.js'

export interface DetectionCountsInput {
  /** Exactly the array the dense planner received. */
  readonly tracks: readonly TimelapseTrackInterval[]
  /**
   * Classes to report. Absent OR EMPTY ⇒ every class the window contained.
   *
   * Empty and absent must mean the same thing: the wire cannot distinguish "he
   * cleared the field" from "he never opened it", and reporting nothing is the
   * answer no operator wants from a field he does not know exists.
   */
  readonly reportClasses?: readonly string[]
}

export interface DetectionCounts {
  /** Total over the REPORTED classes — never over all of them. A total that
   *  disagreed with the per-class line beside it would be worse than no total. */
  readonly total: number
  /** Count per reported class, lower-cased keys. A selected class the window
   *  never contained is present with 0, so a template can say "0 veicoli". */
  readonly byClass: Readonly<Record<string, number>>
  /** Reported classes, busiest first, ties by name — so the same night always
   *  produces the same sentence. */
  readonly classes: readonly string[]
}

/** One normalisation, used on both sides of every comparison — a rule that
 *  named `Person` must match a track classified `person`. */
function normalise(name: string): string {
  return name.trim().toLowerCase()
}

/** Count per class over the tracks, honouring the rule's selection. */
export function countDetections(input: DetectionCountsInput): DetectionCounts {
  const selected = (input.reportClasses ?? []).map(normalise).filter((c) => c.length > 0)
  const seen = new Map<string, number>()
  for (const t of input.tracks) {
    // A track with no class is a legacy row or a synthetic sensor track.
    // Counting it would put the word "undefined" in a notification.
    if (t.className === undefined) continue
    const key = normalise(t.className)
    if (key.length === 0) continue
    if (selected.length > 0 && !selected.includes(key)) continue
    seen.set(key, (seen.get(key) ?? 0) + 1)
  }
  // A SELECTED class the window never contained is reported as 0, not omitted:
  // "0 veicoli" is an answer, a missing placeholder is a defect.
  const byClass: Record<string, number> = {}
  for (const key of selected) byClass[key] = seen.get(key) ?? 0
  for (const [key, n] of seen) byClass[key] = n
  const classes = Object.keys(byClass).sort((a, b) => {
    const diff = (byClass[b] ?? 0) - (byClass[a] ?? 0)
    return diff !== 0 ? diff : a.localeCompare(b)
  })
  return {
    total: classes.reduce((sum, key) => sum + (byClass[key] ?? 0), 0),
    byClass,
    classes,
  }
}

/**
 * `3 persone, 2 veicoli e 1 animale` — empty when nothing was counted, so the
 * caller can omit the line rather than print a zero nobody reads.
 *
 * The nouns and the conjunction come from the TEXT CATALOG. They used to be a
 * six-word Italian table right here, chosen because the derived body around it
 * was hard-coded Italian too; both are the catalog's now, so this file counts
 * and orders and says nothing about words.
 */
export function detectionSummary(texts: NcTextCatalog, counts: DetectionCounts): string {
  return ncDetectionSummary(
    texts,
    counts.classes.map((className) => ({ className, count: counts.byClass[className] ?? 0 })),
  )
}

/**
 * The `{{var}}` slice a timelapse template gains from the counts.
 *
 * Keys are `\w+` ONLY, because that is exactly what `renderTemplate` matches:
 * a key carrying a hyphen or a space would be a placeholder that silently
 * renders as itself forever. `count_` + the class name satisfies it for every
 * class this system emits.
 */
export function detectionTemplateVars(
  texts: NcTextCatalog,
  counts: DetectionCounts,
): Readonly<Record<string, string>> {
  const perClass: Record<string, string> = {}
  for (const key of counts.classes) {
    const safe = key.replace(/\W+/g, '_')
    perClass[`count_${safe}`] = String(counts.byClass[key] ?? 0)
  }
  return {
    detections: String(counts.total),
    detectionSummary: detectionSummary(texts, counts),
    ...perClass,
  }
}
