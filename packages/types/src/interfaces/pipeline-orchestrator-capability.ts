import type { RunnerLocalLoad } from './pipeline-runner-capability.js'
import type { CamProfile } from '../capabilities/schemas/streaming-shared.js'

// ──────────────────────────────────────────────────────────────────────
// Orchestration-level field value types
// ──────────────────────────────────────────────────────────────────────
//
// After the Phase 6 cleanup, the `OrchestrationDeviceSettings` and
// `ResolvedOrchestrationSettings` interfaces have been removed.
// Consumers read per-device settings via the standard 3-level resolver
// `resolveAddonSettings(schema, global, device)` over the addon config
// store and narrow the returned `Record<string, unknown>` locally if
// they need typed access. See `DetectionWiringService.resolveDeviceSettings`
// for the canonical example.
//
// The small set of string-literal field types below is kept because
// it's re-used by several interfaces (CameraDetectionConfig etc.) and
// benefits from a single source of truth.

/** Stream profile quality values. */
export type OrchestrationStreamProfile = CamProfile

/**
 * How motion is detected for a camera — list of active sources,
 * OR-ed. Re-export of the cap-side type so orchestrator-facing code
 * doesn't have to import from the pipeline-runner cap directly.
 */
export type OrchestrationMotionSources =
  import('../capabilities/pipeline-runner.cap.js').MotionSources

// `OrchestrationCameraPriority` was a 2-state alias of CameraPriority;
// dropped together with `priority` in favour of `PipelinePhaseMode` from
// `device-profile.ts`. Consumers import that 4-state enum directly.

/**
 * Pipeline placement record persisted by `addon-pipeline-orchestrator` via
 * the multi-level settings store. The orchestrator looks this up on every
 * `DeviceStreamsRegistered` event to decide whether the camera has a
 * manual pipeline node pin (L1 affinity) or whether the load balancer
 * (L2 capacity / L3 hardware-aware) needs to pick one.
 *
 * Naming convention: `{Pipeline,Decoder}Assignment` — one record type per
 * placement domain managed by the orchestrator. Future domains (recording,
 * etc.) follow the same pattern.
 */
export interface PipelineAssignment {
  readonly deviceId: number
  /** Moleculer node id of the runner currently responsible for this camera. */
  readonly agentNodeId: string
  /** True when the assignment was set manually, false when chosen by the balancer. */
  readonly pinned: boolean
  /** Why this assignment was made — useful for debugging the load balancer. */
  readonly reason: 'manual' | 'capacity' | 'hardware-affinity' | 'failover' | 'rebalance'
  /** Unix timestamp (ms) when the assignment was last updated. */
  readonly assignedAt: number
}

// NOTE: the `DecoderAssignment` record was removed with the advisory decoder
// surface — decode is always co-located with its frame consumer, so decoder
// placement is not an independently assignable domain. The camera-status
// aggregator reports it as the detection node (`assignment.decoderNodeId`).

/**
 * Per-agent load summary surfaced to the load balancer + dashboards.
 * Aggregated from each runner's `getLocalLoad` cap call.
 */
export interface AgentLoadSummary {
  readonly nodeId: string
  readonly online: boolean
  readonly load: RunnerLocalLoad
  /** Computed score used by the L2 capacity balancer (lower = less loaded). */
  readonly score: number
  /**
   * The decode hwaccel backend this node runs on (e.g. `videotoolbox`, `vaapi`,
   * `qsv`), from the decoder addon's per-node `probedBestHwaccel@<node>` setting,
   * or `null` when not yet probed. For the cluster Pipeline table UI's per-node
   * capability column (P0.2). Sourced from a node-LOCAL probe published to a
   * per-node setting — never the `platform-probe` singleton (whose per-node pin
   * answers with the hub's hardware).
   */
  readonly decodeHwaccel: string | null
}

/**
 * Aggregate metrics across the whole detection cluster.
 *
 * Replaces the legacy `IPipelineExecutorProvider.orchestratorStatus()` cap
 * method as the canonical source of truth for global pipeline health.
 * The orchestrator computes this by aggregating each runner's local
 * metrics over the cluster.
 */
export interface PipelineOrchestratorGlobalMetrics {
  readonly totalAgents: number
  readonly onlineAgents: number
  readonly totalCameras: number
  readonly attachedCameras: number
  readonly activeCameras: number
  /** Average inference time across all agents weighted by their camera count. */
  readonly avgInferenceTimeMs: number
  /** Total queue depth across all agents. */
  readonly queueDepth: number
}

/**
 * Pipeline Orchestrator provider interface — implemented by
 * `addon-pipeline-orchestrator`. Lives on the hub.
 *
 * Tracks the camera-to-agent assignment map, listens to device lifecycle
 * events, queries each runner's capacity + hardware profile, and dispatches
 * `attachCamera` / `detachCamera` cap calls to the appropriate runner
 * instances. Persists assignments via the multi-level settings store so
 * they survive hub restarts.
 *
 * Strictly the control plane: never sees a frame, never calls inference,
 * never drains queues. The runner does that work locally on each agent.
 *
 * All methods are serializable so the orchestrator is routable across the
 * cluster (in practice it's hub-only, but the interface enforces the
 * discipline that nothing leaks across boundaries as live references).
 */
export interface IPipelineOrchestratorProvider {
  // ── Pipeline placement overrides ───────────────────────────────────────
  /**
   * Pin a camera's pipeline to a specific agent. Sets the manual L1
   * affinity in the camera's per-device settings and re-evaluates the
   * assignment immediately.
   */
  assignPipeline(input: { deviceId: number; agentNodeId: string }): Promise<{ success: true }>

  /**
   * Clear a camera's pipeline pin and stop detection on it.
   * Removes the entry from the assignment map until the next
   * `DeviceStreamsRegistered` event triggers a fresh assignment.
   */
  unassignPipeline(input: { deviceId: number }): Promise<{ success: true }>

  /**
   * Trigger a full rebalance pass. Iterates over all assigned cameras,
   * recomputes the optimal agent for each one based on current load +
   * hardware affinity, and migrates cameras whose current agent is no
   * longer optimal. Pinned cameras are never migrated.
   *
   * Returns the number of cameras that were migrated to a different agent.
   */
  rebalance(): Promise<{ migrated: number }>

  // ── Observability ──────────────────────────────────────────────────────
  /** Get every camera's pipeline placement. */
  getPipelineAssignments(): readonly PipelineAssignment[]
  /** Get one camera's pipeline placement, or null if unassigned. */
  getPipelineAssignment(input: { deviceId: number }): PipelineAssignment | null
  /**
   * Get per-agent load summaries used by the load balancer + dashboards.
   * Async so each call can refresh the in-memory cache from live runner
   * state — the cache is only populated during dispatch / rebalance, so
   * a sync accessor would return stale (empty) data after a server
   * restart that rehydrated assignments from disk without
   * re-dispatching.
   */
  getAgentLoad(): Promise<readonly AgentLoadSummary[]>
  /** Aggregate global metrics across the whole detection cluster. */
  getGlobalMetrics(): Promise<PipelineOrchestratorGlobalMetrics>

  // ── Capability bindings ────────────────────────────────────────────────
  /**
   * Read the per-node capability binding map: which addon implements each
   * well-known cap on the named node. Empty record = no overrides (the
   * kernel's "first registered wins" lookup applies).
   */
  getCapabilityBindings(input: { nodeId: string }): Promise<Readonly<Record<string, string>>>

  /**
   * Set the addon that implements `capName` on `nodeId`. Persisted in
   * the orchestrator's settings store; emits a `capability.binding-changed`
   * event so each kernel process updates its local preferred-provider
   * registry on the fly.
   */
  setCapabilityBinding(input: {
    nodeId: string
    capName: string
    addonId: string
  }): Promise<{ success: true }>

  // NOTE: the per-device settings accessors
  // (`getDeviceOrchestrationSettings`, `getDeviceOrchestrationOverrides`,
  // `getGlobalOrchestrationSettings`) were removed in Phase 6. Consumers
  // read via the standard addon config store + `resolveAddonSettings`
  // helper — see the comment block at the top of this file.
}
