/**
 * Shared text ranking for the admin global search and `deviceManager.search`.
 *
 * One ascending scale. Lower is better; `null` is no match. Exact levels
 * (0–5) are tried before either fuzzy level (6–7), so a fuzzy hit cannot
 * outrank an exact one. Identifiers match on equality only — a device id is
 * a fact, not a spelling, and "108" must never fuzzy-match device 102.
 *
 * Fuzzy runs on the label first. Keywords are fuzzied only when the label
 * itself did not match, so an item that already matched keeps its rank.
 */

const COMBINING_MARKS = /\p{Mn}/gu

/** Case- and diacritic-insensitive. "Perche" and "Perché" compare equal. */
export function normalizeSearchText(value: string): string {
  return value.normalize('NFD').replace(COMBINING_MARKS, '').toLowerCase().trim()
}

/** What {@link searchRank} matches. Keywords are substring-then-fuzzy; identifiers are exact. */
export interface SearchRankFields {
  readonly label: string
  readonly keywords?: readonly string[]
  readonly identifiers?: readonly string[]
}

const RANK_EXACT_IDENTIFIER = 0
const RANK_EXACT_LABEL = 1
const RANK_LABEL_PREFIX = 2
const RANK_WORD_PREFIX = 3
const RANK_LABEL_SUBSTRING = 4
const RANK_KEYWORD_SUBSTRING = 5
const RANK_SUBSEQUENCE = 6
const RANK_FUZZY_WORD = 7

/**
 * Exact levels. `null` means no exact match; the caller falls through to fuzzy.
 *   0 — the query IS one of `identifiers`
 *   1 — exact label
 *   2 — label starts with the query
 *   3 — some whole word in the label starts with the query
 *   4 — query appears anywhere in the label
 *   5 — query appears in a keyword (stableId, parent name, path, …)
 *
 * Level 0 sits above the exact label: `102` is a device id, and a camera
 * named "Garage 102" must not bury it.
 */
function matchRank(
  normalizedLabel: string,
  normalizedKeywords: readonly string[],
  normalizedIdentifiers: readonly string[],
  query: string,
): number | null {
  if (normalizedIdentifiers.includes(query)) return RANK_EXACT_IDENTIFIER
  if (normalizedLabel === query) return RANK_EXACT_LABEL
  if (normalizedLabel.startsWith(query)) return RANK_LABEL_PREFIX
  if (normalizedLabel.split(/\s+/).some((word) => word.startsWith(query))) return RANK_WORD_PREFIX
  if (normalizedLabel.includes(query)) return RANK_LABEL_SUBSTRING
  if (normalizedKeywords.some((keyword) => keyword.includes(query))) return RANK_KEYWORD_SUBSTRING
  return null
}

/** Every character of `query` appears in `label`, in order. Gaps allowed. */
function isSubsequence(label: string, query: string): boolean {
  let queryIndex = 0
  for (let labelIndex = 0; labelIndex < label.length && queryIndex < query.length; labelIndex++) {
    const labelChar = label[labelIndex]
    const queryChar = query[queryIndex]
    if (labelChar !== undefined && labelChar === queryChar) queryIndex++
  }
  return queryIndex === query.length
}

/**
 * Edit-distance budget, proportional to query length. A fixed budget would
 * let a 3-letter query match nearly any 3-letter word.
 */
function fuzzyThreshold(queryLength: number): number {
  if (queryLength < 4) return 0
  if (queryLength <= 7) return 1
  if (queryLength <= 12) return 2
  return 3
}

/**
 * Bounded Damerau-Levenshtein (optimal string alignment: one adjacent
 * transposition is one edit). `null` once the distance is provably over
 * `maxDistance`. Three rotating rows because the transposition term reads
 * the row two back.
 */
function boundedOsaDistance(a: string, b: string, maxDistance: number): number | null {
  if (a === b) return 0
  if (maxDistance <= 0) return null
  if (Math.abs(a.length - b.length) > maxDistance) return null

  const bLen = b.length
  let rowBefore = new Array<number>(bLen + 1).fill(0)
  let rowPrev = Array.from({ length: bLen + 1 }, (_, j) => j)
  let rowCurr = new Array<number>(bLen + 1).fill(0)

  for (let i = 1; i <= a.length; i++) {
    rowCurr[0] = i
    let rowMin = i
    const aChar = a[i - 1]
    if (aChar === undefined) return null
    for (let j = 1; j <= bLen; j++) {
      const bChar = b[j - 1]
      const prevDelete = rowPrev[j]
      const prevDiag = rowPrev[j - 1]
      const currInsert = rowCurr[j - 1]
      if (bChar === undefined || prevDelete === undefined || prevDiag === undefined) return null
      if (currInsert === undefined) return null
      const substitutionCost = aChar === bChar ? 0 : 1
      let value = Math.min(prevDelete + 1, currInsert + 1, prevDiag + substitutionCost)
      const prevA = a[i - 2]
      const prevB = b[j - 2]
      const transpose = rowBefore[j - 2]
      if (
        i > 1 &&
        j > 1 &&
        prevA !== undefined &&
        prevB !== undefined &&
        aChar === prevB &&
        prevA === bChar
      ) {
        if (transpose !== undefined) value = Math.min(value, transpose + 1)
      }
      rowCurr[j] = value
      if (value < rowMin) rowMin = value
    }
    if (rowMin > maxDistance) return null
    const recycled = rowBefore
    rowBefore = rowPrev
    rowPrev = rowCurr
    rowCurr = recycled
  }

  const result = rowPrev[bLen] ?? Infinity
  return result <= maxDistance ? result : null
}

/**
 * Fuzzy levels, only after every exact level missed.
 *   6 — subsequence of the whole text
 *   7 — some WORD of the text is within a length-proportional OSA distance
 */
function fuzzyMatchRank(normalizedText: string, query: string): number | null {
  if (isSubsequence(normalizedText, query)) return RANK_SUBSEQUENCE

  const threshold = fuzzyThreshold(query.length)
  if (threshold > 0) {
    for (const word of normalizedText.split(/\s+/)) {
      if (boundedOsaDistance(word, query, threshold) !== null) return RANK_FUZZY_WORD
    }
  }
  return null
}

/** Best fuzzy rank across `texts`, or `null`. Subsequence (6) is the best fuzzy can be. */
function bestFuzzy(texts: readonly string[], query: string): number | null {
  let best: number | null = null
  for (const text of texts) {
    const rank = fuzzyMatchRank(text, query)
    if (rank === null) continue
    if (best === null || rank < best) best = rank
    if (best === RANK_SUBSEQUENCE) return best
  }
  return best
}

/**
 * Rank `rawQuery` against one record. `null` when nothing matches, including
 * a blank query. Keywords are fuzzied only when the label produced no rank,
 * so a label hit is never demoted or promoted by a keyword.
 */
export function searchRank(rawQuery: string, fields: SearchRankFields): number | null {
  const query = normalizeSearchText(rawQuery)
  if (query.length === 0) return null
  const label = normalizeSearchText(fields.label)
  const keywords = (fields.keywords ?? [])
    .map(normalizeSearchText)
    .filter((keyword) => keyword.length > 0)
  const identifiers = (fields.identifiers ?? [])
    .map(normalizeSearchText)
    .filter((identifier) => identifier.length > 0)
  return (
    matchRank(label, keywords, identifiers, query) ??
    fuzzyMatchRank(label, query) ??
    bestFuzzy(keywords, query)
  )
}
