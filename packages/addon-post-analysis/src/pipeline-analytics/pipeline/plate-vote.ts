/**
 * Per-character VOTE over a track's plate reads.
 *
 * A track produces up to `plate-ocr`'s `cadence.maxPerTrack` reads of the SAME
 * physical plate, from different frames. The recognizer used to keep the single
 * read with the highest OCR score (`holdBest`, argmax) — and OCR score does not
 * correlate with correctness. In the 2026-08 audit the top-scoring read of a
 * track was routinely the wrong one while two lower-scoring reads agreed on the
 * right glyph: score ranks how confident the recognizer was about the pixels it
 * saw, not how much of the plate those pixels were.
 *
 * So the reads vote. Each read is normalized (upper, alnum only), aligned to a
 * reference read, and contributes its OCR score to whichever glyph it saw at
 * each reference position; the winner per position is the output. Two reads
 * that agree beat one confident read that disagrees, which is the whole point.
 *
 * ALIGNMENT — reads differ in length (4–9 glyphs live: a dropped leading
 * district letter, a hallucinated trailing glyph). A positional vote on raw
 * indices would let one missing character shift every later column and destroy
 * the agreement it was supposed to measure. Each read is therefore aligned to
 * the reference by Levenshtein traceback: a match or substitution votes at the
 * reference position it aligned to, an insertion votes nowhere, and a deletion
 * simply abstains at that position.
 *
 * REFERENCE — the length carrying the most SCORE MASS wins (a hallucinated
 * 9-glyph read does not get to set the output length just by being longest);
 * ties inside that length go to the highest-scoring read. With ≤5 reads this is
 * the honest cheap heuristic: there is no third source of truth to consult.
 */
import { normalizePlate } from './plate-clustering.js'

/** One OCR read of a track's plate: the raw text and the recognizer's score. */
export interface PlateReadVote {
  readonly text: string
  readonly score: number
}

/**
 * How many reads a track keeps for the vote. Mirrors the plate-ocr step's
 * `cadence.maxPerTrack` — more would be buffered and never arrive.
 */
export const MAX_VOTING_READS = 5

interface NormalizedRead {
  readonly text: string
  readonly score: number
}

/**
 * Align `candidate` to `reference` by Levenshtein traceback. Returns one entry
 * per REFERENCE position: the candidate glyph that aligned there, or `null`
 * when the candidate had nothing at that position (a deletion). Candidate
 * insertions are dropped — they have no reference column to vote in.
 */
function alignToReference(reference: string, candidate: string): readonly (string | null)[] {
  const n = reference.length
  const m = candidate.length
  const dist: number[][] = []
  for (let i = 0; i <= n; i++) {
    const row = new Array<number>(m + 1).fill(0)
    row[0] = i
    dist.push(row)
  }
  const first = dist[0]
  if (first === undefined) return []
  for (let j = 0; j <= m; j++) first[j] = j

  for (let i = 1; i <= n; i++) {
    const prev = dist[i - 1]
    const cur = dist[i]
    if (prev === undefined || cur === undefined) continue
    for (let j = 1; j <= m; j++) {
      const cost = reference[i - 1] === candidate[j - 1] ? 0 : 1
      cur[j] = Math.min((prev[j] ?? 0) + 1, (cur[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost)
    }
  }

  const aligned: (string | null)[] = new Array<string | null>(n).fill(null)
  let i = n
  let j = m
  while (i > 0 && j > 0) {
    const cur = dist[i]
    const prev = dist[i - 1]
    if (cur === undefined || prev === undefined) break
    const cost = reference[i - 1] === candidate[j - 1] ? 0 : 1
    if (cur[j] === (prev[j - 1] ?? 0) + cost) {
      aligned[i - 1] = candidate[j - 1] ?? null
      i--
      j--
    } else if (cur[j] === (prev[j] ?? 0) + 1) {
      i--
    } else {
      j--
    }
  }
  return aligned
}

/** The read whose LENGTH carries the most score mass; ties → highest score. */
function pickReference(reads: readonly NormalizedRead[]): string {
  const massByLength = new Map<number, number>()
  for (const r of reads) {
    massByLength.set(r.text.length, (massByLength.get(r.text.length) ?? 0) + r.score)
  }
  let bestLength = 0
  let bestMass = -1
  for (const [length, mass] of massByLength) {
    if (mass > bestMass || (mass === bestMass && length < bestLength)) {
      bestMass = mass
      bestLength = length
    }
  }
  let reference = ''
  let referenceScore = -1
  for (const r of reads) {
    if (r.text.length === bestLength && r.score > referenceScore) {
      referenceScore = r.score
      reference = r.text
    }
  }
  return reference
}

/**
 * Confidence-weighted per-character vote over a track's plate reads. Returns
 * the normalized winning text (`''` when there is nothing to vote on).
 */
export function votePlateText(reads: readonly PlateReadVote[]): string {
  const normalized: NormalizedRead[] = []
  for (const r of reads) {
    const text = normalizePlate(r.text)
    if (text.length > 0) normalized.push({ text, score: r.score })
  }
  if (normalized.length === 0) return ''
  const only = normalized[0]
  if (normalized.length === 1 && only !== undefined) return only.text

  const reference = pickReference(normalized)
  if (reference.length === 0) return ''

  const columns: Map<string, number>[] = []
  for (let i = 0; i < reference.length; i++) columns.push(new Map<string, number>())

  for (const r of normalized) {
    const aligned = r.text === reference ? [...r.text] : alignToReference(reference, r.text)
    for (let i = 0; i < reference.length; i++) {
      const glyph = aligned[i]
      if (glyph === null || glyph === undefined) continue
      const column = columns[i]
      if (column === undefined) continue
      column.set(glyph, (column.get(glyph) ?? 0) + r.score)
    }
  }

  let out = ''
  for (let i = 0; i < reference.length; i++) {
    const column = columns[i]
    const referenceGlyph = reference[i] ?? ''
    if (column === undefined || column.size === 0) {
      out += referenceGlyph
      continue
    }
    // Seed the winner with the reference glyph so a tie resolves to it rather
    // than to Map iteration order.
    let bestGlyph = referenceGlyph
    let bestMass = column.get(referenceGlyph) ?? -1
    for (const [glyph, mass] of column) {
      if (mass > bestMass) {
        bestMass = mass
        bestGlyph = glyph
      }
    }
    out += bestGlyph
  }
  return out
}
