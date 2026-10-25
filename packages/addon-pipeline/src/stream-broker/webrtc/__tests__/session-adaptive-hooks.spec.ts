import { describe, it, expect } from 'vitest'
import { AdaptiveSession } from '../session.js'

describe('AdaptiveSession adaptive hooks', () => {
  it('exposes a default repacketizer MTU and a smaller adaptive-low MTU', () => {
    expect(AdaptiveSession.H264_REPACKETIZER_MTU).toBeGreaterThan(0)
    expect(AdaptiveSession.ADAPTIVE_LOW_MTU).toBeLessThan(AdaptiveSession.H264_REPACKETIZER_MTU)
  })
})
