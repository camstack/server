/**
 * Adaptive live must not land on an unassigned derived just because it was
 * first in the broker map (618: all slots empty → `candidates[0]` was
 * `derived:Mid to low`, feeder had nothing to transcode).
 */
import { describe, expect, it } from 'vitest'
import { preferLiveAdaptiveCandidates } from '../prefer-live-adaptive-candidates.js'

describe('preferLiveAdaptiveCandidates', () => {
  it('keeps assigned-tier brokers when any slot is bound', () => {
    const out = preferLiveAdaptiveCandidates([
      { brokerId: '618/derived:Mid to low', tier: 'low' },
      { brokerId: '618/native:main', tier: 'high' },
      { brokerId: '618/native:sub', tier: null },
    ])
    expect(out.map((c) => c.brokerId)).toEqual(['618/derived:Mid to low', '618/native:main'])
  })

  it('drops unassigned derived brokers when natives exist and no slot is bound', () => {
    const out = preferLiveAdaptiveCandidates([
      { brokerId: '618/derived:Mid to low', tier: null },
      { brokerId: '618/native:main', tier: null },
      { brokerId: '618/native:sub', tier: null },
    ])
    expect(out.map((c) => c.brokerId)).toEqual(['618/native:main', '618/native:sub'])
  })

  it('keeps the derived when it is the only broker', () => {
    const out = preferLiveAdaptiveCandidates([{ brokerId: '618/derived:Mid to low', tier: null }])
    expect(out.map((c) => c.brokerId)).toEqual(['618/derived:Mid to low'])
  })
})
