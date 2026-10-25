/**
 * A PAST capture (D691) may be served from the recordings (review M2), whose
 * cut is bounded by D686's 30 s — not by the 8 s a live snapshot gets. A past
 * capture held to the snapshot bound would time out on every recorded
 * fallback that the recorder answers in, say, 10 s.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeSilentLogger } from '../../pipeline-analytics/__tests__/test-helpers.js'
import { NC_PAST_STILL_TIMEOUT_MS, NcStillShelf } from '../still-shelf.js'

const JPEG_B64 = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64')

afterEach(() => {
  vi.useRealTimers()
})

function shelfWith(delayMs: number): NcStillShelf {
  return new NcStillShelf({
    getSnapshot: async () => null,
    getPastStill: () =>
      new Promise((resolve) => {
        setTimeout(() => resolve({ base64: JPEG_B64, contentType: 'image/jpeg' }), delayMs)
      }),
    logger: makeSilentLogger(),
    now: () => Date.now(),
  })
}

describe('a past capture waits out the recorded bound, not the snapshot one', () => {
  it('lands a frame the recordings answered in 10 s', async () => {
    vi.useFakeTimers()
    const shelf = shelfWith(10_000)
    const owner = shelf.capture(102, 1_000, 'occupancy', 'past')
    await vi.advanceTimersByTimeAsync(10_000)
    // The downscale runs on real sharp; let it settle.
    vi.useRealTimers()
    await vi.waitFor(() => expect(shelf.get(owner)?.length ?? 0).toBeGreaterThan(0))
  })

  it('is still bounded: a past still that never answers is named a miss at its own bound', async () => {
    vi.useFakeTimers()
    const misses: string[] = []
    const shelf = new NcStillShelf({
      getSnapshot: async () => null,
      getPastStill: () => new Promise(() => {}),
      logger: {
        ...makeSilentLogger(),
        warn: (_msg: string, ctx?: { meta?: Record<string, unknown> }) => {
          misses.push(String(ctx?.meta?.['reason'] ?? ''))
        },
      },
      now: () => Date.now(),
    })
    shelf.capture(102, 1_000, 'occupancy', 'past')
    await vi.advanceTimersByTimeAsync(NC_PAST_STILL_TIMEOUT_MS - 1)
    expect(misses).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(misses).toHaveLength(1)
    expect(misses[0]).toMatch(/timed out/)
  })
})
