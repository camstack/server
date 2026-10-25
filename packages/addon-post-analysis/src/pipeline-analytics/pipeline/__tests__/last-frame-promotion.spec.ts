import { describe, it, expect } from 'vitest'
import type { MediaFile } from '@camstack/types'
import { makeTestMediaFile } from '../../../__tests__/support/media-file.js'
import { decideLastFramePromotion } from '../last-frame-promotion.js'

/** Deterministic media ROW id (D482) for a fixture LABEL — not a real
 *  rowid, just a stable, non-zero number a test can assert back against for
 *  the same label. */
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

describe('decideLastFramePromotion', () => {
  it('promotes the newest snapshot when it is NEWER than the held lastFrame', () => {
    const decision = decideLastFramePromotion([
      media('snapshot', 1000, 'snap-a'),
      media('lastFrame', 2000, 'lf'),
      media('snapshot', 3000, 'snap-b'),
    ])
    expect(decision).toEqual({
      promote: true,
      mode: 'move',
      snapshotMediaId: mediaIdFor('snap-b'),
      snapshotTimestamp: 3000,
    })
  })

  it('does NOT promote when the lastFrame is already at least as new as the newest snapshot', () => {
    expect(
      decideLastFramePromotion([
        media('snapshot', 1000, 'snap-a'),
        media('snapshot', 2000, 'snap-b'),
        media('lastFrame', 2000, 'lf'),
      ]),
    ).toEqual({ promote: false, declinedBecause: 'already-last' })
    expect(
      decideLastFramePromotion([media('snapshot', 1000, 'snap-a'), media('lastFrame', 5000, 'lf')]),
    ).toEqual({ promote: false, declinedBecause: 'already-last' })
  })

  it('does NOT promote when there are no snapshots (keeps current behaviour)', () => {
    expect(decideLastFramePromotion([media('lastFrame', 2000, 'lf')])).toEqual({
      promote: false,
      declinedBecause: 'no-source',
    })
    expect(decideLastFramePromotion([media('thumbnail', 2000, 'th')])).toEqual({
      promote: false,
      declinedBecause: 'no-key-frame',
    })
    expect(decideLastFramePromotion([])).toEqual({
      promote: false,
      declinedBecause: 'no-key-frame',
    })
  })

  // Short-track fallback (2026-07-23): 4-5s tracks die within one snapshot
  // interval — no snapshot ever appends and the rolling lastFrame never fires,
  // so they always closed lastFrame-less (live evidence dev102). Copy the
  // keyFrameSmall full frame into the empty slot, keeping the source row.
  describe('keyFrameSmall copy fallback (no snapshot, no lastFrame)', () => {
    it('copies the newest keyFrameSmall when the track has neither snapshot nor lastFrame', () => {
      const decision = decideLastFramePromotion([
        media('keyFrame', 1500, 'kf'),
        media('keyFrameSmall', 1500, 'kfs-a'),
        media('keyFrameSmall', 2500, 'kfs-b'),
        media('thumbnail', 1500, 'th'),
      ])
      expect(decision).toEqual({
        promote: true,
        mode: 'copy',
        snapshotMediaId: mediaIdFor('kfs-b'),
        snapshotTimestamp: 2500,
      })
    })

    it('does NOT fall back when a lastFrame already exists', () => {
      expect(
        decideLastFramePromotion([
          media('keyFrameSmall', 1500, 'kfs'),
          media('lastFrame', 1000, 'lf'),
        ]),
      ).toEqual({ promote: false, declinedBecause: 'no-source' })
    })

    it('does NOT fall back when a snapshot exists (the move path owns that case)', () => {
      const decision = decideLastFramePromotion([
        media('keyFrameSmall', 9000, 'kfs'),
        media('snapshot', 1000, 'snap'),
      ])
      expect(decision).toMatchObject({
        promote: true,
        mode: 'move',
        snapshotMediaId: mediaIdFor('snap'),
      })
    })

    it('does nothing when the short track also lacks a keyFrameSmall', () => {
      expect(decideLastFramePromotion([media('thumbnail', 2000, 'th')])).toEqual({
        promote: false,
        declinedBecause: 'no-key-frame',
      })
    })
  })

  /**
   * D400 — the cascade behind the operator's two 102 notes, "niente primo e
   * ultimo" (`59bbae2b`) and "niente ultimo" (`a99af2f3`). Both are ONE
   * failure: no keyFrame ⇒ no keyFrameSmall ⇒ no `copy` source ⇒ no lastFrame.
   * The decision used to return a bare `{promote:false}` for that case AND for
   * the healthy already-last case, so the close could not tell them apart and
   * logged neither.
   */
  describe('the decline says WHY (D400)', () => {
    it('names no-key-frame on the 59bbae2b shape: no snapshot, no lastFrame, no keyFrameSmall', () => {
      // The audit's row: a raster-tile thumbnail, nothing else that a lastFrame
      // could be cut or copied from.
      expect(decideLastFramePromotion([media('thumbnail', 1_788_800_752_000, 'th')])).toEqual({
        promote: false,
        declinedBecause: 'no-key-frame',
      })
    })

    it('names no-key-frame on the a99af2f3 shape: a firstFrame exists but is not a copy source', () => {
      // It has firstFrame + thumbnail + a face crop, and still no lastFrame.
      // The birth frame is deliberately NOT promoted: showing it as "Ultimo"
      // would be a lie about time, so the decline is reported instead.
      const decision = decideLastFramePromotion([
        media('firstFrame', 1_788_800_750_466, 'ff'),
        media('thumbnail', 1_788_800_751_000, 'th'),
        media('faceCrop', 1_788_800_751_200, 'fc'),
      ])
      expect(decision).toEqual({ promote: false, declinedBecause: 'no-key-frame' })
    })

    it('distinguishes the HEALTHY already-last case, which is not a miss at all', () => {
      expect(
        decideLastFramePromotion([media('snapshot', 1000, 'snap'), media('lastFrame', 2000, 'lf')]),
      ).toEqual({ promote: false, declinedBecause: 'already-last' })
    })
  })

  it('promotes the newest snapshot when there is NO lastFrame at all', () => {
    const decision = decideLastFramePromotion([
      media('snapshot', 1000, 'snap-a'),
      media('snapshot', 4000, 'snap-b'),
      media('thumbnail', 9000, 'th'),
    ])
    expect(decision).toEqual({
      promote: true,
      mode: 'move',
      snapshotMediaId: mediaIdFor('snap-b'),
      snapshotTimestamp: 4000,
    })
  })

  it('selects the newest snapshot by timestamp regardless of list order', () => {
    const decision = decideLastFramePromotion([
      media('snapshot', 3000, 'snap-c'),
      media('snapshot', 1000, 'snap-a'),
      media('snapshot', 2000, 'snap-b'),
    ])
    expect(decision).toMatchObject({ promote: true, snapshotMediaId: mediaIdFor('snap-c') })
  })
})
