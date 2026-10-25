import { describe, it, expect, beforeEach } from 'vitest'
import { NetworkQualityService } from './network-quality.service'

describe('NetworkQualityService', () => {
  let service: NetworkQualityService

  beforeEach(() => {
    service = new NetworkQualityService()
  })

  it('should return null for unknown device', () => {
    expect(service.getDeviceStats(999)).toBeNull()
  })

  it('should track stream bitrate with rolling average', () => {
    service.reportStreamStats(1, 'main', 8000)
    service.reportStreamStats(1, 'main', 10000)
    service.reportStreamStats(1, 'main', 9000)

    const stats = service.getDeviceStats(1)
    expect(stats).not.toBeNull()
    expect(stats!.streams['main']!.observedBitrateKbps).toBe(9000)
    expect(stats!.streams['main']!.peakBitrateKbps).toBe(10000)
  })

  it('should track packet loss', () => {
    service.reportStreamStats(1, 'main', 8000, 0.5)
    service.reportStreamStats(1, 'main', 8000, 1.5)

    const stats = service.getDeviceStats(1)
    expect(stats!.streams['main']!.packetLossPercent).toBe(1.0)
  })

  it('should track client stats', () => {
    service.reportClientStats(1, {
      rttMs: 50,
      jitterMs: 5,
      estimatedBandwidthKbps: 20000,
      packetLossPercent: 3,
    })
    const stats = service.getDeviceStats(1)
    expect(stats!.client?.rttMs).toBe(50)
    expect(stats!.client?.estimatedBandwidthKbps).toBe(20000)
    expect(stats!.client?.packetLossPercent).toBe(3)
  })

  it('carries the viewer probe (whatever it read, and its age) to the broker — D635 I4', () => {
    service.reportClientStats(1, {
      rttMs: 5,
      jitterMs: 1,
      estimatedBandwidthKbps: 41,
      packetLossPercent: 0,
      downlinkMbps: 1.2,
      downlinkAgeMs: 4_000,
    })
    const client = service.getDeviceStats(1)?.client
    expect(client?.downlinkMbps).toBe(1.2)
    expect(client?.downlinkAgeMs).toBe(4_000)
  })

  it('should list all device stats', () => {
    service.reportStreamStats(1, 'main', 8000)
    service.reportStreamStats(2, 'sub', 2000)
    const all = service.getAllStats()
    expect(all).toHaveLength(2)
  })
})
