/**
 * Deep wiring healthcheck — snapshot of active reachability probes across
 * every declared capability + widget of every installed plugin, on every
 * node. Produced by the backend `WiringHealthService` and surfaced via
 * `GET /health/wiring`, the tRPC `health.wiring` query, and the boot-gate.
 *
 * Unlike `/health` (process liveness), this reflects whether each cap/widget
 * is actually *reachable* over the real cap-dispatch path. See spec
 * `docs/superpowers/specs/2026-05-23-deep-healthcheck-design.md`.
 */
import { z } from 'zod'

/** What kind of target a probe addressed. */
export const wiringProbeKindSchema = z.enum(['singleton', 'device', 'widget'])
export type WiringProbeKind = z.infer<typeof wiringProbeKindSchema>

/** Result of probing a single (cap|widget [, device]) target. */
export const wiringProbeResultSchema = z.object({
  capName: z.string(),
  kind: wiringProbeKindSchema,
  deviceId: z.number().optional(),
  reachable: z.boolean(),
  latencyMs: z.number(),
  error: z.string().optional(),
})
export type WiringProbeResult = z.infer<typeof wiringProbeResultSchema>

/** Per-addon roll-up of cap + widget probe results. */
export const wiringAddonHealthSchema = z.object({
  addonId: z.string(),
  caps: z.array(wiringProbeResultSchema).readonly(),
  widgets: z.array(wiringProbeResultSchema).readonly(),
})
export type WiringAddonHealth = z.infer<typeof wiringAddonHealthSchema>

/** Per-node roll-up. */
export const wiringNodeHealthSchema = z.object({
  nodeId: z.string(),
  addons: z.array(wiringAddonHealthSchema).readonly(),
})
export type WiringNodeHealth = z.infer<typeof wiringNodeHealthSchema>

/** Full snapshot returned by every surface. */
export const wiringHealthSnapshotSchema = z.object({
  /** True only when every probed target is reachable. */
  ok: z.boolean(),
  /** True when at least one target is unreachable. */
  degraded: z.boolean(),
  checkedAt: z.string(),
  nodes: z.array(wiringNodeHealthSchema).readonly(),
  summary: z.object({
    total: z.number(),
    reachable: z.number(),
    unreachable: z.number(),
  }),
})
export type WiringHealthSnapshot = z.infer<typeof wiringHealthSnapshotSchema>
