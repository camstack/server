/**
 * dedupePages — collapse duplicate addon-page entries that arise when the
 * SAME addon is deployed on more than one node.
 *
 * Root cause this guards against: `addon-pages-source` is a COLLECTION cap.
 * When an addon (e.g. `benchmark`) runs on the hub-local child AND a remote
 * agent, each node registers its own collection provider under a distinct
 * registry key (`benchmark` vs `benchmark@dev-agent-0`). The hub's
 * `getCollection('addon-pages-source')` therefore returns multiple providers,
 * every one of which reports the SAME `id` (the addon's own id) and the SAME
 * page declarations. The aggregator's per-source fan-out then pushes the
 * identical page once per node, and the admin-ui sidebar shows the page twice.
 *
 * A page is uniquely identified by `(addonId, page.id)` — an addon's page id
 * is stable across the nodes it runs on, and `page.path` is derived from it.
 * We keep the FIRST occurrence (entry order is the source fan-out order, which
 * preserves the hub-local provider ahead of remote ones).
 */
import type { AddonPageInfo } from '@camstack/types'

/** Stable identity for an addon page, independent of which node reported it. */
function pageKey(info: AddonPageInfo): string {
  return `${info.addonId}::${info.page.id}`
}

/**
 * Return a new list with duplicate `(addonId, page.id)` entries removed,
 * preserving first-seen order. Pure — never mutates the input.
 */
export function dedupePages(pages: readonly AddonPageInfo[]): readonly AddonPageInfo[] {
  const seen = new Set<string>()
  const out: AddonPageInfo[] = []
  for (const info of pages) {
    const key = pageKey(info)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(info)
  }
  return out
}
