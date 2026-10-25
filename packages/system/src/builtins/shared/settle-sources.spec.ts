import { describe, it, expect } from 'vitest'
import { settleSourcesWithTimeout } from './settle-sources.js'

/**
 * Covers every branch of the parallel, per-source-timeout fan-out the
 * addon-pages / addon-widgets aggregators use so that ONE slow or
 * unreachable source (e.g. an agent-hosted source whose cap call sits in a
 * 30s Moleculer `waitForServices`) can no longer block or fail the whole
 * listing.
 */
describe('settleSourcesWithTimeout', () => {
  it('returns an ok result for every source, preserving entry order', async () => {
    const results = await settleSourcesWithTimeout<number>(
      [
        ['a', async () => [1]],
        ['b', async () => [2, 3]],
        ['c', async () => []],
      ],
      1_000,
    )

    expect(results.map(([id]) => id)).toEqual(['a', 'b', 'c'])
    expect(results.map(([, r]) => (r.ok ? r.value : null))).toEqual([[1], [2, 3], []])
  })

  it('isolates a rejecting source — others still resolve ok', async () => {
    const results = await settleSourcesWithTimeout<number>(
      [
        ['ok-1', async () => [1]],
        [
          'boom',
          async () => {
            throw new Error('provider exploded')
          },
        ],
        ['ok-2', async () => [2]],
      ],
      1_000,
    )

    const byId = new Map(results)
    expect(byId.get('ok-1')).toEqual({ ok: true, value: [1] })
    expect(byId.get('ok-2')).toEqual({ ok: true, value: [2] })
    const boom = byId.get('boom')
    expect(boom?.ok).toBe(false)
    if (boom && !boom.ok) expect(boom.error.message).toContain('provider exploded')
  })

  it('times out a hanging source without blocking the others', async () => {
    const start = Date.now()
    const results = await settleSourcesWithTimeout<string>(
      [
        ['fast', async () => ['quick']],
        // never resolves — models the 30s Moleculer waitForServices hang
        [
          'hang',
          () =>
            new Promise<readonly string[]>(() => {
              /* never */
            }),
        ],
      ],
      50,
    )
    const elapsed = Date.now() - start

    const byId = new Map(results)
    expect(byId.get('fast')).toEqual({ ok: true, value: ['quick'] })
    const hang = byId.get('hang')
    expect(hang?.ok).toBe(false)
    if (hang && !hang.ok) expect(hang.error.message).toMatch(/timed out/i)
    // The whole fan-out must settle on the timeout, NOT wait for the hang.
    expect(elapsed).toBeLessThan(1_000)
  })

  it('runs sources in parallel — total time tracks the slowest, not the sum', async () => {
    const start = Date.now()
    await settleSourcesWithTimeout<number>(
      [
        [
          's1',
          async () => {
            await delay(60)
            return [1]
          },
        ],
        [
          's2',
          async () => {
            await delay(60)
            return [2]
          },
        ],
        [
          's3',
          async () => {
            await delay(60)
            return [3]
          },
        ],
      ],
      1_000,
    )
    const elapsed = Date.now() - start
    // Sequential would be ~180ms; parallel ~60ms. Allow generous slack.
    expect(elapsed).toBeLessThan(150)
  })

  it('returns an empty array for no sources', async () => {
    const results = await settleSourcesWithTimeout<number>([], 1_000)
    expect(results).toEqual([])
  })
})

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
