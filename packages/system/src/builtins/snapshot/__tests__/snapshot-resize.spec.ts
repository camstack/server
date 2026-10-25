/**
 * The variant cache, and one real sharp round-trip.
 *
 * The cache's correctness rests entirely on the SOURCE timestamp: a thumbnail
 * is only valid for the frame it was derived from, and a stale one would leave
 * a card showing a picture the full-size view had already replaced.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import sharp from 'sharp'
import { resizeJpeg, SnapshotVariantCache } from '../snapshot-resize.js'

let cache: SnapshotVariantCache

beforeEach(() => {
  cache = new SnapshotVariantCache()
})

describe('variant cache', () => {
  it('returns a variant for the frame it came from', () => {
    cache.set(1, 'low', 320, 1000, Buffer.from('small'))
    expect(cache.get(1, 'low', 320, 1000)?.toString()).toBe('small')
  })

  it('MISSES once the source frame was recaptured', () => {
    // The whole point: a new capture moves `capturedAt`, and every variant of
    // the old frame must stop matching rather than outlive it.
    cache.set(1, 'low', 320, 1000, Buffer.from('old'))
    expect(cache.get(1, 'low', 320, 2000)).toBeUndefined()
  })

  it('keeps widths and streams apart', () => {
    cache.set(1, 'low', 320, 1000, Buffer.from('a'))
    expect(cache.get(1, 'low', 480, 1000)).toBeUndefined()
    expect(cache.get(1, 'high', 320, 1000)).toBeUndefined()
  })

  it('keeps raw and state-labelled variants apart', () => {
    cache.set(1, 'low', 320, 1000, Buffer.from('raw'))
    cache.set(1, 'low', 320, 1000, Buffer.from('sleeping'), 'sleeping')

    expect(cache.get(1, 'low', 320, 1000)?.toString()).toBe('raw')
    expect(cache.get(1, 'low', 320, 1000, 'sleeping')?.toString()).toBe('sleeping')
  })

  it('drops every variant of a device at once', () => {
    cache.set(1, 'low', 320, 1000, Buffer.from('a'))
    cache.set(1, 'low', 480, 1000, Buffer.from('b'))
    cache.set(2, 'low', 320, 1000, Buffer.from('c'))

    cache.deleteDevice(1)

    expect(cache.get(1, 'low', 320, 1000)).toBeUndefined()
    expect(cache.get(1, 'low', 480, 1000)).toBeUndefined()
    expect(cache.get(2, 'low', 320, 1000)?.toString()).toBe('c')
  })
})

/**
 * The width a baseline/progressive JPEG declares in its SOF segment. Read
 * here rather than with an external probe: `ffprobe` is not on every machine
 * the suite runs on (the CI runner has `ffmpeg` but not `ffprobe`), and a
 * test that only runs where a tool happens to be installed proves nothing.
 */
function jpegWidth(jpeg: Buffer): number {
  let offset = 2 // past SOI
  while (offset + 4 <= jpeg.length) {
    if (jpeg[offset] !== 0xff) throw new Error(`not a JPEG marker at ${offset}`)
    const marker = jpeg[offset + 1] ?? 0
    const length = jpeg.readUInt16BE(offset + 2)
    // SOF0..SOF15, minus DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return jpeg.readUInt16BE(offset + 7)
    }
    offset += 2 + length
  }
  throw new Error('no SOF segment in JPEG')
}

describe('resizeJpeg (real sharp)', () => {
  /** A 1280x720 JPEG of noise (a flat frame would compress to almost nothing at any size), generated rather than committed. */
  function sourceJpeg(): Promise<Buffer> {
    return sharp({
      create: {
        width: 1280,
        height: 720,
        channels: 3,
        background: { r: 128, g: 128, b: 128 },
        noise: { type: 'gaussian', mean: 128, sigma: 40 },
      },
    })
      .jpeg()
      .toBuffer()
  }

  it('produces a smaller JPEG at the requested width', async () => {
    const src = await sourceJpeg()
    expect(jpegWidth(src)).toBe(1280)
    const out = await resizeJpeg(src, 320)

    // Still a JPEG (SOI marker), and materially smaller.
    expect(out.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]))
    expect(out.length).toBeLessThan(src.length / 2)

    // And it is actually 320 wide — the size assertion alone would pass on a
    // more-compressed frame of the original dimensions.
    expect(jpegWidth(out)).toBe(320)
  }, 30_000)

  it('rejects on garbage instead of returning the input', async () => {
    // Never a silent fallback to the original: serving the 4K frame when the
    // resize failed is exactly the bug this module exists to fix, and it
    // would be invisible.
    //
    // Asserted on the BEHAVIOUR, not on the wording — the message belonged to
    // the ffmpeg implementation and did not survive the move to sharp
    // (2026-08-11). What must survive is that it throws, and that the input
    // never comes back out.
    // Rejecting IS "does not return the input" — there is no resolved value to
    // hand back. The pairing to avoid is a resolve that happens to equal the
    // source, which only a silent fallback could produce.
    await expect(resizeJpeg(Buffer.from('not a jpeg'), 320)).rejects.toThrow(Error)
  }, 30_000)
})

/**
 * A variant derived from a superseded frame returns `undefined` — correct — but
 * the entry itself used to stay in the map forever. Every recapture therefore
 * added a dead key that nothing could ever read and nothing ever removed.
 */
describe('variant cache bounds', () => {
  it('DELETES a stale variant rather than leaving a key nothing can read', () => {
    cache.set(1, 'low', 320, 1000, Buffer.from('old'))
    expect(cache.entryCount()).toBe(1)
    // The frame was recaptured: this variant is unreachable from now on.
    expect(cache.get(1, 'low', 320, 2000)).toBeUndefined()
    expect(cache.entryCount()).toBe(0)
    expect(cache.sizeBytes()).toBe(0)
  })

  it('holds a byte budget by evicting the least-recently-accessed variant', () => {
    let now = 0
    const bounded = new SnapshotVariantCache({ maxBytes: 30, now: () => now })
    bounded.set(1, 'low', 320, 1, Buffer.alloc(10))
    bounded.set(2, 'low', 320, 1, Buffer.alloc(10))
    bounded.set(3, 'low', 320, 1, Buffer.alloc(10))
    now += 1
    expect(bounded.get(1, 'low', 320, 1)).toBeDefined() // device 2 is now coldest
    now += 1
    bounded.set(4, 'low', 320, 1, Buffer.alloc(10))

    expect(bounded.sizeBytes()).toBeLessThanOrEqual(30)
    expect(bounded.get(2, 'low', 320, 1)).toBeUndefined()
    expect(bounded.get(1, 'low', 320, 1)).toBeDefined()
    expect(bounded.get(4, 'low', 320, 1)).toBeDefined()
  })
})
