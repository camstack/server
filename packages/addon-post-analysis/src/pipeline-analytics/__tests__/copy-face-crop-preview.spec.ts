/**
 * Unit tests for `copyFaceCropIfTrackHasNoThumbnail`.
 *
 * Live 2026-08-24: person tracks (0e343f86, 9310d1ff) closed with a face crop
 * and ZERO track media. Events `?kind=thumbnailSmall` then 404'd / fell through
 * to a full frame. The face crop is already a subject tile — copy it onto the
 * track when the track has no thumbnail of its own.
 */
import { describe, expect, it, vi } from 'vitest'
import { copyFaceCropIfTrackHasNoThumbnail } from '../copy-face-crop-preview.js'

function makeDeps(kinds: readonly string[]) {
  const putTrackThumbnail = vi.fn(async () => 42)
  return {
    deps: {
      listTrackMedia: async () => kinds.map((kind) => ({ kind })),
      putTrackThumbnail,
    },
    putTrackThumbnail,
  }
}

const CROP = Buffer.from('face-crop')

describe('copyFaceCropIfTrackHasNoThumbnail', () => {
  it('copies the face crop onto a track that has no subject thumbnail (0e343f86)', async () => {
    const { deps, putTrackThumbnail } = makeDeps(['keyFrame'])
    const copied = await copyFaceCropIfTrackHasNoThumbnail(deps, {
      deviceId: 103,
      trackId: '0e343f86',
      crop: CROP,
      timestamp: 12_000,
    })
    expect(copied).toBe(true)
    expect(putTrackThumbnail).toHaveBeenCalledWith({
      deviceId: 103,
      trackId: '0e343f86',
      timestamp: 12_000,
      data: CROP,
      // D276: the copy is a DETAIL stand-in — `standin` is what lets the
      // close-time derive and the late keyFrame upgrade replace it while a
      // genuinely-ranked `native` tile stays untouchable.
      provenance: 'standin',
    })
  })

  it('does not overwrite a track that already has a thumbnail', async () => {
    const { deps, putTrackThumbnail } = makeDeps(['thumbnail', 'keyFrame'])
    const copied = await copyFaceCropIfTrackHasNoThumbnail(deps, {
      deviceId: 1,
      trackId: 't-1',
      crop: CROP,
      timestamp: 1,
    })
    expect(copied).toBe(false)
    expect(putTrackThumbnail).not.toHaveBeenCalled()
  })

  it('does not overwrite a track that already has thumbnailSmall', async () => {
    const { deps, putTrackThumbnail } = makeDeps(['thumbnailSmall'])
    const copied = await copyFaceCropIfTrackHasNoThumbnail(deps, {
      deviceId: 1,
      trackId: 't-1',
      crop: CROP,
      timestamp: 1,
    })
    expect(copied).toBe(false)
    expect(putTrackThumbnail).not.toHaveBeenCalled()
  })
})
