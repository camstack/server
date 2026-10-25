import { describe, it, expect } from 'vitest'
import type { MediaFile } from '@camstack/types'
import { makeTestMediaFile } from '../../../__tests__/support/media-file.js'
import { decideFirstLastFrameOrder } from '../first-last-frame-order.js'

/** Deterministic media ROW id (D482) for a fixture LABEL — not a real rowid,
 *  just a stable, non-zero number a test can assert back against for the
 *  same label. */
function mediaIdFor(label: string): number {
  let hash = 0
  for (const ch of label) hash = (hash * 31 + ch.charCodeAt(0)) % 100_000
  return hash + 1000
}

function media(
  kind: MediaFile['kind'],
  timestamp: number,
  label = `${kind}-${timestamp}`,
): MediaFile {
  return makeTestMediaFile({
    mediaId: mediaIdFor(label),
    kind,
    base64: '',
    sizeBytes: 0,
    timestamp,
  })
}

/**
 * Device 3829, 2026-09-08 16:09 — the three tracks the operator filed by hand
 * as "Ultimo frame prima del primo" (`d035f251`, `448678bb`, `7628b19d`). Every
 * one of them stored a `firstFrame` NEWER than its `lastFrame`.
 */
describe('decideFirstLastFrameOrder', () => {
  it('swaps the two slots when the held firstFrame POST-DATES the held lastFrame (7628b19d)', () => {
    // lastFrame was copied from keyFrameSmall at the birth instant; the
    // firstFrame landed 260 ms later, on the frame the confirmation gate
    // finally released the birth on.
    const decision = decideFirstLastFrameOrder([
      media('keyFrame', 1_788_883_780_851, 'kf'),
      media('keyFrameSmall', 1_788_883_780_851, 'kfs'),
      media('lastFrame', 1_788_883_780_851, 'lf'),
      media('firstFrame', 1_788_883_781_111, 'ff'),
    ])
    expect(decision).toEqual({
      swap: true,
      firstFrameMediaId: mediaIdFor('ff'),
      lastFrameMediaId: mediaIdFor('lf'),
      firstFrameTimestamp: 1_788_883_781_111,
      lastFrameTimestamp: 1_788_883_780_851,
      inversionMs: 260,
    })
  })

  it('swaps on the d035f251 shape, where the firstFrame also post-dates the track itself', () => {
    const decision = decideFirstLastFrameOrder([
      media('keyFrame', 1_788_883_782_745, 'kf'),
      media('keyFrameSmall', 1_788_883_782_745, 'kfs'),
      media('thumbnail', 1_788_883_782_745, 'th'),
      media('lastFrame', 1_788_883_782_745, 'lf'),
      media('firstFrame', 1_788_883_784_582, 'ff'),
    ])
    expect(decision).toMatchObject({ swap: true, inversionMs: 1837 })
  })

  it('leaves an ordered pair alone — first BEFORE last is the healthy shape', () => {
    expect(
      decideFirstLastFrameOrder([media('firstFrame', 1000, 'ff'), media('lastFrame', 5000, 'lf')]),
    ).toEqual({ swap: false, skippedBecause: 'ordered' })
  })

  it('leaves a COLLAPSED pair alone — a sub-interval track legitimately has one frame', () => {
    // first === last is not an inversion. A track shorter than the lastFrame
    // interval has exactly one honest view, and both slots showing it is the
    // correct answer, not a defect to repair.
    expect(
      decideFirstLastFrameOrder([media('firstFrame', 4000, 'ff'), media('lastFrame', 4000, 'lf')]),
    ).toEqual({ swap: false, skippedBecause: 'ordered' })
  })

  it('does nothing when either slot is empty — there is no pair to order', () => {
    expect(decideFirstLastFrameOrder([media('lastFrame', 5000, 'lf')])).toEqual({
      swap: false,
      skippedBecause: 'no-first-frame',
    })
    expect(decideFirstLastFrameOrder([media('firstFrame', 5000, 'ff')])).toEqual({
      swap: false,
      skippedBecause: 'no-last-frame',
    })
    expect(decideFirstLastFrameOrder([])).toEqual({
      swap: false,
      skippedBecause: 'no-first-frame',
    })
  })

  it('ignores every other kind — only the two ordered slots are in scope', () => {
    expect(
      decideFirstLastFrameOrder([
        media('snapshot', 9000, 'snap'),
        media('keyFrameSmall', 9000, 'kfs'),
        media('firstFrame', 1000, 'ff'),
        media('lastFrame', 2000, 'lf'),
      ]),
    ).toEqual({ swap: false, skippedBecause: 'ordered' })
  })

  it('picks the newest row per slot should a legacy duplicate linger', () => {
    expect(
      decideFirstLastFrameOrder([
        media('firstFrame', 1000, 'ff-old'),
        media('firstFrame', 7000, 'ff-new'),
        media('lastFrame', 2000, 'lf-old'),
        media('lastFrame', 3000, 'lf-new'),
      ]),
    ).toEqual({
      swap: true,
      firstFrameMediaId: mediaIdFor('ff-new'),
      lastFrameMediaId: mediaIdFor('lf-new'),
      firstFrameTimestamp: 7000,
      lastFrameTimestamp: 3000,
      inversionMs: 4000,
    })
  })
})
