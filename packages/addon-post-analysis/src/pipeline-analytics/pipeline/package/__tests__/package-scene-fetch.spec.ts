import { describe, expect, it } from 'vitest'
import { IR_CHROMA_THRESHOLD } from '../../../scene/condition-resolver.js'
import { chromaSpreadFromRgb } from '../package-scene-fetch.js'

describe('chromaSpreadFromRgb', () => {
  it('is 0 for a grey (IR) crop', () => {
    expect(chromaSpreadFromRgb(new Uint8Array([90, 90, 90, 200, 200, 200]))).toBe(0)
  })

  it('is above the IR threshold for a colour crop', () => {
    expect(chromaSpreadFromRgb(new Uint8Array([200, 120, 60, 40, 90, 160]))).toBeGreaterThan(
      IR_CHROMA_THRESHOLD,
    )
  })
})
