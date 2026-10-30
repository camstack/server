/**
 * The per-`(device, day)` catalog cache (D549 § 4 / D224).
 *
 * Two windows, because two days are two different questions: a CLOSED day
 * cannot change, so its listing is immutable for a day; TODAY is
 * serve-and-revalidate under `OPERATOR_WRITTEN_STALE_MS`, the same discipline
 * every other Reolink cap read uses. Every answer carries `catalogAsOf` — a
 * cached list is never drawn as current.
 *
 * The rule a test can actually catch: a read NEVER joins a refresh already in
 * flight (D224). It is answered from the slice, empty included, because
 * "unknown" is the truth about a camera nobody reached.
 */

import { OPERATOR_WRITTEN_STALE_MS } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { CLOSED_DAY_TTL_MS, ClipCatalogCache } from '../clips/clip-catalog-cache.js'

const DAY = '2026-09-16'
const TODAY = '2026-09-20'

function cacheAt(now: () => number) {
  return new ClipCatalogCache<string>({ now })
}

describe('ClipCatalogCache', () => {
  it('serves nothing before anything was stored', () => {
    const cache = cacheAt(() => 1_000)
    expect(cache.peek(592, DAY)).toBeNull()
  })

  it('stamps catalogAsOf at the moment of the store', () => {
    let now = 5_000
    const cache = cacheAt(() => now)
    cache.put(592, DAY, ['a'], { closed: true })
    now = 9_000
    expect(cache.peek(592, DAY)?.catalogAsOf).toBe(5_000)
  })

  it('keeps a CLOSED day fresh for a whole day', () => {
    let now = 0
    const cache = cacheAt(() => now)
    cache.put(592, DAY, ['a'], { closed: true })
    now = CLOSED_DAY_TTL_MS - 1
    expect(cache.peek(592, DAY)?.stale).toBe(false)
    now = CLOSED_DAY_TTL_MS + 1
    expect(cache.peek(592, DAY)?.stale).toBe(true)
  })

  it('calls TODAY stale after the operator-written window', () => {
    let now = 0
    const cache = cacheAt(() => now)
    cache.put(592, TODAY, ['a'], { closed: false })
    now = OPERATOR_WRITTEN_STALE_MS - 1
    expect(cache.peek(592, TODAY)?.stale).toBe(false)
    now = OPERATOR_WRITTEN_STALE_MS + 1
    expect(cache.peek(592, TODAY)?.stale).toBe(true)
  })

  it('still SERVES a stale day — a stale list is a list with an age on it', () => {
    let now = 0
    const cache = cacheAt(() => now)
    cache.put(592, TODAY, ['a'], { closed: false })
    now = OPERATOR_WRITTEN_STALE_MS * 10
    const hit = cache.peek(592, TODAY)
    expect(hit?.clips).toEqual(['a'])
    expect(hit?.stale).toBe(true)
  })

  it('keeps devices apart', () => {
    const cache = cacheAt(() => 0)
    cache.put(592, DAY, ['a'], { closed: true })
    expect(cache.peek(618, DAY)).toBeNull()
  })

  it('remembers an EMPTY day as an answer, not as a miss', () => {
    // 618: the calendar marks the day, the index lists nothing. Re-asking the
    // camera on every scroll would not change that, and "we did not look" and
    // "we looked and it is empty" must not be the same value.
    const cache = cacheAt(() => 0)
    cache.put(618, DAY, [], { closed: true })
    expect(cache.peek(618, DAY)?.clips).toEqual([])
    expect(cache.peek(618, DAY)?.stale).toBe(false)
  })

  it('marks a day stale on demand without dropping what it holds', () => {
    // The standalone-battery timer marks the catalog stale and does NOTHING
    // else (D549 12). The rows must survive so a sleeping camera still lists.
    const cache = cacheAt(() => 0)
    cache.put(640, DAY, ['a'], { closed: true })
    cache.markStale(640)
    const hit = cache.peek(640, DAY)
    expect(hit?.clips).toEqual(['a'])
    expect(hit?.stale).toBe(true)
    expect(hit?.catalogAsOf).toBe(0)
  })

  it('answers a read from the slice rather than joining a refresh in flight', async () => {
    let now = 0
    const cache = cacheAt(() => now)
    cache.put(592, DAY, ['cached'], { closed: false })
    now = OPERATOR_WRITTEN_STALE_MS + 1
    let release = (): void => {}
    const slow = new Promise<readonly string[]>((resolve) => {
      release = () => resolve(['fresh'])
    })
    const refresh = vi.fn(() => slow)

    const first = await cache.serveAndRevalidate(592, DAY, { closed: false }, refresh)
    expect(first.clips).toEqual(['cached'])

    const second = await cache.serveAndRevalidate(592, DAY, { closed: false }, refresh)
    expect(second.clips).toEqual(['cached'])
    // One refresh for two reads — the second did not start a second one and
    // did not wait on the first.
    expect(refresh).toHaveBeenCalledTimes(1)
    release()
    await slow
  })

  it('waits for the refresh when it holds NOTHING at all', async () => {
    const cache = cacheAt(() => 0)
    const out = await cache.serveAndRevalidate(592, DAY, { closed: false }, async () => ['fresh'])
    expect(out.clips).toEqual(['fresh'])
    expect(out.catalogAsOf).toBe(0)
  })

  it('keeps the cached rows when the revalidation FAILS', async () => {
    // Fail OPEN on the list (D549 § 4): a fallible read must never empty a
    // surface. The failure is the caller's to log; the rows stay.
    let now = 0
    const cache = cacheAt(() => now)
    cache.put(592, DAY, ['cached'], { closed: false })
    now = OPERATOR_WRITTEN_STALE_MS + 1
    const out = await cache.serveAndRevalidate(592, DAY, { closed: false }, async () => {
      throw new Error('camera refused')
    })
    expect(out.clips).toEqual(['cached'])
    await Promise.resolve()
    expect(cache.peek(592, DAY)?.clips).toEqual(['cached'])
  })

  it('throws when it holds nothing AND the read fails', async () => {
    const cache = cacheAt(() => 0)
    await expect(
      cache.serveAndRevalidate(592, DAY, { closed: false }, async () => {
        throw new Error('camera refused')
      }),
    ).rejects.toThrow('camera refused')
  })
})

describe('ClipCatalogCache row lookup', () => {
  const row = (key: string, startMs: number) => ({ key, startMs })

  it('finds a row across every day it holds for a device', () => {
    // The thumbnail and playback routes are addressed by clipKey alone; they
    // must resolve it WITHOUT re-listing the camera (D549 15).
    const cache = new ClipCatalogCache<{ key: string; startMs: number }>({ now: () => 0 })
    cache.put(592, '2026-09-15', [row('a', 1)], { closed: true })
    cache.put(592, '2026-09-16', [row('b', 2)], { closed: true })
    expect(cache.findBy(592, (r) => r.key === 'b')?.startMs).toBe(2)
  })

  it('does not find a row filed under another device', () => {
    const cache = new ClipCatalogCache<{ key: string; startMs: number }>({ now: () => 0 })
    cache.put(592, '2026-09-16', [row('a', 1)], { closed: true })
    expect(cache.findBy(618, (r) => r.key === 'a')).toBeNull()
  })

  it('answers null rather than undefined when nothing matches', () => {
    const cache = new ClipCatalogCache<{ key: string; startMs: number }>({ now: () => 0 })
    expect(cache.findBy(592, () => true)).toBeNull()
  })

  it('lists every row a device holds, so a prefetch can pick the newest', () => {
    const cache = new ClipCatalogCache<{ key: string; startMs: number }>({ now: () => 0 })
    cache.put(592, '2026-09-15', [row('a', 1)], { closed: true })
    cache.put(592, '2026-09-16', [row('b', 2), row('c', 3)], { closed: true })
    expect(
      cache
        .allRows(592)
        .map((r) => r.key)
        .toSorted(),
    ).toEqual(['a', 'b', 'c'])
    expect(cache.allRows(618)).toEqual([])
  })
})
