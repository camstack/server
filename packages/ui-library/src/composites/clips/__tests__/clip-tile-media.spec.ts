/**
 * A tile's picture — vouched, offered, or absent WITH a reason. Never blank.
 *
 * `thumbnail` is a JPEG already on disk; `thumbnailMint` is a URL that MAY
 * produce one and answers 204 with `x-camstack-reason` when it cannot;
 * `thumbnailUnavailable.reason` is the provider saying no mint will succeed
 * now. The three are mutually exclusive by design (D549 decision 5) and this
 * is the one place that is enforced for the surface — a tile that fell through
 * all three would render as an empty grey box, which is exactly the "we did
 * not look" ambiguity the vouching rule exists to remove.
 */
import { describe, expect, it } from 'vitest'
import type { Clip } from '@camstack/types'
import { describeRefusal, resolveTileMedia } from '../clip-tile-media.js'

const BASE: Clip = {
  id: 'native:reolink:onboard:592:abc',
  source: 'native:reolink:onboard',
  kind: 'native',
  timeRange: { startMs: 1, endMs: 2 },
}

describe('resolveTileMedia', () => {
  it('prefers the vouched JPEG over an offer', () => {
    const media = resolveTileMedia({ ...BASE, thumbnail: '/a.jpg', thumbnailMint: '/mint' })
    expect(media).toEqual({ kind: 'vouched', url: '/a.jpg' })
  })

  it('offers the mint when there is no vouched JPEG', () => {
    expect(resolveTileMedia({ ...BASE, thumbnailMint: '/mint' })).toEqual({
      kind: 'mint',
      url: '/mint',
    })
  })

  it('states the provider reason rather than showing an empty box', () => {
    const media = resolveTileMedia({
      ...BASE,
      thumbnailUnavailable: { reason: 'sleeping' },
    })
    expect(media.kind).toBe('unavailable')
    expect(media.kind === 'unavailable' ? media.reason : '').toBe('sleeping')
    expect(media.kind === 'unavailable' ? media.text : '').toMatch(/asleep/i)
  })

  it('a clip that offers nothing SAYS so — it never falls through to blank', () => {
    const media = resolveTileMedia(BASE)
    expect(media.kind).toBe('none')
    expect(media.kind === 'none' ? media.text.length : 0).toBeGreaterThan(0)
  })

  it('each unavailable reason gets its own words', () => {
    const reasons = ['sleeping', 'camera-refused', 'no-keyframe', 'unsupported'] as const
    const texts = reasons.map((reason) => {
      const media = resolveTileMedia({ ...BASE, thumbnailUnavailable: { reason } })
      return media.kind === 'unavailable' ? media.text : ''
    })
    expect(new Set(texts).size).toBe(reasons.length)
  })
})

describe('describeRefusal — keyed by the CODE, never by the prose', () => {
  it('gives the operator words for a code, whatever prose came with it', () => {
    const media = describeRefusal({
      code: 'queue-full',
      reason: 'queue-full: 16 thumbnail mints already waiting for host 192.168.10.20',
      disposition: 'deferred',
    })
    expect(media.kind).toBe('deferred')
    expect(media.kind === 'deferred' ? media.text : '').toMatch(/queue|busy|waiting/i)
    // The prose is not the words on screen, and it is not thrown away either.
    expect(media.kind === 'deferred' ? media.text : '').not.toContain('192.168.10.20')
  })

  it('shows the CAMERA’s own words when the code cannot explain itself', () => {
    const media = describeRefusal({
      code: 'camera-refused',
      reason: 'rejected: responseCode=400 (cmdId=298)',
      disposition: 'final',
    })
    expect(media.kind).toBe('unavailable')
    expect(media.kind === 'unavailable' ? media.text : '').toContain('responseCode=400')
  })

  it('treats an answer with NO disposition as final — an old addon keeps its old behaviour', () => {
    const media = describeRefusal({
      code: undefined,
      reason: 'queue-full: waiting',
      disposition: undefined,
    })
    expect(media.kind).toBe('unavailable')
  })

  it('treats a disposition it does not recognise as final, never as retry-forever', () => {
    const media = describeRefusal({ code: 'queue-full', reason: 'x', disposition: 'maybe-later' })
    expect(media.kind).toBe('unavailable')
  })

  it('keeps an unknown CODE visible rather than dropping it', () => {
    const media = describeRefusal({
      code: 'something-new-from-the-firmware',
      reason: 'something-new-from-the-firmware: who knows',
      disposition: 'final',
    })
    expect(media.kind === 'unavailable' ? media.text : '').toContain(
      'something-new-from-the-firmware',
    )
  })
})
