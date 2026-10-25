import { describe, it, expect } from 'vitest'
import type { AddonPageInfo } from '@camstack/types'
import { dedupePages } from './dedupe-pages.js'

/**
 * Regression test for the "two Benchmark pages in the nav" bug.
 *
 * `addon-pages-source` is a collection cap; an addon deployed on the
 * hub-local child AND a remote agent registers one provider per node, each
 * reporting the SAME addon id + page declaration. The aggregator's per-source
 * fan-out then pushed the same page once per node, so the sidebar listed it
 * twice. `dedupePages` collapses those by `(addonId, page.id)`.
 */
function makePage(addonId: string, pageId: string, path: string, bundleUrl: string): AddonPageInfo {
  return {
    addonId,
    page: {
      id: pageId,
      label: 'Benchmark',
      icon: 'gauge',
      path,
      remoteName: 'addon_benchmark_page',
      bundle: 'remoteEntry.js',
    },
    bundleUrl,
  }
}

describe('dedupePages', () => {
  it('collapses the same addon page reported by multiple nodes to a single entry', () => {
    // Hub-local + agent-0 both report benchmark's single page.
    const input: readonly AddonPageInfo[] = [
      makePage(
        'benchmark',
        'benchmark',
        '/addon/benchmark',
        '/api/addon-pages/benchmark/remoteEntry.js?v=1',
      ),
      makePage(
        'benchmark',
        'benchmark',
        '/addon/benchmark',
        '/api/addon-pages/benchmark/remoteEntry.js?v=2',
      ),
    ]

    const out = dedupePages(input)

    expect(out).toHaveLength(1)
    expect(out[0]!.addonId).toBe('benchmark')
    expect(out[0]!.page.id).toBe('benchmark')
    // First-seen wins (hub-local provider precedes remote in fan-out order).
    expect(out[0]!.bundleUrl).toBe('/api/addon-pages/benchmark/remoteEntry.js?v=1')
  })

  it('keeps distinct pages from the same addon', () => {
    const input: readonly AddonPageInfo[] = [
      makePage('benchmark', 'benchmark', '/addon/benchmark', 'u1'),
      makePage('benchmark', 'pipeline-live', '/addon/pipeline-live', 'u2'),
    ]

    const out = dedupePages(input)

    expect(out).toHaveLength(2)
    expect(out.map((p) => p.page.id)).toEqual(['benchmark', 'pipeline-live'])
  })

  it('keeps same-id pages from different addons', () => {
    const input: readonly AddonPageInfo[] = [
      makePage('benchmark', 'dashboard', '/addon/benchmark', 'u1'),
      makePage('analytics', 'dashboard', '/addon/analytics', 'u2'),
    ]

    const out = dedupePages(input)

    expect(out).toHaveLength(2)
    expect(out.map((p) => p.addonId)).toEqual(['benchmark', 'analytics'])
  })

  it('does not mutate the input and returns a new array', () => {
    const input: readonly AddonPageInfo[] = [
      makePage('benchmark', 'benchmark', '/addon/benchmark', 'u1'),
      makePage('benchmark', 'benchmark', '/addon/benchmark', 'u2'),
    ]

    const out = dedupePages(input)

    expect(input).toHaveLength(2)
    expect(out).not.toBe(input)
  })

  it('returns empty for empty input', () => {
    expect(dedupePages([])).toEqual([])
  })
})
