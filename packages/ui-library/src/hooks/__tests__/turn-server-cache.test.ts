/**
 * TurnServerCache — the ICE-server fetch is serialized BEFORE `createOffer`
 * on every connect (camera-stream-player.tsx), and production timing lines
 * (`embed:webrtc-timing`) put it at 0.2–3.6 s on a cold page. Two verified
 * gaps caused that:
 *
 *  1. no in-flight coalescing — the mount-time prefetch and the connect's own
 *     call raced, so the connect started a SECOND full fetch instead of
 *     awaiting the first;
 *  2. the cache was a WeakMap keyed on the page's tRPC client, so every fresh
 *     embed page (one per camera open on native) started cold — the common
 *     remote path never hit it.
 *
 * The cache under test fixes both: an in-flight promise shared by concurrent
 * callers, plus a storage layer (localStorage when available) that survives
 * page reloads, with a fresh TTL and a bounded stale-while-revalidate window.
 */
import { describe, it, expect, vi } from 'vitest'
import { TurnServerCache, type TurnCacheStorage } from '../turn-server-cache'

interface MemoryStorageHarness {
  readonly storage: TurnCacheStorage
  readonly map: Map<string, string>
}

function memoryStorage(): MemoryStorageHarness {
  const map = new Map<string, string>()
  return {
    map,
    storage: {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => {
        map.set(k, v)
      },
    },
  }
}

const SERVERS: readonly RTCIceServer[] = [
  { urls: 'turn:turn.example.com:3478?transport=udp', username: 'u', credential: 'c' },
]
const SERVERS_2: readonly RTCIceServer[] = [{ urls: 'stun:stun.example.com:3478' }]

const FRESH_TTL_MS = 5 * 60_000
const STALE_CAP_MS = 12 * 60 * 60_000

interface CacheHarness {
  readonly cache: TurnServerCache
  readonly clock: { now: number }
  readonly harness: MemoryStorageHarness
}

function makeCache(opts?: { storage?: TurnCacheStorage | null }): CacheHarness {
  const clock = { now: 1_000_000 }
  const harness = memoryStorage()
  const cache = new TurnServerCache({
    storage: opts && 'storage' in opts ? (opts.storage ?? null) : harness.storage,
    now: () => clock.now,
  })
  return { cache, clock, harness }
}

describe('TurnServerCache', () => {
  it('cold: awaits the fetch, returns the servers, and persists them', async () => {
    const { cache, harness } = makeCache()
    const key = {}
    const fetch = vi.fn(async () => SERVERS)
    const out = await cache.getOrFetch(key, fetch)
    expect(out).toEqual(SERVERS)
    expect(fetch).toHaveBeenCalledTimes(1)
    // Persisted for the NEXT page load (the common native path).
    expect(harness.map.size).toBe(1)
  })

  it('coalesces concurrent callers onto ONE fetch', async () => {
    const { cache } = makeCache()
    const key = {}
    let resolveFetch: (v: readonly RTCIceServer[]) => void = () => {}
    const fetch = vi.fn(
      () =>
        new Promise<readonly RTCIceServer[]>((resolve) => {
          resolveFetch = resolve
        }),
    )
    const a = cache.getOrFetch(key, fetch)
    const b = cache.getOrFetch(key, fetch)
    resolveFetch(SERVERS)
    expect(await a).toEqual(SERVERS)
    expect(await b).toEqual(SERVERS)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('fresh memory hit: no second fetch', async () => {
    const { cache, clock } = makeCache()
    const key = {}
    const fetch = vi.fn(async () => SERVERS)
    await cache.getOrFetch(key, fetch)
    clock.now += FRESH_TTL_MS - 1
    const out = await cache.getOrFetch(key, fetch)
    expect(out).toEqual(SERVERS)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('fresh storage hit from a NEW key (fresh page): no fetch at all', async () => {
    const { cache, clock, harness } = makeCache()
    await cache.getOrFetch({}, async () => SERVERS)
    // Simulate a fresh embed page: new cache instance, same storage.
    const cache2 = new TurnServerCache({ storage: harness.storage, now: () => clock.now })
    const fetch2 = vi.fn(async () => SERVERS_2)
    const out = await cache2.getOrFetch({}, fetch2)
    expect(out).toEqual(SERVERS)
    expect(fetch2).not.toHaveBeenCalled()
  })

  it('stale-but-within-cap storage: returns stale IMMEDIATELY and refreshes in background', async () => {
    const { cache, clock, harness } = makeCache()
    await cache.getOrFetch({}, async () => SERVERS)
    clock.now += FRESH_TTL_MS + 1

    const cache2 = new TurnServerCache({ storage: harness.storage, now: () => clock.now })
    let resolveFetch: (v: readonly RTCIceServer[]) => void = () => {}
    const fetch2 = vi.fn(
      () =>
        new Promise<readonly RTCIceServer[]>((resolve) => {
          resolveFetch = resolve
        }),
    )
    const key = {}
    // Returns without awaiting the (still pending) refresh.
    const out = await cache2.getOrFetch(key, fetch2)
    expect(out).toEqual(SERVERS)
    expect(fetch2).toHaveBeenCalledTimes(1)

    // Once the background refresh lands, the next call serves the fresh set.
    resolveFetch(SERVERS_2)
    await Promise.resolve()
    await Promise.resolve()
    const out2 = await cache2.getOrFetch(key, fetch2)
    expect(out2).toEqual(SERVERS_2)
    expect(fetch2).toHaveBeenCalledTimes(1)
  })

  it('storage beyond the stale cap: awaits a full fetch', async () => {
    const { cache, clock, harness } = makeCache()
    await cache.getOrFetch({}, async () => SERVERS)
    clock.now += STALE_CAP_MS + 1

    const cache2 = new TurnServerCache({ storage: harness.storage, now: () => clock.now })
    const fetch2 = vi.fn(async () => SERVERS_2)
    const out = await cache2.getOrFetch({}, fetch2)
    expect(out).toEqual(SERVERS_2)
    expect(fetch2).toHaveBeenCalledTimes(1)
  })

  it('fetch failure with a stale entry: serves the stale entry', async () => {
    const { cache, clock } = makeCache()
    const key = {}
    await cache.getOrFetch(key, async () => SERVERS)
    clock.now += STALE_CAP_MS + 1
    const out = await cache.getOrFetch(key, async () => {
      throw new Error('network down')
    })
    expect(out).toEqual(SERVERS)
  })

  it('fetch failure with nothing cached: resolves undefined (STUN-only fallback)', async () => {
    const { cache } = makeCache()
    const out = await cache.getOrFetch({}, async () => {
      throw new Error('network down')
    })
    expect(out).toBeUndefined()
  })

  it('a failed fetch is not cached as in-flight — the next call retries', async () => {
    const { cache } = makeCache()
    const key = {}
    await cache.getOrFetch(key, async () => {
      throw new Error('network down')
    })
    const fetch2 = vi.fn(async () => SERVERS)
    const out = await cache.getOrFetch(key, fetch2)
    expect(out).toEqual(SERVERS)
    expect(fetch2).toHaveBeenCalledTimes(1)
  })

  it('corrupt storage entry: ignored, falls through to the fetch', async () => {
    const { cache, harness } = makeCache()
    // Poison every plausible key shape before first use.
    harness.storage.setItem('camstack:turn-servers:v1', '{not json')
    const fetch = vi.fn(async () => SERVERS)
    const out = await cache.getOrFetch({}, fetch)
    expect(out).toEqual(SERVERS)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('storage entry with a wrong shape: ignored, falls through to the fetch', async () => {
    const { cache, harness } = makeCache()
    harness.storage.setItem(
      'camstack:turn-servers:v1',
      JSON.stringify({ servers: [{ nope: true }], fetchedAt: 999 }),
    )
    const fetch = vi.fn(async () => SERVERS)
    const out = await cache.getOrFetch({}, fetch)
    expect(out).toEqual(SERVERS)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('a throwing storage (private mode) is tolerated end-to-end', async () => {
    const throwing: TurnCacheStorage = {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('denied')
      },
    }
    const cache = new TurnServerCache({ storage: throwing, now: () => 1 })
    const out = await cache.getOrFetch({}, async () => SERVERS)
    expect(out).toEqual(SERVERS)
  })

  it('null storage (RN webview without localStorage injected): memory-only still works', async () => {
    const { cache } = makeCache({ storage: null })
    const key = {}
    const fetch = vi.fn(async () => SERVERS)
    await cache.getOrFetch(key, fetch)
    const out = await cache.getOrFetch(key, fetch)
    expect(out).toEqual(SERVERS)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('an empty fetched list is returned but NOT persisted (no provider configured)', async () => {
    const { cache, clock, harness } = makeCache()
    const out = await cache.getOrFetch({}, async () => [])
    expect(out).toEqual([])
    // A later page must not read [] as a usable credential set.
    const cache2 = new TurnServerCache({ storage: harness.storage, now: () => clock.now })
    const fetch2 = vi.fn(async () => SERVERS)
    expect(await cache2.getOrFetch({}, fetch2)).toEqual(SERVERS)
    expect(fetch2).toHaveBeenCalledTimes(1)
  })
})
