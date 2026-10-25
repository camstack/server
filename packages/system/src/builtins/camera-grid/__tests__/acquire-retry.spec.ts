/**
 * A source that has not republished YET is not a source that is missing.
 *
 * For a few seconds after every hub restart the camera providers have not
 * re-announced their streams, and a grid opened in that window failed outright:
 *
 *   camera grid: could not acquire every source — releasing the ones already
 *   taken {acquired=0 error="getStreamWithCodec: profile \"low\" source
 *   \"native:sub\" not published for device 107"}
 *
 * Observed on the hub at 12:02 on 2026-09-18, twice, and gone by the next
 * attempt. Same shape as the WebRTC broker that was being rebuilt: the answer
 * changes with TIME, and the consumer was failing on the first ask.
 *
 * So the acquire retries under a bound, and a camera that genuinely has no such
 * profile still fails — with the provider's own error, after the wait it
 * actually spent.
 */
import { describe, expect, it, vi } from 'vitest'
import { acquireWithRetry } from '../acquire-retry.js'

describe('acquireWithRetry', () => {
  it('returns the first success without waiting', async () => {
    const attempt = vi.fn(async () => 'url')
    const sleep = vi.fn(async () => undefined)
    await expect(acquireWithRetry(attempt, { budgetMs: 5_000, now: () => 0, sleep })).resolves.toBe(
      'url',
    )
    expect(attempt).toHaveBeenCalledTimes(1)
    expect(sleep).not.toHaveBeenCalled()
  })

  it('retries while the budget lasts and returns the answer that finally comes', async () => {
    let calls = 0
    const attempt = vi.fn(async () => {
      calls += 1
      if (calls < 3) throw new Error('not published for device 107')
      return 'url'
    })
    let clock = 0
    await expect(
      acquireWithRetry(attempt, {
        budgetMs: 5_000,
        now: () => clock,
        sleep: async () => {
          clock += 500
        },
      }),
    ).resolves.toBe('url')
    expect(attempt).toHaveBeenCalledTimes(3)
  })

  it('gives up on the budget and throws the LAST error, not a summary of its own', async () => {
    const attempt = vi.fn(async () => {
      throw new Error('profile "low" source "native:sub" not published for device 107')
    })
    let clock = 0
    await expect(
      acquireWithRetry(attempt, {
        budgetMs: 1_000,
        now: () => clock,
        sleep: async () => {
          clock += 400
        },
      }),
    ).rejects.toThrow(/not published for device 107/)
    // Bounded: it did not hammer the provider for a camera that has no such
    // profile at all.
    expect(attempt.mock.calls.length).toBeLessThanOrEqual(4)
  })

  it('reports how long it waited, so a slow start is visible', async () => {
    const waited: number[] = []
    let clock = 0
    await acquireWithRetry(
      async () => {
        if (clock < 900) throw new Error('not published')
        return 'url'
      },
      {
        budgetMs: 5_000,
        now: () => clock,
        sleep: async () => {
          clock += 500
        },
        onRetry: (ms) => waited.push(ms),
      },
    )
    expect(waited.length).toBeGreaterThan(0)
    expect(waited.at(-1)).toBeGreaterThan(0)
  })
})
