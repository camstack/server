/**
 * Global search — pure filter + ranking logic, deliberately separated from
 * the `<GlobalSearch>` component (see components/search/GlobalSearch.tsx).
 *
 * Domains: device (cameras/other devices), page (admin-ui sections — both
 * built-in and addon-contributed), integration (installed provider
 * addons), and the Build elements (automation, script, scheduler, action,
 * template, customDevice) — found by name and by tag. Callers build a flat `SearchItem[]` from whatever data they
 * already have loaded (see `search-items.ts`) and pass it here; this module
 * knows nothing about tRPC, React Query, or React. Ranking is `searchRank`
 * in `@dominevo/types` — the same function `deviceManager.search` uses.
 */
import type { LucideIcon } from 'lucide-react'
import { normalizeSearchText, searchRank } from '@dominevo/types'

export type SearchDomain =
  | 'device'
  | 'page'
  | 'integration'
  | 'automation'
  | 'script'
  | 'scheduler'
  | 'action'
  | 'template'
  | 'customDevice'

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
 *  then pages (the case the operator asked for by name), then the Build
 *  elements, then integrations. */
const DOMAIN_ORDER: readonly SearchDomain[] = [
  'device',
  'page',
  'automation',
  'script',
  'scheduler',
  'action',
  'template',
  'customDevice',
  'integration',
]

/** Safety cap on the TOTAL result count across every domain — not a
 *  per-domain cap (there is none; every exact/fuzzy match is returned and
 *  the dropdown scrolls). This only exists for the degenerate case of a
 *  one-letter query matching most of the item list. When it engages the UI
 *  MUST say so (`truncated` below) — a silent cap is worse than none. */
export const MAX_TOTAL_RESULTS = 200

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
    const rank = searchRank(rawQuery, {
      label: item.label,
      keywords: item.keywords,
      identifiers: item.identifiers,
    })
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
