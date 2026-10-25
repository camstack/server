import { describe, it, expect, vi } from 'vitest'
import {
  COALESCE_MS,
  MAX_CONCURRENT_GRABS,
  SWR_COLD_WAIT_MS,
  SWR_STALE_WAIT_MS,
  Semaphore,
  SingleFlight,
  decideSnapshotServe,
  raceForResult,
} from '../snapshot-coalescing.js'

// -- decideSnapshotServe -------------------------------------------------

describe('decideSnapshotServe', () => {
  it('serves the cache when a fresh frame exists and no force', () => {
    const d = decideSnapshotServe({
      now: 1_000,
      cachedAt: 500,
      effectiveMaxAgeMs: 10_000,
      force: false,
    })
    expect(d).toEqual({ kind: 'serve-cache' })
  })

  it('SWR: stale cached frame -> await-refresh with the short stale wait + stale fallback', () => {
    const d = decideSnapshotServe({
      now: 20_000,
      cachedAt: 500,
      effectiveMaxAgeMs: 10_000,
      force: false,
    })
    expect(d).toEqual({ kind: 'await-refresh', waitMs: SWR_STALE_WAIT_MS, staleFallback: true })
  })

  it('cold: no cached frame -> await-refresh with the long cold wait + no fallback', () => {
    const d = decideSnapshotServe({
      now: 20_000,
      cachedAt: null,
      effectiveMaxAgeMs: 10_000,
      force: false,
    })
    expect(d).toEqual({ kind: 'await-refresh', waitMs: SWR_COLD_WAIT_MS, staleFallback: false })
  })

  it('force with a fresh frame still refreshes (bypasses the freshness gate) but can fall back to stale', () => {
    const d = decideSnapshotServe({
      now: 1_000,
      cachedAt: 900,
      effectiveMaxAgeMs: 10_000,
      force: true,
    })
    expect(d).toEqual({ kind: 'await-refresh', waitMs: SWR_COLD_WAIT_MS, staleFallback: true })
  })

  it('force with no frame refreshes with no fallback', () => {
    const d = decideSnapshotServe({
      now: 1_000,
      cachedAt: null,
      effectiveMaxAgeMs: 10_000,
      force: true,
    })
    expect(d).toEqual({ kind: 'await-refresh', waitMs: SWR_COLD_WAIT_MS, staleFallback: false })
  })

  it('boundary: exactly at max-age is NOT fresh (refreshes)', () => {
    const d = decideSnapshotServe({
      now: 10_000,
      cachedAt: 0,
      effectiveMaxAgeMs: 10_000,
      force: false,
    })
    expect(d.kind).toBe('await-refresh')
  })
})

// -- Semaphore -----------------------------------------------------------

describe('Semaphore', () => {
  it('rejects a non-positive / non-integer max', () => {
    expect(() => new Semaphore(0)).toThrow()
    expect(() => new Semaphore(-1)).toThrow()
    expect(() => new Semaphore(1.5)).toThrow()
  })

  it('caps concurrency at max: peak in-flight never exceeds the bound', async () => {
    const sem = new Semaphore(MAX_CONCURRENT_GRABS)
    let inFlight = 0
    let peak = 0
    const release: Array<() => void> = []
    const gate = () =>
      new Promise<void>((resolve) => {
        release.push(resolve)
      })

    const tasks = Array.from({ length: 12 }, () =>
      sem.run(async () => {
        inFlight += 1
        peak = Math.max(peak, inFlight)
        await gate()
        inFlight -= 1
      }),
    )

    // Let the first wave acquire permits.
    await Promise.resolve()
    await Promise.resolve()
    expect(inFlight).toBe(MAX_CONCURRENT_GRABS)

    // Drain: release one at a time; peak must never exceed the bound.
    while (release.length > 0) {
      const next = release.shift()
      next?.()
      await Promise.resolve()
      await Promise.resolve()
    }
    await Promise.all(tasks)
    expect(peak).toBe(MAX_CONCURRENT_GRABS)
  })

  it('releases the permit even when fn throws', async () => {
    const sem = new Semaphore(1)
    await expect(
      sem.run(async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    // If the permit leaked this second run would hang forever.
    await expect(sem.run(async () => 42)).resolves.toBe(42)
  })
})

// -- SingleFlight --------------------------------------------------------

describe('SingleFlight', () => {
  it('concurrent callers for the same key share ONE flight', async () => {
    const holdWorthy = (v: number) => v > 0
    const sf = new SingleFlight<number>(COALESCE_MS, holdWorthy)
    const factory = vi.fn(async () => 7)
    const [a, b, c] = await Promise.all([
      sf.run('k', factory),
      sf.run('k', factory),
      sf.run('k', factory),
    ])
    expect([a, b, c]).toEqual([7, 7, 7])
    expect(factory).toHaveBeenCalledTimes(1)
  })

  it('a settled hold-worthy result collapses a burst within the hold window', async () => {
    let clock = 1_000
    const now = () => clock
    const sf = new SingleFlight<number>(COALESCE_MS, (v) => v > 0, now)
    const factory = vi.fn(async () => 5)

    await sf.run('k', factory)
    clock += COALESCE_MS - 1 // still inside the hold window
    await sf.run('k', factory)
    expect(factory).toHaveBeenCalledTimes(1)

    clock += 2 // now past the hold window
    await sf.run('k', factory)
    expect(factory).toHaveBeenCalledTimes(2)
  })

  it('a settled NON-hold-worthy result (null/empty) is retried immediately', async () => {
    const sf = new SingleFlight<number>(COALESCE_MS, (v) => v > 0)
    const factory = vi.fn(async () => 0) // 0 is not hold-worthy
    await sf.run('k', factory)
    await sf.run('k', factory)
    expect(factory).toHaveBeenCalledTimes(2)
  })

  it('invalidatePrefix drops held flights so the next call re-runs', async () => {
    let clock = 1_000
    const sf = new SingleFlight<number>(
      COALESCE_MS,
      (v) => v > 0,
      () => clock,
    )
    const factory = vi.fn(async () => 5)
    await sf.run('9:auto', factory)
    sf.invalidatePrefix('9:')
    await sf.run('9:auto', factory)
    expect(factory).toHaveBeenCalledTimes(2)
  })

  it('different keys do not share a flight', async () => {
    const sf = new SingleFlight<number>(COALESCE_MS, (v) => v > 0)
    const factory = vi.fn(async (): Promise<number> => 5)
    await Promise.all([sf.run('a', factory), sf.run('b', factory)])
    expect(factory).toHaveBeenCalledTimes(2)
  })
})

// -- raceForResult -------------------------------------------------------

describe('raceForResult', () => {
  it('returns settled with the value when the promise wins', async () => {
    const out = await raceForResult(Promise.resolve('done'), 10_000)
    expect(out).toEqual({ settled: true, value: 'done' })
  })

  it('returns settled=false on timeout while the promise keeps running', async () => {
    vi.useFakeTimers()
    try {
      let landed = false
      const slow = new Promise<string>((resolve) => {
        setTimeout(() => {
          landed = true
          resolve('late')
        }, 5_000)
      })
      const raced = raceForResult(slow, 1_000)
      await vi.advanceTimersByTimeAsync(1_000)
      expect(await raced).toEqual({ settled: false })
      // The promise was NOT cancelled — it still lands afterwards.
      await vi.advanceTimersByTimeAsync(4_000)
      expect(landed).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('propagates a rejection that wins the race', async () => {
    await expect(raceForResult(Promise.reject(new Error('nope')), 10_000)).rejects.toThrow('nope')
  })
})
