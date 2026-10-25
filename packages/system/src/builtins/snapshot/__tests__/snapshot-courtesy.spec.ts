/**
 * The courtesy frame — what a camera that CANNOT capture answers with.
 *
 * Measured on the live grid 2026-08-11: 10 of 26 tiles returned HTTP 404, so a
 * deliberately disabled camera was indistinguishable from a broken one. [D62]
 * requires the opposite — an off switch is REPORTED off.
 */
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import {
  buildCourtesySvg,
  buildCourtesyOverlaySvg,
  courtesyBackground,
  courtesyCacheKey,
  courtesyLabel,
  escapeCourtesyText,
  renderCourtesyJpeg,
  renderCourtesyOverlayJpeg,
} from '../snapshot-courtesy.js'

describe('courtesyLabel / courtesyBackground', () => {
  it('names every reason in the operator vocabulary', () => {
    expect(courtesyLabel('disabled')).toBe('Disabled')
    expect(courtesyLabel('offline')).toBe('Offline')
    expect(courtesyLabel('sleeping')).toBe('Sleeping')
    expect(courtesyLabel('waking')).toBe('Waking')
  })

  it('does not paint a deliberate state like a fault', () => {
    // Disabled is a choice, offline is a failure. If they shared a colour the
    // frame would say "something is wrong" about a camera the operator turned
    // off on purpose.
    expect(courtesyBackground('disabled')).not.toBe(courtesyBackground('offline'))
  })
})

describe('escapeCourtesyText', () => {
  it('escapes what would otherwise break the SVG', () => {
    // A camera named `Cortile <A> & "B"` is not exotic, and an unescaped `<`
    // makes librsvg reject the whole document — the frame would fail, not
    // render wrong, which is why this is not cosmetic.
    expect(escapeCourtesyText('Cortile <A> & "B"')).toBe('Cortile &lt;A&gt; &amp; &quot;B&quot;')
  })

  it('leaves ordinary names untouched', () => {
    expect(escapeCourtesyText('Camera porch')).toBe('Camera porch')
  })
})

describe('buildCourtesySvg', () => {
  const base = { deviceName: 'IP4M-1041B', reason: 'disabled', height: 360 } as const

  it('carries the state and the camera name', () => {
    const svg = buildCourtesySvg({ ...base, width: 640 })
    expect(svg).toContain('>Disabled<')
    expect(svg).toContain('>IP4M-1041B<')
    expect(svg).toContain(courtesyBackground('disabled'))
  })

  describe('buildCourtesyOverlaySvg', () => {
    // The OVERLAY sits on a real frame. Its job is to say "this is not live"
    // WITHOUT hiding what the camera last saw — the operator opens a baby
    // monitor to see the room, and a marker that costs them the room has taken
    // more than it gave.
    //
    // This used to be a full-frame wash at 0.62 opacity. The docblock said
    // "translucent so the last real camera frame remains visible underneath",
    // and the old test asserted the literal `0.62` — which pins a number and
    // says nothing about the property, so it would have passed at 0.99 just as
    // happily. Reported by the operator on the Baby monitor, 2026-09-16: "ma
    // perché Waking? Dovremmo mostrare l'ultimo snapshot disponibile." [but why Waking? We should show the last available snapshot.]
    const overlay = (): string =>
      buildCourtesyOverlaySvg({
        deviceName: 'Baby monitor',
        reason: 'sleeping',
        width: 640,
        height: 360,
      })

    it('still says what the state is, and for which camera', () => {
      // The marker is what earns the band its place: a stale frame shown clean
      // gets mistaken for live. Both halves must survive any redesign.
      expect(overlay()).toContain('>Sleeping')
      expect(overlay()).toContain('Baby monitor')
    })

    it('does NOT paint over the whole frame', () => {
      // The one assertion that matters. A full-bleed rect is the wash; a band
      // is the marker.
      expect(overlay()).not.toMatch(/<rect[^>]*width="100%"[^>]*height="100%"/)
    })

    it('leaves most of the picture untouched', () => {
      // Whatever shape the marker takes, it must cover a MINORITY of the
      // frame. Derived from the rect's own height rather than trusted from a
      // literal, so a redesign that quietly grows the band fails here.
      const rect = /<rect[^>]*height="(\d+)"/.exec(overlay())
      expect(rect, 'the overlay should draw a band').not.toBeNull()
      expect(Number(rect?.[1] ?? 0)).toBeLessThan(360 * 0.3)
    })

    it('the GENERATED card still covers everything — there is no picture under it', () => {
      // The two must not converge: with no cached frame the card IS the
      // picture, and a translucent one would show black through it.
      const card = buildCourtesySvg({
        deviceName: 'Baby monitor',
        reason: 'sleeping',
        width: 640,
        height: 360,
      })
      expect(card).toMatch(/<rect[^>]*width="100%"[^>]*height="100%"/)
      expect(card).toContain('fill-opacity="1"')
    })
  })

  it('scales the text with the frame so a tile and a full frame read alike', () => {
    const sizeOf = (s: string): number => Number(/font-size="(\d+)"/.exec(s)?.[1] ?? '0')
    const small = buildCourtesySvg({ ...base, width: 240, height: 135 })
    const large = buildCourtesySvg({ ...base, width: 1920, height: 1080 })
    expect(sizeOf(large)).toBeGreaterThan(sizeOf(small))
    // …but never below a legible floor on a thumbnail.
    expect(sizeOf(small)).toBeGreaterThanOrEqual(12)
  })

  it('names a font FAMILY, never a path', () => {
    // The ffmpeg draft needed a font FILE and probed candidate paths, which is
    // a host-layout dependency. An SVG names a family and fontconfig resolves
    // it — one less thing to be wrong on a machine we did not test on.
    const svg = buildCourtesySvg({ ...base, width: 640 })
    expect(svg).toContain('font-family=')
    expect(svg).not.toContain('.ttf')
  })
})

describe('courtesyCacheKey', () => {
  it('separates every dimension that changes the pixels', () => {
    const a = { deviceName: 'Cam', reason: 'disabled', width: 640, height: 360 } as const
    expect(courtesyCacheKey(a)).toBe(courtesyCacheKey({ ...a }))
    expect(courtesyCacheKey({ ...a, reason: 'offline' })).not.toBe(courtesyCacheKey(a))
    expect(courtesyCacheKey({ ...a, width: 320 })).not.toBe(courtesyCacheKey(a))
    expect(courtesyCacheKey({ ...a, height: 180 })).not.toBe(courtesyCacheKey(a))
    expect(courtesyCacheKey({ ...a, deviceName: 'Altra' })).not.toBe(courtesyCacheKey(a))
  })
})

describe('renderCourtesyJpeg', () => {
  it('produces a real JPEG at the requested size', async () => {
    const bytes = await renderCourtesyJpeg({
      deviceName: 'IP4M-1041B',
      reason: 'disabled',
      width: 640,
      height: 360,
    })

    expect(bytes.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]))
    const meta = await sharp(bytes).metadata()
    expect(meta).toMatchObject({ format: 'jpeg', width: 640, height: 360 })
  })

  it('renders a name that would have broken the document', async () => {
    // The escaping test above proves the string; this proves the pipeline does
    // not reject it. A frame that throws here is a 404 by another route.
    const bytes = await renderCourtesyJpeg({
      deviceName: 'Cortile <A> & "B"',
      reason: 'offline',
      width: 320,
      height: 180,
    })
    expect(bytes.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]))
  })

  it('uses a cached real frame as the background for the state overlay', async () => {
    const background = await sharp({
      create: {
        width: 320,
        height: 180,
        channels: 3,
        background: '#f02020',
      },
    })
      .jpeg()
      .toBuffer()
    const bytes = await renderCourtesyOverlayJpeg(background, {
      deviceName: 'Baby monitor',
      reason: 'sleeping',
    })

    expect(await sharp(bytes).metadata()).toMatchObject({ width: 320, height: 180 })
    const pixel = await sharp(bytes).removeAlpha().raw().toBuffer()
    // The translucent wash leaves the distinctive red source visible. A
    // generated courtesy background would be the opaque sleeping blue.
    expect(pixel[0]).toBeGreaterThan(70)
  })
})
