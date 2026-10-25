/**
 * Wire shapes of the Load balancing surface (D748): the session placement
 * policy, the atomic share write, the observed placement statistics, the
 * hardware share suggestion and the stale device pins.
 */
import { z } from 'zod'

/**
 * How a new detection session picks its node and device.
 *  - `least-loaded` — the historical rule: lowest `attached / weight`, a
 *    constant node order at a tie (D37). An idle node always ties at 0, so a
 *    weight only bites once a node already holds a session.
 *  - `share` — the share of PARALLEL sessions is held to the weights, and a
 *    full or drowning node yields to a free one (D748).
 */
export const SessionPlacementPolicySchema = z.enum(['least-loaded', 'share'])
export type SessionPlacementPolicy = z.infer<typeof SessionPlacementPolicySchema>
/**
 * `share` since D750: the percentages are held by default. `least-loaded` stays
 * selectable.
 */
export const DEFAULT_SESSION_PLACEMENT_POLICY: SessionPlacementPolicy = 'share'

/** The global-settings key the policy is stored under (orchestrator `load` section). */
export const SESSION_PLACEMENT_SETTING_KEY = 'sessionPlacement'

/** Parse a stored value; anything unknown is the default. */
export function parseSessionPlacementPolicy(value: unknown): SessionPlacementPolicy {
  const parsed = SessionPlacementPolicySchema.safeParse(value)
  return parsed.success ? parsed.data : DEFAULT_SESSION_PLACEMENT_POLICY
}

export const LoadBalancingSharesInputSchema = z.object({
  /** nodeId → share (> 0). A node left out keeps its weight. */
  nodes: z.record(z.string(), z.number().positive()).default({}),
  /** nodeId → deviceKey → share (> 0). A device left out keeps its weight. */
  devices: z.record(z.string(), z.record(z.string(), z.number().positive())).default({}),
})
export type LoadBalancingSharesInput = z.infer<typeof LoadBalancingSharesInputSchema>

export const PlacementStatsInputSchema = z.object({
  /** Window the observed shares are averaged over (default 1 h, max 24 h). */
  windowMs: z
    .number()
    .int()
    .min(60_000)
    .max(24 * 60 * 60 * 1000)
    .default(60 * 60 * 1000),
})
export type PlacementStatsInput = z.infer<typeof PlacementStatsInputSchema>

export const PlacementDeviceStatsSchema = z.object({
  deviceKey: z.string(),
  /** Sessions running on this device now. */
  sessionsNow: z.number(),
  /** Sessions started on this device inside the window. */
  sessionsStarted: z.number(),
  /** Time-weighted share of the node's parallel sessions over the window (0–1); null = no session ran. */
  observedShare: z.number().nullable(),
})
export type PlacementDeviceStats = z.infer<typeof PlacementDeviceStatsSchema>

export const PlacementNodeStatsSchema = z.object({
  nodeId: z.string(),
  sessionsNow: z.number(),
  sessionsStarted: z.number(),
  /** Time-weighted share of the cluster's parallel sessions over the window (0–1); null = none ran. */
  observedShare: z.number().nullable(),
  /** Most sessions this node ran at once inside the window. */
  peakSessions: z.number(),
  /** Sessions a share election handed elsewhere because this node was full or drowning. */
  yieldsAway: z.number(),
  devices: z.array(PlacementDeviceStatsSchema).readonly(),
})
export type PlacementNodeStats = z.infer<typeof PlacementNodeStatsSchema>

/** A camera's device pin that the session path cannot honour. */
export const StaleDevicePinSchema = z.object({
  deviceId: z.number(),
  deviceKey: z.string(),
  /** `disabled` — the key exists on some node but is not enabled anywhere; `absent` — no node has it. */
  reason: z.enum(['disabled', 'absent']),
})
export type StaleDevicePin = z.infer<typeof StaleDevicePinSchema>

export const PlacementStatsSchema = z.object({
  policy: SessionPlacementPolicySchema,
  windowMs: z.number(),
  /** How much of the window was actually observed (the hub keeps it in memory). */
  observedForMs: z.number(),
  sessionsNow: z.number(),
  /** Most parallel sessions across the cluster inside the window. */
  clusterPeakSessions: z.number(),
  nodes: z.array(PlacementNodeStatsSchema).readonly(),
  stalePins: z.array(StaleDevicePinSchema).readonly(),
})
export type PlacementStats = z.infer<typeof PlacementStatsSchema>

/**
 * Where an automatic share's capacity comes from (D755).
 *  - `hardware` — the static capacity of each device at its Auto tune model:
 *    the measured latency table for the node's hardware class.
 *  - `benchmark` — the node's own measured capacity (node benchmark results).
 *    A node with no results falls back to `hardware`, and says so.
 */
export const CapacitySourceSchema = z.enum(['hardware', 'benchmark'])
export type CapacitySource = z.infer<typeof CapacitySourceSchema>

/** Why a node under the `benchmark` source was sized from hardware instead. */
export const CapacityFallbackSchema = z.enum([
  /** No benchmark result exists for the node. */
  'no-benchmark-results',
  /** Some of its enabled devices have no result: the whole node uses hardware. */
  'partial-benchmark-results',
])
export type CapacityFallback = z.infer<typeof CapacityFallbackSchema>

export const SuggestSharesInputSchema = z.object({
  headroom: z.number().min(0.3).max(0.5).default(0.4),
  /** Default `hardware`. */
  source: CapacitySourceSchema.default('hardware'),
})
export type SuggestSharesInput = z.infer<typeof SuggestSharesInputSchema>

export const SuggestedDeviceShareSchema = z.object({
  deviceKey: z.string(),
  /** Share of the node (0–100, rounded). */
  share: z.number(),
  modelId: z.string().nullable(),
  /** Inferences per second at that model, from the measured table; null when sized by a benchmark. */
  fps: z.number().nullable(),
  /** False for a table cell derived from another chip; true for a measured cell or a benchmark. */
  measured: z.boolean(),
  /**
   * Advisory session cap: ⌊fps × (1 − headroom) / camera fps⌋ from the table,
   * or the benchmark's measured max sessions. Never enforced.
   */
  suggestedMaxSessions: z.number().nullable(),
})
export type SuggestedDeviceShare = z.infer<typeof SuggestedDeviceShareSchema>

export const SuggestedNodeShareSchema = z.object({
  nodeId: z.string(),
  /** Share of the cluster (0–100, rounded); null = node skipped (offline, unknown hardware). */
  share: z.number().nullable(),
  /** Parallel sessions the node sustains at the suggested models with the headroom kept free. */
  capacitySessions: z.number(),
  devices: z.array(SuggestedDeviceShareSchema).readonly(),
  skippedReason: z.string().nullable(),
  /** What this node's capacity was read from; null when the node is skipped. */
  capacitySource: CapacitySourceSchema.nullable(),
  /** Set when the `benchmark` source was asked for and this node used `hardware`. */
  capacityFallback: CapacityFallbackSchema.nullable(),
})
export type SuggestedNodeShare = z.infer<typeof SuggestedNodeShareSchema>

export const SuggestSharesResultSchema = z.object({
  headroom: z.number(),
  /** The source asked for; each node says what it actually used. */
  source: CapacitySourceSchema,
  /** Camera detection rate the capacity is counted in (the fastest camera's fps). */
  cameraFps: z.number(),
  /** The Auto tune capacity floor the models were picked at. */
  minSessionsPerDevice: z.number(),
  nodes: z.array(SuggestedNodeShareSchema).readonly(),
})
export type SuggestSharesResult = z.infer<typeof SuggestSharesResultSchema>

/**
 * Where the node and device shares come from (D750, D755, D791).
 *  - `benchmark` (default since D791) — each node's capacity as its own node
 *    benchmark measured it; a node without fresh results is sized from
 *    `hardware` and says so. Measured on the node beats the table.
 *  - `hardware` — computed from each node's static capacity only (its
 *    accelerators at their Auto tune models, from the latency table).
 *  Both are recomputed whenever a node or device joins, leaves, is switched
 *  on or off, changes model, or a benchmark result is written. No load input.
 *  - `manual` — the operator's stored sliders.
 * Either way a node or device that cannot take sessions gives its share to
 * the others in proportion; the stored values are never rewritten for that.
 */
export const ShareSourceSchema = z.enum(['hardware', 'benchmark', 'manual'])
export type ShareSource = z.infer<typeof ShareSourceSchema>
export const DEFAULT_SHARE_SOURCE: ShareSource = 'benchmark'

/** `hardware` or `benchmark`: the system computes the shares. */
export function isAutomaticShareSource(
  source: ShareSource,
): source is Exclude<ShareSource, 'manual'> {
  return source !== 'manual'
}

/** Headroom the automatic shares are computed at (Auto tune's default). */
export const AUTO_SHARE_HEADROOM = 0.4

/** The global-settings key the share source is stored under (orchestrator `load` section). */
export const SHARE_SOURCE_SETTING_KEY = 'shareSource'

/**
 * Parse a stored value; anything unknown is the default. `auto` (D750, before
 * D755 split it) reads as `hardware` — that is what it computed.
 */
export function parseShareSource(value: unknown): ShareSource {
  if (value === 'auto') return 'hardware'
  const parsed = ShareSourceSchema.safeParse(value)
  return parsed.success ? parsed.data : DEFAULT_SHARE_SOURCE
}

export const SetShareSourceInputSchema = z.object({ source: ShareSourceSchema })
export type SetShareSourceInput = z.infer<typeof SetShareSourceInputSchema>

/** Raw relative weights (any scale) per node and per node's device. */
export const ShareWeightsSchema = z.object({
  nodes: z.record(z.string(), z.number()),
  devices: z.record(z.string(), z.record(z.string(), z.number())),
})
export type ShareWeights = z.infer<typeof ShareWeightsSchema>

export const EffectiveDeviceShareSchema = z.object({
  deviceKey: z.string(),
  /** Can take sessions now (enabled, available, can run the root). */
  eligible: z.boolean(),
  /** The share the source assigns, as a percentage of the node's devices. */
  configuredPct: z.number(),
  /** The share actually used, after an ineligible device's share went to the others. */
  effectivePct: z.number(),
})
export type EffectiveDeviceShare = z.infer<typeof EffectiveDeviceShareSchema>

export const EffectiveNodeShareSchema = z.object({
  nodeId: z.string(),
  eligible: z.boolean(),
  configuredPct: z.number(),
  effectivePct: z.number(),
  /** Automatic sources: what this node's share was computed from; null under `manual` or before the first answer. */
  capacitySource: CapacitySourceSchema.nullable(),
  /** Automatic `benchmark`: why this node used `hardware` instead. */
  capacityFallback: CapacityFallbackSchema.nullable(),
  devices: z.array(EffectiveDeviceShareSchema).readonly(),
})
export type EffectiveNodeShare = z.infer<typeof EffectiveNodeShareSchema>

export const EffectiveSharesSchema = z.object({
  source: ShareSourceSchema,
  policy: SessionPlacementPolicySchema,
  /** An automatic source with no computed answer yet: the stored sliders are used meanwhile. */
  autoPending: z.boolean(),
  /** When the automatic shares were last computed (ms epoch); null = never. */
  computedAt: z.number().nullable(),
  /** What made the system recompute them last. */
  trigger: z.string().nullable(),
  nodes: z.array(EffectiveNodeShareSchema).readonly(),
  /** The relative weights the election reads (before eligibility). */
  nodeWeights: z.record(z.string(), z.number()),
  deviceWeights: z.record(z.string(), z.record(z.string(), z.number())),
})
export type EffectiveShares = z.infer<typeof EffectiveSharesSchema>
