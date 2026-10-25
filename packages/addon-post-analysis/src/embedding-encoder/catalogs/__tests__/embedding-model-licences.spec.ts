/** Every CLIP image and text encoder declares its licence (D661). */
import { describe, expect, it } from 'vitest'
import { CLIP_IMAGE_MODELS, CLIP_TEXT_MODELS } from '../embedding-models.js'

describe('CLIP catalogs declare their licence', () => {
  it.each(
    [...CLIP_IMAGE_MODELS, ...CLIP_TEXT_MODELS].map((e) => [e.id, e] as const),
  )('%s', (_id, e) => {
    expect(e.license?.weights).toBeTruthy()
    expect(e.license?.upstream?.url).toMatch(/^https:\/\//)
    expect(e.license?.hosting).toBe('camstack-hf')
    expect(e.license?.modifications).toBeTruthy()
  })

  it('every CLIP encoder is commercially usable (SigLIP2, Apache-2.0)', () => {
    for (const e of [...CLIP_IMAGE_MODELS, ...CLIP_TEXT_MODELS]) {
      expect(e.license?.nonCommercial, e.id).not.toBe(true)
      expect(e.license?.weights, e.id).toBe('Apache-2.0')
    }
  })

  it('MobileCLIP is gone from the catalog', () => {
    const ids = [...CLIP_IMAGE_MODELS, ...CLIP_TEXT_MODELS].map((e) => e.id)
    expect(ids.some((id) => id.startsWith('mobileclip-'))).toBe(false)
  })
})
