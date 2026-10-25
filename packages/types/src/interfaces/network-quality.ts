export interface StreamNetworkStats {
  readonly nominalBitrateKbps: number
  readonly observedBitrateKbps: number
  readonly peakBitrateKbps: number
  readonly packetLossPercent: number
  readonly lastUpdated: number
}

export interface ClientNetworkStats {
  readonly rttMs: number
  readonly jitterMs: number
  readonly estimatedBandwidthKbps: number
  /**
   * Client-reported packet-loss percentage (0–100). Real WebRTC clients
   * report it from `RTCInboundRtpStreamStats`, and the benchmark
   * "Network Simulation" presets report a simulated value so the adaptive
   * ladder can be exercised (via the broker's client-loss poll) without
   * inducing real RTCP loss.
   */
  readonly packetLossPercent: number
  /** Latest `/adaptive-probe` reading, Mbps, whatever it read (D635 I4); absent = unknown. */
  readonly downlinkMbps?: number
  /** Age of that reading when the report was sent, ms. */
  readonly downlinkAgeMs?: number
  readonly lastUpdated: number
}

export interface DeviceNetworkStats {
  readonly deviceId: number
  readonly streams: Readonly<Record<string, StreamNetworkStats>>
  readonly client?: ClientNetworkStats
}

export interface INetworkQualityTracker {
  reportStreamStats(
    deviceId: number,
    streamId: string,
    bitrateKbps: number,
    packetLoss?: number,
  ): void
  reportClientStats(deviceId: number, stats: Omit<ClientNetworkStats, 'lastUpdated'>): void
  getDeviceStats(deviceId: number): DeviceNetworkStats | null
  getAllStats(): readonly DeviceNetworkStats[]
}
