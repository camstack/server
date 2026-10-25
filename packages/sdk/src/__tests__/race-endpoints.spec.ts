/**
 * SDK — endpoint race tests.
 *
 * Covers `raceFastestEndpoint`: the pure helper that probes each
 * candidate URL with a short timeout and returns the first 2xx
 * response. Browser/Node `fetch` is stubbed via `vi.spyOn` so we
 * don't depend on real network sockets.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { raceFastestEndpoint } from '../system.js'

const originalFetch = globalThis.fetch

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  globalThis.fetch = originalFetch
})

function mockFetch(impl: (url: string, init: RequestInit | undefined) => Promise<Response>): void {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    return impl(url, init)
  }) as typeof fetch
}

describe('raceFastestEndpoint', () => {
  it('returns null for an empty candidate list', async () => {
    expect(await raceFastestEndpoint([], 1000)).toBeNull()
  })

  it('returns the only candidate when fetch is unavailable (Node < 18)', async () => {
    // Simulate missing fetch — the helper should gracefully fall back
    // to the first URL rather than crash callers.
    const orig = globalThis.fetch
    // @ts-expect-error — deliberately deleting `fetch` for this branch
    delete globalThis.fetch
    try {
      const out = await raceFastestEndpoint(['http://192.168.10.10:4000'], 1000)
      expect(out).toBe('http://192.168.10.10:4000')
    } finally {
      globalThis.fetch = orig
    }
  })

  it('picks the fastest 2xx responder', async () => {
    mockFetch(async (url) => {
      // LAN is fast (10ms), public tunnel is slow (200ms).
      if (url.includes('192.168.10.10')) {
        await new Promise((r) => setTimeout(r, 10))
        return new Response(null, { status: 204 })
      }
      await new Promise((r) => setTimeout(r, 200))
      return new Response(null, { status: 204 })
    })

    const promise = raceFastestEndpoint(
      ['https://camstack.example.com', 'http://192.168.10.10:4000'],
      500,
    )
    await vi.advanceTimersByTimeAsync(15)
    const winner = await promise
    expect(winner).toBe('http://192.168.10.10:4000')
  })

  it('falls back to the public URL when LAN times out', async () => {
    mockFetch(async (url, init) => {
      // LAN candidate hangs forever (until AbortController kicks in).
      if (url.includes('192.168.10.10')) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        })
      }
      // Public URL responds after 50ms.
      await new Promise((r) => setTimeout(r, 50))
      return new Response(null, { status: 200 })
    })

    const promise = raceFastestEndpoint(
      ['http://192.168.10.10:4000', 'https://camstack.example.com'],
      1500,
    )
    await vi.advanceTimersByTimeAsync(60)
    const winner = await promise
    expect(winner).toBe('https://camstack.example.com')
  })

  it('returns null when every candidate fails or times out', async () => {
    mockFetch(async (_url, init) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      })
    })

    const promise = raceFastestEndpoint(['http://192.168.10.10:4000', 'http://10.0.0.5:4000'], 300)
    await vi.advanceTimersByTimeAsync(350)
    const winner = await promise
    expect(winner).toBeNull()
  })

  it('rejects non-2xx responses so a 502 from a stale candidate is skipped', async () => {
    mockFetch(async (url) => {
      // First candidate returns 502 (stale tunnel), second responds 200.
      if (url.includes('first')) return new Response(null, { status: 502 })
      await new Promise((r) => setTimeout(r, 5))
      return new Response(null, { status: 200 })
    })

    const promise = raceFastestEndpoint(
      ['http://first.example.com', 'http://second.example.com'],
      1000,
    )
    await vi.advanceTimersByTimeAsync(10)
    const winner = await promise
    expect(winner).toBe('http://second.example.com')
  })

  it('strips trailing slashes from the probed URL', async () => {
    const seen: string[] = []
    mockFetch(async (url) => {
      seen.push(url)
      return new Response(null, { status: 200 })
    })

    const promise = raceFastestEndpoint(['http://lan.test:4000/'], 100)
    await vi.advanceTimersByTimeAsync(5)
    await promise
    expect(seen[0]).toBe('http://lan.test:4000/health')
  })
})
