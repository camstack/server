/**
 * plate-clustering — pure grouping of license-plate OCR reads by text proximity.
 *
 * Unlike faces (opaque embeddings → cosine), a plate is SELF-LABELING: the OCR
 * text IS the identity. The same physical plate is read slightly differently
 * across frames/angles ("AB123CD" vs "AB123CO" vs "A8123CD"), so we group reads
 * by edit-distance on a normalized, OCR-confusion-folded form. No I/O.
 *
 * Used to SUGGEST groups of equal-plate reads for review/merge, and to power
 * proximity search ("find plates close to this text").
 */

export interface PlateClusterItem {
  readonly id: string
  readonly text: string
}

export interface PlateCluster {
  /** Member plate ids, representative first. */
  readonly plateIds: readonly string[]
  readonly representativePlateId: string
  /** Normalized text of the representative read (display-friendly, upper, no separators). */
  readonly representativeText: string
  readonly size: number
  /** Mean text similarity (0..1) of members to the representative. */
  readonly cohesion: number
}

/**
 * Normalize a raw OCR plate string for display/storage: uppercase, strip
 * everything but A–Z/0–9. Does NOT fold confusable characters (that is only for
 * distance comparison) so the stored text stays faithful to the read.
 */
export function normalizePlate(text: string): string {
  return text.toUpperCase().replace(/[^A-Z0-9]/g, '')
}

/** Minimum alphanumeric length of a plausible plate read. */
const PLATE_MIN_LENGTH = 4
/** Minimum OCR confidence of a plausible plate read. */
export const PLATE_MIN_SCORE = 0.4

/** Raw-read glyphs a real plate can never contain: anything outside letters,
 *  digits, whitespace and the hyphen (display separator). The OCR charset
 *  includes bracket/punctuation glyphs, so a blurred crop can hallucinate
 *  reads like "[miv4o)" / "6ou.2" (live-observed 2026-07-22) that a
 *  length-only gate lets through. */
const PLATE_SYMBOL_GLYPH = /[^A-Za-z0-9\s-]/

/**
 * Quality gate for a raw OCR plate read BEFORE it becomes a track label or a
 * gallery row. Distant/oblique parked plates produce junk reads ("N", "Idag",
 * "@em") that otherwise flood track labels (live-observed on the parking
 * camera, 2026-07-16). A plausible European plate is ≥{@link PLATE_MIN_LENGTH}
 * alphanumerics, mixes letters AND digits, and carries NO symbol glyph in the
 * RAW read (spaces/hyphens allowed — normalization would silently strip a
 * hallucinated "[" and launder the junk); anything else — or a read below
 * {@link PLATE_MIN_SCORE} — is discarded, not stored.
 */
export function isPlausiblePlateRead(text: string, score: number): boolean {
  if (score < PLATE_MIN_SCORE) return false
  if (PLATE_SYMBOL_GLYPH.test(text)) return false
  const norm = normalizePlate(text)
  if (norm.length < PLATE_MIN_LENGTH) return false
  return /[0-9]/.test(norm) && /[A-Z]/.test(norm)
}

/**
 * Fold characters that OCR routinely confuses onto a single canonical symbol, so
 * "AB0" and "ABO" compare as equal. Applied to BOTH operands of a distance
 * comparison only — never stored. Conservative set covering the common Latin
 * plate confusions.
 */
export function canonicalizePlate(text: string): string {
  const norm = normalizePlate(text)
  const fold: Record<string, string> = {
    O: '0',
    Q: '0',
    D: '0',
    I: '1',
    L: '1',
    Z: '2',
    S: '5',
    B: '8',
    G: '6',
    T: '7',
  }
  let out = ''
  for (const ch of norm) out += fold[ch] ?? ch
  return out
}

/** Levenshtein edit distance between two strings (insert/delete/substitute = 1). */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  if (a.length === 0) return b.length
  if (b.length === 0) return a.length
  let prev = Array.from<number>({ length: b.length + 1 })
  let curr = Array.from<number>({ length: b.length + 1 })
  for (let j = 0; j <= b.length; j++) prev[j] = j
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i
    const ai = a.charCodeAt(i - 1)
    for (let j = 1; j <= b.length; j++) {
      const cost = ai === b.charCodeAt(j - 1) ? 0 : 1
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost)
    }
    const tmp = prev
    prev = curr
    curr = tmp
  }
  return prev[b.length]!
}

/** Edit distance on the OCR-confusion-folded, normalized forms. */
export function plateDistance(a: string, b: string): number {
  return levenshtein(canonicalizePlate(a), canonicalizePlate(b))
}

interface Bucket {
  readonly repId: string
  readonly repText: string
  readonly repCanon: string
  readonly ids: string[]
  simSum: number
}

/**
 * Greedily group plate reads by text proximity. A read joins the BEST existing
 * group whose representative is within `maxDistance` edits (after folding);
 * otherwise it opens a new group. Empty/blank reads are skipped.
 *
 * @param items       Plate reads (id + raw OCR text).
 * @param maxDistance Max folded edit-distance to join a group (default 1).
 * @returns Groups sorted largest-first, ties broken by cohesion desc.
 */
export function clusterByText(items: readonly PlateClusterItem[], maxDistance = 1): PlateCluster[] {
  const buckets: Bucket[] = []

  for (const item of items) {
    const canon = canonicalizePlate(item.text)
    if (canon.length === 0) continue

    let best: Bucket | null = null
    let bestDist = maxDistance + 1
    for (const b of buckets) {
      const dist = levenshtein(canon, b.repCanon)
      if (dist <= maxDistance && dist < bestDist) {
        bestDist = dist
        best = b
      }
    }

    if (best) {
      best.ids.push(item.id)
      const maxLen = Math.max(canon.length, best.repCanon.length) || 1
      best.simSum += 1 - bestDist / maxLen
    } else {
      buckets.push({
        repId: item.id,
        repText: normalizePlate(item.text),
        repCanon: canon,
        ids: [item.id],
        simSum: 1,
      })
    }
  }

  return buckets
    .map(
      (b): PlateCluster => ({
        plateIds: b.ids,
        representativePlateId: b.repId,
        representativeText: b.repText,
        size: b.ids.length,
        cohesion: b.simSum / b.ids.length,
      }),
    )
    .toSorted((a, b) => b.size - a.size || b.cohesion - a.cohesion)
}
