import { describe, it, expect } from 'vitest'
// Documents that MobileCLIP CLIP models use inputNormalization:'none' + preprocessMode:'resize'
// which means: resize to 256x256, divide by 255 — no mean/std subtraction.
// This is correct per MobileCLIP preprocessor_config (image_mean=null, image_std=null).
import { CLIP_EMBEDDING_MODELS } from '../registry/model-catalogs.js'

describe('CLIP model preprocessing — no mean/std (MobileCLIP)', () => {
  it('all CLIP models use preprocessMode:resize', () => {
    for (const m of CLIP_EMBEDDING_MODELS) {
      expect(m.preprocessMode).toBe('resize')
    }
  })

  it('all CLIP models have inputNormalization:none or undefined (no imagenet normalization)', () => {
    for (const m of CLIP_EMBEDDING_MODELS) {
      // 'none' or undefined both mean: rescale /255 only, no mean/std subtraction
      expect(m.inputNormalization === 'none' || m.inputNormalization === undefined).toBe(true)
    }
  })
})
