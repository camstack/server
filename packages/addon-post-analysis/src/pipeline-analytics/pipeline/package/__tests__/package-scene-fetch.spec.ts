import { describe, expect, it } from 'vitest'
import { IR_CHROMA_THRESHOLD } from '../../../scene/condition-resolver.js'
import { chromaSpreadFromRgb } from '../package-scene-fetch.js'

describe('chromaSpreadFromRgb', () => {
  it('is 0 for a grey (IR) crop', () => {
    expect(chromaSpreadFromRgb(new Uint8Array([90, 90, 90, 200, 200, 200]), 2, 1)).toBe(0)
  })

  it('is above the IR threshold for a colour crop', () => {
    expect(chromaSpreadFromRgb(new Uint8Array([200, 120, 60, 40, 90, 160]), 2, 1)).toBeGreaterThan(
      IR_CHROMA_THRESHOLD,
    )
  })

  it('averages on a 32x32 grid first: per-pixel speckle on a grey frame is not colour', () => {
    const w = 64
    const h = 64
    const rgb = new Uint8Array(w * h * 3)
    for (let i = 0; i < w * h; i++) {
      const warm = i % 2 === 0
      rgb.set(warm ? [140, 128, 116] : [116, 128, 140], i * 3)
    }
    expect(chromaSpreadFromRgb(rgb, w, h)).toBeLessThan(IR_CHROMA_THRESHOLD)
  })
})
