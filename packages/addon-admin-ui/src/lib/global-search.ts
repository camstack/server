/**
 * Global search — pure filter + ranking logic, deliberately separated from
 * the `<GlobalSearch>` component (see components/search/GlobalSearch.tsx).
 *
 * Domains: device (cameras/other devices), page (admin-ui sections — both
 * built-in and addon-contributed), integration (installed provider
 * addons). Callers build a flat `SearchItem[]` from whatever data they
 * already have loaded (see `search-items.ts`) and pass it here; this module
 * knows nothing about tRPC, React Query, or React.
 */
import type { LucideIcon } from 'lucide-react'
import { normalizeSearchText } from './search-normalize'

export type SearchDomain = 'device' | 'page' | 'integration'

export interface SearchItem {
  /** Globally unique across all domains (used as the React key and for
   *  keyboard-navigation identity). Convention: `${domain}:${id}`. */
  readonly key: string
  readonly domain: SearchDomain
  readonly label: string
  /** Secondary line shown under the label (device type, section, addon id, …). */
  readonly subtitle?: string
  /** Extra text folded into matching but not shown (stableId, path, addonId…). */
  readonly keywords?: readonly string[]
  /** Tokens that match ONLY on equality, and outrank every label match when
   *  they do. An operator who types one of these has NAMED a record rather
   *  than described it, so the hit is a certainty and must sort as one —
   *  above a device whose name merely happens to contain the same digits.
   *
   *  Never substring- or fuzzy-matched, deliberately: the numeric device id
   *  is the motivating case and `1` as a substring would hit a third of a
   *  1 000-device fleet. Anything that SHOULD match partially (a stableId)
   *  belongs in `keywords`, not here. */
  readonly identifiers?: readonly string[]
  readonly path: string
  /** Per-item icon override (built-in and addon pages carry one already).
   *  Falls back to a per-domain default icon in the results list. */
  readonly icon?: LucideIcon
}

export interface SearchResultGroup {
  readonly domain: SearchDomain
  readonly items: readonly SearchItem[]
}

/** Fixed render order — devices first (the everyday "find my camera" case),
 *  then pages (the case the operator asked for by name), then integrations. */
const DOMAIN_ORDER: readonly SearchDomain[] = ['device', 'page', 'integration']

/** Safety cap on the TOTAL result count across every domain — not a
 *  per-domain cap (there is none; every exact/fuzzy match is returned and
 *  the dropdown scrolls). This only exists for the degenerate case of a
 *  one-letter query matching most of the item list. When it engages the UI
 *  MUST say so (`truncated` below) — a silent cap is worse than none. */
export const MAX_TOTAL_RESULTS = 200

/**
 * One ascending scale for every way an item can match, exact levels first
 * and the two fuzzy levels last. Lower is better; `null` = no match at all.
 *
 * They are named rather than written inline because the ordering is the
 * whole contract: a fuzzy hit outranking an exact one is a bug you only
 * notice by reading two unrelated numbers side by side.
 */
const RANK_EXACT_IDENTIFIER = 0
const RANK_EXACT_LABEL = 1
const RANK_LABEL_PREFIX = 2
const RANK_WORD_PREFIX = 3
const RANK_LABEL_SUBSTRING = 4
const RANK_KEYWORD_SUBSTRING = 5
const RANK_SUBSEQUENCE = 6
const RANK_FUZZY_WORD = 7

/**
 * The exact levels (0-5). `null` = no exact match; the caller then falls
 * through to {@link fuzzyMatchRank}.
 *   0 — the query IS one of the item's `identifiers` (the numeric device id)
 *   1 — exact label match
 *   2 — label starts with the query
 *   3 — some whole word in the label starts with the query
 *   4 — query appears anywhere in the label
 *   5 — query only matches a keyword (stableId, addonId, path segment, …)
 *
 * Level 0 sits ABOVE the exact-label level on purpose: `102` typed into the
 * box is a device id, and a camera named "Garage 102" must not bury it.
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

/** True when every character of `query` appears in `label`, in order, gaps
 *  allowed — two pointers, O(label.length). Catches abbreviations and
 *  dropped letters: "vdc" → "camera", "ingrso" → "front door", and
 *  ("vdc front door" → "Camera front door" — the query's literal space
 *  just has to line up with a space in the label, same as any other
 *  character). */
function isSubsequence(label: string, query: string): boolean {
  let queryIndex = 0
  for (let labelIndex = 0; labelIndex < label.length && queryIndex < query.length; labelIndex++) {
    if (label[labelIndex] === query[queryIndex]) queryIndex++
  }
  return queryIndex === query.length
}

/** Edit-distance budget for level 6, proportional to query length — a FIXED
 *  budget (e.g. always 2) would let a 3-letter query match nearly any
 *  3-letter word, which is noise, not fuzzy search. Longer queries can
 *  absorb more typos without losing precision. */
function fuzzyThreshold(queryLength: number): number {
  if (queryLength < 4) return 0
  if (queryLength <= 7) return 1
  if (queryLength <= 12) return 2
  return 3
}

/**
 * Bounded Damerau-Levenshtein distance (optimal string alignment — adjacent
 * transpositions count as one edit, not two) between `a` and `b`, or `null`
 * once it's provable the true distance exceeds `maxDistance`.
 *
 * Three rotating rows (i-2, i-1, i): OSA's transposition term reads the row
 * two back, so the usual two-row rolling DP isn't enough. Early-exits the
 * moment a row's own minimum already exceeds the budget — the distance can
 * only grow from there, never shrink back under it.
 */
function boundedOsaDistance(a: string, b: string, maxDistance: number): number | null {
  if (a === b) return 0
  if (maxDistance <= 0) return null
  if (Math.abs(a.length - b.length) > maxDistance) return null

  const bLen = b.length
  let rowBefore = new Array<number>(bLen + 1).fill(0) // row i-2
  let rowPrev = Array.from({ length: bLen + 1 }, (_, j) => j) // row i-1 (i.e. i=0)
  let rowCurr = new Array<number>(bLen + 1).fill(0) // row i

  for (let i = 1; i <= a.length; i++) {
    rowCurr[0] = i
    let rowMin = i
    const aChar = a[i - 1]
    for (let j = 1; j <= bLen; j++) {
      const bChar = b[j - 1]
      const substitutionCost = aChar === bChar ? 0 : 1
      let value = Math.min(
        (rowPrev[j] ?? Infinity) + 1, // deletion
        rowCurr[j - 1] + 1, // insertion
        (rowPrev[j - 1] ?? Infinity) + substitutionCost, // substitution
      )
      if (i > 1 && j > 1 && aChar === b[j - 2] && a[i - 2] === bChar) {
        value = Math.min(value, (rowBefore[j - 2] ?? Infinity) + 1) // transposition
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
 * The two fuzzy levels — tried ONLY when every level of `matchRank` (0-5)
 * has already returned null for this item. That ordering is what makes it
 * structurally impossible for a fuzzy hit to outrank an exact one: they
 * share one numeric scale and sorting is ascending.
 *   6 — subsequence match against the whole label.
 *   7 — some individual WORD of the label (not the label as a whole — a
 *       typo in one word of a long label shouldn't be swamped by the
 *       label's other, unrelated words) is within a length-proportional
 *       bounded OSA distance of the query.
 *
 * Note what is NOT reachable from here: `identifiers`. A device id is a
 * fact, not a spelling — "108" must never fuzzy-match device 102.
 */
function fuzzyMatchRank(normalizedLabel: string, query: string): number | null {
  if (isSubsequence(normalizedLabel, query)) return RANK_SUBSEQUENCE

  const threshold = fuzzyThreshold(query.length)
  if (threshold > 0) {
    for (const word of normalizedLabel.split(/\s+/)) {
      if (boundedOsaDistance(word, query, threshold) !== null) return RANK_FUZZY_WORD
    }
  }
  return null
}

export interface SearchFilterResult {
  readonly groups: readonly SearchResultGroup[]
  /** Every item that matched, across all domains, BEFORE `maxTotalResults`
   *  was applied — what the truncation notice's "of M" refers to. */
  readonly totalMatched: number
  /** True when `totalMatched` exceeded `maxTotalResults` and some matches
   *  were therefore left out of `groups`. The UI must surface this rather
   *  than silently dropping results. */
  readonly truncated: boolean
}

/**
 * Filter + rank + group `items` against `rawQuery`.
 *
 * Returns an empty result for a blank query (nothing typed — the caller
 * shows no dropdown, not an empty-state message) AND for a query that
 * matches nothing (the caller is expected to distinguish these two cases by
 * checking whether `rawQuery.trim()` is empty — see GlobalSearch.tsx).
 */
export function filterSearchItems(
  items: readonly SearchItem[],
  rawQuery: string,
  maxTotalResults: number = MAX_TOTAL_RESULTS,
): SearchFilterResult {
  const query = normalizeSearchText(rawQuery)
  if (query.length === 0) return { groups: [], totalMatched: 0, truncated: false }

  const byDomain = new Map<SearchDomain, Array<{ item: SearchItem; rank: number }>>()
  for (const item of items) {
    const normalizedLabel = normalizeSearchText(item.label)
    const normalizedKeywords = (item.keywords ?? []).map(normalizeSearchText)
    const normalizedIdentifiers = (item.identifiers ?? []).map(normalizeSearchText)
    const rank =
      matchRank(normalizedLabel, normalizedKeywords, normalizedIdentifiers, query) ??
      fuzzyMatchRank(normalizedLabel, query)
    if (rank === null) continue
    const bucket = byDomain.get(item.domain) ?? []
    bucket.push({ item, rank })
    byDomain.set(item.domain, bucket)
  }

  let totalMatched = 0
  for (const bucket of byDomain.values()) totalMatched += bucket.length

  let remaining = maxTotalResults
  const groups: SearchResultGroup[] = []
  for (const domain of DOMAIN_ORDER) {
    const bucket = byDomain.get(domain)
    if (!bucket || bucket.length === 0 || remaining <= 0) continue
    bucket.sort((a, b) => a.rank - b.rank || a.item.label.localeCompare(b.item.label))
    const taken = bucket.slice(0, remaining).map((entry) => entry.item)
    remaining -= taken.length
    groups.push({ domain, items: taken })
  }

  return { groups, totalMatched, truncated: totalMatched > maxTotalResults }
}

/** Flatten grouped results in display order — the sequence keyboard
 *  ArrowUp/ArrowDown walks through, spanning domain boundaries. */
export function flattenSearchResults(groups: readonly SearchResultGroup[]): readonly SearchItem[] {
  return groups.flatMap((group) => group.items)
}
