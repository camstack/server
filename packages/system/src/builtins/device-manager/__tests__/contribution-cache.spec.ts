/**
 * The device-details fan-out: budgeted, cached, single-flight.
 *
 * Measured on this hub (2026-09-14): `getDeviceAggregate` cost 10 595 ms on a
 * battery camera against 331 ms on a mains one, and the page re-polls every
 * 2 500 ms. The fan-out was a bare `Promise.all` with no budget and no line
 * naming the provider that was holding it, so one slow contributor stalled the
 * entire device page and nothing said which.
 *
 * A budget ALONE would have made it worse: dropping the slow provider makes its
 * settings section vanish and come back between polls, and a section of
 * settings that flickers is worse than a slow one. So the budget is paired with
 * a cache — the last answer a provider gave is served while its next one is
 * still being computed.
 */
import { describe, expect, it, vi } from 'vitest'
import { ContributionCache } from '../contribution-cache.js'

const never = (): Promise<string | null> => new Promise(() => {})

describe('ContributionCache', () => {
  it('serves a fast provider fresh', async () => {
    const cache = new ContributionCache()
    const out = await cache.resolve('k', async () => 'first', 500)
    expect(out).toEqual({ kind: 'fresh', value: 'first' })
  })

  it('a provider that never answered and overruns is ABSENT, with the reason', async () => {
    const cache = new ContributionCache()
    const out = await cache.resolve('k', never, 10)
    expect(out).toEqual({ kind: 'absent', reason: 'slow' })
  })

  it('serves the LAST answer while the next one is still being computed', async () => {
    const cache = new ContributionCache()
    await cache.resolve('k', async () => 'first', 500)
    const out = await cache.resolve('k', never, 10)
    expect(out.kind).toBe('stale')
    if (out.kind !== 'stale') return
    expect(out.value).toBe('first')
  })

  // D224: a read is answered from the slice, it never JOINS a refresh already
  // in flight. Without this the 2.5 s poll stacks a new 10 s call every tick.
  it('does not start a second call while one is in flight', async () => {
    const cache = new ContributionCache()
    const call = vi.fn(never)
    void cache.resolve('k', call, 10)
    await cache.resolve('k', call, 10)
    await cache.resolve('k', call, 10)
    expect(call).toHaveBeenCalledTimes(1)
  })

  it('a late answer refreshes the cache, so the NEXT read is fresh', async () => {
    const cache = new ContributionCache()
    let release: (v: string) => void = () => {}
    const slow = (): Promise<string | null> =>
      new Promise((resolve) => {
        release = resolve
      })
    expect(await cache.resolve('k', slow, 10)).toEqual({ kind: 'absent', reason: 'slow' })
    release('landed')
    await Promise.resolve()
    await Promise.resolve()
    expect(await cache.resolve('k', async () => 'second', 500)).toEqual({
      kind: 'fresh',
      value: 'second',
    })
  })

  it('a provider that THROWS falls back to its last answer', async () => {
    const cache = new ContributionCache()
    await cache.resolve('k', async () => 'first', 500)
    const out = await cache.resolve(
      'k',
      async () => {
        throw new Error('provider down')
      },
      500,
    )
    expect(out.kind).toBe('stale')
  })

  it('a throw with nothing cached is ABSENT and names the failure', async () => {
    const cache = new ContributionCache()
    const out = await cache.resolve(
      'k',
      async () => {
        throw new Error('provider down')
      },
      500,
    )
    expect(out).toEqual({ kind: 'absent', reason: 'failed' })
  })

  // A provider answering `null` MEANS "I have nothing for this device" — it is
  // an answer, and it must replace a previous one rather than being served
  // around forever by a cache that only remembers successes.
  it('an explicit null is an answer and clears what was cached', async () => {
    const cache = new ContributionCache()
    await cache.resolve('k', async () => 'first', 500)
    expect(await cache.resolve('k', async () => null, 500)).toEqual({ kind: 'fresh', value: null })
    expect(await cache.resolve('k', never, 10)).toEqual({ kind: 'absent', reason: 'slow' })
  })

  // The operator's "I changed the detection source and it snapped back": the
  // write landed, the read-back overran the budget, and the cache answered with
  // the value the write had just replaced. A cached answer is the provider's
  // view BEFORE the write — after one it is wrong, not merely old.
  describe('after a write to the provider (markWritten)', () => {
    it('never serves the pre-write answer when the read-back overruns its bound', async () => {
      const cache = new ContributionCache()
      await cache.resolve('k', async () => 'before', 500)
      cache.markWritten('k')
      const out = await cache.resolve('k', never, 10, 20)
      expect(out).toEqual({ kind: 'absent', reason: 'slow' })
    })

    it('waits past the normal budget for the read-back, then serves it fresh', async () => {
      const cache = new ContributionCache()
      await cache.resolve('k', async () => 'before', 500)
      cache.markWritten('k')
      const readBack = (): Promise<string | null> =>
        new Promise((resolve) => setTimeout(() => resolve('after'), 60))
      // 10 ms is the page budget; the read-back is allowed 500 ms.
      expect(await cache.resolve('k', readBack, 10, 500)).toEqual({
        kind: 'fresh',
        value: 'after',
      })
    })

    it('does not join a call that began before the write, and ignores its answer', async () => {
      const cache = new ContributionCache()
      let releaseOld: (v: string) => void = () => {}
      const old = vi.fn(
        (): Promise<string | null> =>
          new Promise((resolve) => {
            releaseOld = resolve
          }),
      )
      void cache.resolve('k', old, 10)
      cache.markWritten('k')
      const next = vi.fn(async () => 'after')
      expect(await cache.resolve('k', next, 10, 500)).toEqual({ kind: 'fresh', value: 'after' })
      expect(next).toHaveBeenCalledTimes(1)
      // The pre-write call lands late with the pre-write value: it must not
      // replace what the read-back established.
      releaseOld('before')
      await Promise.resolve()
      await Promise.resolve()
      const out = await cache.resolve('k', never, 10)
      expect(out.kind).toBe('stale')
      if (out.kind === 'stale') expect(out.value).toBe('after')
    })

    it('a read-back that throws is ABSENT, not the pre-write answer', async () => {
      const cache = new ContributionCache()
      await cache.resolve('k', async () => 'before', 500)
      cache.markWritten('k')
      const out = await cache.resolve(
        'k',
        async () => {
          throw new Error('provider down')
        },
        500,
        500,
      )
      expect(out).toEqual({ kind: 'absent', reason: 'failed' })
    })

    it('the entry is ordinary again once a read-back landed', async () => {
      const cache = new ContributionCache()
      await cache.resolve('k', async () => 'before', 500)
      cache.markWritten('k')
      await cache.resolve('k', async () => 'after', 500, 500)
      const out = await cache.resolve('k', never, 10)
      expect(out.kind).toBe('stale')
    })

    it('marks every key under a prefix (settings + live of one provider)', async () => {
      const cache = new ContributionCache()
      await cache.resolve('1:settings:cap:addon', async () => 'a', 500)
      await cache.resolve('1:live:cap:addon', async () => 'b', 500)
      await cache.resolve('2:settings:cap:addon', async () => 'c', 500)
      cache.markWrittenWhere((key) => key.startsWith('1:') && key.endsWith(':cap:addon'))
      expect(await cache.resolve('1:settings:cap:addon', never, 10, 10)).toEqual({
        kind: 'absent',
        reason: 'slow',
      })
      expect(await cache.resolve('1:live:cap:addon', never, 10, 10)).toEqual({
        kind: 'absent',
        reason: 'slow',
      })
      // Another device is untouched.
      expect((await cache.resolve('2:settings:cap:addon', never, 10, 10)).kind).toBe('stale')
    })
  })

  it('is bounded — a fleet of devices cannot grow it without limit', async () => {
    const cache = new ContributionCache(2)
    await cache.resolve('a', async () => 'A', 500)
    await cache.resolve('b', async () => 'B', 500)
    await cache.resolve('c', async () => 'C', 500)
    // 'a' is the oldest and was evicted; 'c' is still there.
    expect(await cache.resolve('a', never, 10)).toEqual({ kind: 'absent', reason: 'slow' })
    expect((await cache.resolve('c', never, 10)).kind).toBe('stale')
  })
})
