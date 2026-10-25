import { describe, it, expect } from 'vitest'
import {
  ScrubFragmentCache,
  SCRUB_FRAGMENT_CACHE_MB,
  SCRUB_FRAGMENT_CACHE_MIN_ENTRIES,
  SCRUB_FRAGMENT_CACHE_OTHER_MB,
} from '../scrub-fragment-cache'
import type { AccessUnit } from '../segment-demux'

/**
 * The scrub cache is bounded in BYTES, because entries are not comparable: a
 * demuxed `low` GOP measured 41–173 KB in the field, so the old count of 8 was
 * anywhere between 0.3 and 1.4 MB per viewer session and could not be reasoned
 * about from either end. What a knob in MB buys is a number an operator can set
 * against RAM instead of against a fragment size nobody knows.
 */

function fragment(startMs: number, bytes: number, durMs = 4_000) {
  const aus: AccessUnit[] = [
    { data: new Uint8Array(bytes), ptsMs: 0, keyframe: true, codec: 'H264' },
  ]
  return { startMs, durMs, aus }
}

describe('ScrubFragmentCache — bounded in bytes', () => {
  it('evicts least-recently-used once the byte bound is exceeded', () => {
    const cache = new ScrubFragmentCache(300_000)
    cache.put('low', fragment(0, 100_000))
    cache.put('low', fragment(4_000, 100_000))
    cache.put('low', fragment(8_000, 100_000))
    expect(cache.byteSize).toBe(300_000)
    expect(cache.size).toBe(3)

    // Touch the oldest so it is no longer the eviction candidate.
    expect(cache.get('low', 0)).not.toBeNull()
    cache.put('low', fragment(12_000, 100_000))
    // Four × 100 KB is over the bound, but the floor on entries holds them.
    expect(cache.size).toBe(4)
    // A fifth pushes past both the byte bound AND the floor: the least
    // recently used goes, and the touched fragment survives.
    cache.put('low', fragment(16_000, 100_000))
    expect(cache.get('low', 0)).not.toBeNull()
    expect(cache.get('low', 4_000)).toBeNull()
  })

  it('never evicts below the working set a drag needs', () => {
    // Fragments far larger than the whole bound: a naive byte cap would empty
    // the cache on every put, so every tick would pay the read AND the demux —
    // worse than having no cache at all.
    const cache = new ScrubFragmentCache(10_000)
    for (let i = 0; i < 8; i++) cache.put('low', fragment(i * 4_000, 500_000))
    expect(cache.size).toBe(SCRUB_FRAGMENT_CACHE_MIN_ENTRIES)
    // …and what survives is the most recent, which is where the drag is.
    expect(cache.get('low', 7 * 4_000)).not.toBeNull()
  })

  it('replacing an entry re-counts its bytes instead of leaking them', () => {
    const cache = new ScrubFragmentCache(1_000_000)
    cache.put('low', fragment(0, 100_000))
    cache.put('low', fragment(0, 40_000))
    expect(cache.size).toBe(1)
    expect(cache.byteSize).toBe(40_000)
  })

  it('the default bound is the documented MB knob — and it is FOR the scrub profile', () => {
    expect(new ScrubFragmentCache().byteSize).toBe(0)
    // 48 MB ≈ 200 whole `low` segments ≈ ±15 min of timeline resident in RAM,
    // the sliding window around the cursor (not a 6-hour prefetch).
    expect(SCRUB_FRAGMENT_CACHE_MB).toBe(48)
    expect(SCRUB_FRAGMENT_CACHE_OTHER_MB).toBeLessThan(SCRUB_FRAGMENT_CACHE_MB)
  })

  it("a heavy profile cannot spend the scrub profile's budget", () => {
    // A `high` segment is ~5 MB demuxed. Its entries live under the small
    // budget and, crucially, evict each OTHER — never the `low` segments the
    // drag is running on.
    const cache = new ScrubFragmentCache(1_000_000, 200_000)
    for (let i = 0; i < 6; i++) cache.put('low', fragment(i * 4_000, 100_000))
    const lowBytes = cache.byteSizeFor('low')
    for (let i = 0; i < 8; i++) cache.put('high', fragment(i * 4_000, 100_000))
    expect(cache.byteSizeFor('low')).toBe(lowBytes)
    expect(cache.byteSizeFor('high')).toBeLessThanOrEqual(
      SCRUB_FRAGMENT_CACHE_MIN_ENTRIES * 100_000,
    )
  })

  it('keeps profiles apart — a `low` fragment never answers for `mid`', () => {
    const cache = new ScrubFragmentCache(1_000_000)
    cache.put('low', fragment(0, 1_000))
    expect(cache.covering('mid', 100)).toBeNull()
    expect(cache.covering('low', 100)).not.toBeNull()
  })
})
