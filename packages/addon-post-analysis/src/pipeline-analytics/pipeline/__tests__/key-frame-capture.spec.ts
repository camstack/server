import { describe, it, expect } from 'vitest'
import sharp from 'sharp'
import type { DecodedFrame } from '@camstack/types'
import {
  KEYFRAME_NATIVE_MAX_WIDTH,
  KEYFRAME_SMALL_MAX_WIDTH,
  selectKeyFrameCaptures,
  deriveKeyFrameSmall,
} from '../key-frame-capture.js'

/** A deterministic non-uniform RGB frame of the given dims (real JPEG content). */
function rgbFrame(width: number, height: number): DecodedFrame {
  const data = Buffer.allocUnsafe(width * height * 3)
  for (let i = 0; i < data.length; i++) data[i] = (i * 31) & 0xff
  return { data, width, height, format: 'rgb', timestamp: 0 }
}

/** A parked parcel stand-in: the frame encoded to JPEG at its own size. */
async function parcelJpeg(width: number, height: number): Promise<Buffer> {
  const frame = rgbFrame(width, height)
  return sharp(frame.data, { raw: { width, height, channels: 3 } })
    .jpeg()
    .toBuffer()
}

describe('selectKeyFrameCaptures', () => {
  it('selects the tracks whose GENUINE new-best fired this frame', () => {
    expect(
      selectKeyFrameCaptures([
        { trackId: 'a', keyFrame: 'new-best' },
        { trackId: 'b', keyFrame: 'skip' },
        { trackId: 'c', keyFrame: 'new-best' },
      ]),
    ).toEqual([
      { trackId: 'a', retry: false },
      { trackId: 'c', retry: false },
    ])
  })

  it('returns empty when no track is due a key frame', () => {
    expect(
      selectKeyFrameCaptures([
        { trackId: 'a', keyFrame: 'skip' },
        { trackId: 'b', keyFrame: 'skip' },
      ]),
    ).toEqual([])
  })

  // 2026-08-06: the keyFrame ALSO fires on the bounded catch-up retry now (a
  // peak-only gate left 71.6% of miss-logged tracks with no key frame ever).
  // The two paths must stay distinguishable — the retry runs at a lower
  // scheduler priority and is charged against a budget.
  it('carries the RETRY path through as its own selection', () => {
    expect(selectKeyFrameCaptures([{ trackId: 'catch-up', keyFrame: 'retry' }])).toEqual([
      { trackId: 'catch-up', retry: true },
    ])
  })

  it('selects a best-frame track regardless of any embedding presence', () => {
    expect(selectKeyFrameCaptures([{ trackId: 'person-1', keyFrame: 'new-best' }])).toEqual([
      { trackId: 'person-1', retry: false },
    ])
  })
})

describe('KEYFRAME_NATIVE_MAX_WIDTH', () => {
  it('defaults to 4096 — a 4K surface parks at TRUE native (3840 ≤ 4096, no downscale)', () => {
    expect(KEYFRAME_NATIVE_MAX_WIDTH).toBe(4096)
  })
})

describe('deriveKeyFrameSmall — the companion from the PARKED parcel (D422)', () => {
  it('downscales the parcel to the 960 long side, aspect preserved', async () => {
    const small = await deriveKeyFrameSmall(await parcelJpeg(1600, 900))
    const meta = await sharp(small).metadata()
    expect(meta.width).toBe(KEYFRAME_SMALL_MAX_WIDTH)
    expect(meta.height).toBe(540)
  })

  it('never UPSCALES a sub-960 parcel', async () => {
    const meta = await sharp(await deriveKeyFrameSmall(await parcelJpeg(640, 360))).metadata()
    expect(meta.width).toBe(640)
  })
})
