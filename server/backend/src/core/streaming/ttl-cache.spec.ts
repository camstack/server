/**
 * The bound these tests exist for is "the structure stops growing", not "the
 * constant is N". `StreamProbeService` shipped a Map keyed by stream URL whose
 * TTL was consulted only when the same URL was probed again — so an entry
 * nobody asked about a second time was retained forever.
 */
import { describe, it, expect } from 'vitest'
import { TtlCache } from './ttl-cache'

describe('TtlCache', () => {
  it('serves a live value and reports a miss once it expires', () => {
    let now = 0
    const cache = new TtlCache<string>({ ttlMs: 100, maxEntries: 10, now: () => now })
    cache.set('rtsp://a', 'meta-a')
    now = 99
    expect(cache.get('rtsp://a')).toBe('meta-a')
    now = 200
    expect(cache.get('rtsp://a')).toBeUndefined()
  })

  it('EVICTS an expired entry nobody ever asks for again', () => {
    // The whole bug: with the TTL checked on read only, `rtsp://gone` is never
    // read a second time, so it is never found expired, so it is never removed.
    let now = 0
    const cache = new TtlCache<string>({ ttlMs: 100, maxEntries: 100, now: () => now })
    cache.set('rtsp://gone', 'meta')
    expect(cache.size()).toBe(1)
    now = 500
    cache.set('rtsp://other', 'meta')
    expect(cache.size()).toBe(1) // only the live one is left
  })

  it('never grows past maxEntries even when every entry is inside its TTL', () => {
    let now = 0
    const cache = new TtlCache<string>({ ttlMs: 3_600_000, maxEntries: 3, now: () => now })
    for (let i = 0; i < 50; i += 1) {
      now += 1
      cache.set(`rtsp://cam-${String(i)}`, 'meta')
    }
    expect(cache.size()).toBe(3)
  })

  it('evicts the least-recently-USED entry, so a hot URL survives a burst', () => {
    let now = 0
    const cache = new TtlCache<string>({ ttlMs: 3_600_000, maxEntries: 2, now: () => now })
    cache.set('hot', 'h')
    now += 1
    cache.set('cold', 'c')
    now += 1
    expect(cache.get('hot')).toBe('h') // `cold` is now the coldest
    now += 1
    cache.set('new', 'n')

    expect(cache.get('cold')).toBeUndefined()
    expect(cache.get('hot')).toBe('h')
    expect(cache.get('new')).toBe('n')
  })
})
