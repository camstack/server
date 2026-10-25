import { z } from 'zod'
import { method, type CapabilityDefinition, type InferProvider } from './capability-definition.js'

/**
 * network-quality — system-scoped singleton capability tracking RTT,
 * jitter, and observed/peak bandwidth per device + per client.
 *
 * Implementation lives in the server's `NetworkQualityService` (thin
 * wrapper over the shared `NetworkQualityTracker` from `@camstack/system`).
 * The provider is registered from `trpc.router.ts` against the existing
 * service instance — no addon owns this state.
 *
 * Phase E of the API consolidation: previously a hand-written core
 * router. Cap conversion lets the same codegen pipeline produce both
 * the tRPC router and the canonical UI hooks
 * (`useNetworkQualityGetDeviceStats`, …).
 */

const StreamNetworkStatsSchema = z.object({
  nominalBitrateKbps: z.number(),
  observedBitrateKbps: z.number(),
  peakBitrateKbps: z.number(),
  packetLossPercent: z.number(),
  lastUpdated: z.number(),
})

const ClientNetworkStatsSchema = z.object({
  rttMs: z.number(),
  jitterMs: z.number(),
  estimatedBandwidthKbps: z.number(),
  packetLossPercent: z.number().min(0).max(100),
  /** The viewer's latest `/adaptive-probe` reading, Mbps — whatever it read
   *  (D635 I4). Absent when it never probed or the probe failed (unknown). */
  downlinkMbps: z.number().optional(),
  /** Age of that reading when this report was sent, ms. */
  downlinkAgeMs: z.number().optional(),
  lastUpdated: z.number(),
})

const DeviceNetworkStatsSchema = z.object({
  deviceId: z.number(),
  streams: z.record(z.string(), StreamNetworkStatsSchema),
  client: ClientNetworkStatsSchema.optional(),
})

export const networkQualityCapability = {
  name: 'network-quality',
  scope: 'system',
  mode: 'singleton',
  methods: {
    getDeviceStats: method(z.object({ deviceId: z.number() }), DeviceNetworkStatsSchema.nullable()),
    getAllStats: method(z.void(), z.array(DeviceNetworkStatsSchema).readonly()),
    reportClientStats: method(
      z.object({
        deviceId: z.number(),
        rttMs: z.number().min(0).max(60000),
        jitterMs: z.number().min(0).max(10000),
        estimatedBandwidthKbps: z.number().min(0).max(1000000),
        packetLossPercent: z.number().min(0).max(100),
        /** Latest downlink probe, Mbps, whatever it read; absent = never / failed. */
        downlinkMbps: z.number().min(0).max(100000).optional(),
        /** Age of that probe when this report is sent, ms. */
        downlinkAgeMs: z.number().min(0).max(86_400_000).optional(),
      }),
      z.void(),
      { role: 'viewer', kind: 'mutation' },
    ),
  },
  /** BIG PLAN 2: declarative mount hint — read by `@camstack/system` `buildCapRouters`. */
  mount: { kind: 'server-provided' },
} as const satisfies CapabilityDefinition

export type INetworkQualityProvider = InferProvider<typeof networkQualityCapability>

export { StreamNetworkStatsSchema, ClientNetworkStatsSchema, DeviceNetworkStatsSchema }
