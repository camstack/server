/**
 * `mapWithConcurrency` — the helper that took `listRecentFaces` off the serial
 * I/O path.
 *
 * The tests that matter here are the two properties the gallery depends on:
 * results come back in INPUT order (the Faces view renders the query's
 * `timestamp DESC`, not the I/O scheduler's), and more than one mapper is
 * genuinely in flight (the whole point — a green suite that never observed
 * concurrency would pass against the `for … await` this replaced).
 */

import { describe, expect, it } from 'vitest'
import { mapWithConcurrency } from '../map-with-concurrency.js'

/** Resolves on the next macrotask, so interleaving is observable. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

describe('mapWithConcurrency', () => {
  it('preserves input order regardless of completion order', async () => {
    const items = [0, 1, 2, 3, 4, 5, 6, 7]
    // Reverse the delays so completion order is the OPPOSITE of input order:
    // a `results.push(...)` implementation cannot pass this.
    const out = await mapWithConcurrency(items, 4, async (n) => {
      await new Promise((resolve) => setTimeout(resolve, (items.length - n) * 2))
      return n * 10
    })
    expect(out).toEqual([0, 10, 20, 30, 40, 50, 60, 70])
  })

  it('runs more than one mapper at a time, bounded by the limit', async () => {
    let inFlight = 0
    let maxInFlight = 0
    const items = Array.from({ length: 20 }, (_, i) => i)

    await mapWithConcurrency(items, 5, async (n) => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await tick()
      inFlight -= 1
      return n
    })

    // The discriminating half: the serial implementation this replaced pins
    // maxInFlight at exactly 1.
    expect(maxInFlight).toBeGreaterThan(1)
    // And the bound is real — an unbounded Promise.all would reach 20.
    expect(maxInFlight).toBeLessThanOrEqual(5)
  })

  it('never exceeds the item count when the limit is larger', async () => {
    let inFlight = 0
    let maxInFlight = 0
    await mapWithConcurrency([1, 2, 3], 50, async (n) => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await tick()
      inFlight -= 1
      return n
    })
    expect(maxInFlight).toBeLessThanOrEqual(3)
  })

  it('maps every item exactly once', async () => {
    const seen: number[] = []
    const items = Array.from({ length: 50 }, (_, i) => i)
    const out = await mapWithConcurrency(items, 7, async (n) => {
      await tick()
      seen.push(n)
      return n
    })
    expect(out).toEqual(items)
    expect([...seen].sort((a, b) => a - b)).toEqual(items)
  })

  it('returns an empty array for no items without invoking the mapper', async () => {
    let calls = 0
    const out = await mapWithConcurrency([], 4, async (n: number) => {
      calls += 1
      return n
    })
    expect(out).toEqual([])
    expect(calls).toBe(0)
  })

  it('treats a zero or negative limit as one rather than hanging', async () => {
    const out = await mapWithConcurrency([1, 2, 3], 0, async (n) => n * 2)
    expect(out).toEqual([2, 4, 6])
  })

  it('rejects when a mapper rejects', async () => {
    await expect(
      mapWithConcurrency([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error('boom')
        return n
      }),
    ).rejects.toThrow('boom')
  })
})
