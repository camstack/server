import type {
  StreamNetworkStats,
  ClientNetworkStats,
  DeviceNetworkStats,
  INetworkQualityTracker,
} from '@camstack/types'

export type { StreamNetworkStats, ClientNetworkStats, DeviceNetworkStats, INetworkQualityTracker }

interface MutableStreamStats {
  nominalBitrateKbps: number
  samples: number[]
  peakBitrateKbps: number
  packetLossSamples: number[]
  lastUpdated: number
}

export class NetworkQualityTracker implements INetworkQualityTracker {
  private readonly devices = new Map<
    number,
    {
      streams: Map<string, MutableStreamStats>
      client: (ClientNetworkStats & { lastUpdated: number }) | null
    }
  >()

  private static readonly MAX_SAMPLES = 30 // ~5 min at 10s reporting interval

  reportStreamStats(
    deviceId: number,
    streamId: string,
    bitrateKbps: number,
    packetLoss?: number,
  ): void {
    const device = this.getOrCreateDevice(deviceId)
    let stream = device.streams.get(streamId)
    if (!stream) {
      stream = {
        nominalBitrateKbps: bitrateKbps,
        samples: [],
        peakBitrateKbps: 0,
        packetLossSamples: [],
        lastUpdated: 0,
      }
      device.streams.set(streamId, stream)
    }

    stream.samples.push(bitrateKbps)
    if (stream.samples.length > NetworkQualityTracker.MAX_SAMPLES) stream.samples.shift()

    stream.peakBitrateKbps = Math.max(stream.peakBitrateKbps, bitrateKbps)

    if (packetLoss !== undefined) {
      stream.packetLossSamples.push(packetLoss)
      if (stream.packetLossSamples.length > NetworkQualityTracker.MAX_SAMPLES)
        stream.packetLossSamples.shift()
    }

    stream.lastUpdated = Date.now()
  }

  reportClientStats(deviceId: number, stats: Omit<ClientNetworkStats, 'lastUpdated'>): void {
    const device = this.getOrCreateDevice(deviceId)
    device.client = { ...stats, lastUpdated: Date.now() }
  }

  getDeviceStats(deviceId: number): DeviceNetworkStats | null {
    const device = this.devices.get(deviceId)
    if (!device) return null

    const streams: Record<string, StreamNetworkStats> = {}
    for (const [streamId, s] of device.streams) {
      const avg = (arr: number[]) =>
        arr.length === 0 ? 0 : arr.reduce((a, b) => a + b, 0) / arr.length
      streams[streamId] = {
        nominalBitrateKbps: s.nominalBitrateKbps,
        observedBitrateKbps: Math.round(avg(s.samples)),
        peakBitrateKbps: s.peakBitrateKbps,
        packetLossPercent: Math.round(avg(s.packetLossSamples) * 10) / 10,
        lastUpdated: s.lastUpdated,
      }
    }

    return { deviceId, streams, client: device.client ?? undefined }
  }

  getAllStats(): readonly DeviceNetworkStats[] {
    const results: DeviceNetworkStats[] = []
    for (const deviceId of this.devices.keys()) {
      const stats = this.getDeviceStats(deviceId)
      if (stats) results.push(stats)
    }
    return results
  }

  private getOrCreateDevice(deviceId: number) {
    let device = this.devices.get(deviceId)
    if (!device) {
      device = { streams: new Map(), client: null }
      this.devices.set(deviceId, device)
    }
    return device
  }
}
