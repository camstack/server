/**
 * The short-TTL memo behind the session-dispatch balancer reads.
 *
 * Its whole contract is "make the hot path free WITHOUT ever making a dispatch
 * fail" — so every test here is about what happens when the cache cannot help:
 * a cold key, a failing read, a burst of simultaneous callers, and a key that
 * has gone idle.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_BALANCER_INPUT_TTL_MS, TtlMemo } from '../balancer-input-cache.js'

/** A controllable clock so freshness is asserted, not slept for. */
function clock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = start
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms
    },
  }
}

describe('TtlMemo', () => {
  it('reads through on a miss and serves memory inside the TTL', async () => {
    const c = clock()
    const load = vi.fn(async (key: string) => `${key}:1`)
    const memo = new TtlMemo<string, string>({ load, now: c.now })

    expect(await memo.get('hub')).toBe('hub:1')
    expect(await memo.get('hub')).toBe('hub:1')
    expect(load).toHaveBeenCalledTimes(1)

    c.advance(DEFAULT_BALANCER_INPUT_TTL_MS - 1)
    expect(await memo.get('hub')).toBe('hub:1')
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('re-reads once the TTL elapses', async () => {
    const c = clock()
    let n = 0
    const load = vi.fn(async () => `v${++n}`)
    const memo = new TtlMemo<string, string>({ load, now: c.now })

    expect(await memo.get('hub')).toBe('v1')
    c.advance(DEFAULT_BALANCER_INPUT_TTL_MS)
    expect(await memo.get('hub')).toBe('v2')
  })

  it('keys are independent', async () => {
    const c = clock()
    const load = vi.fn(async (key: string) => key.toUpperCase())
    const memo = new TtlMemo<string, string>({ load, now: c.now })

    expect(await memo.get('hub')).toBe('HUB')
    expect(await memo.get('agent-1')).toBe('AGENT-1')
    expect(load).toHaveBeenCalledTimes(2)
    expect(memo.size).toBe(2)
  })

  it('THROWS on a cold miss — a cold cache falls back to exactly the old read', async () => {
    const memo = new TtlMemo<string, string>({
      load: async () => {
        throw new Error('agent unreachable')
      },
      now: clock().now,
    })

    await expect(memo.get('hub')).rejects.toThrow('agent unreachable')
  })

  it('serves the STALE value when a refresh read fails — never fails a dispatch', async () => {
    const c = clock()
    let fail = false
    const memo = new TtlMemo<string, string>({
      load: async () => {
        if (fail) throw new Error('agent unreachable')
        return 'good'
      },
      now: c.now,
    })

    expect(await memo.get('hub')).toBe('good')
    fail = true
    c.advance(DEFAULT_BALANCER_INPUT_TTL_MS * 2)

    expect(await memo.get('hub')).toBe('good')
  })

  it('collapses a simultaneous burst into ONE read', async () => {
    const c = clock()
    const resolvers: Array<(v: string) => void> = []
    const load = vi.fn(
      () =>
        new Promise<string>((r) => {
          resolvers.push(r)
        }),
    )
    const memo = new TtlMemo<string, string>({ load, now: c.now })

    const all = Promise.all([memo.get('hub'), memo.get('hub'), memo.get('hub')])
    for (const r of resolvers) r('once')

    expect(await all).toEqual(['once', 'once', 'once'])
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('invalidate makes the next get read through, however recent the value', async () => {
    const c = clock()
    let n = 0
    const load = vi.fn(async () => `v${++n}`)
    const memo = new TtlMemo<string, string>({ load, now: c.now })

    expect(await memo.get('hub')).toBe('v1')
    memo.invalidate('hub')
    // No time has passed at all — freshness is not the question, correctness is.
    expect(await memo.get('hub')).toBe('v2')
  })

  it('a read already in flight when invalidate lands never becomes the cached value', async () => {
    const c = clock()
    const resolvers: Array<(v: string) => void> = []
    const load = vi.fn(
      () =>
        new Promise<string>((r) => {
          resolvers.push(r)
        }),
    )
    const memo = new TtlMemo<string, string>({ load, now: c.now })

    const stalePending = memo.get('hub')
    // The caller changes the world while that read is in flight.
    memo.invalidate('hub')
    resolvers[0]?.('before-the-change')
    expect(await stalePending).toBe('before-the-change')

    // The NEXT caller must not be served the pre-change answer.
    const fresh = memo.get('hub')
    resolvers[1]?.('after-the-change')
    expect(await fresh).toBe('after-the-change')
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('refresh populates a key that is not currently held (re-warm after invalidate)', async () => {
    const c = clock()
    let n = 0
    const load = vi.fn(async () => `v${++n}`)
    const memo = new TtlMemo<string, string>({ load, now: c.now })

    await memo.refresh('hub')
    expect(load).toHaveBeenCalledTimes(1)
    expect(await memo.get('hub')).toBe('v1') // served from memory
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('refreshAll re-reads live keys and swallows their failures', async () => {
    const c = clock()
    let n = 0
    const load = vi.fn(async (key: string) => {
      if (key === 'bad') throw new Error('nope')
      return `v${++n}`
    })
    const memo = new TtlMemo<string, string>({ load, now: c.now })

    expect(await memo.get('hub')).toBe('v1')
    await expect(memo.get('bad')).rejects.toThrow('nope')

    await expect(memo.refreshAll()).resolves.toBeUndefined()
    // 'hub' was re-read off the caller's path; the value is fresh for free.
    expect(await memo.get('hub')).toBe('v2')
  })

  it('refreshAll evicts a key nobody has asked for in a long time', async () => {
    const c = clock()
    const load = vi.fn(async (key: string) => key)
    const memo = new TtlMemo<string, string>({ load, now: c.now })

    await memo.get('agent-gone')
    expect(memo.size).toBe(1)

    c.advance(DEFAULT_BALANCER_INPUT_TTL_MS * 5)
    await memo.refreshAll()

    expect(memo.size).toBe(0)
    expect(load).toHaveBeenCalledTimes(1) // evicted, not re-read
  })

  it('clear drops everything', async () => {
    const memo = new TtlMemo<string, string>({ load: async (k) => k, now: clock().now })
    await memo.get('hub')
    memo.clear()
    expect(memo.size).toBe(0)
  })
})

/**
 * D441: a re-read that overruns its budget yields to the LAST KNOWN answer.
 *
 * `invalidate` still means "wrong, never serve it from `get`" — but a dispatch
 * that finds the re-read stuck behind a saturated hub-main event loop must not
 * wait for it. Measured 2026-09-10 18:39:49: three cameras with
 * `balanceMs 9205` identical, all joined one `collectAgentLoad` in flight after
 * `notePlacementChanged()` invalidated the memo. A load snapshot a few seconds
 * old is a worse balancer input than a fresh one; a nine-second wait is a
 * worse dispatch than either.
 */
describe('TtlMemo.getWithin — a read past its budget yields to the last known answer', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  function deferredLoad(): {
    load: ReturnType<typeof vi.fn>
    resolvers: Array<(v: string) => void>
    rejecters: Array<(e: unknown) => void>
  } {
    const resolvers: Array<(v: string) => void> = []
    const rejecters: Array<(e: unknown) => void> = []
    const load = vi.fn(
      () =>
        new Promise<string>((resolve, reject) => {
          resolvers.push(resolve)
          rejecters.push(reject)
        }),
    )
    return { load, resolvers, rejecters }
  }

  it('a fresh value is served from memory and reported as not stale', async () => {
    const c = clock()
    const load = vi.fn(async () => 'v1')
    const memo = new TtlMemo<string, string>({ load, now: c.now })
    await memo.get('hub')
    c.advance(1_500)

    const answer = await memo.getWithin('hub', 500)

    expect(answer).toEqual({ value: 'v1', stale: false, ageMs: 1_500 })
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('an INVALIDATED value answers a re-read that overruns the budget, with its age', async () => {
    const c = clock()
    const { load, resolvers } = deferredLoad()
    const memo = new TtlMemo<string, string>({ load, now: c.now })
    const first = memo.get('hub')
    resolvers[0]?.('v1')
    await first
    c.advance(3_000)
    memo.invalidate('hub')

    const pending = memo.getWithin('hub', 500)
    await vi.advanceTimersByTimeAsync(500)

    expect(await pending).toEqual({ value: 'v1', stale: true, ageMs: 3_000 })
    // The read was not abandoned: it lands and becomes the next caller's answer.
    c.advance(200)
    resolvers[1]?.('v2')
    await vi.advanceTimersByTimeAsync(0)
    expect(await memo.getWithin('hub', 500)).toEqual({ value: 'v2', stale: false, ageMs: 0 })
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('a read that lands inside the budget is served fresh, and no budget timer is left behind', async () => {
    const c = clock()
    const { load, resolvers } = deferredLoad()
    const memo = new TtlMemo<string, string>({ load, now: c.now })

    const pending = memo.getWithin('hub', 500)
    await vi.advanceTimersByTimeAsync(100)
    resolvers[0]?.('v1')

    expect(await pending).toEqual({ value: 'v1', stale: false, ageMs: 0 })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a COLD key waits past the budget — a cold cache must never fail a dispatch', async () => {
    const c = clock()
    const { load, resolvers } = deferredLoad()
    const memo = new TtlMemo<string, string>({ load, now: c.now })

    let settled = false
    const pending = memo.getWithin('hub', 500).then((a) => {
      settled = true
      return a
    })
    await vi.advanceTimersByTimeAsync(2_000)
    expect(settled).toBe(false)

    resolvers[0]?.('v1')
    expect(await pending).toEqual({ value: 'v1', stale: false, ageMs: 0 })
  })

  it('a re-read that FAILS is answered from the last known value, invalidated or not', async () => {
    const c = clock()
    const { load, resolvers, rejecters } = deferredLoad()
    const memo = new TtlMemo<string, string>({ load, now: c.now })
    const first = memo.get('hub')
    resolvers[0]?.('v1')
    await first
    memo.invalidate('hub')
    c.advance(700)

    const pending = memo.getWithin('hub', 500)
    rejecters[1]?.(new Error('agent unreachable'))

    expect(await pending).toEqual({ value: 'v1', stale: true, ageMs: 700 })
  })

  it('`get` never serves an invalidated value — the bounded fallback is getWithin alone', async () => {
    const c = clock()
    let n = 0
    const load = vi.fn(async () => `v${++n}`)
    const memo = new TtlMemo<string, string>({ load, now: c.now })
    expect(await memo.get('hub')).toBe('v1')
    memo.invalidate('hub')
    expect(await memo.get('hub')).toBe('v2')
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('clear drops the last known value too', async () => {
    const c = clock()
    const { load, resolvers } = deferredLoad()
    const memo = new TtlMemo<string, string>({ load, now: c.now })
    const first = memo.get('hub')
    resolvers[0]?.('v1')
    await first
    memo.clear()

    let settled = false
    void memo.getWithin('hub', 500).then(() => {
      settled = true
    })
    await vi.advanceTimersByTimeAsync(2_000)
    expect(settled).toBe(false)
  })
})
