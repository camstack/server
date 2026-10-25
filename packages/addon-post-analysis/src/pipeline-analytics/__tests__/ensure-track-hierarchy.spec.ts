/**
 * When a face (or plate) crop lands from a live handle, the track must also
 * get a body crop and a full frame from that same handle — not a tight face
 * JPEG standing in as the person, and not a class icon.
 */
import { describe, expect, it, vi } from 'vitest'
import { ensureTrackHierarchyMedia } from '../ensure-track-hierarchy.js'
import { makeTestFrameHandle } from './support/frame-handle.js'

const HANDLE = makeTestFrameHandle({ shmId: '1', nodeId: 'n' })

const REQUEST = {
  deviceId: 103,
  trackId: '0e343f86',
  timestamp: 12_000,
  bodyBbox: { x: 10, y: 20, w: 40, h: 80 },
  frameWidth: 1920,
  frameHeight: 1080,
  cropPadding: 0.1,
  frameHandle: HANDLE,
}

describe('ensureTrackHierarchyMedia', () => {
  it('captures the body thumbnail and the full frame when both are missing', async () => {
    const captureBodyThumbnail = vi.fn(async () => {})
    const captureKeyFrame = vi.fn(async () => {})
    await ensureTrackHierarchyMedia(
      {
        isThumbnailLanded: () => false,
        isKeyFrameLanded: () => false,
        captureBodyThumbnail,
        captureKeyFrame,
      },
      REQUEST,
    )
    expect(captureBodyThumbnail).toHaveBeenCalledWith(REQUEST)
    expect(captureKeyFrame).toHaveBeenCalledWith(REQUEST)
  })

  it('does not recapture media that has already landed', async () => {
    const captureBodyThumbnail = vi.fn(async () => {})
    const captureKeyFrame = vi.fn(async () => {})
    await ensureTrackHierarchyMedia(
      {
        isThumbnailLanded: () => true,
        isKeyFrameLanded: () => true,
        captureBodyThumbnail,
        captureKeyFrame,
      },
      REQUEST,
    )
    expect(captureBodyThumbnail).not.toHaveBeenCalled()
    expect(captureKeyFrame).not.toHaveBeenCalled()
  })

  it('fills only the missing rung of the hierarchy', async () => {
    const captureBodyThumbnail = vi.fn(async () => {})
    const captureKeyFrame = vi.fn(async () => {})
    await ensureTrackHierarchyMedia(
      {
        isThumbnailLanded: () => false,
        isKeyFrameLanded: () => true,
        captureBodyThumbnail,
        captureKeyFrame,
      },
      REQUEST,
    )
    expect(captureBodyThumbnail).toHaveBeenCalledTimes(1)
    expect(captureKeyFrame).not.toHaveBeenCalled()
  })
})
