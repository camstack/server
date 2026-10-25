/**
 * The `crops` layout cuts with THE runtime derivation. A 100×100 frame with a
 * 40×40 subject at (30,30) and padding 0.15 is the 52×52 window at (24,24) —
 * the window `deriveDetailCropRect` gives the runtime for the same box.
 */
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import { DEFAULT_DETAIL_CROP_CONVENTION } from '@camstack/types'
import { cutRetrainCrop, retrainCropWindow } from '../retrain-crop-cut.js'

const BOX = { x: 0.3, y: 0.3, w: 0.4, h: 0.4 }

describe('retrain crop cut', () => {
  it('is the runtime detail-crop window', () => {
    expect(
      retrainCropWindow({
        frameWidth: 100,
        frameHeight: 100,
        bbox: BOX,
        convention: DEFAULT_DETAIL_CROP_CONVENTION,
      }),
    ).toEqual({ left: 24, top: 24, width: 52, height: 52 })
  })

  it('cuts and bounds the longest side', async () => {
    const frame = await sharp({
      create: { width: 1000, height: 500, channels: 3, background: { r: 200, g: 10, b: 10 } },
    })
      .jpeg()
      .toBuffer()
    const crop = await cutRetrainCrop({
      frameBytes: frame,
      frameWidth: 1000,
      frameHeight: 500,
      bbox: { x: 0.1, y: 0.1, w: 0.8, h: 0.5 },
      convention: DEFAULT_DETAIL_CROP_CONVENTION,
      maxSide: 256,
    })
    if (crop === null) throw new Error('no crop')
    const meta = await sharp(crop).metadata()
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBe(256)
  })

  it('a box with no area inside the frame has no crop', () => {
    expect(
      retrainCropWindow({
        frameWidth: 100,
        frameHeight: 100,
        bbox: { x: 1.2, y: 1.2, w: 0.1, h: 0.1 },
        convention: DEFAULT_DETAIL_CROP_CONVENTION,
      }),
    ).toBeNull()
  })
})
