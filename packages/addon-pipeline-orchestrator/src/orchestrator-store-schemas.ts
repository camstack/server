/**
 * `orchestrator-store-schemas.ts` — whole-blob Zod schemas for the
 * orchestrator's addon-store keys that persist an ENTIRE collection
 * under a single key (`nodeBindings`, `agentSettings`, `cameraSettings`).
 *
 * These back the durable-state primitive (`this.state(KEY, Schema, {})`)
 * so a hand-written serializer can never silently drop a field on save:
 * the whole validated value round-trips on every read and write.
 *
 * Each schema mirrors the SAME shape the orchestrator already persisted
 * (the `pipeline-orchestrator.cap.ts` storage contract). Every field that
 * is only conditionally written is `.optional()`, so an existing blob
 * that predates a newer field still loads — durable-state `get()` only
 * falls back to the empty map on a whole-blob parse failure, so the
 * schema is kept faithful to the on-disk shape rather than overly strict.
 */

import { z } from 'zod'
import { NodeColorIdSchema } from '@camstack/types/node-color'

// ── nodeBindings: Record<nodeId, Record<capName, addonId>> ──────────────
//
// Persisted by `setCapabilityBinding`, read by `getCapabilityBindings`.
// A two-level string→string map.
export const NodeBindingsSchema = z.record(z.string(), z.record(z.string(), z.string()))
export type NodeBindingsBlob = z.infer<typeof NodeBindingsSchema>

// ── autoBenchmarkAttempts: nodeId → deviceKey → attempts ────────────────
//
// The automatic benchmark's bounded-retry ledger (D913). Persisted so a
// restart does not hand a failing device a fresh budget and no spacing.
export const AutoBenchmarkAttemptsSchema = z.record(
  z.string(),
  z.record(z.string(), z.object({ count: z.number().int().min(0), lastAtMs: z.number() })),
)
export type AutoBenchmarkAttemptsBlob = z.infer<typeof AutoBenchmarkAttemptsSchema>

// ── agentSettings: Record<nodeId, AgentPipelineSettings> ────────────────
//
// Persisted by writeAgentSettings/removeAgentSettings, read by
// readAgentSettingsMap. Mirrors `AgentPipelineSettingsSchema`.
//
// Per-(node,device) config: the model/format layer lives ONLY under
// `inferenceDevices[deviceKey].steps`; node-wide content under `stepSettings`
// (D927). Retired keys of an old blob (`addonDefaults`, `inferenceDevices[k].
// models`) are not in the schema, so they are stripped on the next write.
// Per-(node,device) base provisioning for one step: model + intrinsic
// settings the executing node applies for every camera landing on that
// accelerator. Both fields optional (absent = format-default at runtime).
const StoredDeviceStepConfigSchema = z.object({
  modelId: z.string().optional(),
  settings: z.record(z.string(), z.unknown()).readonly().optional(),
  // Step-tree device jump (phase 1) — optional per-(node,device) BASE manual
  // override: run this step on another enabled same-node device. Persisted so a
  // saved override survives restarts.
  jumpDeviceKey: z.string().optional(),
})

const StoredAgentPipelineSettingsSchema = z.object({
  maxCameras: z.number().int().nonnegative().nullable().default(null),
  // Per-node detection WEIGHT (relative share). Unpinned cameras distribute
  // proportionally to weight across detect-capable nodes (placement-model-design
  // §4). Optional — absent = weight 1 (back-compat: identical to score-only balance).
  detectWeight: z.number().positive().optional(),
  // Placement capabilities (placement-model-design §6) — the per-node record
  // that replaced the four flat orchestrator lists. Each flag is optional; an
  // absent flag inherits the node default (`hub` → capable, others → not), so
  // an empty store keeps the classic hub-only cluster.
  detect: z.boolean().optional(),
  // DEPRECATED-AND-IGNORED: decode eligibility IS detect eligibility (decode
  // is always co-located with its frame consumer). Kept schema-optional so
  // stores written before the removal still validate; the derivation ignores
  // it and `setAgentCapabilities` strips it on the next capability write.
  decode: z.boolean().optional(),
  audio: z.boolean().optional(),
  ingest: z.boolean().optional(),
  decodeBudgetMb: z.number().int().min(1024).max(65536).optional(),
  maxLiveDecodeWorkers: z.number().int().min(1).max(32).optional(),
  // Operator override for the LAN host a cross-node decoder dials to reach
  // this node's restream (Cluster UI). Optional — absent = auto-detect (the
  // remote runner falls back to its CAMSTACK_HUB_URL-derived host).
  reachableHost: z.string().optional(),
  color: NodeColorIdSchema.optional(),
  // NODE-wide step settings (D927): stepId → { key → value }, under every
  // accelerator's own settings. Never a model or a model-bound threshold.
  stepSettings: z.record(z.string(), z.record(z.string(), z.unknown()).readonly()).optional(),
  // Multi-device inference opt-in (Phase 4). Per-node map deviceKey → {enabled,
  // weight, steps}. Absent / all-disabled ⇒ single default device (safe
  // default); two+ enabled ⇒ the dispatcher balances sessions across them
  // concurrently. `steps` (per-(node,device) base) is the model/settings
  // authority: `stepId → {modelId?, settings?}` — a stepId absent ⇒ the step
  // uses that device's format default at runtime.
  inferenceDevices: z
    .record(
      z.string(),
      z.object({
        enabled: z.boolean(),
        weight: z.number().positive().optional(),
        // Per-device concurrent-session cap (multi-device C4). Null/absent =
        // unlimited; a device at its cap is skipped by the device balancer.
        maxSessions: z.number().int().positive().optional(),
        // Per-(node,device) base provisioning: stepId → {modelId?, settings?}.
        steps: z.record(z.string(), StoredDeviceStepConfigSchema).optional(),
      }),
    )
    .optional(),
})

export const AgentSettingsMapSchema = z.record(z.string(), StoredAgentPipelineSettingsSchema)
export type AgentSettingsMapBlob = z.infer<typeof AgentSettingsMapSchema>

// ── cameraSettings: Record<deviceIdString, CameraPipelineSettings> ──────
//
// Persisted by writeCameraSettings (+ purge in handleDeviceUnregistered),
// read by readCameraSettingsMap. Mirrors `CameraPipelineSettingsSchema` —
// sparse by design, every overlay field optional. A camera carries no model
// (D927): the retired `stepOverridesByDevice` / `pipelineByAgent` keys of an
// old blob are not in the schema, so they are stripped on the next write and
// never read (the offline runbook in D927 removes them up front).

const StoredCameraPipelineSettingsSchema = z.object({
  // `pinnedAgentNodeId` was retired (D748): nothing wrote it; the live node pin
  // is the device store's `pipelineNodeId`. An old blob's value is stripped.
  stepToggles: z.record(z.string(), z.boolean()).optional(),
  // Camera-wide, field-level step settings (D754): [step] → { key → value }.
  stepSettings: z.record(z.string(), z.record(z.string(), z.unknown()).readonly()).optional(),
  /**
   * Legacy "nuke inference" flag. Superseded by the detection-pipeline
   * wrapper binding, but the one-shot boot migration
   * (`migrateLegacyFlagsToBindings`) still reads it off the persisted
   * blob to flip the binding off. Kept here so the durable round-trip
   * does NOT strip it before the migration runs.
   */
  disableInference: z.boolean().optional(),
})

export const CameraSettingsMapSchema = z.record(z.string(), StoredCameraPipelineSettingsSchema)
export type CameraSettingsMapBlob = z.infer<typeof CameraSettingsMapSchema>
