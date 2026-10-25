import { describe, expect, it } from 'vitest'
import { isDerivedBrokerId, pickWarmSnapshotBroker } from '../snapshot-grab-pick.js'

const PREFIX = '618/'

describe('isDerivedBrokerId', () => {
  it('recognises a derived restream id', () => {
    expect(isDerivedBrokerId('618/derived:Mid to low', PREFIX)).toBe(true)
    expect(isDerivedBrokerId('618/native:main', PREFIX)).toBe(false)
    expect(isDerivedBrokerId('618/native:sub', PREFIX)).toBe(false)
  })
})

describe('pickWarmSnapshotBroker', () => {
  it('skips a streaming derived so a 0-packet transcode cannot stall the grab', () => {
    const ranked = [
      { brokerId: '618/native:main', status: 'idle' },
      { brokerId: '618/native:slot-3', status: 'idle' },
      { brokerId: '618/native:sub', status: 'idle' },
      { brokerId: '618/derived:Mid to low', status: 'streaming' },
    ]
    expect(pickWarmSnapshotBroker(ranked, PREFIX)).toBeUndefined()
  })

  it('still prefers a native that is actually streaming', () => {
    const ranked = [
      { brokerId: '618/native:main', status: 'streaming' },
      { brokerId: '618/derived:Mid to low', status: 'streaming' },
    ]
    expect(pickWarmSnapshotBroker(ranked, PREFIX)?.brokerId).toBe('618/native:main')
  })
})
