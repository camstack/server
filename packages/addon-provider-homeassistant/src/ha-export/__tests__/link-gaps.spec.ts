import { describe, expect, it } from 'vitest'
import { summariseLinkGaps } from '../link-gaps.js'

describe('summariseLinkGaps', () => {
  it('reports a suspended link as a gap with its recheck time, never excluded', () => {
    const s = summariseLinkGaps([
      { brokerId: 'a', healthy: true, suspended: false, recheckAt: 0 },
      { brokerId: 'b', healthy: false, suspended: true, recheckAt: 1234 },
      { brokerId: 'c', healthy: false, suspended: false, recheckAt: 0 },
    ])
    expect(s.suspended).toEqual([{ brokerId: 'b', recheckAt: 1234 }])
    expect(s.failing).toEqual(['c'])
    expect(s.anyLive).toBe(true)
  })

  it('has no live link when every one is parked', () => {
    const s = summariseLinkGaps([{ brokerId: 'b', healthy: false, suspended: true, recheckAt: 1 }])
    expect(s.anyLive).toBe(false)
    expect(s.suspended).toHaveLength(1)
  })
})
