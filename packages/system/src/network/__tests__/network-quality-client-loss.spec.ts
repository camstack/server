import { describe, it, expect } from 'vitest'
import { NetworkQualityTracker } from '../network-quality.js'

describe('NetworkQualityTracker client-reported packet loss', () => {
  it('stores the reported packetLossPercent and returns it via getDeviceStats', () => {
    const t = new NetworkQualityTracker()
    t.reportClientStats(12, {
      rttMs: 60,
      jitterMs: 9,
      estimatedBandwidthKbps: 5000,
      packetLossPercent: 10,
    })
    const stats = t.getDeviceStats(12)
    expect(stats).not.toBeNull()
    expect(stats?.client?.packetLossPercent).toBe(10)
  })

  it('returns no client block for a device with no client report', () => {
    const stats = new NetworkQualityTracker().getDeviceStats(999)
    expect(stats).toBeNull()
  })
})
