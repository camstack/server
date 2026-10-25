/**
 * The sentry's picture, and the fallback the operator approved.
 *
 * The snapshot cache is RAM-only, so after a hub restart the cameras this
 * feature exists for — sleeping battery ones — have NO cached frame, and the
 * fetch must not `force` one into existence (that wakes the camera). "No
 * picture" is therefore a normal state on the happy path, and a generated card
 * carrying the camera's name is the answer.
 *
 * Both branches are pinned, and so is the third: a cached frame that cannot be
 * decoded falls through to the card rather than being shown untreated.
 */
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import { composePrestreamPicture } from '../sentry-picture.js'

async function realJpeg(width: number, height: number): Promise<Buffer> {
  return await sharp({
    create: { width, height, channels: 3, background: { r: 20, g: 60, b: 90 } },
  })
    .jpeg()
    .toBuffer()
}

describe('composePrestreamPicture', () => {
  it('treats the camera’s own cached frame and keeps its dimensions', async () => {
    const cached = await realJpeg(1600, 1200)
    const picture = await composePrestreamPicture({
      cachedJpeg: cached,
      deviceName: 'Garden',
      // Deliberately different from the cached frame: an overlay preserves the
      // frame, it does not resize it to the card geometry.
      width: 640,
      height: 480,
    })

    expect(picture.source).toBe('cached-snapshot')
    const meta = await sharp(picture.jpeg).metadata()
    expect(meta.width).toBe(1600)
    expect(meta.height).toBe(1200)
  })

  it('falls back to a generated card at the asked geometry when the cache is cold', async () => {
    const picture = await composePrestreamPicture({
      cachedJpeg: null,
      deviceName: 'Garden',
      width: 1280,
      height: 720,
    })

    expect(picture.source).toBe('generated-card')
    const meta = await sharp(picture.jpeg).metadata()
    expect(meta.width).toBe(1280)
    expect(meta.height).toBe(720)
  })

  it('treats an EMPTY buffer as a cold cache, not as a frame', async () => {
    const picture = await composePrestreamPicture({
      cachedJpeg: Buffer.alloc(0),
      deviceName: 'Garden',
      width: 640,
      height: 480,
    })
    expect(picture.source).toBe('generated-card')
  })

  it('falls back rather than leaking an untreated frame when the cached bytes are junk', async () => {
    const picture = await composePrestreamPicture({
      cachedJpeg: Buffer.from('not a jpeg at all'),
      deviceName: 'Garden',
      width: 640,
      height: 480,
    })
    expect(picture.source).toBe('generated-card')
  })
})

/**
 * The card must not announce something the code refuses to do.
 *
 * Both branches asked for `reason: 'waking'`, and in this window nothing is
 * being woken — the caller never passes `force` to the snapshot, deliberately,
 * because *"a background caller that sets it wakes the very camera the
 * sentry exists so as not to disturb"*. The camera is asleep and we are
 * watching the door. `'waking'` is the truth only AFTER a wake signal, when it
 * really is coming up.
 *
 * The vocabulary already had the right word — `CourtesyReason` carries
 * `'sleeping'` — it was simply never used here.
 *
 * The reason is returned rather than only painted, because the operator's
 * question about a stale tile is always "what did we think the camera was
 * doing", and a pixel cannot be grepped.
 */
describe('the courtesy reason tells the truth', () => {
  it('depicts a SLEEPING camera when composing the generated card', async () => {
    const picture = await composePrestreamPicture({
      cachedJpeg: null,
      deviceName: 'Baby monitor',
      width: 640,
      height: 360,
    })
    expect(picture.source).toBe('generated-card')
    expect(picture.reason).toBe('sleeping')
  })

  it('depicts a SLEEPING camera when overlaying a cached frame too', async () => {
    const picture = await composePrestreamPicture({
      cachedJpeg: await realJpeg(320, 240),
      deviceName: 'Baby monitor',
      width: 640,
      height: 360,
    })
    expect(picture.source).toBe('cached-snapshot')
    expect(picture.reason).toBe('sleeping')
  })
})
