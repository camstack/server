/**
 * The cache was keyed by `deviceId` alone, and `getSnapshot` served the hit
 * BEFORE it resolved the requested stream. So `?streamId=low` returned whatever
 * was already cached — in production, the 4K main frame. The escape hatch that
 * existed for exactly this problem had never worked: probing a live camera with
 * `streamId=low|sub|high` returned three byte-identical 1.2 MB responses.
 *
 * These tests pin the key, and the two views that must still ask "anything for
 * this device?" without knowing which stream produced it.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { SnapshotCache, SNAPSHOT_CACHE_MAX_BYTES } from '../snapshot-cache.js'

const img = (tag: string): { base64: string; contentType: string } => ({
  base64: tag,
  contentType: 'image/jpeg',
})

let cache: SnapshotCache

beforeEach(() => {
  cache = new SnapshotCache()
})

describe('keying', () => {
  it('keeps one entry per stream', () => {
    cache.set(1, 'high', { data: img('4k'), ts: 10, streamId: 'high' })
    cache.set(1, 'low', { data: img('sub'), ts: 20, streamId: 'low' })

    expect(cache.get(1, 'high')?.data.base64).toBe('4k')
    expect(cache.get(1, 'low')?.data.base64).toBe('sub')
  })

  it('does not serve a 4K frame to a request for the low stream', () => {
    // The exact production bug.
    cache.set(1, 'high', { data: img('4k'), ts: 10, streamId: 'high' })
    expect(cache.get(1, 'low')).toBeUndefined()
  })

  it('treats "no stream asked" as its own entry, not as any entry', () => {
    cache.set(1, undefined, { data: img('auto'), ts: 10, streamId: null })
    expect(cache.get(1, undefined)?.data.base64).toBe('auto')
    expect(cache.get(1, 'high')).toBeUndefined()
  })

  it('separates devices', () => {
    cache.set(1, 'high', { data: img('a'), ts: 10, streamId: 'high' })
    expect(cache.get(2, 'high')).toBeUndefined()
  })
})

describe('latest — the device-wide view', () => {
  it('returns the NEWEST entry across streams', () => {
    // `getSnapshotOverview` and `getStatus` answer "when did this camera last
    // produce a frame", which is not a per-stream question.
    cache.set(1, 'high', { data: img('old'), ts: 10, streamId: 'high' })
    cache.set(1, 'low', { data: img('new'), ts: 99, streamId: 'low' })

    expect(cache.latest(1)?.data.base64).toBe('new')
  })

  it('is undefined for a device that never captured', () => {
    expect(cache.latest(7)).toBeUndefined()
  })
})

describe('invalidation', () => {
  it('drops EVERY stream of a device', () => {
    // A settings change (or an operator refresh) invalidates the camera, not
    // one of its streams — leaving a sibling entry behind would serve the
    // pre-change frame from the other key.
    cache.set(1, 'high', { data: img('a'), ts: 10, streamId: 'high' })
    cache.set(1, 'low', { data: img('b'), ts: 11, streamId: 'low' })
    cache.set(2, 'high', { data: img('c'), ts: 12, streamId: 'high' })

    cache.deleteDevice(1)

    expect(cache.latest(1)).toBeUndefined()
    expect(cache.latest(2)?.data.base64).toBe('c')
  })

  it('clears everything', () => {
    cache.set(1, 'high', { data: img('a'), ts: 10, streamId: 'high' })
    cache.clear()
    expect(cache.latest(1)).toBeUndefined()
  })
})

/**
 * The cache holds base64 JPEG payloads — the single largest retained structure
 * in the snapshot runner — and shipped with no TTL and no eviction of any kind.
 * Every camera that ever produced a frame kept its bytes for the life of the
 * process, so the ceiling was "cameras × streams × frame size", i.e. none.
 */
describe('bounds — the cache stops growing', () => {
  const payload = (bytes: number): { base64: string; contentType: string } => ({
    base64: 'x'.repeat(bytes),
    contentType: 'image/jpeg',
  })

  it('holds a byte budget by evicting the LEAST-RECENTLY-ACCESSED entry', () => {
    let now = 0
    const bounded = new SnapshotCache({ maxBytes: 300, now: () => now })
    bounded.set(1, 'high', { data: payload(100), ts: (now += 1), streamId: 'high' })
    bounded.set(2, 'high', { data: payload(100), ts: (now += 1), streamId: 'high' })
    bounded.set(3, 'high', { data: payload(100), ts: (now += 1), streamId: 'high' })
    // Device 1 is read — device 2 becomes the coldest entry.
    now += 1
    expect(bounded.get(1, 'high')).toBeDefined()

    now += 1
    bounded.set(4, 'high', { data: payload(100), ts: now, streamId: 'high' })

    expect(bounded.sizeBytes()).toBeLessThanOrEqual(300)
    expect(bounded.get(2, 'high')).toBeUndefined() // coldest, evicted
    expect(bounded.get(1, 'high')).toBeDefined() // recently accessed, kept
    expect(bounded.get(4, 'high')).toBeDefined() // just written, kept
  })

  it('releases an entry nobody has looked at — idle, not stale', () => {
    // Deliberately an IDLE ttl, not a capture-age ttl: a battery camera's frame
    // is legitimately fresh for an hour (`BATTERY_DEFAULT_MAX_AGE_S`), so
    // expiring on capture age would fight the freshness rules. An entry NOBODY
    // has read is dead weight whatever its age.
    let now = 0
    const bounded = new SnapshotCache({ idleTtlMs: 1_000, now: () => now })
    bounded.set(7, 'high', { data: payload(50), ts: 0, streamId: 'high' })
    now = 500
    expect(bounded.get(7, 'high')).toBeDefined()
    now = 2_000 // 1500ms since the last access
    expect(bounded.get(7, 'high')).toBeUndefined()
    expect(bounded.sizeBytes()).toBe(0)
    expect(bounded.latest(7)).toBeUndefined()
  })

  it('reports every eviction — a dropped frame that explains a later miss is never silent', () => {
    const evicted: Array<{ deviceId: number; reason: string }> = []
    let now = 0
    const bounded = new SnapshotCache({
      maxBytes: 100,
      now: () => now,
      onEvict: (deviceId, _streamId, reason) => evicted.push({ deviceId, reason }),
    })
    bounded.set(11, 'high', { data: payload(100), ts: (now += 1), streamId: 'high' })
    bounded.set(12, 'high', { data: payload(100), ts: (now += 1), streamId: 'high' })
    expect(evicted).toEqual([{ deviceId: 11, reason: 'budget' }])
  })

  it('a default cache is bounded — the shipped configuration, not a test-only one', () => {
    const shipped = new SnapshotCache()
    // 512 x 1MB frames is far more than any real roster; the assertion is that
    // the total is HELD, whatever the configured budget happens to be.
    for (let i = 0; i < 512; i += 1) {
      shipped.set(i, 'high', { data: payload(1_048_576), ts: i, streamId: 'high' })
    }
    expect(shipped.sizeBytes()).toBeLessThanOrEqual(SNAPSHOT_CACHE_MAX_BYTES)
    expect(shipped.sizeBytes()).toBeLessThan(512 * 1_048_576)
  })
})
