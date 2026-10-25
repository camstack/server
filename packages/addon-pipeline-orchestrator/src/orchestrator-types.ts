/**
 * Pure declaration module for the pipeline orchestrator — dispatch-result
 * types, the failover policy shape + default, the local-provider surface,
 * the diagnostics schema + custom-action catalog, and the orchestrator-wide
 * timing/tunable constants.
 *
 * Extracted verbatim from `index.ts` (S1 refactor slice — zero behavior
 * change). No logic lives here, only types, schemas, and constants.
 */
import type {
  CameraDetectionConfig,
  IPipelineOrchestratorProvider,
  PipelineAssignment,
  PipelinePhaseMode,
  RunnerCameraConfig,
} from '@camstack/types'
import { customAction, defineCustomActions } from '@camstack/types'
import { z } from 'zod'

// ── Pipeline phase-mode guard ────────────────────────────────────────────

const PHASE_MODE_VALUES: ReadonlySet<string> = new Set(['disabled', 'always-on', 'on-motion'])
export function isPipelinePhaseMode(v: string): v is PipelinePhaseMode {
  return PHASE_MODE_VALUES.has(v)
}

/**
 * Target PCM window duration, in ms, for audio classification.
 *
 * Sized for the ~1 s inference window the downstream classifiers expect —
 * YAMNet consumes a 0.975 s frame and Apple SoundAnalysis a ~1 s frame.
 * The broker's `AudioCodecSession` no longer batches (its 500 ms
 * accumulator was removed for WebRTC latency), so decoded codec chunks now
 * arrive at ~21–64 ms each — ~16–48 chunks per second per camera. Feeding
 * each tiny chunk to the analyzer meant one cross-process `analyseChunk`
 * RPC + one `PipelineAudioInferenceResult` event PER chunk for a classifier
 * that (a) throttles to ~2 Hz internally anyway and (b) needs a ~1 s window
 * for accurate inference. We instead accumulate raw PCM per device and flush
 * ONE classify + ONE event per ~1 s window: ~1 RPC/event/s/camera and a
 * correctly-sized inference frame.
 */
export const AUDIO_WINDOW_TARGET_MS = 1_000

/** f32le PCM = 4 bytes per sample. */
export const F32_BYTES_PER_SAMPLE = 4

/** Debounce window for `scheduleReconcile` — coalesces bursts of topology/slot-change signals. */
export const RECONCILE_DEBOUNCE_MS = 200
/**
 * Periodic sweep interval for `retryPendingDispatches` — re-dispatches cameras
 * that are KNOWN but UNASSIGNED (pending/over-cap/no-frame-source/load-shed).
 * `reconcileDispatch` is additive-only and never revisits these, so a slow
 * safety-net timer + event-driven debounce triggers recover them.
 */
export const PENDING_RETRY_INTERVAL_MS = 60_000
/** Debounce window for `schedulePendingRetry` — coalesces capacity/eligibility/readiness signals. */
export const PENDING_RETRY_DEBOUNCE_MS = 2_000
/**
 * Periodic auto-rebalance sweep. New attaches are already load-balanced at
 * dispatch time; this corrects DRIFT that accumulates over time (uneven
 * detach, a node returning online, a weight change) so the steady-state
 * distribution tracks the per-node weights. Only runs with ≥2 enabled detect
 * nodes, and migrates under hysteresis so a balanced cluster is a no-op.
 */
export const AUTO_REBALANCE_INTERVAL_MS = 60_000
/**
 * Hysteresis margin (weight-adjusted cameras) for the periodic auto-rebalance:
 * migrate a camera only when its target node is at least this much less loaded
 * than its current node. > 1 so equalizing a single-camera gap (which would
 * only reverse the imbalance) is skipped — prevents periodic churn.
 */
export const AUTO_REBALANCE_MIN_IMPROVEMENT = 1.5
/**
 * Remote-assignment health loop (T7) bounded backoff. A remote camera flagged
 * as unhealthy (0-fps / metrics-stale) is re-placed at most
 * `REMOTE_HEALTH_MAX_ATTEMPTS` times inside a rolling `REMOTE_HEALTH_WINDOW_MS`
 * window; once exhausted the camera is left visibly pending (`'unhealthy'`) for
 * the operator instead of churning forever.
 */
export const REMOTE_HEALTH_MAX_ATTEMPTS = 3
export const REMOTE_HEALTH_WINDOW_MS = 60 * 60_000

/**
 * The retired device-details key that carried a camera's whole
 * `CameraPipelineConfig` (the removed `pipeline-editor` ConfigField). A camera
 * only turns steps on or off now (D927): `applyDeviceSettingsPatch` refuses
 * this key by name rather than storing it as an unknown setting.
 */
export const RETIRED_CAMERA_PIPELINE_PATCH_KEY = 'cameraPipeline'

/** Failover policy values persisted under `addon:pipeline-orchestrator` global settings. */
type DisconnectPolicy = 'migrate' | 'leave-unassigned'
type PinnedDisconnectPolicy = 'leave-pinned' | 'unpin-and-migrate'
type ReconnectPolicy = 'restore' | 'rebalance'

export interface FailoverPolicy {
  readonly onDisconnect: DisconnectPolicy
  readonly pinnedOnDisconnect: PinnedDisconnectPolicy
  readonly onReconnect: ReconnectPolicy
}

export const DEFAULT_FAILOVER_POLICY: FailoverPolicy = {
  onDisconnect: 'migrate',
  pinnedOnDisconnect: 'leave-pinned',
  onReconnect: 'restore',
}

/**
 * Cluster-wide singleton role assignments (placement-model §6) — the ONE
 * node that serves each role for every camera. Driven by the `ingestNode` /
 * `audioNode` / `motionNode` node-selects in the addon global schema;
 * defaults to the hub for all three.
 */
export interface ClusterRoles {
  readonly ingestNode: string
  readonly audioNode: string
  readonly motionNode: string
}

/**
 * Custom-action catalog exposed through `api.addons.custom` (Task 9.1 PoC).
 *
 * The orchestrator's cap surface is the contract for all runtime traffic
 * (assignCamera / unassignCamera / rebalance / getGlobalMetrics etc). This
 * catalog is reserved for read-only diagnostics that are intentionally
 * outside the cap — they expose internal state (balancer caches, enabledNodes
 * set, active detection count) that is useful for admin tooling but does not
 * belong on the capability contract.
 */
export const OrchestratorDiagnosticsSchema = z.object({
  localNodeId: z.string(),
  knownRunnerNodes: z.array(z.string()),
  cachedAgentLoadNodeIds: z.array(z.string()),
  enabledNodes: z.array(z.string()),
  enabledDecoderNodes: z.array(z.string()),
  enabledAudioNodes: z.array(z.string()),
  enabledIngestNodes: z.array(z.string()),
  clusterRoles: z.object({
    ingestNode: z.string(),
    audioNode: z.string(),
    motionNode: z.string(),
  }),
  assignedDeviceCount: z.number().int().min(0),
  cameraConfigCount: z.number().int().min(0),
  activeDetectionCount: z.number().int().min(0),
})

export type OrchestratorDiagnostics = z.infer<typeof OrchestratorDiagnosticsSchema>

/**
 * The node-stress long-term-statistics read surface.
 *
 * A custom action rather than a cap method, matching how the orchestrator
 * already serves `dumpState`: this is a hub-local read over a table the hub
 * owns, and it ships with one `camstack deploy` instead of a release train.
 * The MEAN is derived here and returned alongside the addable `sum`/`samples`
 * — a chart wants the first, a re-bucketing caller wants the second, and a
 * stored mean is a field that can disagree with both.
 */
const NodeStressStatsInputSchema = z.object({
  /** `node-score` | `node-queue-pressure` | `node-drop-ratio` | `node-fps-deficit`. */
  series: z.string().optional(),
  /** A node id. Omit for every node. */
  subject: z.string().optional(),
  /** Inclusive bucket-start bounds, ms. */
  from: z.number().int().optional(),
  to: z.number().int().optional(),
  limit: z.number().int().positive().max(5_000).optional(),
})

const NodeStressStatsRowSchema = z.object({
  subject: z.string(),
  series: z.string(),
  scope: z.string(),
  bucketStart: z.number(),
  samples: z.number(),
  sum: z.number(),
  mean: z.number(),
  min: z.number(),
  max: z.number(),
})

const NodeStressStatsOutputSchema = z.object({
  rows: z.array(NodeStressStatsRowSchema).readonly(),
  /** Buckets still accumulating — "is it running" answerable at once, rather
   *  than after five minutes of indistinguishable silence. */
  open: z.array(NodeStressStatsRowSchema).readonly(),
  /** The durable failover history the anti-flap guards read, newest first.
   *  Exposed for the same reason the heartbeat exists: "nothing moved" has to
   *  be distinguishable from "nothing is watching". */
  moves: z
    .array(z.object({ deviceId: z.number(), fromNodeId: z.string(), at: z.number() }))
    .readonly(),
})

export type NodeStressStatsInput = z.infer<typeof NodeStressStatsInputSchema>
export type NodeStressStatsOutput = z.infer<typeof NodeStressStatsOutputSchema>

export const pipelineOrchestratorActions = defineCustomActions({
  dumpState: customAction(z.void(), OrchestratorDiagnosticsSchema),
  nodeStressStats: customAction(NodeStressStatsInputSchema, NodeStressStatsOutputSchema, {
    auth: 'admin',
  }),
})

export type PipelineOrchestratorActions = typeof pipelineOrchestratorActions

// NOTE — Phase 6 cleanup: `DEFAULT_ORCHESTRATION_SETTINGS` and
// `ORCHESTRATION_SETTING_KEYS` lived here to back the legacy
// `getDeviceOrchestrationSettings` / `getGlobalOrchestrationSettings`
// cap methods. They've been removed: the addon's `getConfigSchema()`
// now carries every field default, and consumers read settings via
// `resolveAddonSettings(schema, global, device)` which uses those
// defaults directly. See `DetectionWiringService.resolveDeviceSettings`
// for the canonical consumer.

/**
 * Dispatch succeeded and the camera was assigned to a concrete agent node.
 * `agentNodeId` is always a non-empty, valid node identifier.
 */
export type DispatchResultAssigned = {
  readonly success: true
  readonly kind: 'assigned'
  readonly agentNodeId: string
  readonly reason: PipelineAssignment['reason']
}

/**
 * Dispatch succeeded in accepting the camera but no node had remaining
 * capacity — the camera is intentionally left unassigned until capacity
 * frees. The caller must NOT assume any real node was chosen.
 */
export type DispatchResultPending = {
  readonly success: true
  readonly kind: 'pending'
}

/**
 * What a RE-place may elect against (D650 round 3): the eligible devices, or
 * the node and the answer it has never given (its device probe + pool health,
 * or its catalog). A re-place never waits for that answer — the camera stays
 * pending as `<what>-unavailable:<nodeId>` until a later round.
 */
/**
 * How a LIVE eligibility read (`resolveEligibleInferenceDevices`) obtains the
 * node's catalog for its root guard (D650 pre-ship, D3):
 *  - `await-catalog` — reconcile against the executor until it answers. ONLY
 *    for a first placement or a motion-start dispatch, where a camera is
 *    waiting and nothing else could be attached instead.
 *  - `one-round` — one bounded round; a node that does not answer makes the
 *    read FAIL (the caller keeps its last answer). For anything that runs on
 *    its own clock — the session controller's balancer refresher — where an
 *    unbounded wait on a departed node is a loop that never ends.
 */
export type EligibilityCatalogRead = 'await-catalog' | 'one-round'

export type EligibilityIfCached =
  | { readonly kind: 'eligible'; readonly eligible: Record<string, number> }
  | {
      readonly kind: 'unavailable'
      readonly nodeId: string
      readonly what: 'catalog' | 'device-health'
    }

/**
 * Discriminated union returned by `dispatchCamera`. Discriminate on `kind`:
 * - `'assigned'` → camera is live on `agentNodeId`.
 * - `'pending'`  → camera is queued; no node was assigned yet.
 */
export type DispatchResult = DispatchResultAssigned | DispatchResultPending

/**
 * Sentinel returned by `buildDetectionConfig` when the profile-slot READ
 * itself failed transiently (e.g. `listAllProfileSlots` discovery timeout
 * while the stream-broker is (re)starting) — as opposed to `null`, which
 * means "genuinely no assigned slot / not configured". Callers MUST treat
 * this differently from `null`: never stop active detection on a transient
 * read failure (the slots almost certainly still exist), and schedule a retry.
 */
export const TRANSIENT_SLOT_READ: unique symbol = Symbol('transient-slot-read')
export type DetectionConfigResult = CameraDetectionConfig | null | typeof TRANSIENT_SLOT_READ

/**
 * Metadata for a per-device audio-analyzer assignment.
 * Replaces the bare `audioNodeByDevice` string value with a typed record.
 */
export interface AudioNodeAssignment {
  readonly deviceId: number
  readonly nodeId: string
  readonly pinned: boolean
  readonly assignedAt: number
}

/**
 * Local-only provider surface resolved via the kernel capability registry.
 * Extends the cap interface with the in-process dispatch entrypoints that
 * can't cleanly round-trip through the tRPC serializer because they carry
 * a full `PipelineConfig` payload attached to the `RunnerCameraConfig`.
 */
export interface IPipelineOrchestratorLocalProvider extends IPipelineOrchestratorProvider {
  /**
   * In-process dispatch entrypoint. Caches the config, runs the load
   * balancer, dispatches the attach call to the chosen runner.
   */
  dispatchCamera(runnerConfig: RunnerCameraConfig): Promise<DispatchResult>
  /** In-process release entrypoint — detach + clear cached state. */
  releaseCamera(input: { deviceId: number }): Promise<{ success: true }>
}
