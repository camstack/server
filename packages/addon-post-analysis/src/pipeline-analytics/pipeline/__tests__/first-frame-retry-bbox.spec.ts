import { describe, expect, it } from 'vitest'
import { firstFrameRetryBbox } from '../first-frame-retry-bbox.js'

describe('firstFrameRetryBbox', () => {
  const birth = { x: 494.1, y: 130.1, w: 39, h: 49.2 }
  const frozen = { x: 492.8, y: 124.9, w: 25.7, h: 46.3 }

  it('retries the BIRTH box, not the later frozen one (1b659d56)', () => {
    expect(firstFrameRetryBbox(frozen, birth)).toEqual(birth)
  })

  it('falls back to the current box when birth is missing or empty', () => {
    expect(firstFrameRetryBbox(frozen, undefined)).toEqual(frozen)
    expect(firstFrameRetryBbox(frozen, { x: 0, y: 0, w: 0, h: 0 })).toEqual(frozen)
  })
})
