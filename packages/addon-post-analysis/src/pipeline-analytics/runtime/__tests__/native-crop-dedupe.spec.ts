import { describe, expect, it } from 'vitest'
import { NativeCropDedupe } from '../native-crop-dedupe.js'

/**
 * The same crop, asked for twice, crosses the wire once.
 *
 * Every enrichment consumer — face, plate, clip, detail, best shot — pulls its
 * ROI by frame handle, and each response transits hub-main as a msgpack buffer.
 * Measured 2026-08-29: ~2 267 responses/min at ~236 kB each, 81% of hub-main's
 * outbound bytes, and it is what puts that process 12% over its RSS budget with
 * a half-second stop-the-world reclaim every couple of minutes on the one
 * process every cross-runner call goes through.
 *
 * Two mechanisms, deliberately separated:
 *  - COALESCING joins callers that ask while a request is in flight. Pure win:
 *    nothing is retained beyond the request that was happening anyway.
 *  - The short TTL answers a repeat that arrives just after. That one DOES
 *    retain bytes in this process, so it is small and brief on purpose — the
 *    point is to move bytes off hub-main, not to move a leak here.
 */
const HANDLE = { shmId: 'ring-102', slot: 3, seq: 42 }
const REGION = { x: 0.1, y: 0.2, w: 0.3, h: 0.4 }

function makeClock(): { now: () => number; advance: (ms: number) => void } {
  let t = 1_000
  return { now: () => t, advance: (ms) => (t += ms) }
}

describe('NativeCropDedupe', () => {
  it('joins a concurrent request instead of issuing a second one', async () => {
    const clock = makeClock()
    const d = new NativeCropDedupe<Buffer>({ now: clock.now, ttlMs: 1_500, maxEntries: 8 })
    let calls = 0
    let release: (v: Buffer | null) => void = () => {}
    const slow = () =>
      new Promise<Buffer | null>((r) => {
        calls += 1
        release = r
      })

    const a = d.run(HANDLE, REGION, undefined, slow)
    const b = d.run(HANDLE, REGION, undefined, slow)
    release(Buffer.from('jpeg'))
    expect(await a).toEqual(Buffer.from('jpeg'))
    expect(await b).toEqual(Buffer.from('jpeg'))
    expect(calls).toBe(1)
  })

  it('serves a repeat from the window without touching the wire', async () => {
    const clock = makeClock()
    const d = new NativeCropDedupe<Buffer>({ now: clock.now, ttlMs: 1_500, maxEntries: 8 })
    let calls = 0
    const fetch = async () => {
      calls += 1
      return Buffer.from('jpeg')
    }
    await d.run(HANDLE, REGION, undefined, fetch)
    clock.advance(500)
    await d.run(HANDLE, REGION, undefined, fetch)
    expect(calls).toBe(1)
  })

  it('fetches again once the window has passed — a cache, never a store', async () => {
    const clock = makeClock()
    const d = new NativeCropDedupe<Buffer>({ now: clock.now, ttlMs: 1_500, maxEntries: 8 })
    let calls = 0
    const fetch = async () => {
      calls += 1
      return Buffer.from('jpeg')
    }
    await d.run(HANDLE, REGION, undefined, fetch)
    clock.advance(2_000)
    await d.run(HANDLE, REGION, undefined, fetch)
    expect(calls).toBe(2)
  })

  it('never confuses two different regions of the SAME frame', async () => {
    const clock = makeClock()
    const d = new NativeCropDedupe<Buffer>({ now: clock.now, ttlMs: 1_500, maxEntries: 8 })
    const a = await d.run(HANDLE, REGION, undefined, async () => Buffer.from('face'))
    const b = await d.run(HANDLE, { x: 0.5, y: 0.5, w: 0.2, h: 0.2 }, undefined, async () =>
      Buffer.from('plate'),
    )
    expect(a).toEqual(Buffer.from('face'))
    expect(b).toEqual(Buffer.from('plate'))
  })

  it('never confuses two different frames of the same ring slot', async () => {
    const clock = makeClock()
    const d = new NativeCropDedupe<Buffer>({ now: clock.now, ttlMs: 1_500, maxEntries: 8 })
    const a = await d.run(HANDLE, REGION, undefined, async () => Buffer.from('seq42'))
    const b = await d.run({ ...HANDLE, seq: 43 }, REGION, undefined, async () =>
      Buffer.from('seq43'),
    )
    expect(a).toEqual(Buffer.from('seq42'))
    expect(b).toEqual(Buffer.from('seq43'))
  })

  it('distinguishes a downscaled request from a full-size one', async () => {
    const clock = makeClock()
    const d = new NativeCropDedupe<Buffer>({ now: clock.now, ttlMs: 1_500, maxEntries: 8 })
    const a = await d.run(HANDLE, REGION, 448, async () => Buffer.from('small'))
    const b = await d.run(HANDLE, REGION, undefined, async () => Buffer.from('full'))
    expect(a).toEqual(Buffer.from('small'))
    expect(b).toEqual(Buffer.from('full'))
  })

  it('does not remember a MISS — a null must stay retry-eligible', async () => {
    const clock = makeClock()
    const d = new NativeCropDedupe<Buffer>({ now: clock.now, ttlMs: 1_500, maxEntries: 8 })
    let calls = 0
    const miss = async () => {
      calls += 1
      return null
    }
    await d.run(HANDLE, REGION, undefined, miss)
    await d.run(HANDLE, REGION, undefined, miss)
    expect(calls).toBe(2)
  })

  it('releases an in-flight entry when the fetch throws, so the next call retries', async () => {
    const clock = makeClock()
    const d = new NativeCropDedupe<Buffer>({ now: clock.now, ttlMs: 1_500, maxEntries: 8 })
    await expect(
      d.run(HANDLE, REGION, undefined, async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    const after = await d.run(HANDLE, REGION, undefined, async () => Buffer.from('ok'))
    expect(after).toEqual(Buffer.from('ok'))
  })

  it('stays bounded — it must not become the memory it was written to save', async () => {
    const clock = makeClock()
    const d = new NativeCropDedupe<Buffer>({ now: clock.now, ttlMs: 60_000, maxEntries: 4 })
    for (let i = 0; i < 20; i += 1) {
      await d.run({ ...HANDLE, seq: i }, REGION, undefined, async () => Buffer.from(`f${i}`))
    }
    expect(d.size()).toBeLessThanOrEqual(4)
  })
})

/**
 * The counters exist so the saving is a MEASUREMENT, not a claim. Shipping the
 * dedupe without them left only the process RSS as evidence — allocator residue
 * that ratchets within a boot and cannot answer "did it fire".
 */
describe('NativeCropDedupe — what it saved', () => {
  it('counts a wire fetch, a coalesce and a reuse separately', async () => {
    const clock = makeClock()
    const d = new NativeCropDedupe<Buffer>({ now: clock.now, ttlMs: 1_500, maxEntries: 8 })
    let release: (v: Buffer | null) => void = () => {}
    const slow = () => new Promise<Buffer | null>((r) => (release = r))

    const a = d.run(HANDLE, REGION, undefined, slow)
    const b = d.run(HANDLE, REGION, undefined, slow)
    release(Buffer.from('jpeg'))
    await Promise.all([a, b])
    await d.run(HANDLE, REGION, undefined, async () => Buffer.from('jpeg'))

    expect(d.drainCounts()).toEqual({ fetched: 1, coalesced: 1, reused: 1 })
  })

  it('resets on read, so each report covers its own window', async () => {
    const clock = makeClock()
    const d = new NativeCropDedupe<Buffer>({ now: clock.now, ttlMs: 1_500, maxEntries: 8 })
    await d.run(HANDLE, REGION, undefined, async () => Buffer.from('x'))
    d.drainCounts()
    expect(d.drainCounts()).toEqual({ fetched: 0, coalesced: 0, reused: 0 })
  })
})
