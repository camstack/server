/**
 * addon-pipeline-orchestrator — hub-side camera-to-agent load balancer.
 *
 * Owns the control plane for the distributed detection pipeline. Tracks
 * which `addon-pipeline-runner` instance is responsible for each camera,
 * queries each runner's capacity + hardware profile, and dispatches
 * `attachCamera` / `detachCamera` cap calls to the appropriate runner via
 * the Moleculer broker. Persists manual pins via the per-device settings
 * store so user overrides survive hub restarts.
 *
 * Strictly control plane — never sees a frame, never runs inference, never
 * drains queues. The runner does that work locally on each vision node.
 *
 * ## Dispatch entrypoints
 *
 * - **`dispatchCamera(runnerConfig)`** — in-process only (not in the cap
 *   def). Called by `DetectionWiringService` with a freshly-built
 *   `RunnerCameraConfig`. Runs the L1/L2/L3 balancer, picks an agent, then
 *   issues `broker.call('pipeline-runner.pipeline-runner.attachCamera', ...)`.
 *   Caches the config so future rebalance / pinning can re-dispatch without
 *   the caller rebuilding it.
 *
 * - **`assignCamera({deviceId, agentNodeId})`** — cap method. Persists a
 *   manual `preferredAgent` pin to per-device settings and re-dispatches
 *   immediately if the camera is already attached.
 *
 * - **`unassignCamera({deviceId})`** — cap method. Clears the pin,
 *   detaches the camera from its current agent.
 *
 * - **`rebalance()`** — cap method. Walks every cached camera config and
 *   re-runs the balancer; migrates cameras whose current agent is no
 *   longer optimal. Pinned cameras are never migrated.
 *
 * ## Runner dispatch
 *
 * All runner calls go through `this.ctx.api.pipelineRunner.*` (the generated
 * tRPC cap router). The router extracts `nodeId` from the input and
 * routes transparently to the local runner (direct in-process call) or
 * to a remote agent (via Moleculer). Node discovery is driven by
 * `EventCategory.AgentOnline/AgentOffline` events forwarded by
 * `agent-registry.service.ts`.
 */
import { randomUUID } from 'node:crypto'
import type {
  AddonInitResult,
  AgentLoadSummary,
  AutoTuneApplyResult,
  AutoTunePlan,
  CapacitySource,
  CurrentPool,
  EffectiveShares,
  ListNodeBenchmarkResultsInput,
  MeasuredLatency,
  NodeBenchmarkCandidates,
  NodeBenchmarkPlanInput,
  NodeBenchmarkPreflight,
  NodeBenchmarkResult,
  NodeBenchmarkResultView,
  NodeBenchmarkStatus,
  NodeMeasuredCapacity,
  LoadBalancingSharesInput,
  PlacementStats,
  SessionPlacementPolicy,
  ShareSource,
  SuggestSharesResult,
  ClusterModelChoice,
  OccupancyLookAnswer,
  OccupancyLookRequest,
  AgentPipelineSettings,
  NodeColorId,
  CameraDetectionConfig,
  CameraMetrics,
  CameraPipelineConfig,
  CameraDetectionSource,
  CameraPipelineSettings,
  CameraStatus,
  CameraSwitchGroup,
  CameraSwitchId,
  ConfigUISchemaWithValues,
  DeviceStepConfig,
  InferenceDeviceDescriptor,
  PipelineSchema,
  IngestOwner,
  NodeInferenceDevices,
  PipelineAssignment,
  PipelineInferenceResultPayload,
  PipelineOrchestratorGlobalMetrics,
  PipelinePhaseMode,
  RunnerCameraConfig,
  SetCameraSensorsInput,
  Unsubscribe,
  DurableState,
} from '@camstack/types'
import {
  assignNodeColorId,
  addonWidgetsSourceCapability,
  nodeRemovalHookCapability,
  AUTO_SHARE_HEADROOM,
  BaseAddon,
  cameraPipelineConfigCapability,
  modelScopedStepSettingKeys,
  CLUSTER_MODEL_SCOPED_STEPS,
  clusterModelSettingKey,
  createEvent,
  DEFAULT_SESSION_PLACEMENT_POLICY,
  DEFAULT_SHARE_SOURCE,
  EventCategory,
  errMsg,
  type IAddonWidgetsSourceProvider,
  isAutomaticShareSource,
  measuredCapacityFromResults,
  measuredDetectorCells,
  nodePin,
  pinUnderBenchmark,
  displayPaletteCapability,
  pipelineOrchestratorCapability,
  resolveEffectiveShares,
  SHARE_SOURCE_SETTING_KEY,
  viewerUiCapability,
  zoneRulesCapability,
  zonesCapability,
} from '@camstack/types'
import { AgentLoadService } from './agent-load-service.js'
import type { NodeBenchmarkService } from './node-benchmark/node-benchmark-service.js'
import { NodeBenchmarkStore } from './node-benchmark/node-benchmark-store.js'
import {
  AutoBenchmarkScheduler,
  readAutoBenchNodes,
  benchKey,
  benchmarkedDevices,
  type AutoBenchAttempt,
} from './node-benchmark/auto-benchmark.js'
import { attemptsFromBlob, attemptsToBlob } from './node-benchmark/auto-benchmark-attempts.js'
import { createNodeBenchmarkService } from './node-benchmark/node-benchmark-wiring.js'
import { orchestratorRecordKinds } from './record-kinds.js'
import {
  listNodeBenchmarkResultViews,
  readNodeBenchmarkCandidates,
} from './node-benchmark/node-benchmark-reads.js'
import { decideClusterModelChoice } from './cluster-model-choice.js'
import { AUDIO_NODE_SETTING, AudioSubscriptionController } from './audio-subscription-controller.js'
import { type CameraSensorsWriteResult, writeCameraSensors } from './camera-sensors/write.js'
import { CameraStatusService } from './camera-status-service.js'
import { CameraSwitchService } from './camera-switch-service.js'
import type { DetectionSessionRegistry } from './detection-session-registry.js'
import { DetectionWiringController } from './detection-wiring-controller.js'
import { DeviceConfigContributions } from './device-config-contributions.js'
import { createDiskReconcileJobRunner } from './disk-reconcile-job.js'
import {
  annotateInferenceDeviceExclusions,
  type InferenceDeviceExclusion,
  inferenceDeviceCaps,
  makeRootCapabilityGuard,
  mergeInferenceDevices,
  type NodeInferenceUsability,
  resolveInferenceDeviceEligibility,
  resolveNodeInferenceUsability,
  validateJumpTargets,
} from './inference-device-model.js'
import {
  foldInferenceDeviceHealth,
  InferenceDeviceUsabilityMirror,
} from './inference-device-usability-mirror.js'
import { LoadShedController } from './load-shed-controller.js'
import { NodeInferenceUsabilityMirror } from './node-inference-usability-mirror.js'
import { NodeLifecycleHandler } from './node-lifecycle-handler.js'
import type { NodeStressController } from './node-stress-controller.js'
import type { NodeStressHistoryProducer } from './node-stress-history-producer.js'
import { NodeTopologyService } from './node-topology.js'
import {
  buildOrchestratorControllers,
  type OrchestratorBootstrapDeps,
} from './orchestrator-bootstrap.js'
import {
  type AudioNodeAssignment,
  DEFAULT_FAILOVER_POLICY,
  type DetectionConfigResult,
  type DispatchResult,
  type DispatchResultAssigned,
  type DispatchResultPending,
  type EligibilityCatalogRead,
  type EligibilityIfCached,
  type FailoverPolicy,
  type IPipelineOrchestratorLocalProvider,
  type NodeStressStatsInput,
  type NodeStressStatsOutput,
  type OrchestratorDiagnostics,
  type PipelineOrchestratorActions,
  pipelineOrchestratorActions,
} from './orchestrator-types.js'
import { PipelineSettingsStore } from './pipeline-settings-store.js'
import { PipelineWatchdog } from './pipeline-watchdog.js'
import { PlacementLedger } from './placement-ledger.js'
import {
  PlacementService,
  PREFERRED_AGENT_SETTING,
  type RebalanceOptions,
  type RebalanceResult,
} from './placement-service.js'
import { ReconcileController } from './reconcile-controller.js'
import {
  DEFAULT_SUGGESTION_DEBOUNCE_MS,
  REBALANCE_SUGGESTED_ALERT_ID,
  RebalanceSuggestion,
} from './rebalance-suggestion.js'
import {
  type PinResetTrigger,
  type ResetModelPin,
  resetRemovedModelPins,
} from './removed-model-pin-reset.js'
import { SessionDispatchController } from './session-dispatch-controller.js'
import {
  buildDeviceSettingsSections,
  buildGlobalSettingsSections,
  deriveRuntimeSettings,
} from './settings-ui-schemas.js'
import { createDisplayPaletteProvider } from './display-palette-provider.js'
import { createViewerUiProvider } from './viewer-ui-provider.js'
import { pipelineOrchestratorWidgets } from './widget-catalog.js'
import { ZoneRulesProvider } from './zone-rules-provider.js'
import { ZonesProvider } from './zones-provider.js'
import { AutoTuneService } from './auto-tune/auto-tune-service.js'
import { SessionPlacementStats } from './session-placement-stats.js'
import { applyLoadBalancingShares } from './load-balancing-shares.js'
import { EffectiveSharesService } from './load-balancing/effective-shares-service.js'
import {
  AutoBenchmarkAttemptsSchema,
  type AgentSettingsMapBlob,
  type AutoBenchmarkAttemptsBlob,
} from './orchestrator-store-schemas.js'
import { createNodeRemovalHook, type NodeRemovalDeps } from './node-removal.js'
import {
  probedDeviceSignature,
  shareTopologySignature,
  storedShareWeights,
  type LiveDevicesByNode,
} from './load-balancing/share-inputs.js'
import { findStaleDevicePins, type PinnedCamera } from './stale-device-pins.js'

// Re-exported for external consumers (tests, admin-ui) that imported these
// symbols from this module before the S1 extraction to `orchestrator-types.ts`.
export type {
  AudioNodeAssignment,
  DetectionConfigResult,
  DispatchResult,
  DispatchResultAssigned,
  DispatchResultPending,
  FailoverPolicy,
  IPipelineOrchestratorLocalProvider,
  OrchestratorDiagnostics,
  PipelineOrchestratorActions,
}
export { pipelineOrchestratorActions }

/**
 * The FULL action catalog, under the name the HUB HARVESTS.
 *
 * The hub's forked-addon harvest imports this entry module and reads the
 * `customActions` NAMED export (`loadForkedCustomActionCatalog`) — returning a
 * catalog from `onInitialize` is not enough. Without this line the bridge
 * answers *"no addon 'pipeline-orchestrator' registers custom actions"* for
 * every action here, which is what `dumpState` had been doing, silently, since
 * it was written: an admin diagnostic that 404s is worse than no diagnostic,
 * because nobody discovers it is missing until they need it.
 */
export const customActions = pipelineOrchestratorActions

// The orchestrator reaches the broker through the `stream-broker` capability
// over tRPC (`this.ctx.api.streamBroker.*`). Audio analysis subscribes via the
// serialisable `subscribeAudioChunks` / `pullAudioChunks` plane (Phase 5 / D9),
// polled by `AudioChunkPoller` — no live broker object crosses the boundary.

// `PREFERRED_AGENT_SETTING` (the per-device manual-pin setting key) moved to
// `placement-service.ts` (S8 extraction) — imported above.

// `AUDIO_NODE_SETTING` (the per-device audio node pin key) moved to
// `audio-subscription-controller.ts` (S7 extraction) — imported above.

// ── Pipeline settings store keys ──────────────────────────────────────
//
// 3-level resolution model:
//
//   `agentSettings[nodeId]`  → engine choice + addonDefaults (every
//                               addonId in the catalog gets an entry)
//                               + audio baseline. Auto-seeded on
//                               $node.connected, editable by operator.
//
//   `cameraSettings[deviceId]` → per-camera overlay: stepToggles
//                                 (addonId→bool force) and camera-semantic
//                                 stepSettings — never a model (D927). The
//                                 legacy disableInference nuke switch is
//                                 replaced by the detection-pipeline binding.
//
//   (`templates`, the old preset library, is no longer read or written —
//    D759 — and a stored blob is left as it is.)
//
// Each of these two keys — plus `nodeBindings` — persists its WHOLE
// collection through a durable-state handle (see `*State` getters and
// `orchestrator-store-schemas.ts`); the read + every write route through
// the same Zod-validated handle so no field can be silently dropped on
// save.

/**
 * One node's inference-device probe. `reachable: false` means the node did
 * not ANSWER — `probed` is then empty because nothing was read, not because
 * the node has no accelerators, and no placement state may change on it.
 */
interface InferenceDeviceProbe {
  readonly probed: readonly InferenceDeviceDescriptor[]
  readonly reachable: boolean
}

export default class PipelineOrchestratorAddon
  extends BaseAddon
  implements IPipelineOrchestratorLocalProvider
{
  /** This node's Moleculer nodeId (from this.ctx.kernel.localNodeId). */
  private localNodeId = 'hub'
  /**
   * A shutdown latch for {@link getClusterModelChoice} (D651): cleared on the
   * first line of `onShutdown`, so an owner that is tearing down stops
   * answering. Set at the end of `onInitialize`; it is also false before that,
   * but nothing can call the method then — the cap provider is registered
   * from what `onInitialize` RETURNS, so the pre-init state is unreachable and
   * not a claim this flag makes.
   */
  private clusterModelChoiceReady = false
  /** The per-device 24 h peak of concurrent sessions, fed by every runner census (D745). */
  /** What session placement did (D748): the Load balancing tab's "actual" column. */
  private readonly placementStats = new SessionPlacementStats()
  /** The stored session placement policy (D748, default `share` since D750). */
  private readSessionPlacement: () => SessionPlacementPolicy = () =>
    DEFAULT_SESSION_PLACEMENT_POLICY
  /** Where the shares come from (D750); `auto` before init. */
  private readShareSource: () => ShareSource = () => DEFAULT_SHARE_SOURCE
  private autoTuneService: AutoTuneService | null = null
  private effectiveSharesService: EffectiveSharesService | null = null
  /** The node benchmark lifecycle (D791); null before init. */
  protected nodeBenchmark: NodeBenchmarkService | null = null
  private nodeBenchmarkStore: NodeBenchmarkStore | null = null
  private nodeBenchmarkTimer: ReturnType<typeof setInterval> | null = null
  /** Measures an enabled device that has no result yet (GAP 2 of the balancing work). */
  private autoBenchmark: AutoBenchmarkScheduler | null = null
  /** How often the active run's runner is polled (a test seam). */
  protected nodeBenchmarkPollMs = 3000
  /**
   * Single owner of the shared placement state (`assignments`/`cameraConfigs`/
   * `pendingReasons`/`dispatchingDevices`) — see `placement-ledger.ts` (S6
   * extraction). Constructed FIRST in `onInitialize` (several other
   * constructions below read through it via closures); disposed + nulled at
   * the end of `onShutdown`.
   */
  protected ledger: PlacementLedger | null = null
  /**
   * Node topology & eligibility (`knownRunnerNodes`/`enabled*`/
   * `remoteSourcingNodes`/`reachableHostByNode`/`clusterRoles`) — see
   * `node-topology.ts` (S6 extraction). Constructed SECOND (before the load
   * service, which reads `topology.knownRunnerNodeIds()`/`isNodeEnabled()`).
   */
  private topology: NodeTopologyService | null = null
  /**
   * Agent load & metrics collection (`cachedAgentLoad`/`decodeHwaccelByNode`)
   * — see `agent-load-service.ts` (S6 extraction). Constructed THIRD
   * (depends on `topology`).
   */
  private loadService: AgentLoadService | null = null
  /**
   * Per-camera low-fps load shedding (`cameraFpsMap`/`loadShedState`/
   * `shedInFlight`/`loadShedResumeTimer`/the grace-period `firstSeenByDevice`
   * map) — see `load-shed-controller.ts` (S8 extraction, cluster C15).
   * Constructed BEFORE `placement`, right after `settingsStore` — `placement`'s
   * `dispatchCamera` reads it (`dispatchDeferralCheck`), while `loadShed`'s own
   * `attach`/`detach`/`redispatchSingleCamera` deps are lazy closures onto
   * `placement` (invoked only once both exist), so the two are safely
   * construction-order-independent either way. Disposed + nulled at the end
   * of `onShutdown`.
   */
  private loadShed: LoadShedController | null = null
  /**
   * Per-NODE saturation verdict and (in `failover` mode) the one-camera-at-a-
   * time relocation — see `node-stress-controller.ts`. Distinct from
   * `loadShed`: that one asks "is THIS camera slow" against an absolute fps
   * floor and ships disabled; this one asks "is THIS NODE saturated" from a
   * corroborated composite. Shares the camera-metrics subscription; disposed +
   * nulled at the end of `onShutdown`.
   */
  private nodeStress: NodeStressController | null = null
  /**
   * Standing camera placement core (`dispatchCamera`/`releaseCamera`/
   * `assignPipeline`/`unassignPipeline`/`rebalance`/`attachOn`/`detachOn`/
   * `redispatch*`) — see `placement-service.ts` (S8 extraction, cluster C3).
   * Constructed right after `loadShed`. Nulled at the end of `onShutdown`.
   */
  private placement: PlacementService | null = null
  /** The debounced "placement can be rebalanced" evaluation; see `rebalance-suggestion.ts`. */
  private rebalanceSuggestion: RebalanceSuggestion | null = null
  private unsubSuggestionEvents: Unsubscribe[] = []
  /** EventBus unsubscribes for agent online/offline events. */
  private unsubAgentOnline: Unsubscribe | null = null
  private unsubAgentOffline: Unsubscribe | null = null
  /**
   * Dispatch reconcile + pending/stranded retry sweep + remote-assignment
   * health loop (C8, S9 extraction) — see `reconcile-controller.ts`.
   * Constructed right after `cameraStatusService`, BEFORE the settings-load
   * block (`applyRuntimeSettings` calls `schedulePendingRetry` synchronously
   * during that block). Nulled at the end of `onShutdown`.
   */
  private reconcile: ReconcileController | null = null
  /**
   * Runner disconnect/reconnect failover + `detection-pipeline` readiness
   * plumbing (C6 + C7-detection, S9 extraction) — see
   * `node-lifecycle-handler.ts`. Owns the `ReadinessRegistry` instance
   * itself (shared kernel singleton or a local fallback). Constructed AFTER
   * `this.localNodeId` is resolved (stripped of any `/group` suffix) and
   * AFTER `reconcile` (whose `scheduleReconcile`/`schedulePendingRetry` it
   * depends on), immediately before the AgentOnline/AgentOffline
   * subscriptions are wired. Nulled at the end of `onShutdown`.
   */
  private nodeLifecycle: NodeLifecycleHandler | null = null

  /**
   * The 3-level pipeline settings store (agent + camera settings maps,
   * pipeline-executor catalog cache) plus the co-declared
   * `nodeBindings` capability-binding map and the one-shot bindings-
   * migration guard flag — see `pipeline-settings-store.ts` (S4
   * extraction, cluster C11). Constructed early in `onInitialize` (before
   * anything needs `readCameraSettingsMap`/`readAgentSettingsMap`), never
   * null while the addon is running; `dispose()`'d and nulled at the end
   * of `onShutdown`.
   */
  private settingsStore: PipelineSettingsStore | null = null
  /**
   * Per-camera zones CRUD provider. Constructed lazily in `onInitialize`
   * because it captures `this.ctx` for settings + api access; cleared
   * to null in `onShutdown` so a soft-restart is observable.
   */
  private zonesProvider: ZonesProvider | null = null
  /**
   * Per-camera zone-rules CRUD provider — bulk-replace per stage,
   * mirrors to dev.state slices `motion-zone-rules` /
   * `detection-zone-rules` so consumer addons subscribe per stage.
   */
  private zoneRulesProvider: ZoneRulesProvider | null = null
  /**
   * The per-camera status aggregator (`getCameraStatus`/`getCameraStatuses`)
   * — see `camera-status-service.ts` (S5 extraction, cluster C12). READ-ONLY
   * over `assignments`/`audioAssignments`/`cameraConfigs`/`pendingReasons`,
   * reached only through injected closures. Constructed in `onInitialize`
   * (its `api`/`resolveDecoderNode` closures read `this` live, so
   * construction order relative to those fields doesn't matter); nulled at
   * the end of `onShutdown`.
   */
  private cameraStatusService: CameraStatusService | null = null
  /** The per-camera function switch group (D61) — see `camera-switch-service.ts`. */
  private cameraSwitchService: CameraSwitchService | null = null
  /**
   * Device-details aggregator contributions (`getDeviceSettingsContribution`/
   * `getDeviceLiveContribution`/`applyDeviceSettingsPatch`/
   * `updateGlobalSettings`/`writeDeviceOrchestratorSettings`/
   * `splitPipelinePatch`/`applyPipelinePatch`) — see
   * `device-config-contributions.ts` (S11 Task 1 extraction, C13 remnant).
   * Owns nothing durable (reads through injected closures); constructed in
   * `onInitialize` AFTER `settingsStore`/`topology`/`placement`/`loadShed`
   * exist. Stateless — no `dispose()`, just nulled at the end of `onShutdown`.
   */
  private deviceConfig: DeviceConfigContributions | null = null
  /**
   * Read-only test-seam compat accessor — mirrors the pre-S9 `protected
   * remoteHealthAttempts` field so `remote-health.spec.ts`'s subclass
   * (`this.remoteHealthAttempts.get/.set(...)`) keeps reading/writing the
   * SAME live Map `ReconcileController` reads on its next evaluation pass
   * (S9 extraction, cluster C8 — see `reconcile-controller.ts`).
   */
  protected get remoteHealthAttempts(): Map<number, { count: number; windowStart: number }> {
    return this.reconcile!.remoteHealthAttempts
  }

  /** Runtime failover policy, driven by `getConfigSchema` fields + `onConfigChange`. */
  private failoverPolicy: FailoverPolicy = { ...DEFAULT_FAILOVER_POLICY }
  // `globalSettings` (the in-memory global-settings snapshot) is now fully
  // self-contained inside `buildOrchestratorControllers` (S11 Task 4,
  // `orchestrator-bootstrap.ts`) — every reader/writer (`loadShed`/
  // `loadService`'s `readGlobalSettings`, `deviceConfig`'s
  // `setGlobalSettings`, the settings-load block's `applyRuntimeSettings`
  // call) is a closure constructed there, closing over ONE local variable.
  // No code outside that closure network ever read the class field, so it
  // was removed rather than kept as a write-only class field (TS6133).

  // ── Detection wiring state (moved from kernel DetectionWiringService) ──
  //
  // The orchestrator owns the full detection lifecycle: it subscribes to the
  // stream-router device registrations, resolves per-device settings from
  // its own store, builds `CameraDetectionConfig`, dispatches the camera to
  // a runner, and subscribes to audio chunks for hub-side analysis. The
  // kernel no longer runs any of this logic — it lives here because the
  // orchestrator is a plug-and-play addon and the rules are under user
  // control via its `getConfigSchema()`.
  /**
   * The detection-wiring coordination layer — owns `activeDetections` (the
   * per-device active-detection-config cache) + the full device-lifecycle
   * handler surface (`handleDeviceRegistered`/`handleDeviceUnregistered`/
   * `handleSettingsChanged`/`handlePipelineCameraUpdated`/
   * `handleInferenceResult`/`startDetection`/`stopDetection`) — see
   * `detection-wiring-controller.ts` (S11 Task 3 extraction, C14).
   * Constructed LAST in `onInitialize` — it depends on every other
   * controller (`ledger`/`placement`/`audio`/`session`/`settingsStore`/
   * `reconcile`/`loadShed`). Controllers constructed earlier that need
   * `activeDetections` (`audio`/`session`/`reconcile`/
   * `wireOrchestratorSubscriptions`/`pipelineWatchdog`) receive LAZY
   * closures onto this field — see that class's doc comment for why this is
   * boot-safe. Nulled at the end of `onShutdown`.
   */
  private detectionWiring: DetectionWiringController | null = null
  /**
   * Read/write test-seam compat accessor — mirrors the `remoteHealthAttempts`
   * pattern (S9) so `remote-health.spec.ts`'s subclass
   * (`this.activeDetections.set(deviceId, {...})`) keeps reading/writing the
   * SAME live Map `DetectionWiringController` owns (S11 Task 3 extraction,
   * C14 — see `detection-wiring-controller.ts`). Production code never
   * reads/writes this getter — it uses the `getActiveDetectionConfig`/
   * `isDetectionActive`/`dropActiveDetection`/`activeDeviceIds` accessor
   * methods instead.
   */
  protected get activeDetections(): Map<number, CameraDetectionConfig> {
    return this.detectionWiring!.activeDetections
  }
  /**
   * The audio subscription plane — owns `audioSubscriptions`/`audioSubLocks`/
   * the shutdown guard/`lazyAudioTeardownTimers`/`audioAssignments`/
   * `readyAudioNodes`/`lastSeenAudioEpochByNode` (C17 + C10's audio half —
   * see `audio-subscription-controller.ts`, S7 extraction). Constructed in
   * `onInitialize` (after `topology`, which its deps read live); nulled at
   * the end of `onShutdown`.
   */
  private audio: AudioSubscriptionController | null = null
  /**
   * Read-only test-seam compat accessor — mirrors the pre-S7 `protected
   * audioSubscriptions` field so `bindings-e2e.spec.ts`'s cast-based read
   * (`(addon via an unsafe cast to {...}).audioSubscriptions?.has(deviceId)`)
   * continues to observe REAL controller state after the S7 extraction
   * instead of silently reading `undefined` (which would still satisfy the
   * assertion vacuously). Production code never reads this — the audio
   * controller owns the real map.
   */
  protected get audioSubscriptions(): ReadonlyMap<number, Unsubscribe> {
    return this.audio?.subscriptionsSnapshot ?? new Map()
  }
  /**
   * Session-time dispatch for `on-motion` cameras — owns the ephemeral
   * `sessionRegistry` (ACTIVE session tracking), the session `KeyedAsyncLock`,
   * the session shutdown guard, and `motionWatchByDevice` (C16, S11 Task 2
   * extraction — see `session-dispatch-controller.ts`). Constructed in
   * `onInitialize` right after `placement` — its deps need `ledger`/
   * `topology`/`loadService`/`settingsStore` to already exist (the same
   * point the former inline session fields were effectively available, since
   * those were plain field initializers). Nulled at the end of `onShutdown`.
   */
  private session: SessionDispatchController | null = null
  /**
   * Read-only test-seam compat accessor — mirrors the pre-S11-Task-2
   * `protected readonly sessionRegistry` field so
   * `on-motion-session-cutover.spec.ts`'s subclass
   * (`this.sessionRegistry.has(deviceId)`) keeps reading the SAME live
   * registry `SessionDispatchController` mutates, after the extraction.
   */
  protected get sessionRegistry(): DetectionSessionRegistry {
    return this.session!.sessionRegistry
  }
  // Production code never reads the getter above — it reaches
  // `this.session!.sessionRegistry` directly (mirrors `audioSubscriptions`).
  /**
   * Single composite unsubscribe for the ten detection-wiring event-bus
   * subscriptions (S9 extraction — see `orchestrator-subscriptions.ts`).
   * Replaces the former ten separate `unsub*` fields + `profileSlotTimers`
   * (now a closure-local `Map` inside that module).
   */
  private unsubOrchestratorSubscriptions: Unsubscribe | null = null
  /** Per-camera pipeline watchdog (heartbeat + bounded auto-recovery). */
  private pipelineWatchdog: PipelineWatchdog | null = null
  private static readonly WATCHDOG_INTERVAL_MS = 30_000

  // `cameraFpsMap`/`loadShedState`/`loadShedResumeTimer`/`shedInFlight`/the
  // grace-period first-seen tracker moved to `LoadShedController` (S8
  // extraction, cluster C15) — call `this.loadShed!.<method>(...)`.
  // `slotReadRetryTimers`/`slotReadRetryAttempts`/`SLOT_READ_MAX_RETRIES`/
  // `SLOT_READ_RETRY_BASE_MS`/`reconcileTimer`/`reconcileInFlight`/
  // `reconcileRerunRequested`/`pendingRetryDebounceTimer`/
  // `pendingRetryInFlight`/`pendingRetryRerunRequested`/
  // `attachmentReconcileInFlight`/`remoteHealthAttempts` moved to
  // `ReconcileController` (S9 extraction, cluster C8) — call
  // `this.reconcile!.<method>(...)`.
  /** Periodic `retryPendingDispatches` safety-net timer (T3) — stays addon-owned (mirrors `autoRebalanceTimer`). */
  private pendingRetryTimer: ReturnType<typeof setInterval> | null = null
  /** Periodic auto-rebalance sweep timer (drift correction under hysteresis). */
  private autoRebalanceTimer: ReturnType<typeof setInterval> | null = null
  /** Node-stress five-minute statistics + its flush timer (see
   *  `node-stress-history-producer.ts`). `observe` mode's first durable output. */
  private nodeStressLts: NodeStressHistoryProducer | null = null
  private nodeStressLtsTimer: ReturnType<typeof setInterval> | null = null
  // `autoRebalanceInFlight` moved to `PlacementService` (S8 extraction).
  private initTimestamp = 0
  /** Storage migration maintenance lease. It only gates dispatch; it does not
   * change any camera wrapper or persistent pipeline configuration. */
  private storageMigrationLeaseId: string | null = null
  /** In-memory disk-wins fleet job — start returns immediately; poll status. */
  private readonly diskReconcileJob = createDiskReconcileJobRunner()

  constructor() {
    super({})
  }

  /**
   * Build the {@link OrchestratorBootstrapDeps} bag `buildOrchestratorControllers`
   * (`orchestrator-bootstrap.ts`, S11 Task 4) needs — every addon-owned
   * method/field its construction closures read that stays on this class
   * (never moved). Built fresh on every `onInitialize` call, with full
   * privileged `this` access (these are `private`/`protected` members that
   * an external function cannot reach directly).
   */
  private buildBootstrapDeps(): OrchestratorBootstrapDeps {
    return {
      ctx: () => this.ctx,
      ctxIfReady: () => this.ctxIfReady,
      failoverPolicy: () => this.failoverPolicy,
      initTimestamp: this.initTimestamp,
      watchdogIntervalMs: PipelineOrchestratorAddon.WATCHDOG_INTERVAL_MS,
      attachOn: (nodeId, config) => this.attachOn(nodeId, config),
      detachOn: (nodeId, deviceId) => this.detachOn(nodeId, deviceId),
      readPipelinePin: (deviceId) => this.readPipelinePin(deviceId),
      getEligibleInferenceDevices: (nodeId, read) =>
        this.resolveEligibleInferenceDevices(nodeId, read),
      getEligibleInferenceDevicesIfCached: (nodeId) =>
        this.resolveEligibleInferenceDevicesIfCached(nodeId),
      forgetInferenceDeviceProbe: (nodeId) => this.forgetInferenceDeviceProbe(nodeId),
      noteShareTopologyChange: (trigger) => this.noteShareChange(trigger),
      isNodeInferenceUsable: (nodeId) => this.isNodeInferenceUsable(nodeId),
      getInferenceDeviceCaps: (nodeId) => this.getInferenceDeviceCaps(nodeId),
      readPipelineDevicePin: (deviceId) => this.readPipelineDevicePin(deviceId),
      subscribeToAudioAnalyzerReadiness: (nodeId) => this.subscribeToAudioAnalyzerReadiness(nodeId),
      emitResolvedCameraUpdated: (deviceId) => this.emitResolvedCameraUpdated(deviceId),
      applyRuntimeSettings: (config) => this.applyRuntimeSettings(config),
      isCapActiveForDevice: (deviceId, capName) => this.isCapActiveForDevice(deviceId, capName),
      isAudioAnalysisActive: (deviceId) => this.isAudioAnalysisActive(deviceId),
      deviceHasOnboardMotionCap: (deviceId) => this.deviceHasOnboardMotionCap(deviceId),
      deviceHasActivitySignalCap: (deviceId) => this.deviceHasActivitySignalCap(deviceId),
      deviceHasNativeObjectDetectionCap: (deviceId) =>
        this.deviceHasNativeObjectDetectionCap(deviceId),
      handleDeviceRegistered: (deviceId) => this.handleDeviceRegistered(deviceId),
      handleDeviceUnregistered: (deviceId) => this.handleDeviceUnregistered(deviceId),
      handleSettingsChanged: (deviceId) => this.handleSettingsChanged(deviceId),
      handlePipelineCameraUpdated: (deviceId, config) =>
        this.handlePipelineCameraUpdated(deviceId, config),
      handleInferenceResult: (payload) => this.handleInferenceResult(payload),
      isSessionCamera: (deviceId) => this.isSessionCamera(deviceId),
      isIdleSessionCamera: (deviceId) => this.isIdleSessionCamera(deviceId),
      deviceSettingsSchema: () => this.deviceSettingsSchema(),
      resolveGlobalStore: () => this.resolveGlobalStore(),
      baseUpdateGlobalSettings: (patch) => super.updateGlobalSettings(patch),
      watchCapability: (capNames, handlers) => this.watchCapability(capNames, handlers),
      state: this.state.bind(this),
      rebalance: (opts) => this.rebalance(opts),
      maintenancePaused: () => this.storageMigrationLeaseId !== null,
      benchmarkNodeId: () => this.nodeBenchmark?.modeNodeId() ?? null,
      placementStats: this.placementStats,
      setTopology: (topology) => {
        this.topology = topology
      },
      setReconcile: (reconcile) => {
        this.reconcile = reconcile
      },
      setNodeLifecycle: (nodeLifecycle) => {
        this.nodeLifecycle = nodeLifecycle
      },
      setAudio: (audio) => {
        this.audio = audio
      },
    }
  }

  protected async onInitialize(): Promise<AddonInitResult<PipelineOrchestratorActions>> {
    this.initTimestamp = Date.now()

    // Record kinds (D881, phase 2 steps 12-15) — declared FIRST, before any
    // store or controller that depends on them.  hub-only: the addon's
    // execution.placement is `hub-only`, so ctx.records is always present.
    const records = this.ctx.records
    if (records === undefined) {
      throw new Error('pipeline-orchestrator (hub) needs ctx.records — check execution.placement')
    }
    await records.declare(orchestratorRecordKinds)

    // Controller construction — see `orchestrator-bootstrap.ts` (S11 Task 4)
    // for the full former `onInitialize` body (construction order,
    // per-controller dep-closure reasoning, subscription wiring, readiness
    // seed, and the eager reconcile — all moved verbatim, same order).
    const controllers = await buildOrchestratorControllers(this.buildBootstrapDeps())
    this.ledger = controllers.ledger
    this.topology = controllers.topology
    this.loadService = controllers.loadService
    this.audio = controllers.audio
    this.settingsStore = controllers.settingsStore
    this.loadShed = controllers.loadShed
    this.nodeStress = controllers.nodeStress
    this.placement = controllers.placement
    this.session = controllers.session
    this.readSessionPlacement = controllers.sessionPlacement
    this.readShareSource = controllers.shareSource
    // Every balancer, the share election and the stress failover read node
    // shares through the effective source from here on (D750).
    this.settingsStore.setEffectiveNodeWeights(() => this.effectiveShares().nodeWeights())
    this.effectiveShares().start()
    this.noteShareChange('startup')
    this.deviceConfig = controllers.deviceConfig
    this.cameraStatusService = controllers.cameraStatusService
    this.cameraSwitchService = controllers.cameraSwitchService
    this.reconcile = controllers.reconcile
    this.nodeLifecycle = controllers.nodeLifecycle
    this.pipelineWatchdog = controllers.pipelineWatchdog
    this.zoneRulesProvider = controllers.zoneRulesProvider
    this.zonesProvider = controllers.zonesProvider
    this.detectionWiring = controllers.detectionWiring
    this.localNodeId = controllers.localNodeId
    this.unsubAgentOnline = controllers.unsubAgentOnline
    this.unsubAgentOffline = controllers.unsubAgentOffline
    this.startRebalanceSuggestion()
    this.unsubOrchestratorSubscriptions = controllers.unsubOrchestratorSubscriptions
    this.pendingRetryTimer = controllers.pendingRetryTimer
    this.autoRebalanceTimer = controllers.autoRebalanceTimer
    this.nodeStressLts = controllers.nodeStressLts
    this.nodeStressLtsTimer = controllers.nodeStressLtsTimer
    this.startBootPinSweep()
    await this.initNodeBenchmark()

    // Widget bundle contribution — pipeline-orchestrator owns the
    // detection-state surface, so the per-camera "Pipeline quick stats"
    // KPI block lives here. Admin-ui's <WidgetRegistryProvider> imports
    // /api/addon-widgets/pipeline-orchestrator/widgets.mjs?v=<mtime>;
    // <WidgetSlot widgetId="pipeline-orchestrator/pipeline-quick-stats"/>
    // mounts it from form contributions or dashboard layouts.
    const widgetsProvider: IAddonWidgetsSourceProvider = {
      listWidgets: async () => pipelineOrchestratorWidgets,
    }

    // Boot has settled: every controller is built. From here the owner may say
    // which model the operator chose (D651).
    this.clusterModelChoiceReady = true

    return {
      providers: [
        { capability: pipelineOrchestratorCapability, provider: this },
        // D12 re-home: the per-device settings contribution (motion/pipeline
        // tabs + zones top-tab) rides this device-scoped defaultActive wrapper
        // so it auto-binds to every camera and the binding-driven aggregate
        // invokes it. `this` already implements the three contribution methods.
        { capability: cameraPipelineConfigCapability, provider: this },
        { capability: zonesCapability, provider: this.zonesProvider },
        { capability: zoneRulesCapability, provider: this.zoneRulesProvider },
        { capability: addonWidgetsSourceCapability, provider: widgetsProvider },
        // A forgotten node's pipeline data is removed / its camera pins re-pointed (#265).
        {
          capability: nodeRemovalHookCapability,
          provider: createNodeRemovalHook(this.nodeRemovalDeps()),
        },
        // Serve the CamStack viewer web SPA (dist staged into assets/viewer by
        // the viewer repo's copy-dist-to-orchestrator.js). The hub's main.ts
        // mounts it at /viewer/camstack; it 404s cleanly when nothing is staged.
        { capability: viewerUiCapability, provider: createViewerUiProvider() },
        // Cluster colour table (D940). One key in this addon's settings store.
        {
          capability: displayPaletteCapability,
          provider: createDisplayPaletteProvider(this.ctx.settings, this.ctx.logger),
        },
      ],
      customActions: pipelineOrchestratorActions,
      actionHandlers: {
        dumpState: async () => this.dumpDiagnostics(),
        rebalanceNow: async () => this.rebalanceNow(),
        nodeStressStats: async (input: NodeStressStatsInput): Promise<NodeStressStatsOutput> => {
          const lts = this.nodeStressLts
          const moves = this.nodeStress?.historyView() ?? []
          if (!lts) return { rows: [], open: [], moves: [...moves] }
          const rows = await lts.read(input)
          return {
            rows: rows.map(withStatsMean),
            open: lts.openBuckets().map(withStatsMean),
            moves: [...moves],
          }
        },
      },
    }
  }

  /**
   * Build the diagnostic snapshot exposed via the `dumpState` custom action.
   * Pure read — never mutates state. Extracted from `handleCustomAction` so
   * tests can assert the snapshot shape directly without going through the
   * dispatcher.
   */
  private dumpDiagnostics(): OrchestratorDiagnostics {
    return {
      localNodeId: this.localNodeId,
      knownRunnerNodes: [...this.topology!.knownRunnerNodeIds()].toSorted(),
      cachedAgentLoadNodeIds: [...this.loadService!.cachedAgentLoadNodeIds()].toSorted(),
      enabledNodes: [...this.topology!.enabledNodes],
      enabledDecoderNodes: [...this.topology!.enabledDecoderNodes],
      enabledAudioNodes: [...this.topology!.enabledAudioNodes],
      enabledIngestNodes: [...this.topology!.enabledIngestNodes],
      clusterRoles: { ...this.topology!.clusterRoles },
      assignedDeviceCount: this.ledger!.assignmentCount,
      cameraConfigCount: this.ledger!.configCount,
      activeDetectionCount: this.detectionWiring!.activeDetectionCount,
    }
  }

  protected async onShutdown(): Promise<void> {
    // First: a shutting-down owner stops answering the model choice (D651).
    this.clusterModelChoiceReady = false
    // Mark audio shutdown BEFORE tearing down handles / clearing the maps
    // below. From here on, queued/new `withAudioSubLock` sections become
    // no-ops and `storeAudioSub` refuses to store — so no critical section
    // that was in-flight (or queued) when shutdown began can resurrect a
    // zombie subscription into the cleared `audioSubscriptions` map.
    this.audio!.beginShutdown()
    // Session shutdown guard + registry/motion-watch clears — see
    // `SessionDispatchController.shutdown`'s doc comment for the proof that
    // consolidating the former three scattered statements (flag set here,
    // `sessionRegistry.clear()`/`sessionLocks.clear()` later after
    // `reconcile.dispose()`/`pipelineWatchdog.stop()`,
    // `motionWatchByDevice.clear()` later still after `audio.shutdown()`)
    // into one call here is behavior-preserving.
    this.session!.shutdown()
    // Cancel the periodic pending-retry safety-net timer + the periodic
    // auto-rebalance sweep — both addon-owned intervals (mirrors the former
    // two independent clears; unaffected by the S9 extraction below).
    if (this.pendingRetryTimer !== null) {
      clearInterval(this.pendingRetryTimer)
      this.pendingRetryTimer = null
    }
    if (this.autoRebalanceTimer !== null) {
      clearInterval(this.autoRebalanceTimer)
      this.autoRebalanceTimer = null
    }
    if (this.nodeStressLtsTimer !== null) {
      clearInterval(this.nodeStressLtsTimer)
      this.nodeStressLtsTimer = null
    }
    if (this.nodeBenchmarkTimer !== null) {
      clearInterval(this.nodeBenchmarkTimer)
      this.nodeBenchmarkTimer = null
    }
    this.autoBenchmark?.stop()
    this.autoBenchmark = null
    this.nodeStressLts = null
    // Tear down detection-wiring subscriptions and active detections first
    // so no events land while the rest of the addon is being disposed. The
    // composite unsubscribe (S9: `orchestrator-subscriptions.ts`) also
    // cancels the profile-slot debounce timers internally — bundling that
    // cancel with the ten unsubs (rather than clearing it separately,
    // earlier, as before S9) is behavior-preserving: this entire prefix of
    // `onShutdown`, from here through the `activeDetections` release loop
    // below, is fully synchronous — no `await` — so no debounced callback
    // could ever observe an intermediate state regardless of the exact
    // statement order within it.
    this.unsubOrchestratorSubscriptions?.()
    this.unsubOrchestratorSubscriptions = null
    // Reconcile debounce/in-flight timers, slot-read retry timers, and the
    // remote-health backoff ledger — see `ReconcileController.dispose`
    // (S9 extraction, cluster C8). Same synchronous-prefix reasoning as above
    // justifies bundling former scattered clears (`reconcileTimer`,
    // `pendingRetryDebounceTimer`, `slotReadRetryTimers`/`Attempts`,
    // `remoteHealthAttempts`) into one call here.
    this.reconcile?.dispose()

    this.pipelineWatchdog?.stop()
    this.pipelineWatchdog = null
    // `loadShed.dispose()` clears `cameraFpsMap`/`loadShedState` + the resume
    // timer (mirrors the former inline three-statement block exactly); the
    // FIELD itself is nulled later, alongside `ledger`/`placement` — mirrors
    // `audio`'s early-dispose-late-null pattern in this same method.
    this.loadShed?.dispose()
    // Stops the 15s sweep timer and drops the sample ring / state carriers.
    this.nodeStress?.dispose()

    // Full audio teardown (lazy-teardown timers, subscriptions, lock,
    // assignment/readiness maps) — see `AudioSubscriptionController.shutdown`'s
    // doc comment for the proof that combining the former two separate
    // blocks here is behavior-preserving.
    this.audio!.shutdown()

    for (const deviceId of this.detectionWiring!.activeDetectionDeviceIds()) {
      try {
        await this.releaseCamera({ deviceId })
      } catch (err: unknown) {
        const msg = errMsg(err)
        this.ctx.logger.debug('releaseCamera failed during shutdown', {
          tags: { deviceId },
          meta: { error: msg },
        })
      }
    }
    this.detectionWiring!.clear()
    this.detectionWiring = null

    this.unsubAgentOffline?.()
    this.unsubAgentOffline = null
    this.stopRebalanceSuggestion()
    this.effectiveSharesService?.stop()
    this.unsubAgentOnline?.()
    this.unsubAgentOnline = null
    // Readiness subscriptions + the shared/local `ReadinessRegistry` —
    // see `NodeLifecycleHandler.dispose` (S9 extraction, cluster C6 + C7-detection).
    this.nodeLifecycle?.dispose()
    this.nodeLifecycle = null
    this.reconcile = null
    this.ledger?.dispose()
    this.ledger = null
    this.loadService?.dispose()
    this.loadService = null
    this.loadShed = null
    this.nodeStress = null
    this.placement = null
    this.session = null
    this.audio = null
    this.topology = null
    this.zonesProvider = null
    this.zoneRulesProvider = null
    this.cameraStatusService = null
    this.cameraSwitchService = null
    this.deviceConfig = null
    // Signal the abort flag LAST — any `waitForAgentAndCatalog` resolve
    // still in flight (smell #20) observes it on its next loop-condition
    // check and throws a clean abort instead of continuing to retry
    // against this now-tearing-down addon.
    this.settingsStore?.dispose()
    this.settingsStore = null
  }

  // ── In-process dispatch surface (local-only, not in cap def) ──────────
  //
  // `dispatchCamera`/`releaseCamera`/`assignPipeline`/`unassignPipeline`/
  // `rebalance`/`getPipelineAssignments`/`getPipelineAssignment` are thin
  // delegates onto `PlacementService` (S8 extraction, cluster C3) — they
  // MUST stay directly on this class because `provider: this` registers the
  // addon instance itself for `pipelineOrchestratorCapability`, and
  // `dispatchCamera`/`releaseCamera` are required by
  // `IPipelineOrchestratorLocalProvider`. See `placement-service.ts`.

  async dispatchCamera(runnerConfig: RunnerCameraConfig): Promise<DispatchResult> {
    if (this.storageMigrationLeaseId !== null) return { success: true, kind: 'pending' }
    return this.placement!.dispatchCamera(runnerConfig)
  }

  async pauseForStorageMigration(input: { leaseId: string }): Promise<{ paused: true }> {
    if (this.storageMigrationLeaseId !== null && this.storageMigrationLeaseId !== input.leaseId) {
      throw new Error('pipeline dispatch is already paused by another storage migration')
    }
    this.storageMigrationLeaseId = input.leaseId
    try {
      await this.placement!.waitForMigrationIdle()
      return { paused: true }
    } catch (err) {
      this.storageMigrationLeaseId = null
      throw err
    }
  }

  async resumeForStorageMigration(input: { leaseId: string }): Promise<{ resumed: true }> {
    if (this.storageMigrationLeaseId === null) return { resumed: true }
    if (this.storageMigrationLeaseId !== input.leaseId) {
      throw new Error('pipeline storage migration lease does not match')
    }
    this.storageMigrationLeaseId = null
    return { resumed: true }
  }

  async releaseCamera(input: { deviceId: number }): Promise<{ success: true }> {
    return this.placement!.releaseCamera(input)
  }

  // ── IPipelineOrchestratorProvider (cap surface) ──────────────────────

  async assignPipeline(input: {
    deviceId: number
    agentNodeId: string
  }): Promise<{ success: true }> {
    return this.placement!.assignPipeline(input)
  }

  async unassignPipeline(input: { deviceId: number }): Promise<{ success: true }> {
    return this.placement!.unassignPipeline(input)
  }

  async setPipelineDevicePin(input: {
    deviceId: number
    deviceKey: string
  }): Promise<{ success: true }> {
    return this.placement!.setPipelineDevicePin(input)
  }

  async getPipelineDevicePin(input: { deviceId: number }): Promise<{ deviceKey: string | null }> {
    return { deviceKey: await this.readPipelineDevicePin(input.deviceId) }
  }

  async rebalance(opts?: RebalanceOptions): Promise<RebalanceResult> {
    return this.placement!.rebalance(opts)
  }

  /**
   * The `rebalanceNow` custom action: a manual rebalance, and the verdict on
   * the suggestion alert that offered it. Every branch is logged.
   */
  private async rebalanceNow(): Promise<{ migrated: number; skipped: number }> {
    const alertId = REBALANCE_SUGGESTED_ALERT_ID
    try {
      const result = await this.rebalance({ minImprovement: 0 })
      const message = `${String(result.migrated)} ${result.migrated === 1 ? 'camera' : 'cameras'} moved`
      this.ctx.logger.info('rebalanceNow: done', {
        meta: { migrated: result.migrated, skipped: result.skipped.length },
      })
      await this.ctx.api.alerts.update
        .mutate({
          alertId,
          patch: { status: 'completed', message, updatedAt: Date.now() },
        })
        .catch((err: unknown) =>
          this.ctx.logger.warn('rebalanceNow: could not close the suggestion alert', {
            meta: { error: errMsg(err) },
          }),
        )
      return { migrated: result.migrated, skipped: result.skipped.length }
    } catch (err: unknown) {
      const reason = errMsg(err)
      this.ctx.logger.error('rebalanceNow: failed', {
        meta: { error: reason },
      })
      await this.ctx.api.alerts.update
        .mutate({
          alertId,
          patch: {
            status: 'failed',
            message: `Rebalance failed: ${reason}`,
            updatedAt: Date.now(),
          },
        })
        .catch((e: unknown) =>
          this.ctx.logger.warn('rebalanceNow: could not mark the suggestion alert failed', {
            meta: { error: errMsg(e) },
          }),
        )
      throw err
    }
  }

  private startRebalanceSuggestion(): void {
    const ctx = this.ctx
    const suggestion = new RebalanceSuggestion({
      addonId: 'pipeline-orchestrator',
      logger: ctx.logger,
      debounceMs: DEFAULT_SUGGESTION_DEBOUNCE_MS,
      now: () => Date.now(),
      plan: (minImprovement) => this.rebalance({ minImprovement, dryRun: true }),
      enabledNodes: () => this.topology?.enabledNodes ?? [],
      runnerNodes: () => this.topology?.collectRunnerNodeIds() ?? [],
      nodeName: async (nodeId) => {
        try {
          const directory = await ctx.api.nodes.directory.query()
          return directory.nodes.find((n) => n.id === nodeId)?.name ?? null
        } catch {
          return null
        }
      },
      alerts: {
        emit: (alert) => ctx.api.alerts.emit.mutate(alert),
        complete: (alertId) =>
          ctx.api.alerts.update.mutate({
            alertId,
            patch: { status: 'completed', updatedAt: Date.now() },
          }),
      },
    })
    this.rebalanceSuggestion = suggestion
    this.unsubSuggestionEvents = [
      ctx.eventBus.subscribe({ category: EventCategory.AgentOnline }, (event) =>
        suggestion.noteNodeEvent({
          kind: 'joined',
          nodeId: event.data.agentId,
        }),
      ),
      ctx.eventBus.subscribe({ category: EventCategory.AgentOffline }, (event) =>
        suggestion.noteNodeEvent({
          kind: 'left',
          nodeId: event.data.agentId,
        }),
      ),
      ctx.eventBus.subscribe({ category: EventCategory.AgentUnregistered }, (event) => {
        const agentId = event.data['agentId']
        if (typeof agentId === 'string') suggestion.noteNodeEvent({ kind: 'left', nodeId: agentId })
      }),
    ]
  }

  private stopRebalanceSuggestion(): void {
    for (const unsub of this.unsubSuggestionEvents) unsub()
    this.unsubSuggestionEvents = []
    this.rebalanceSuggestion?.dispose()
    this.rebalanceSuggestion = null
  }

  getPipelineAssignments(): readonly PipelineAssignment[] {
    return this.placement!.getPipelineAssignments()
  }

  getPipelineAssignment(input: { deviceId: number }): PipelineAssignment | null {
    return this.placement!.getPipelineAssignment(input)
  }

  /**
   * Per-camera live metrics. Centralised entry point for the UI: the
   * orchestrator owns the device→agent assignment map, so it knows
   * which runner holds the camera and can route the cap call to the
   * exact node. Calling `pipelineRunner.getCameraMetrics` directly
   * from the UI breaks in multi-agent setups because the hub-side cap
   * router resolves the runner singleton against the registry's first-
   * registered provider, which races between agents and may not be the
   * one the orchestrator actually dispatched the camera to.
   */
  async getCameraMetrics(input: { deviceId: number }): Promise<CameraMetrics | null> {
    // Check if this camera is load-shed paused — return synthetic metrics
    if (this.loadShed!.isPaused(input.deviceId)) {
      return {
        detectionMode: 'on-motion' as PipelinePhaseMode,
        configuredFps: 0,
        actualFps: 0,
        queueDepth: 0,
        avgInferenceTimeMs: 0,
        droppedFrames: 0,
        phase: 'load-shed',
      }
    }
    const assignment = this.ledger!.getAssignment(input.deviceId)
    if (!assignment) return null
    const api = this.ctx.api
    if (!api) return null
    const result = await api.pipelineRunner.getCameraMetrics.query({
      deviceId: input.deviceId,
      nodeId: assignment.agentNodeId,
    })
    return result ?? null
  }

  /**
   * Live snapshot of every runner's load. Triggers a fresh
   * `collectAgentLoad()` on each call so the UI's "Live load" panel
   * always reflects reality — the in-memory cache is only populated
   * during dispatch / rebalance, so without a refresh here the panel
   * would stay empty until the next dispatch event (problematic after
   * a server restart that rehydrates assignments from disk without
   * re-dispatching).
   */
  /**
   * The operator's stored model choice for a cluster-scoped step (D651).
   * Answers `owner-not-ready` from the first line of `onShutdown`: an owner
   * that is tearing down must not answer at all. (Before `onInitialize`
   * returns nobody can reach this method — see `clusterModelChoiceReady`.)
   */
  async getClusterModelChoice(input: { stepId: string }): Promise<ClusterModelChoice> {
    if (!this.clusterModelChoiceReady) {
      return decideClusterModelChoice(input.stepId, 'owner-not-ready')
    }
    return decideClusterModelChoice(
      input.stepId,
      await this.readStoredGlobalKey(clusterModelSettingKey(input.stepId)),
    )
  }

  /**
   * D691 — one occupancy burst at the end of a pending flip's sustain window,
   * asked by the notification centre. See `requestEarlyLook` in
   * `occupancy-recheck-controller.ts` for the bound and the refusals.
   */
  async requestOccupancyLook(input: OccupancyLookRequest): Promise<OccupancyLookAnswer> {
    const session = this.session
    if (session === null) return { scheduled: false, refusedBecause: 'no-burst-producer' }
    const answer = session.requestEarlyOccupancyLook(input.deviceId, input.afterMs, input.reason)
    return answer.scheduled
      ? { scheduled: true, dueInMs: answer.dueInMs }
      : { scheduled: false, refusedBecause: answer.refusedBecause }
  }

  async getAgentLoad(): Promise<readonly AgentLoadSummary[]> {
    // Refresh the per-node decode hwaccel BEFORE collecting load so the summaries
    // built by `refreshAgentLoadCache` carry a fresh `decodeHwaccel` (UI path
    // only — the balancer's internal `collectAgentLoad` calls skip this).
    await this.loadService!.refreshDecodeHwaccels()
    await this.loadService!.collectAgentLoad()
    return this.loadService!.reportedAgentLoad()
  }

  async getGlobalMetrics(): Promise<PipelineOrchestratorGlobalMetrics> {
    const summaries = await this.getAgentLoad()
    const onlineAgents = summaries.filter((s) => s.online).length
    let totalCameras = 0
    let attachedCameras = 0
    let activeCameras = 0
    let weightedInferenceMs = 0
    let totalQueueDepth = 0
    for (const s of summaries) {
      totalCameras += s.load.attachedCameras
      attachedCameras += s.load.attachedCameras
      activeCameras += s.load.activeCameras
      weightedInferenceMs += s.load.avgInferenceTimeMs * s.load.attachedCameras
      totalQueueDepth += s.load.queueDepthTotal
    }
    const avgInferenceTimeMs = attachedCameras > 0 ? weightedInferenceMs / attachedCameras : 0
    return {
      totalAgents: summaries.length,
      onlineAgents,
      totalCameras,
      attachedCameras,
      activeCameras,
      avgInferenceTimeMs,
      queueDepth: totalQueueDepth,
    }
  }

  // ── Internals ─────────────────────────────────────────────────────────

  /**
   * Thin seams onto `PlacementService.attachOn`/`.detachOn` (S8 extraction).
   * Kept as class-level wrapper methods — rather than rewriting every call
   * site to `this.placement!.attachOn(...)` — specifically so every existing
   * `this.attachOn`/`this.detachOn` caller (including the `attachOn`/
   * `detachOn` closures wired into `SessionDispatchController`'s deps, S11
   * Task 2) stays byte-for-byte unchanged. See `placement-service.ts` for
   * the actual attach/detach body (the single `frameSource` choke point).
   */
  private async attachOn(nodeId: string, config: RunnerCameraConfig): Promise<void> {
    return this.placement!.attachOn(nodeId, config)
  }

  private async detachOn(nodeId: string, deviceId: number): Promise<void> {
    return this.placement!.detachOn(nodeId, deviceId)
  }

  // `resolveDecoderNode` removed together with the advisory decoder surface:
  // decode is always co-located with its frame consumer (the shm ring is
  // node-local; an off-owner detection node decodes locally via its satellite
  // plane), so there is no decoder-placement decision to make.

  /**
   * Cap surface: the cluster's single camera-source owner + its
   * LAN-reachable host — see `node-topology.ts` (`NodeTopologyService.getIngestOwner`,
   * S6 extraction).
   */
  async getIngestOwner(): Promise<IngestOwner> {
    return this.topology!.getIngestOwner()
  }

  /**
   * Resolve the persisted pipeline-node pin for a device. `pipelineNodeId` is
   * the canonical key (matching the sibling `audioNodeId`
   * `'auto'`-sentinel pattern); the legacy `preferredAgent` key is a read-only
   * fallback kept for backward compatibility with stores written before the
   * unification. A single device-store read serves both. Returns a concrete
   * node id, or `null` when neither key holds a pin (auto-balance).
   */
  private async readPipelinePin(deviceId: number): Promise<string | null> {
    const pin = await this.readStoredPipelinePin(deviceId)
    // Benchmark mode (D791): a pin naming the node under test is ignored for
    // a camera another node can serve — read-time only, never rewritten, so
    // ending the mode restores it.
    return pinUnderBenchmark(
      pin,
      this.nodeBenchmark?.modeNodeId() ?? null,
      this.topology?.detectionEligibleNodesIgnoringBenchmark(deviceId) ?? [],
    )
  }

  /** The stored node pin as written — see {@link readPipelinePin} for the placement view. */
  private async readStoredPipelinePin(deviceId: number): Promise<string | null> {
    const ctx = this.ctx
    if (!ctx?.settings) return null
    try {
      const settings = await this.ctx.settings!.readDeviceStore(deviceId)
      const pipelinePin = settings['pipelineNodeId']
      if (typeof pipelinePin === 'string' && pipelinePin.length > 0 && pipelinePin !== 'auto') {
        return pipelinePin
      }
      const legacy = settings[PREFERRED_AGENT_SETTING]
      return typeof legacy === 'string' && legacy.length > 0 ? legacy : null
    } catch {
      return null
    }
  }

  /**
   * Resolve the persisted node+device pin for a camera (multi-device C4/D5).
   * `pipelineDeviceKey` is the sibling of `pipelineNodeId` in the device store —
   * a SOFT L1 device affinity honoured by the second `balance()` pass (mirrors
   * the node-level `pipelineNodeId` soft pin). Returns a concrete deviceKey, or
   * `null` for auto (no device pin).
   */
  private async readPipelineDevicePin(deviceId: number): Promise<string | null> {
    const ctx = this.ctx
    if (!ctx?.settings) return null
    try {
      const settings = await this.ctx.settings!.readDeviceStore(deviceId)
      const pin = settings['pipelineDeviceKey']
      return typeof pin === 'string' && pin.length > 0 && pin !== 'auto' ? pin : null
    } catch {
      return null
    }
  }

  // `buildNodeCaps`/`buildNodeWeights` moved to `PipelineSettingsStore`
  // (S4 extraction) — call `this.settingsStore!.buildNodeCaps()` /
  // `.buildNodeWeights()`.

  // `readAudioNodePin`/`collectAudioNodeLoad`/`recordAudioAssignment`/
  // `dispatchAudio` moved to `AudioSubscriptionController` (S7 extraction)
  // — call `this.audio!.dispatch(deviceId)` / `.getNodeLoad()` / etc.

  // `handleNodeDisconnect`/`handleNodeConnect`/`subscribeToDetectionPipelineReadiness`/
  // `unsubscribeDetectionPipelineReadiness`/`handleDetectionPipelineReadiness`/
  // `reattachStaleEmpties` moved to `NodeLifecycleHandler` (S9 extraction,
  // cluster C6 + C7-detection) — call `this.nodeLifecycle!.<method>(...)`.
  // The Phase 3 slice 2 `isSessionCamera` guards inside
  // `handleNodeDisconnect`/`handleNodeConnect`'s `'restore'` path moved
  // VERBATIM (proved by `standing-machinery-on-motion-scope.spec.ts`).

  /**
   * Subscribe to `audio-analyzer` readiness transitions for `nodeId`.
   * Idempotent — re-subscribing the same node is a no-op (uses its own
   * key space separate from detection readiness subscriptions). Reaches the
   * single shared/local `ReadinessRegistry` `NodeLifecycleHandler` owns
   * (S9) via its `readinessRegistry` accessor — no second parallel registry.
   */
  private subscribeToAudioAnalyzerReadiness(nodeId: string): void {
    this.nodeLifecycle!.readinessRegistry.onReadyState(
      'audio-analyzer',
      { type: 'node', nodeId },
      (t) => {
        void this.audio!.handleAudioAnalyzerReadiness(t, nodeId)
      },
    )
  }

  // `handleAudioAnalyzerReadiness`/`reattachAudioForNode`/`reattachAudioForDevice`
  // moved to `AudioSubscriptionController` (S7 extraction) — call
  // `this.audio!.handleAudioAnalyzerReadiness(t, nodeId)` /
  // `.reattachForNode(nodeId)` / `.reattachForDevice(deviceId)`.

  // `scheduleReconcile`/`reconcileDispatch`/`reconcilePlacementFromRunners`/
  // `scheduleSlotReadRetry`/`clearSlotReadRetry`/`schedulePendingRetry`/
  // `retryPendingDispatches`/`handleRemoteHealthReplace` moved to
  // `ReconcileController` (S9 extraction, cluster C8) — call
  // `this.reconcile!.<method>(...)`.

  /**
   * Thin seam onto `ReconcileController.evaluateRemoteAssignmentHealth` —
   * kept as a `protected` class-level wrapper (mirrors the `attachOn`/
   * `detachOn` pattern) specifically so `remote-health.spec.ts`'s
   * orchestrator subclass (`this.evaluateRemoteAssignmentHealth()`) stays
   * byte-for-byte unchanged. See `reconcile-controller.ts` for the actual
   * body.
   */
  protected async evaluateRemoteAssignmentHealth(): Promise<void> {
    return this.reconcile!.evaluateRemoteAssignmentHealth()
  }

  /**
   * Thin seam onto `ReconcileController.retryPendingDispatches` — the same
   * `protected` pattern, for `pending-retry-catalog-wedge.spec.ts` to run one
   * sweep and bound it.
   */
  protected async retryPendingDispatches(): Promise<void> {
    return this.reconcile!.retryPendingDispatches()
  }

  // ── Capability bindings (cap methods) ────────────────────────────────

  async getCapabilityBindings(input: {
    nodeId: string
  }): Promise<Readonly<Record<string, string>>> {
    const ctx = this.ctx
    if (!ctx?.settings) return {}
    return this.settingsStore!.getCapabilityBindings(input.nodeId)
  }

  async setCapabilityBinding(input: {
    nodeId: string
    capName: string
    addonId: string
  }): Promise<{ success: true }> {
    const ctx = this.ctx
    if (!ctx?.settings)
      throw new Error('PipelineOrchestrator: setCapabilityBinding requires a settings backend')

    // Read-modify-write the WHOLE `nodeBindings` blob through the durable
    // handle (in the store) so a concurrent binding for another node/cap
    // can't be dropped.
    await this.settingsStore!.setCapabilityBinding(input.nodeId, input.capName, input.addonId)

    // Emit a typed event so each kernel process updates its preferred-provider
    // registry on the fly. Consumers subscribe in `addon-context-factory` and
    // `addon-registry.service`.
    this.ctx.eventBus?.emit(
      createEvent(
        EventCategory.CapabilityBindingChanged,
        { type: 'system', id: 'pipeline-orchestrator', nodeId: input.nodeId },
        {
          nodeId: input.nodeId,
          capName: input.capName,
          addonId: input.addonId,
        },
      ),
    )

    this.ctx.logger.info('capability binding set', {
      tags: { nodeId: input.nodeId, addonId: input.addonId },
      meta: { capName: input.capName },
    })
    return { success: true }
  }

  // The decoder-scheduling cap surface (`assignDecoder` / `unassignDecoder` /
  // `getDecoderAssignment` / `getDecoderAssignments`) was removed: decode is
  // always co-located with its frame consumer (detect ⇒ decode), so there is
  // no independent decoder placement to schedule or report. `getCameraStatus`
  // reports the broker's LIVE decode-session node ('session') or the
  // detection node ('co-located' — true by construction).

  // ── Audio scheduling cap methods ─────────────────────────────────────

  async assignAudio(input: {
    readonly deviceId: number
    readonly nodeId: string
  }): Promise<{ success: true }> {
    await this.ctx.settings?.writeDeviceStore(input.deviceId, {
      [AUDIO_NODE_SETTING]: input.nodeId,
    })
    // R6: an ineligible pin is stored but `collectAudioNodeLoad` filters by the
    // `enabledAudioNodes` whitelist, so the balancer silently auto-balances it.
    // Keep the auto-balance, but make the no-op visible to the operator.
    if (!this.topology!.enabledAudioNodes.includes(input.nodeId)) {
      this.ctx.logger.warn(
        'audio pin stored but node is not in enabledAudioNodes — pin will not take effect until enabled',
        { tags: { deviceId: input.deviceId, nodeId: input.nodeId } },
      )
    }
    // Clear cached assignment so the re-subscribe re-balances with the new pin.
    this.audio!.clearAssignment(input.deviceId)
    this.ctx.logger.info('Audio node pinned', {
      tags: { deviceId: input.deviceId, nodeId: input.nodeId },
    })
    // Apply the pin IMMEDIATELY: re-subscribe the device's audio so the fresh
    // pin takes effect now, not on some unrelated future re-dispatch.
    await this.audio!.reattachForDevice(input.deviceId)
    return { success: true }
  }

  async unassignAudio(input: { readonly deviceId: number }): Promise<{ success: true }> {
    await this.ctx.settings?.writeDeviceStore(input.deviceId, {
      [AUDIO_NODE_SETTING]: null,
    })
    this.audio!.clearAssignment(input.deviceId)
    this.ctx.logger.info('Audio node unpinned', {
      tags: { deviceId: input.deviceId },
    })
    // Apply immediately: re-subscribe so audio re-balances back to auto now.
    await this.audio!.reattachForDevice(input.deviceId)
    return { success: true }
  }

  async getAudioAssignment(input: {
    readonly deviceId: number
  }): Promise<{ nodeId: string; pinned: boolean; assignedAt: number } | null> {
    return this.audio!.getAssignment(input.deviceId)
  }

  async getAudioNodeLoad(): Promise<Array<{ nodeId: string; deviceCount: number }>> {
    return this.audio!.getNodeLoad()
  }

  async getAudioAssignments(): Promise<
    Array<{
      deviceId: number
      nodeId: string
      pinned: boolean
      assignedAt: number
    }>
  > {
    return this.audio!.getAssignments().map((a) => ({
      deviceId: a.deviceId,
      nodeId: a.nodeId,
      pinned: a.pinned,
      assignedAt: a.assignedAt,
    }))
  }

  // ── 3-level pipeline settings API (new model) ────────────────────────
  //
  // Persistence (readAgentSettingsMap/writeAgentSettings/readCameraSettingsMap/
  // writeCameraSettings/getCatalogForAgent/seedAgentSettingsFromCatalog/
  // resolvePipelineForDevice/the catalog cache) lives in `PipelineSettingsStore`
  // (S4 extraction, cluster C11). These cap methods stay here as thin
  // delegates plus whatever orchestration (rebalance, refreshNodeCapabilities,
  // redispatch, event emission) isn't the store's concern.

  async getAgentSettings(input: {
    readonly agentNodeId: string
  }): Promise<AgentPipelineSettings | null> {
    const all = await this.settingsStore!.readAgentSettingsMap()
    return all[input.agentNodeId] ?? null
  }

  async listAgentSettings(): Promise<
    readonly {
      readonly nodeId: string
      readonly settings: AgentPipelineSettings
    }[]
  > {
    const all = await this.settingsStore!.readAgentSettingsMap()
    const out: { nodeId: string; settings: AgentPipelineSettings }[] = []
    for (const [nodeId, settings] of Object.entries(all)) {
      // Defensive filter: a prior bug could persist `""` or `"undefined"`
      // as agent keys (writeAgentSettings used to accept any string).
      if (
        typeof nodeId !== 'string' ||
        nodeId.length === 0 ||
        nodeId === 'undefined' ||
        nodeId === 'null'
      ) {
        continue
      }
      let resolved = settings
      if (resolved.color === undefined) {
        resolved = { ...resolved, color: assignNodeColorId(nodeId) }
        await this.settingsStore!.writeAgentSettings(nodeId, resolved)
      }
      out.push({ nodeId, settings: resolved })
    }
    return out
  }

  async removeAgentSettings(input: {
    readonly agentNodeId: string
  }): Promise<{ success: boolean; removed: boolean }> {
    if (input.agentNodeId === 'hub') {
      this.ctx.logger.warn("removeAgentSettings: refused to evict 'hub'", {})
      return { success: false, removed: false }
    }
    const removed = await this.settingsStore!.removeAgentSettings(input.agentNodeId)
    if (!removed) {
      return { success: true, removed: false }
    }
    this.forgetInferenceDeviceProbe(input.agentNodeId)
    // Dropping a node can change the derived enabled sets (e.g. it was the
    // only extra detect-capable node) — re-derive from the mutated store.
    await this.topology!.refreshNodeCapabilities()
    this.ctx.logger.info('agentSettings entry removed', {
      tags: { nodeId: input.agentNodeId },
    })
    return { success: true, removed: true }
  }

  // Phase 2f: `setAgentEngineChoice` removed — engine ownership moved
  // to `detection-pipeline` addon global settings.

  async setAgentMaxCameras(input: {
    readonly agentNodeId: string
    readonly maxCameras: number | null
  }): Promise<{ success: true }> {
    const all = await this.settingsStore!.readAgentSettingsMap()
    const existing = all[input.agentNodeId]
    // Seed a bare skeleton when the node has no persisted settings yet so
    // the maxCameras write is not lost on the next addonDefaults seed.
    const next: AgentPipelineSettings = existing
      ? { ...existing, maxCameras: input.maxCameras }
      : { maxCameras: input.maxCameras }
    await this.settingsStore!.writeAgentSettings(input.agentNodeId, next)
    this.ctx.logger.info('agentSettings.maxCameras updated', {
      tags: { nodeId: input.agentNodeId },
      meta: { maxCameras: input.maxCameras },
    })
    // Capacity may have been freed — sweep any cameras stranded over-cap.
    this.reconcile!.schedulePendingRetry()
    return { success: true as const }
  }

  /**
   * Set one node's placement capabilities — the per-node record that replaced
   * the four flat orchestrator lists. Each flag is a tri-state patch: omit to
   * leave unchanged, `null` to reset to the node default (persisted as an
   * absent flag), `true`/`false` to force. After persisting, re-derive the
   * enabled-node sets and reconcile dispatch so the change takes effect
   * immediately (reuses the existing balancer / retry, no custom logic).
   */
  async setAgentCapabilities(input: {
    readonly agentNodeId: string
    readonly detect?: boolean | null
    readonly audio?: boolean | null
    readonly ingest?: boolean | null
  }): Promise<{ success: true }> {
    const all = await this.settingsStore!.readAgentSettingsMap()
    const existing: AgentPipelineSettings = all[input.agentNodeId] ?? {
      maxCameras: null,
    }
    // A `null` patch clears the flag (reset to node default); an omitted key
    // leaves the existing value; a boolean forces it.
    const apply = (key: 'detect' | 'audio' | 'ingest'): boolean | undefined => {
      const patch = input[key]
      if (patch === undefined) return existing[key]
      if (patch === null) return undefined
      return patch
    }
    // Strip the DEPRECATED legacy `decode` flag from the write path: decode
    // eligibility IS detect eligibility (co-location invariant), so a stale
    // persisted flag is dropped on the next capability write. The explicit
    // `decode: undefined` matters — the spread of `existing` above would
    // otherwise carry the persisted value forward.
    const next: AgentPipelineSettings = {
      ...existing,
      detect: apply('detect'),
      decode: undefined,
      audio: apply('audio'),
      ingest: apply('ingest'),
    }
    await this.settingsStore!.writeAgentSettings(input.agentNodeId, next)
    this.ctx.logger.info('agentSettings.capabilities updated', {
      tags: { nodeId: input.agentNodeId },
      meta: { detect: next.detect, audio: next.audio, ingest: next.ingest },
    })
    // Re-derive the enabled-node sets from the mutated store, then sweep any
    // cameras stranded no-frame-source under the new eligibility. Mirrors the
    // old enable/disable path (`applyRuntimeSettings` → `schedulePendingRetry`):
    // eligibility changes drive an additive, debounced re-dispatch, NOT an
    // immediate full rebalance (which would race concurrent capability edits).
    await this.topology!.refreshNodeCapabilities()
    this.topology!.addKnownRunnerNode(input.agentNodeId)
    this.reconcile!.schedulePendingRetry()
    if (input.detect !== undefined) this.noteShareChange(`node-detect:${input.agentNodeId}`)
    this.rebalanceSuggestion?.noteNodeEvent({
      kind: 'capabilities',
      nodeId: input.agentNodeId,
    })
    return { success: true as const }
  }

  /**
   * Size one node's decode admission (D365). `null` clears a limit, an
   * omitted key leaves it; the node's runner reads the entry on its next
   * lease refresh and resizes its admission — no restart.
   */
  async setAgentDecodeLimits(input: {
    readonly agentNodeId: string
    readonly decodeBudgetMb?: number | null
    readonly maxLiveDecodeWorkers?: number | null
  }): Promise<{ success: true }> {
    const all = await this.settingsStore!.readAgentSettingsMap()
    const existing: AgentPipelineSettings = all[input.agentNodeId] ?? {
      maxCameras: null,
    }
    const applyLimit = (key: 'decodeBudgetMb' | 'maxLiveDecodeWorkers'): number | undefined => {
      const patch = input[key]
      if (patch === undefined) return existing[key]
      if (patch === null) return undefined
      return patch
    }
    const next: AgentPipelineSettings = {
      ...existing,
      decodeBudgetMb: applyLimit('decodeBudgetMb'),
      maxLiveDecodeWorkers: applyLimit('maxLiveDecodeWorkers'),
    }
    await this.settingsStore!.writeAgentSettings(input.agentNodeId, next)
    this.ctx.logger.info('agentSettings.decodeLimits updated', {
      tags: { nodeId: input.agentNodeId },
      meta: {
        decodeBudgetMb: next.decodeBudgetMb,
        maxLiveDecodeWorkers: next.maxLiveDecodeWorkers,
      },
    })
    return { success: true as const }
  }

  /**
   * Set (or clear) the per-node `reachableHost` override — the LAN host a
   * cross-node decoder dials to reach this node's restream. A non-empty string
   * overrides the auto-detected host the runner would otherwise derive from
   * `CAMSTACK_HUB_URL`; `null` or an empty string clears it (revert to
   * auto-detect). Persisted onto the node's `agentSettings` entry, then a
   * debounced re-dispatch so new cross-node attaches pick up the host.
   */
  async setAgentReachableHost(input: {
    readonly agentNodeId: string
    readonly reachableHost?: string | null
    readonly color?: NodeColorId | null
  }): Promise<{ success: true }> {
    if (input.reachableHost === undefined && input.color === undefined) {
      throw new Error('reachableHost or color required')
    }
    const all = await this.settingsStore!.readAgentSettingsMap()
    const existing = all[input.agentNodeId]
    const base: AgentPipelineSettings = existing ?? { maxCameras: null }
    let next: AgentPipelineSettings = { ...base }
    let hostPatch: string | null | undefined
    if (input.reachableHost !== undefined) {
      const trimmed = input.reachableHost?.trim()
      const host = trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined
      next = { ...next, reachableHost: host }
      hostPatch = host ?? null
    }
    if (input.color !== undefined) {
      const color = input.color === null ? undefined : input.color
      next = { ...next, color }
    }
    await this.settingsStore!.writeAgentSettings(input.agentNodeId, next)
    const logMessage =
      input.reachableHost !== undefined && input.color !== undefined
        ? 'agentSettings.reachableHostAndColor updated'
        : input.color !== undefined
          ? 'agentSettings.color updated'
          : 'agentSettings.reachableHost updated'
    this.ctx.logger.info(logMessage, {
      tags: { nodeId: input.agentNodeId },
      meta: {
        ...(hostPatch !== undefined ? { reachableHost: hostPatch } : {}),
        ...(input.color !== undefined ? { color: input.color ?? null } : {}),
      },
    })
    if (input.reachableHost !== undefined) {
      // Re-derive reachableHostByNode from the mutated store — without this the
      // topology keeps the OLD host until an unrelated refresh, so getIngestOwner
      // and every new attach payload's ownerReachableHost stay stale.
      await this.topology!.refreshNodeCapabilities()
      // A host change only affects NEW cross-node attaches — sweep pending so a
      // camera stranded by a previously-wrong host can re-attach with the fix.
      this.reconcile!.schedulePendingRetry()
    }
    return { success: true as const }
  }

  /**
   * Set one node's multi-device inference opt-in (Phase 4 multi-device). The
   * `deviceKey → { enabled, weight }` map REPLACES the node's stored
   * `inferenceDevices` wholesale — pass the complete desired set; an empty map
   * clears the opt-in (node reverts to its single default accelerator). Seeds a
   * bare skeleton when the node has no persisted settings yet so the write is
   * not lost on the next addonDefaults seed. The dispatcher reads the enabled
   * subset via `PipelineSettingsStore.buildNodeInferenceDevices` at placement
   * time, so a change takes effect on the next dispatch/rebalance cycle — sweep
   * pending so a node newly given more capacity picks up stranded cameras.
   */
  async setAgentInferenceDevices(input: {
    readonly agentNodeId: string
    readonly inferenceDevices: Readonly<
      Record<
        string,
        {
          readonly enabled: boolean
          readonly weight?: number
          readonly maxSessions?: number
          readonly steps?: Readonly<Record<string, DeviceStepConfig>>
        }
      >
    >
  }): Promise<{ success: true }> {
    // Step-tree device jump (phase 1): reject a step `jumpDeviceKey` that points
    // at a disabled/absent device on this node, so an invalid manual override
    // never reaches the runner. Validate against the effective enabled∧available
    // set (live probe merged with the submitted map).
    const { probed } = await this.probeNodeInferenceDevices(input.agentNodeId)
    const enabledAvailableKeys = new Set(
      mergeInferenceDevices(probed, input.inferenceDevices)
        .filter((d) => d.enabled && d.available)
        .map((d) => d.key),
    )
    const jumpError = validateJumpTargets(input.inferenceDevices, enabledAvailableKeys)
    if (jumpError) {
      throw new Error(`setAgentInferenceDevices: ${jumpError}`)
    }

    const all = await this.settingsStore!.readAgentSettingsMap()
    const existing = all[input.agentNodeId]
    const next: AgentPipelineSettings = existing
      ? { ...existing, inferenceDevices: input.inferenceDevices }
      : { maxCameras: null, inferenceDevices: input.inferenceDevices }
    await this.settingsStore!.writeAgentSettings(input.agentNodeId, next)
    this.ctx.logger.info('agentSettings.inferenceDevices updated', {
      tags: { nodeId: input.agentNodeId },
      meta: {
        enabledKeys: Object.entries(input.inferenceDevices)
          .filter(([, entry]) => entry.enabled)
          .map(([key]) => key),
        // An explicit `enabled:false` is the operator switching a device OFF —
        // the write that used to be impossible (pruned payloads, 2026-08-01).
        // Log it so a durable opt-out is visible, not indistinguishable from
        // an absent (never-configured) key.
        disabledKeys: Object.entries(input.inferenceDevices)
          .filter(([, entry]) => !entry.enabled)
          .map(([key]) => key),
      },
    })
    // A stale draft can still carry a pin to a deleted model (D725): the sweep
    // drops it again, so the store never keeps what no node can serve.
    await this.resetRemovedModelPins('node-device-write')
    // Newly enabled devices add detection capacity on this node — sweep pending
    // so a camera stranded for lack of a session slot can now be placed.
    this.reconcile!.schedulePendingRetry()
    // A device switched on or off, or a model changed: the shares follow (D750).
    this.noteShareChange(`node-devices:${input.agentNodeId}`)
    return { success: true as const }
  }

  /**
   * Device-aware merged view of ONE node's inference accelerators (Phase 4
   * multi-device). Joins each physical device the node HAS — probed live via a
   * node-pinned `platformProbe.getCapabilities` — with its stored opt-in
   * (`enabled`/`weight`) and the object-detection `defaultModelId` the executor
   * would run for that deviceKey. The probe result is `PlatformCapabilities`
   * with `.devices: InferenceDeviceDescriptor[]`.
   *
   * `platform-probe` is a hub-default singleton, so a `nodePin` CONTEXT is
   * ignored by its mount — the node is targeted by passing `{ nodeId }` as the
   * cap INPUT routing selector (local node → no arg). An unreachable node
   * degrades to `reachable:false`; any stored-but-unprobed keys are still
   * surfaced as `available:false` so the operator sees the configured set.
   * NEVER throws.
   */
  async getNodeInferenceDevices(input: { readonly nodeId: string }): Promise<NodeInferenceDevices> {
    const nodeId = input.nodeId
    const stored =
      (await this.settingsStore!.readAgentSettingsMap())[nodeId]?.inferenceDevices ?? {}
    const { probed, reachable } = await this.probeNodeInferenceDevices(nodeId)
    // Each row carries WHY the dispatcher drops it (`exclusion`), computed by the
    // same `resolveInferenceDeviceEligibility` the dispatcher runs — see
    // `annotateInferenceDeviceExclusions` (D216). Read-only: this method never
    // records usability (that belongs to `resolveEligibleInferenceDevices`, which
    // the dispatch path owns) so opening the admin UI cannot move placement state.
    const catalog = await this.settingsStore!.getCatalogForNode(nodeId)
    const canRunRoot = catalog ? makeRootCapabilityGuard(catalog) : undefined
    // The pool-liveness mirror is READ here (never observed into): an operator
    // opening the page must see the same candidate set the dispatcher sees,
    // including an accelerator excluded because its Python pool is dead — that
    // exclusion is otherwise invisible, and an invisible terminal state is the
    // silent fault this whole path exists to end.
    const devices = annotateInferenceDeviceExclusions(
      mergeInferenceDevices(probed, stored),
      resolveInferenceDeviceEligibility(probed, stored, canRunRoot, (deviceKey) =>
        this.inferenceDeviceUsability.isUsable(nodeId, deviceKey),
      ),
    ).map((row) =>
      // A probe that did not answer proves nothing about the hardware: a
      // stored-only row is then UNKNOWN, never absent (D315, D919).
      !reachable && row.presence === 'absent' ? { ...row, presence: 'unknown' as const } : row,
    )
    return { nodeId, reachable, devices }
  }

  /**
   * Forget one stored device entry of a node (D919) — the settings of a device
   * the node no longer has. Refused when the node's probe did not answer (an
   * unreachable node proves nothing about its hardware) or when the probe
   * still reports the key (a present device is switched off, not forgotten).
   * Every other stored key is kept as it was.
   */
  async forgetInferenceDevice(input: {
    readonly agentNodeId: string
    readonly deviceKey: string
  }): Promise<{ success: true }> {
    const { agentNodeId: nodeId, deviceKey } = input
    const { probed, reachable } = await this.probeNodeInferenceDevices(nodeId)
    if (!reachable) {
      throw new Error(
        `forgetInferenceDevice: node "${nodeId}" did not answer its device probe — nothing is known about "${deviceKey}"`,
      )
    }
    if (probed.some((d) => d.key === deviceKey)) {
      throw new Error(
        `forgetInferenceDevice: "${deviceKey}" is present on node "${nodeId}" — switch it off instead`,
      )
    }
    const all = await this.settingsStore!.readAgentSettingsMap()
    const existing = all[nodeId]
    const stored = existing?.inferenceDevices ?? {}
    if (existing === undefined || !(deviceKey in stored)) {
      this.ctx.logger.info('inference device forget: nothing stored', {
        tags: { nodeId },
        meta: { nodeId, deviceKey },
      })
      return { success: true as const }
    }
    const remaining = Object.fromEntries(
      Object.entries(stored).filter(([key]) => key !== deviceKey),
    )
    await this.settingsStore!.writeAgentSettings(nodeId, {
      ...existing,
      inferenceDevices: remaining,
    })
    this.ctx.logger.info('inference device forgotten — its stored settings were deleted', {
      tags: { nodeId },
      meta: { nodeId, deviceKey, removed: stored[deviceKey] },
    })
    this.noteShareChange(`node-devices:${nodeId}`)
    return { success: true as const }
  }

  /**
   * The dispatcher-facing eligible inference devices for a node (audit F1/F4):
   * the enabled AND live-available accelerators as a `deviceKey → weight` map,
   * merging the live probe with the stored opt-OUT map (AUTO = all discovered
   * enabled). Empty / a single entry ⇒ the caller leaves `deviceKey` unset and
   * the runner uses its single default accelerator. NEVER throws (an
   * unreachable probe yields no eligible devices).
   */
  async resolveEligibleInferenceDevices(
    nodeId: string,
    read: EligibilityCatalogRead,
  ): Promise<Record<string, number>> {
    // Hardware ("does the node HAVE it") and pool liveness ("will the executor
    // run a frame on it") are two different questions with two different
    // authorities; only the second could have seen the 2026-08-25 blackout.
    // Read together, off the dispatch path, at the balancer's own cadence.
    const [probe, poolHealth] = await Promise.all([
      this.probeNodeInferenceDevices(nodeId),
      this.probeNodeInferenceDeviceHealth(nodeId),
    ])
    this.noteInferenceDeviceProbe(nodeId, probe, poolHealth)
    const probed = probe.probed
    // Root-capability guard: EXCLUDE any device whose engine format cannot run
    // the object-detection camera root (the always-on detector every session's
    // tracks depend on). A FIRST placement WAITS for the node's catalog before
    // electing (D650 round 3): it will wait for the same catalog to resolve
    // its pipeline anyway, and a cold cache here used to fail OPEN — electing a
    // device that cannot run the root, which then attached a camera with no
    // detector and recorded it as placed. A read nothing waits on (the session
    // controller's balancer refresher) takes ONE round instead: the unbounded
    // form ran forever per departed node (D3).
    const catalog = await this.settingsStore!.awaitCatalogForNode(
      nodeId,
      read === 'one-round' ? 'one-round' : 'unbounded',
    )
    if (catalog === null && read === 'one-round' && !this.settingsStore!.isDisposed()) {
      // Not answered within the round. Never fail open here (that is how a
      // root-less camera got attached, round 3) and never fail closed either —
      // the caller is a memo, and a failed read keeps its last answer.
      this.ctx.logger.debug(
        'inference device eligibility: node catalog not answered in one round — last answer kept',
        { tags: { nodeId }, meta: { nodeId } },
      )
      throw new Error(`inference device eligibility: node "${nodeId}" catalog not answered`)
    }
    return this.effectiveShares().deviceWeights(
      nodeId,
      await this.electableDevices(nodeId, probed, catalog),
    )
  }

  /**
   * Forget a node's last device probe (pre-ship review, M4). Called when the
   * node leaves (`AgentOffline`) and when the operator removes its settings: a
   * node that comes back with a different accelerator set must be probed
   * again, not elected against the list it left with.
   */
  forgetInferenceDeviceProbe(nodeId: string): void {
    if (!this.lastInferenceDeviceProbe.delete(nodeId)) return
    this.ctx.logger.info('inference device probe forgotten — the node left', {
      tags: { nodeId },
      meta: { nodeId },
    })
  }

  /**
   * The NON-BLOCKING sibling of {@link resolveEligibleInferenceDevices}, for
   * the RE-place paths (D650 round 3). Makes no live call to the node: the
   * device list and the pool health are the last ones it answered, the
   * catalog is the cached one. A node that has never answered any of them is
   * `unavailable` — the camera stays pending, named, and ONE background
   * refresh per node is started so the next round can place it. A cold cache
   * never fails open here: failing open on a re-place is how a camera gets
   * attached with no root.
   */
  async resolveEligibleInferenceDevicesIfCached(nodeId: string): Promise<EligibilityIfCached> {
    const known = this.lastInferenceDeviceProbe.get(nodeId)
    if (known === undefined) {
      this.refreshInferenceDeviceProbe(nodeId)
      return { kind: 'unavailable', nodeId, what: 'device-health' }
    }
    const catalog = this.settingsStore!.peekCatalogForAgent(nodeId)
    if (catalog === null) return { kind: 'unavailable', nodeId, what: 'catalog' }
    // The last answer is served, and refreshed behind it — the same
    // serve-and-revalidate the catalog uses.
    this.refreshInferenceDeviceProbe(nodeId)
    return {
      kind: 'eligible',
      eligible: this.effectiveShares().deviceWeights(
        nodeId,
        await this.electableDevices(nodeId, known, catalog),
      ),
    }
  }

  /**
   * The last device list each node's probe returned — what the re-place paths
   * elect against, with the pool-health mirror that probe updated. Written
   * when a probe COMPLETES, so a cold entry means "the node's probe has never
   * come back", never "came back with nothing".
   */
  private readonly lastInferenceDeviceProbe = new Map<
    string,
    readonly InferenceDeviceDescriptor[]
  >()
  /** Nodes with a background device probe in flight (single-flight per node). */
  private readonly inferenceProbeInFlight = new Set<string>()

  private refreshInferenceDeviceProbe(nodeId: string): void {
    if (this.inferenceProbeInFlight.has(nodeId)) return
    this.inferenceProbeInFlight.add(nodeId)
    // A background refresh never rejects into the void: a probe that throws
    // (synchronously included — the addon already shut down) keeps the last
    // known list and frees the single-flight slot.
    void Promise.resolve()
      .then(() =>
        Promise.all([
          this.probeNodeInferenceDevices(nodeId),
          this.probeNodeInferenceDeviceHealth(nodeId),
        ]),
      )
      .then(([probe, poolHealth]) => this.noteInferenceDeviceProbe(nodeId, probe, poolHealth))
      .catch((err: unknown) => {
        this.ctxIfReady?.logger.debug(
          'inference device probe refresh failed — last known list kept',
          {
            tags: { nodeId },
            meta: { nodeId, error: errMsg(err) },
          },
        )
      })
      .finally(() => {
        this.inferenceProbeInFlight.delete(nodeId)
      })
  }

  /**
   * Fold one COMPLETED probe into the pool-health mirror and the last-known
   * list. "Completed" means the node ANSWERED: a probe that could not reach
   * it (`reachable: false`) changes nothing (D49, round 4) — its empty device
   * list is not an answer, and recording it as one both wiped a good
   * last-known list and turned a never-answered node into an "answered with
   * nothing" one, so `device-health-unavailable` stopped firing after a single
   * failure. A health read that failed (`null`) changes no verdict in the
   * mirror either, but it did come back — a node whose read never comes back
   * at all is the one a re-place must not wait on, and that node never reaches
   * this line.
   */
  private noteInferenceDeviceProbe(
    nodeId: string,
    probe: InferenceDeviceProbe,
    poolHealth: readonly string[] | null,
  ): void {
    if (!probe.reachable) {
      // The probe itself already WARNed, naming the node; this says what the
      // failure did to placement state — nothing.
      this.ctx.logger.debug('inference device probe unreachable — last known device list kept', {
        tags: { nodeId },
        meta: { nodeId, known: this.lastInferenceDeviceProbe.has(nodeId) },
      })
      return
    }
    this.noteInferenceDeviceHealth(
      nodeId,
      poolHealth,
      probe.probed.map((d) => d.key),
    )
    const previous = this.lastInferenceDeviceProbe.get(nodeId)
    this.lastInferenceDeviceProbe.set(nodeId, probe.probed)
    // A device plugged in or pulled out changes no stored entry, so nothing
    // else would tell the automatic shares (or the node benchmark) until a node
    // event or the 15-minute age. The first answer of a node counts too.
    if (
      previous === undefined ||
      probedDeviceSignature(previous) !== probedDeviceSignature(probe.probed)
    ) {
      this.ctx.logger.info('inference devices: the live device set changed', {
        tags: { nodeId },
        meta: {
          nodeId,
          devices: probedDeviceSignature(probe.probed),
          first: previous === undefined,
        },
      })
      this.noteShareChange(`devices:${nodeId}`)
      this.onLiveDevicesChanged(nodeId)
    }
  }

  /** A node's live device set changed: a new device may be waiting for its first benchmark. */
  private onLiveDevicesChanged(nodeId: string): void {
    void this.autoBenchmark?.tick(`devices:${nodeId}`)
  }

  /** Eligibility from a device list + catalog; records usability like every dispatch read. */
  private async electableDevices(
    nodeId: string,
    probed: readonly InferenceDeviceDescriptor[],
    catalog: PipelineSchema | null,
  ): Promise<Record<string, number>> {
    const stored =
      (await this.settingsStore!.readAgentSettingsMap())[nodeId]?.inferenceDevices ?? {}
    // `null` only when the store was disposed mid-wait: fail open, as before.
    const canRunRoot = catalog ? makeRootCapabilityGuard(catalog) : undefined
    const eligibility = resolveInferenceDeviceEligibility(probed, stored, canRunRoot, (deviceKey) =>
      this.inferenceDeviceUsability.isUsable(nodeId, deviceKey),
    )
    const { eligible, excluded } = eligibility
    this.logInferenceDeviceShrinkage(nodeId, eligible, excluded)
    this.noteNodeInferenceUsability(nodeId, resolveNodeInferenceUsability(eligibility))
    return eligible
  }

  /**
   * Fold one usability observation into the placement mirror and announce the
   * transition.
   *
   * This is called from the SAME read the dispatcher already makes, plus the
   * session controller's background refresher — so a node's usability is
   * re-observed on the cadence placement itself runs at, without a timer of
   * its own. The mirror is what makes the answer readable synchronously by
   * `detectionEligibleNodes`' callers; see its own docblock for why it refuses
   * to act on a single bad read.
   *
   * The system event is emitted ONLY on the transition into unusable — the
   * kind is `node-inference-unavailable` and it is authorable in a rule.
   * Recovery is logged and deliberately has no event: a notification saying
   * the broken thing is no longer broken is a second rule nobody asked for.
   */
  private noteNodeInferenceUsability(nodeId: string, usability: NodeInferenceUsability): void {
    const transition = this.nodeInferenceUsability.observe(nodeId, usability.usable)
    if (transition === null) return
    if (transition === 'recovered') {
      this.ctx.logger.info('node inference recovered — back in the placement candidate set', {
        tags: { nodeId },
        meta: { eligible: usability.eligibleKeys },
      })
      return
    }
    this.ctx.logger.error(
      'node has NO usable inference device — removed from the placement candidate set',
      {
        tags: { nodeId },
        meta: {
          unavailable: usability.unavailableKeys,
          eligible: usability.eligibleKeys,
        },
      },
    )
    this.ctx.eventBus.emit({
      id: randomUUID(),
      timestamp: new Date(),
      source: {
        type: 'addon',
        id: 'pipeline-orchestrator',
        addonId: 'pipeline-orchestrator',
      },
      category: EventCategory.PipelineNodeInferenceUnavailable,
      data: { nodeId, unavailableDeviceKeys: usability.unavailableKeys },
    })
  }

  /** Can this node be given cameras? Read synchronously by the two dispatch
   *  paths before they hand `eligibleNodes` to the balancer. */
  isNodeInferenceUsable(nodeId: string): boolean {
    return this.nodeInferenceUsability.isUsable(nodeId)
  }

  /**
   * Per-node signature of the last logged eligible/excluded split, so
   * {@link logInferenceDeviceShrinkage} fires on CHANGE only. This runs on
   * every camera dispatch; without the gate it would be one line per dispatch
   * per node repeating an unchanged fact.
   */
  private readonly lastInferenceEligibilitySignature = new Map<string, string>()

  /**
   * Which nodes can still infer. Refreshed by
   * {@link resolveEligibleInferenceDevices}; read synchronously by both
   * dispatch paths so a node whose every enabled accelerator vanished stops
   * receiving cameras. agent-a was handed cameras for a whole day in
   * exactly that state.
   */
  private readonly nodeInferenceUsability = new NodeInferenceUsabilityMirror()

  /**
   * Which `(node, device)` pairs the balancer must stop choosing. Refreshed by
   * {@link resolveEligibleInferenceDevices} on the same cadence as the node
   * tier; read synchronously by `resolveInferenceDeviceEligibility`. See the
   * class docblock for why it is a mirror and not the event (D49).
   */
  private readonly inferenceDeviceUsability = new InferenceDeviceUsabilityMirror()

  /**
   * Ask ONE node's detection executor which of its inference devices it is
   * currently refusing.
   *
   * Returns the refused device keys, or **`null` when the question could not be
   * asked** — an offline node, a version-skewed executor without the method, a
   * rejected RPC. That distinction is the entire safety property: `null` is
   * dropped by {@link noteInferenceDeviceHealth} and changes no verdict, while
   * an empty array is a real answer that re-admits every device. Collapsing the
   * two — answering `[]` on error — would make a flaky link look exactly like a
   * healthy node and would silently re-admit a dead accelerator. NEVER throws.
   */
  private async probeNodeInferenceDeviceHealth(nodeId: string): Promise<readonly string[] | null> {
    try {
      const api = this.ctx.api
      if (!api) return null
      const health = await api.pipelineExecutor.getInferenceDeviceHealth.query({
        nodeId,
      })
      return health.unhealthy.map((entry) => entry.deviceKey)
    } catch (err: unknown) {
      // WARN, not ERROR, and rate-limited by its own change-gate upstream: a
      // node that is simply offline is already reported by the load path, and
      // this read is expected to fail during a runner respawn. It is logged at
      // all because a channel that stops answering forever, silently, is how
      // the mirror would quietly freeze on a stale verdict.
      this.ctx.logger.warn('inference device health read failed — mirror left unchanged', {
        tags: { nodeId },
        meta: { nodeId, error: errMsg(err) },
      })
      return null
    }
  }

  /**
   * Fold one health observation into the per-device mirror and say what
   * changed.
   *
   * The reading discipline itself lives in {@link foldInferenceDeviceHealth} —
   * a failed read changing nothing, and every device the node HAS being
   * observed rather than only the refused ones — because both halves are subtly
   * wrong-able and invisible when wrong, and the tests must exercise the same
   * implementation this does rather than a restatement of it. This method only
   * SAYS what changed.
   *
   * The exclusion is applied by the mirror's second CONSECUTIVE bad
   * observation, never the first — excluding a healthy accelerator is the
   * direction that destroys work.
   */
  private noteInferenceDeviceHealth(
    nodeId: string,
    unhealthy: readonly string[] | null,
    present: readonly string[],
  ): void {
    const changes = foldInferenceDeviceHealth(
      this.inferenceDeviceUsability,
      nodeId,
      unhealthy,
      present,
    )
    // An exclusion that appeared or cleared changes the eligible set.
    if (changes.length > 0) this.noteShareChange(`devices:${nodeId}`)
    for (const { deviceKey, transition } of changes) {
      if (transition === 'recovered') {
        this.ctx.logger.info('inference device recovered — back in the balancer candidate set', {
          tags: { nodeId },
          meta: { nodeId, deviceKey },
        })
        continue
      }
      this.ctx.logger.error(
        'inference device REFUSED by its executor — removed from the balancer candidate set',
        { tags: { nodeId }, meta: { nodeId, deviceKey } },
      )
    }
  }

  /**
   * Say out loud which of a node's inference devices were dropped from the
   * candidate set, and why.
   *
   * All three drops in `resolveInferenceDeviceEligibility` — `!enabled`,
   * `!available`, and the root-capability guard — used to be silent. A device
   * that quietly leaves the candidate set looks exactly like a device that was
   * never there, and that is precisely the failure that hid an idle NPU: the
   * only way to tell "the balancer keeps choosing the GPU" from "the NPU is not
   * even a candidate" was to re-derive the eligibility by hand.
   *
   * Volume: one line per node per CHANGE of the split (a device appearing,
   * disappearing, or changing its exclusion reason), not one per dispatch.
   * The first observation of a node with no exclusions logs nothing — there is
   * nothing to explain; a later shrinkage still fires because the signature
   * changes.
   */
  private logInferenceDeviceShrinkage(
    nodeId: string,
    eligible: Readonly<Record<string, number>>,
    excluded: readonly InferenceDeviceExclusion[],
  ): void {
    const eligibleKeys = Object.keys(eligible).toSorted()
    const signature = `${eligibleKeys.join(',')}#${excluded
      .map((e) => `${e.key}=${e.reason}`)
      .join(',')}`
    const previous = this.lastInferenceEligibilitySignature.get(nodeId)
    if (previous === signature) return
    this.lastInferenceEligibilitySignature.set(nodeId, signature)
    if (previous === undefined && excluded.length === 0) return
    this.ctx.logger.info('inference devices: candidate set changed', {
      tags: { nodeId },
      meta: {
        eligible: eligibleKeys,
        excluded: excluded.map((e) => ({
          key: e.key,
          reason: e.reason,
          format: e.format,
        })),
      },
    })
  }

  /**
   * Per-device concurrent-session caps for a node as `deviceKey → maxSessions`
   * (multi-device C4). Fed to the device balancer's `nodeCaps` so a device at
   * its cap is skipped. Store-only (no probe needed).
   */
  async getInferenceDeviceCaps(nodeId: string): Promise<Record<string, number>> {
    const stored =
      (await this.settingsStore!.readAgentSettingsMap())[nodeId]?.inferenceDevices ?? {}
    return inferenceDeviceCaps(stored)
  }

  /**
   * Live-probe a node's inference device descriptors. `platform-probe` is a
   * hub-default singleton targeted by the `{ nodeId }` cap INPUT (local node →
   * no arg). An unreachable node degrades to `reachable:false` + `probed:[]` —
   * NEVER throws.
   */
  private async probeNodeInferenceDevices(nodeId: string): Promise<InferenceDeviceProbe> {
    try {
      const api = this.ctx.api
      if (!api) throw new Error('ctx.api unavailable')
      const caps =
        nodeId === this.localNodeId
          ? await api.platformProbe.getCapabilities.query()
          : await api.platformProbe.getCapabilities.query({ nodeId })
      // A version-skewed node (older @camstack/system) returns a capabilities
      // payload WITHOUT the `devices` enumeration → `caps.devices` is undefined.
      // Degrade to an empty device set (reachable, "no devices reported") rather
      // than crashing the whole board with `undefined.map`. The node still needs
      // its framework updated to actually enumerate its accelerators.
      return { probed: caps.devices ?? [], reachable: true }
    } catch (err: unknown) {
      // `nodeId` goes in BOTH tags and meta on purpose: tags are the grouping
      // key, but the shipped/rendered line carries meta only — a WARN that
      // named the node solely in `tags` produced 84 identical lines in Loki
      // with no way to tell WHICH node was unreachable (2026-08-07). The
      // per-node question is the only question ever asked of this line.
      this.ctx.logger.warn('probeNodeInferenceDevices: node probe unreachable', {
        tags: { nodeId },
        meta: { nodeId, error: errMsg(err) },
      })
      return { probed: [], reachable: false }
    }
  }

  /**
   * Reset one node's pipeline to its hardware-aware defaults — the HONEST
   * reset (see the cap doc). Order matters:
   *   (a) strip every per-(node,device) base `steps` map from the node's
   *       `inferenceDevices` (each device reverts to its format default);
   *   (b) hot-reload every camera assigned to the node so the reset takes
   *       effect now, not on some future re-dispatch;
   *   (c) report the object-detection default of the accelerator that hosts
   *       the camera root, so the caller reports what will actually run.
   * A camera carries no model (D927), so there is no per-camera layer to
   * clear; its `stepToggles` and camera-semantic `stepSettings` stay.
   *
   * (c) is best-effort: an unreachable node degrades to
   * `effectiveModelId: null` and a logged warning — the persisted reset
   * (a+b) has already been applied and applies on reconnect.
   */
  async resetNodePipelineDefaults(input: {
    readonly agentNodeId: string
  }): Promise<{ success: true; effectiveModelId: string | null }> {
    const node = input.agentNodeId

    // (a) Strip per-(node,device) base `steps` — every accelerator reverts to
    // its format default (weight/enabled/maxSessions are preserved).
    const all = await this.settingsStore!.readAgentSettingsMap()
    const existing = all[node]
    if (existing?.inferenceDevices) {
      const strippedDevices = Object.fromEntries(
        Object.entries(existing.inferenceDevices).map(([deviceKey, entry]) => {
          const { steps: _dropSteps, ...rest } = entry
          return [deviceKey, rest]
        }),
      )
      await this.settingsStore!.writeAgentSettings(node, {
        ...existing,
        inferenceDevices: strippedDevices,
      })
    }

    // (b) Hot-reload every camera assigned to this node with the reset config.
    this.settingsStore!.invalidateCatalog()
    await this.placement!.redispatchCamerasOnAgent(node)

    // (c) Effective post-reset model — a model is chosen by the accelerator
    // that runs it (D927), so this is the object-detection default of the
    // device that would host the camera root, read from the same merged view
    // the operator sees. An unreachable node claims nothing.
    const effectiveModelId = await this.effectiveDetectorModelAfterReset(node)

    this.ctx.logger.info('node pipeline reset to hardware-aware defaults', {
      tags: { nodeId: node },
      meta: { effectiveModelId },
    })
    return { success: true as const, effectiveModelId }
  }

  /**
   * The object-detection model the node's camera-root accelerator runs once
   * its base steps are stripped: the first eligible device's `defaultModelId`.
   * `null` when the node's probe did not answer or no device is eligible —
   * never a guess, and the reason is logged.
   */
  private async effectiveDetectorModelAfterReset(node: string): Promise<string | null> {
    const view = await this.getNodeInferenceDevices({ nodeId: node })
    const host = view.reachable ? view.devices.find((d) => d.exclusion === null) : undefined
    if (!host) {
      this.ctx.logger.warn('resetNodePipelineDefaults: no effective model to report', {
        tags: { nodeId: node },
        meta: { reachable: view.reachable, devices: view.devices.length },
      })
      return null
    }
    return host.defaultModelId
  }

  // ── Auto tune (D745) ──────────────────────────────────────────────

  private autoTune(): AutoTuneService {
    if (this.autoTuneService !== null) return this.autoTuneService
    const store = this.settingsStore!
    this.autoTuneService = new AutoTuneService({
      logger: this.ctx.logger,
      runnerNodeIds: () => this.topology!.collectRunnerNodeIds(),
      readNodeDevices: (nodeId) => this.getNodeInferenceDevices({ nodeId }),
      readHardware: async (nodeId) => {
        const api = this.ctx.api
        if (!api) return null
        return nodeId === this.localNodeId
          ? api.platformProbe.getHardware.query()
          : api.platformProbe.getHardware.query({ nodeId })
      },
      readCatalog: (nodeId) => store.readCatalogForNode(nodeId),
      readAgentSettings: () => store.readAgentSettingsMap(),
      rewriteAgentSettings: (transform) => store.rewriteAgentSettingsMap(transform),
      cameraFps: async () => this.autoTuneCameraFps(),
      // Node benchmark results (D791): measured on the node beats the table.
      measuredCapacity: {
        readMeasuredCapacity: (nodeIds) => this.readMeasuredCapacity(nodeIds),
      },
      measuredLatency: (nodeIds) => this.readMeasuredLatency(nodeIds),
      downloadModel: async (nodeId, modelId, format) => {
        const api = this.ctx.api
        if (!api) throw new Error('ctx.api unavailable')
        await api.pipelineExecutor.downloadModel.mutate(
          { addonId: 'object-detection', modelId, format },
          nodePin(nodeId),
        )
      },
      readCustomModelIds: async () => {
        const api = this.ctx.api
        if (!api) throw new Error('ctx.api unavailable')
        const models = await api.customModelRegistry.listModels.query()
        return new Set(models.map((m) => m.entry.id))
      },
      invalidateCatalog: () => store.invalidateCatalog(),
      redispatch: (nodeId) => this.placement!.redispatchCamerasOnAgent(nodeId),
      now: () => Date.now(),
    })
    return this.autoTuneService
  }

  /**
   * The rate one detection session is counted at (D755): the fastest camera
   * with detection started that runs the pipeline root; null when none does.
   */
  private autoTuneCameraFps(): number | null {
    let fps = 0
    for (const config of this.detectionWiring!.activeDetections.values()) {
      if (config.detectionMode === 'disabled') continue
      if (!(config.detectionSources ?? ['pipeline']).includes('pipeline')) continue
      fps = Math.max(fps, config.detectionFps)
    }
    return fps > 0 ? fps : null
  }

  async planAutoTune(input: {
    readonly headroom: number
    readonly minSessionsPerDevice?: number
  }): Promise<AutoTunePlan> {
    return this.autoTune().plan(input)
  }

  // ── Load balancing (D748) ─────────────────────────────────────────────

  /**
   * Node + device shares in ONE read-modify-write of the agent settings. A
   * device with no stored entry is made explicit with its effective
   * enablement, read from the probe-aware device list. Never touches the
   * `sessionPlacement` policy.
   */
  async setLoadBalancingShares(input: LoadBalancingSharesInput): Promise<{ success: true }> {
    const effectiveEnabled: Record<string, Record<string, boolean>> = {}
    for (const nodeId of Object.keys(input.devices)) {
      const read = await this.getNodeInferenceDevices({ nodeId })
      effectiveEnabled[nodeId] = Object.fromEntries(read.devices.map((d) => [d.key, d.enabled]))
    }
    await this.settingsStore!.rewriteAgentSettingsMap((prev) =>
      applyLoadBalancingShares(prev, {
        nodes: input.nodes,
        devices: input.devices,
        effectiveEnabled,
      }),
    )
    this.ctx.logger.info('load balancing shares updated', {
      meta: {
        nodes: JSON.stringify(input.nodes),
        devices: JSON.stringify(input.devices),
        policy: this.readSessionPlacement(),
      },
    })
    // Standing cameras follow the new node shares exactly as a weight change did.
    if (Object.keys(input.nodes).length > 0) {
      void this.rebalance().catch((err: unknown) => {
        this.ctx.logger.warn('setLoadBalancingShares: rebalance failed', {
          meta: { error: errMsg(err) },
        })
      })
    }
    return { success: true as const }
  }

  async getPlacementStats(input: { readonly windowMs: number }): Promise<PlacementStats> {
    const snap = this.placementStats.snapshot(input.windowMs)
    return {
      policy: this.readSessionPlacement(),
      windowMs: input.windowMs,
      observedForMs: snap.observedForMs,
      sessionsNow: snap.sessionsNow,
      clusterPeakSessions: snap.clusterPeakSessions,
      nodes: snap.nodes,
      stalePins: await this.listStaleDevicePins(),
    }
  }

  /** Device pins the session path cannot honour — see `stale-device-pins.ts`. */
  private async listStaleDevicePins(): Promise<PlacementStats['stalePins']> {
    const nodeIds = [...new Set(['hub', ...this.topology!.collectRunnerNodeIds()])]
    const offered = await Promise.all(
      nodeIds.map(async (nodeId) => ({
        devices: (await this.getNodeInferenceDevices({ nodeId }).catch(() => null))?.devices ?? [],
      })),
    )
    const pins: PinnedCamera[] = []
    for (const deviceId of this.detectionWiring!.activeDetections.keys()) {
      const deviceKey = await this.readPipelineDevicePin(deviceId)
      if (deviceKey !== null) pins.push({ deviceId, deviceKey })
    }
    return findStaleDevicePins(pins, offered)
  }

  async suggestShares(input: {
    readonly headroom: number
    readonly source?: CapacitySource
  }): Promise<SuggestSharesResult> {
    return this.autoTune().suggestShares(input)
  }

  async applyAutoTune(input: {
    readonly planHash: string
    readonly headroom: number
    readonly minSessionsPerDevice?: number
  }): Promise<AutoTuneApplyResult> {
    const result = await this.autoTune().apply(input)
    // New models change each node's capacity: the automatic shares follow (D750).
    if (result.kind === 'applied') this.noteShareChange('auto-tune-applied')
    return result
  }

  // ── Effective shares (D750) ──────────────────────────────────────────

  private effectiveShares(): EffectiveSharesService {
    if (this.effectiveSharesService !== null) return this.effectiveSharesService
    const store = this.settingsStore!
    this.effectiveSharesService = new EffectiveSharesService({
      readSource: () => this.readShareSource(),
      readStored: async () => storedShareWeights(await store.readAgentSettingsMap()),
      // ONE computation: the automatic shares ARE the suggestion for the source.
      suggest: (source) =>
        this.autoTune().suggestShares({
          headroom: AUTO_SHARE_HEADROOM,
          source,
        }),
      topologySignature: async () => {
        const nodeIds = [...new Set(['hub', ...this.topology!.collectRunnerNodeIds()])]
        const blob = await store.readAgentSettingsMap()
        return shareTopologySignature(nodeIds, blob, this.liveDevicesByNode(nodeIds, blob))
      },
      logger: this.ctx.logger,
    })
    return this.effectiveSharesService
  }

  /**
   * Each node's LIVE device set from the last probe — key, availability and
   * the dispatcher's exclusion verdict (`exclusion === null` ⇔ eligible, the
   * same `resolveInferenceDeviceEligibility` the dispatcher runs). No network
   * call: a node never probed contributes nothing, and the probe that first
   * answers announces itself through {@link noteInferenceDeviceProbe}.
   */
  private liveDevicesByNode(
    nodeIds: readonly string[],
    blob: AgentSettingsMapBlob,
  ): LiveDevicesByNode {
    const out: Record<string, { key: string; available: boolean; exclusion: string | null }[]> = {}
    for (const nodeId of nodeIds) {
      const probed = this.lastInferenceDeviceProbe.get(nodeId)
      if (probed === undefined) continue
      const stored = blob[nodeId]?.inferenceDevices ?? {}
      const catalog = this.settingsStore!.peekCatalogForAgent(nodeId)
      const eligibility = resolveInferenceDeviceEligibility(
        probed,
        stored,
        catalog ? makeRootCapabilityGuard(catalog) : undefined,
        (deviceKey) => this.inferenceDeviceUsability.isUsable(nodeId, deviceKey),
      )
      out[nodeId] = annotateInferenceDeviceExclusions(
        mergeInferenceDevices(probed, stored),
        eligibility,
      ).map((d) => ({
        key: d.key,
        available: d.available,
        exclusion: d.exclusion,
      }))
    }
    return out
  }

  /** Something the automatic shares depend on changed: recompute now (best effort). */
  private noteShareChange(trigger: string): void {
    if (this.settingsStore === null) return
    void this.effectiveShares()
      .recompute(trigger)
      .catch((err: unknown) => {
        this.ctx.logger.warn('load balancing: share recompute failed', {
          meta: { trigger, error: errMsg(err) },
        })
      })
  }

  // ── Node benchmark (D791) ─────────────────────────────────────────────

  /** The benchmark reconcile cadence — a restore owed is never older than this. */
  private static readonly NODE_BENCHMARK_RECONCILE_MS = 30_000
  /** How long a node's answered pool tuning is reused for result standings. */
  private static readonly CURRENT_POOL_TTL_MS = 60_000
  private readonly currentPoolCache = new Map<string, { at: number; pool: CurrentPool | null }>()

  /**
   * Build the benchmark lifecycle, then reconcile its manifest: a run that
   * died with the previous process is restored NOW, before anything else
   * can trust the cluster's placement. Never fails the boot.
   */
  private async initNodeBenchmark(): Promise<void> {
    // ctx.records is guaranteed non-null at this point: declared at the top of
    // onInitialize (which calls this method after buildOrchestratorControllers).
    const store = new NodeBenchmarkStore({
      records: this.ctx.records!,
      logger: this.ctx.logger,
    })
    try {
      await store.load()
    } catch (err: unknown) {
      this.ctx.logger.warn(
        'node benchmark: store unavailable at boot — runs refused until it answers',
        {
          meta: { error: errMsg(err) },
        },
      )
    }
    this.nodeBenchmarkStore = store
    this.nodeBenchmark = createNodeBenchmarkService({
      ctx: () => this.ctx,
      persistence: store,
      ledger: this.ledger!,
      topology: this.topology!,
      rebalance: (opts) => this.placement!.rebalance(opts),
      activeSessionNode: (deviceId) => this.session!.activeSessionNode(deviceId),
      readStoredPipelinePin: (deviceId) => this.readStoredPipelinePin(deviceId),
      listDeviceKeys: async (nodeId) =>
        (await this.getNodeInferenceDevices({ nodeId })).devices.map((d) => d.key),
      sessionsNow: () => this.placementStats.snapshot(60_000).sessionsNow,
      suggestShares: () =>
        this.autoTune().suggestShares({
          headroom: AUTO_SHARE_HEADROOM,
          source: 'benchmark',
        }),
      pollIntervalMs: this.nodeBenchmarkPollMs,
      onResultsWritten: (nodeId) => {
        this.currentPoolCache.clear()
        // Measured on this node beats the table: the automatic shares and
        // Auto tune read it from now on (logged by the recompute).
        this.noteShareChange(`benchmark-results:${nodeId}`)
      },
    })
    await this.nodeBenchmark.reconcile('boot').catch((err: unknown) => {
      this.ctx.logger.warn('node benchmark: boot reconcile failed — retried on the next tick', {
        meta: { error: errMsg(err) },
      })
    })
    this.nodeBenchmarkTimer = setInterval(() => {
      void this.nodeBenchmark?.reconcile('tick').catch((err: unknown) => {
        this.ctx.logger.debug('node benchmark: reconcile tick failed', {
          meta: { error: errMsg(err) },
        })
      })
    }, PipelineOrchestratorAddon.NODE_BENCHMARK_RECONCILE_MS)
    this.nodeBenchmarkTimer.unref?.()
    this.startAutoBenchmark(store)
  }

  private autoBenchmarkAttemptsHandle: DurableState<AutoBenchmarkAttemptsBlob> | null = null

  /** The retry ledger's durable handle — one per addon, shared by the scheduler and the node-removal hook. */
  private autoBenchmarkAttemptsState(): DurableState<AutoBenchmarkAttemptsBlob> {
    this.autoBenchmarkAttemptsHandle ??= this.state(
      'autoBenchmarkAttempts',
      AutoBenchmarkAttemptsSchema,
      {},
    )
    return this.autoBenchmarkAttemptsHandle
  }

  /** The node-removal hook's deps over this addon's stores (#265). */
  private nodeRemovalDeps(): NodeRemovalDeps {
    const settings = this.ctx.settings
    if (settings === undefined) throw new Error('pipeline-orchestrator: ctx.settings is missing')
    return {
      removeAgentSettings: async (nodeId) =>
        (await this.removeAgentSettings({ agentNodeId: nodeId })).removed,
      removeCapabilityBindings: (nodeId) => this.settingsStore!.removeCapabilityBindings(nodeId),
      removeAutoBenchmarkAttempts: async (nodeId) => {
        let removed = false
        await this.autoBenchmarkAttemptsState().update((prev) => {
          if (!(nodeId in prev)) return prev
          const { [nodeId]: _drop, ...rest } = prev
          removed = true
          return rest
        })
        return removed
      },
      listCameraDeviceIds: async () =>
        (
          await this.ctx.api.deviceManager.listAll.query({ projection: 'slim', isCamera: true })
        ).map((device) => device.id),
      readDeviceStore: (deviceId) => settings.readDeviceStore(deviceId),
      writeDeviceStore: (deviceId, patch) => settings.writeDeviceStore(deviceId, patch),
      logger: this.ctx.logger.child('node-removal'),
    }
  }

  /**
   * Wire the automatic benchmark: it reads the live device sets already
   * probed (no network call of its own), and starts a device-phase run through
   * the same service the operator uses — so its preflight, its single-run lock
   * and its restore all apply.
   */
  private startAutoBenchmark(store: NodeBenchmarkStore): void {
    this.autoBenchmark?.stop()
    // The retry ledger, in the addon's own settings store (no table of its own).
    const attempts = this.autoBenchmarkAttemptsState()
    this.autoBenchmark = new AutoBenchmarkScheduler({
      logger: this.ctx.logger,
      readNodes: async () => {
        const online = this.topology!.collectRunnerNodeIds()
        const blob = await this.settingsStore!.readAgentSettingsMap()
        const live = this.liveDevicesByNode(online, blob)
        // A node nobody has probed yet (a fresh install with no camera) is
        // asked here; its answer ticks the scheduler via `onLiveDevicesChanged`.
        return readAutoBenchNodes({
          onlineNodeIds: online,
          liveDevices: (nodeId) => live[nodeId],
          requestProbe: (nodeId) => this.refreshInferenceDeviceProbe(nodeId),
          camerasOn: async (nodeId) => (await this.benchmarkService().camerasOn(nodeId)).length,
        })
      },
      benchmarked: async () => {
        if (store.listResults().length === 0) return new Set<string>()
        // The model each device runs now is the shares' own pick, and the
        // measured side is the shares' own reader — one predicate.
        const hardware = await this.autoTune().suggestShares({
          headroom: AUTO_SHARE_HEADROOM,
          source: 'hardware',
        })
        const measured = await this.readMeasuredCapacity(hardware.nodes.map((n) => n.nodeId))
        return benchmarkedDevices(
          hardware.nodes.flatMap((n) =>
            n.devices.map((d) => ({
              nodeId: n.nodeId,
              deviceKey: d.deviceKey,
              modelId: d.modelId,
            })),
          ),
          measured,
        )
      },
      runActive: () => this.benchmarkService().isRunActive(),
      pickModels: async (nodeId, deviceKeys) => {
        const candidates = await this.getNodeBenchmarkCandidates({ nodeId })
        const out: Record<string, string> = {}
        for (const d of candidates.devices) {
          const first = d.suggested[0]
          if (deviceKeys.includes(d.deviceKey) && first !== undefined) out[d.deviceKey] = first
        }
        return out
      },
      start: (plan) => this.benchmarkService().start(plan),
      persistence: {
        load: async () => attemptsFromBlob(await attempts.get(), benchKey),
        save: (map: ReadonlyMap<string, AutoBenchAttempt>) => attempts.set(attemptsToBlob(map)),
      },
    })
    this.autoBenchmark.start()
    void this.autoBenchmark.tick('boot')
  }

  private benchmarkService(): NodeBenchmarkService {
    if (this.nodeBenchmark === null) throw new Error('node benchmark: not initialised')
    return this.nodeBenchmark
  }

  async getNodeBenchmarkPreflight(input: NodeBenchmarkPlanInput): Promise<NodeBenchmarkPreflight> {
    return this.benchmarkService().preflight(input)
  }

  async startNodeBenchmark(
    input: NodeBenchmarkPlanInput,
  ): Promise<
    { kind: 'started'; runId: string } | { kind: 'refused'; preflight: NodeBenchmarkPreflight }
  > {
    return this.benchmarkService().start(input)
  }

  async getNodeBenchmarkStatus(): Promise<NodeBenchmarkStatus> {
    return this.benchmarkService().status()
  }

  async abortNodeBenchmark(input: { readonly runId: string }): Promise<{ aborted: boolean }> {
    return this.benchmarkService().abort(input.runId)
  }

  async getNodeBenchmarkCandidates(input: {
    readonly nodeId: string
  }): Promise<NodeBenchmarkCandidates> {
    return readNodeBenchmarkCandidates({
      nodeId: input.nodeId,
      readDevices: (nodeId) => this.getNodeInferenceDevices({ nodeId }),
      readCatalog: (nodeId) => this.settingsStore!.readCatalogForNode(nodeId),
      autoTunePicks: async (nodeId) => {
        const plan = await this.autoTune().plan({
          headroom: AUTO_SHARE_HEADROOM,
        })
        const node = plan.nodes.find((n) => n.nodeId === nodeId)
        const out: Record<string, string> = {}
        for (const d of node?.devices ?? []) {
          if (d.chosen !== null) out[d.deviceKey] = d.chosen.modelId
        }
        return out
      },
      logger: this.ctx.logger,
    })
  }

  async listNodeBenchmarkResults(
    input: ListNodeBenchmarkResultsInput,
  ): Promise<readonly NodeBenchmarkResultView[]> {
    const rows = this.nodeBenchmarkStore?.listResults() ?? []
    return listNodeBenchmarkResultViews(rows, input, {
      nowMs: Date.now(),
      currentPools: await this.readCurrentPools(rows),
    })
  }

  async deleteNodeBenchmarkResult(input: { readonly id: string }): Promise<{ deleted: boolean }> {
    const deleted = (await this.nodeBenchmarkStore?.deleteResult(input.id)) ?? false
    if (deleted) {
      this.ctx.logger.info('node benchmark result deleted', {
        meta: { id: input.id },
      })
      this.noteShareChange('benchmark-result-deleted')
    }
    return { deleted }
  }

  /**
   * The pool each (node, device) of `rows` runs today, for the fingerprint
   * check. Unanswered = unknown, which never makes a result stale.
   */
  private async readCurrentPools(
    rows: readonly NodeBenchmarkResult[],
  ): Promise<Record<string, Record<string, CurrentPool>>> {
    const out: Record<string, Record<string, CurrentPool>> = {}
    const api = this.ctx.api
    const pairs = new Set(rows.map((r) => `${r.nodeId}\u0000${r.cell.deviceKey}`))
    const now = Date.now()
    await Promise.all(
      [...pairs].map(async (key) => {
        const [nodeId = '', deviceKey = ''] = key.split('\u0000')
        const hit = this.currentPoolCache.get(key)
        let pool: CurrentPool | null
        if (hit !== undefined && now - hit.at < PipelineOrchestratorAddon.CURRENT_POOL_TTL_MS) {
          pool = hit.pool
        } else {
          pool = null
          if (this.topology?.collectRunnerNodeIds().includes(nodeId)) {
            try {
              const t = await api.pipelineExecutor.getEffectiveTuning.query(
                { deviceKey },
                nodePin(nodeId),
              )
              pool = {
                runtime: t.runtime,
                numWorkers: t.numWorkers,
                concurrency: t.concurrency,
                batchMode: t.batchMode,
              }
            } catch {
              pool = null
            }
          }
          this.currentPoolCache.set(key, { at: now, pool })
        }
        if (pool !== null) out[nodeId] = { ...out[nodeId], [deviceKey]: pool }
      }),
    )
    return out
  }

  /** Each node's fresh detector measurements — what Auto tune lays over the table. */
  private async readMeasuredLatency(
    nodeIds: readonly string[],
  ): Promise<ReadonlyMap<string, MeasuredLatency>> {
    const rows = this.nodeBenchmarkStore?.listResults() ?? []
    const out = new Map<string, MeasuredLatency>()
    if (rows.length === 0) return out
    const ctx = {
      nowMs: Date.now(),
      currentPools: await this.readCurrentPools(rows),
    }
    for (const nodeId of nodeIds) {
      const cells = measuredDetectorCells(rows, nodeId, ctx)
      if (Object.keys(cells).length > 0) out.set(nodeId, cells)
    }
    return out
  }

  /** The measured capacity the automatic shares read (D755 `NodeCapacitySource`). */
  private async readMeasuredCapacity(
    nodeIds: readonly string[],
  ): Promise<ReadonlyMap<string, NodeMeasuredCapacity>> {
    const rows = this.nodeBenchmarkStore?.listResults() ?? []
    if (rows.length === 0) return new Map()
    return measuredCapacityFromResults(rows, nodeIds, {
      nowMs: Date.now(),
      currentPools: await this.readCurrentPools(rows),
    })
  }

  async getEffectiveShares(): Promise<EffectiveShares> {
    const service = this.effectiveShares()
    const nodeIds = [...new Set(['hub', ...this.topology!.collectRunnerNodeIds()])].toSorted()
    const rows = await Promise.all(
      nodeIds.map(async (nodeId) => ({
        nodeId,
        read: await this.getNodeInferenceDevices({ nodeId }).catch(() => null),
      })),
    )
    const detectable = new Set(this.topology!.detectionEligibleNodes())
    const eligibleNodes = rows
      .filter(
        (r) =>
          r.read !== null &&
          r.read.reachable &&
          detectable.has(r.nodeId) &&
          this.isNodeInferenceUsable(r.nodeId),
      )
      .map((r) => r.nodeId)
    const eligibleDevices: Record<string, string[]> = {}
    const absentDevices: Record<string, string[]> = {}
    for (const r of rows) {
      if (r.read === null) continue
      eligibleDevices[r.nodeId] = r.read.devices
        .filter((d) => d.enabled && d.available && d.exclusion === null)
        .map((d) => d.key)
      // A device that left the node keeps its stored weight but takes no share (D919).
      absentDevices[r.nodeId] = r.read.devices
        .filter((d) => d.presence === 'absent')
        .map((d) => d.key)
    }
    const auto = service.current()
    return resolveEffectiveShares({
      source: this.readShareSource(),
      policy: this.readSessionPlacement(),
      nodeIds,
      stored: storedShareWeights(await this.settingsStore!.readAgentSettingsMap()),
      auto: auto?.weights ?? null,
      ...(auto !== null ? { autoCapacity: auto.capacity } : {}),
      eligibleNodes,
      eligibleDevices,
      absentDevices,
      computedAt: auto?.computedAt ?? null,
      trigger: auto?.trigger ?? null,
    })
  }

  async setShareSource(input: { readonly source: ShareSource }): Promise<{ success: true }> {
    const previous = this.readShareSource()
    if (input.source === 'manual' && isAutomaticShareSource(previous)) {
      // Seed the sliders with what placement uses now, in ONE write, so
      // switching to manual moves nothing.
      const auto = this.effectiveShares().current()
      if (auto !== null) await this.setLoadBalancingShares(auto.weights)
    }
    await this.updateGlobalSettings({
      [SHARE_SOURCE_SETTING_KEY]: input.source,
    })
    this.ctx.logger.info('load balancing: share source changed', {
      meta: { from: previous, to: input.source },
    })
    if (isAutomaticShareSource(input.source)) this.noteShareChange(`source:${input.source}`)
    return { success: true as const }
  }

  async getCameraSettings(input: {
    readonly deviceId: number
  }): Promise<CameraPipelineSettings | null> {
    const all = await this.settingsStore!.readCameraSettingsMap()
    return all[String(input.deviceId)] ?? null
  }

  async setCameraStepToggle(input: {
    readonly deviceId: number
    readonly addonId: string
    readonly enabled: boolean | null
  }): Promise<{ success: true }> {
    const all = await this.settingsStore!.readCameraSettingsMap()
    const key = String(input.deviceId)
    const existing = all[key] ?? {}
    const nextToggles = { ...existing.stepToggles }
    if (input.enabled === null) {
      delete nextToggles[input.addonId]
    } else {
      nextToggles[input.addonId] = input.enabled
    }
    const next: CameraPipelineSettings =
      Object.keys(nextToggles).length > 0
        ? { ...existing, stepToggles: nextToggles }
        : (() => {
            const { stepToggles: _drop, ...rest } = existing
            return rest
          })()
    await this.settingsStore!.writeCameraSettings(input.deviceId, next)
    await this.emitResolvedCameraUpdated(input.deviceId)
    return { success: true as const }
  }

  /**
   * D927 — write or clear one step's NODE-wide settings: the content every
   * accelerator of the node runs under its own settings. A model-scoped key
   * (a model id, a binding, a `minConfidence*` floor) is REFUSED by name: it
   * belongs to the accelerator that runs the model. Re-dispatches the node's
   * cameras so the change runs now.
   */
  async setNodeStepSettings(input: {
    readonly agentNodeId: string
    readonly addonId: string
    readonly settings: Readonly<Record<string, unknown>> | null
  }): Promise<{ success: true }> {
    const refused = input.settings === null ? [] : modelScopedStepSettingKeys(input.settings)
    if (refused.length > 0) {
      this.ctx.logger.warn('setNodeStepSettings refused: model-scoped keys on the node layer', {
        tags: { nodeId: input.agentNodeId },
        meta: { addonId: input.addonId, keys: refused },
      })
      throw new Error(
        `setNodeStepSettings: ${refused.join(', ')} belong to the accelerator that runs the model — set them on that inference device`,
      )
    }
    await this.settingsStore!.writeNodeStepSettings(
      input.agentNodeId,
      input.addonId,
      input.settings,
    )
    this.ctx.logger.info('node step settings written', {
      tags: { nodeId: input.agentNodeId },
      meta: { addonId: input.addonId, keys: Object.keys(input.settings ?? {}) },
    })
    await this.placement!.redispatchCamerasOnAgent(input.agentNodeId)
    return { success: true as const }
  }

  /**
   * D754 — write or clear one step's CAMERA-WIDE settings (field-level bag,
   * merged over the node base on every accelerator). No deviceKey to
   * validate: the layer is node-independent by construction. A model is
   * chosen by the accelerator that runs it (D927), so a model-scoped key — a
   * model id, a binding or a `minConfidence*` floor — is REFUSED, by name,
   * and nothing is written.
   */
  async setCameraStepSettings(input: {
    readonly deviceId: number
    readonly addonId: string
    readonly settings: Readonly<Record<string, unknown>> | null
  }): Promise<{ success: true }> {
    const refused = input.settings === null ? [] : modelScopedStepSettingKeys(input.settings)
    if (refused.length > 0) {
      this.ctx.logger.warn('setCameraStepSettings refused: model-scoped keys on a camera', {
        tags: { deviceId: input.deviceId },
        meta: { addonId: input.addonId, keys: refused },
      })
      throw new Error(
        `setCameraStepSettings: ${refused.join(', ')} belong to the accelerator that runs the model — set them on the node's inference device, not on a camera`,
      )
    }
    await this.settingsStore!.writeCameraStepSettings(input.deviceId, input.addonId, input.settings)
    await this.emitResolvedCameraUpdated(input.deviceId)
    return { success: true as const }
  }

  async resolvePipeline(input: {
    readonly deviceId: number
    readonly agentNodeId?: string
  }): Promise<CameraPipelineConfig> {
    return this.settingsStore!.resolvePipelineForDevice(input.deviceId, input.agentNodeId)
  }

  /** Emit `pipeline.camera-updated` carrying the freshly-resolved config. */
  private async emitResolvedCameraUpdated(deviceId: number): Promise<void> {
    const resolved = await this.settingsStore!.resolvePipelineForDevice(deviceId)
    this.emitCameraUpdated(deviceId, resolved)
  }

  // `redispatchCamerasOnAgent`/`redispatchAllActiveCameras`/
  // `redispatchSingleCamera` moved to `PlacementService` (S8 extraction,
  // cluster C3) — call `this.placement!.<method>(...)`.

  // ── Camera status aggregator ─────────────────────────────────────────
  // Delegates to `CameraStatusService` (S5 extraction, cluster C12) —
  // READ-ONLY over `assignments`/`audioAssignments`/`cameraConfigs`/
  // `pendingReasons`, reached only through injected closures. See
  // `camera-status-service.ts`.

  /**
   * The per-camera FUNCTION SWITCH group (D61) — derived, never stored.
   *
   * Read-only and view-authed: a non-admin must be able to SEE that a camera
   * is quiet because somebody switched it off.
   */
  async getCameraSwitches(input: { readonly deviceId: number }): Promise<CameraSwitchGroup> {
    return this.cameraSwitchService!.getCameraSwitches(input.deviceId)
  }

  /**
   * Flip one switch, routed to the authority that already owned the function.
   * Returns the recomposed group so a client never renders its own guess.
   */
  async setCameraSwitch(input: {
    readonly deviceId: number
    readonly switchId: CameraSwitchId
    readonly enabled: boolean
  }): Promise<CameraSwitchGroup> {
    return this.cameraSwitchService!.setCameraSwitch(input.deviceId, input.switchId, input.enabled)
  }

  /**
   * Server-composed aggregated status for a single camera.
   *
   * Fans out in parallel (bounded, per-stage graceful degradation) to
   * broker / decoder / motion / detection / audio / recording source caps
   * via `ctx.api`. A stage whose source errors or times out becomes `null`
   * in the returned payload — one slow agent never breaks the whole call.
   */
  async getCameraStatus(input: { readonly deviceId: number }): Promise<CameraStatus> {
    return this.cameraStatusService!.getCameraStatus(input.deviceId)
  }

  /**
   * Server-composed aggregated status for multiple cameras in one call.
   *
   * `deviceIds` defaults to all cameras currently tracked by the
   * orchestrator's assignment map when omitted.
   */
  async getCameraStatuses(input: {
    readonly deviceIds?: readonly number[]
  }): Promise<readonly CameraStatus[]> {
    return this.cameraStatusService!.getCameraStatuses(input.deviceIds)
  }

  /**
   * Disk-wins fleet reconcile: reseat the recordings index from the walk, then
   * drop analytics ghosts. Isolated per camera. Starts in this process and
   * returns immediately — poll `getReconcileFromDiskStatus` (the walk outlives
   * the tRPC/UDS 60s timeout).
   */
  async reconcileFromDisk() {
    const api = this.ctx.api
    return this.diskReconcileJob.start({
      listDeviceIds: async () => {
        const devices = await api.deviceManager.listAll.query({
          projection: 'slim',
          isCamera: true,
        })
        return devices.map((device) => device.id)
      },
      rescanRecordings: async (deviceId) => {
        await api.recordingArchive.rescanStorage.mutate({ deviceId })
      },
      reconcileAnalytics: async (deviceId) =>
        api.pipelineAnalytics.reconcileFromDisk.mutate({ deviceId }),
      log: (message, meta) => this.ctx.logger.info(message, { meta }),
    })
  }

  async getReconcileFromDiskStatus() {
    return this.diskReconcileJob.snapshot()
  }

  /** Emit the `pipeline.camera-updated` event so the internal subscriber hot-reloads the runner. */
  private emitCameraUpdated(deviceId: number, config: CameraPipelineConfig): void {
    const ctx = this.ctx
    if (!ctx?.eventBus) return
    this.ctx.eventBus.emit(
      createEvent(
        EventCategory.PipelineCameraUpdated,
        { type: 'device', id: deviceId, nodeId: 'hub' },
        { deviceId, config },
      ),
    )
  }

  // Phase 2f: `probeHwAccelForNode`, `setAgentHwAccel`, `reprobeAgentHwAccel`,
  // `emitAgentHwAccelChanged` removed. Hwaccel ownership moved to each
  // decoder addon — `api.decoder.reprobeHwaccel` handles re-probing and
  // the decoder addon's `globalSettings.hwaccel` carries the operator
  // choice. Decoder sessions read from their own addon settings at
  // `createSession` time, no orchestrator round-trip.

  // `readAgentSettingsMap`/`writeAgentSettings`/`readCameraSettingsMap`/
  // `writeCameraSettings`/`getCatalogForAgent`/`seedAgentSettingsFromCatalog`/
  // `resolvePipelineForDevice`/`waitForAgentAndCatalog`/
  // `isCameraPipelineConfig` moved
  // to `PipelineSettingsStore` (S4 extraction, cluster C11) — call
  // `this.settingsStore!.<method>(...)`.

  // NOTE — Phase 6 cleanup: the legacy cap methods
  // `getDeviceOrchestrationSettings`, `getDeviceOrchestrationOverrides`
  // and `getGlobalOrchestrationSettings`, along with their helpers
  // (`resolveGlobalSettings`, `projectResolvedKeys`, `projectOverrideKeys`,
  // `readDeviceOrchestrationOverrides`), have been removed. Consumers now
  // read per-device values via the standard 3-level resolver
  // `resolveAddonSettings(schema, global, device)` over the addon
  // config store — the same path every other addon uses. See
  // `DetectionWiringService.resolveDeviceSettings` for the canonical
  // consumer.

  // ── Standard ICamstackAddon — Phase 3 of settings redesign ───────────
  //
  // The orchestrator exposes two disjoint settings levels:
  //
  //   ADDON LEVEL (getAddonSettings) — cluster-wide tunables that apply
  //     to the orchestrator as a whole. Two sections: balancer + failover.
  //     Edited in Pipeline → Cluster → Balancer / Failover tabs.
  //
  //   DEVICE LEVEL (getDeviceSettings) — per-camera fields that drive the
  //     detection wiring. Four sections: enables, source, routing, rates.
  //     Edited in Camera → Device Overrides. Defaults are HARDCODED in the
  //     schema — there is no cluster-wide editable default for these
  //     fields. The "no overlapping settings" invariant of the redesign
  //     means a key lives in exactly one schema; if a future need arises
  //     for system-wide defaults, they would be added to the addon schema
  //     under different keys (e.g. `defaultMotionFps`).
  //
  // Per-addon internal state (`nodeBindings`, `preferredAgent`) is also
  // persisted via the raw store accessors (readAddonStore /
  // writeAddonStore / readDeviceStore / writeDeviceStore) but is not part
  // of either schema — those keys are operational state, not user-facing
  // settings.

  /** Build the addon-level schema (cluster roles + balancer + failover). */
  protected globalSettingsSchema() {
    return this.schema({
      sections: buildGlobalSettingsSections({
        fpsMinThresholdDefault: LoadShedController.DEFAULT_FPS_MIN_THRESHOLD,
      }),
    })
  }

  /** Build the device-level schema (per-camera detection wiring). */
  protected deviceSettingsSchema() {
    return this.schema({
      sections: buildDeviceSettingsSections({
        runnerNodeIds: this.topology!.collectRunnerNodeIds(),
      }),
    })
  }

  // ── New three-level settings API (Phase 3 pilot) ─────────────────────
  //
  // Delegates to `DeviceConfigContributions` (S11 Task 1 extraction, C13
  // remnant) — see `device-config-contributions.ts`. This override still
  // shadows `BaseAddon.updateGlobalSettings` (so the cap surface keeps
  // running the ingest-owner re-derive + re-dispatch + load-shed-clear
  // side effects on every call); the controller internally re-invokes the
  // base-class write via the injected `baseUpdateGlobalSettings` closure.

  async updateGlobalSettings(patch: Record<string, unknown>): Promise<void> {
    await this.deviceConfig!.updateGlobalSettings(patch)
    // A cluster row written with a deleted model is reset at once (D725). The
    // sweep's own patch writes `null`, so it never re-enters here with a value.
    const writesClusterRow = CLUSTER_MODEL_SCOPED_STEPS.some(
      (step) => typeof patch[clusterModelSettingKey(step.stepId)] === 'string',
    )
    if (writesClusterRow) await this.resetRemovedModelPins('cluster-row-write')
  }

  /**
   * The ONE stored-pin reset (D725): drop every pin to a model deleted from
   * its step's catalog — per (node, device), per camera, cluster rows — unless
   * a registered custom model owns the id; log each, re-dispatch what changed.
   * See `removed-model-pin-reset.ts`. Never throws.
   */
  /**
   * D725 at boot: drop every stored pin to a model deleted from its step's
   * catalog. Started once the settings store is assigned. The sweep reads the
   * custom-model registry over `ctx.api`, which the hub wires after the addon
   * init chain resolves — so it waits for it; without it the sweep resets
   * nothing and the next pin write retries.
   */
  private startBootPinSweep(): void {
    void (async () => {
      for (let i = 0; this.ctxIfReady?.api == null && i < 30; i++) {
        await new Promise((r) => setTimeout(r, 200))
      }
      if (this.ctxIfReady !== null) await this.resetRemovedModelPins('boot')
    })().catch((err: unknown) => {
      this.ctxIfReady?.logger.warn('removed-model pin reset failed at boot — retry next boot', {
        meta: { error: errMsg(err) },
      })
    })
  }

  async resetRemovedModelPins(trigger: PinResetTrigger): Promise<readonly ResetModelPin[]> {
    return resetRemovedModelPins(
      {
        listCustomModels: async () => {
          const api = this.ctx.api
          if (!api) throw new Error('ctx.api is not wired yet')
          return api.customModelRegistry.listModels.query()
        },
        resetStoredPins: (isCustom) => this.settingsStore!.resetRemovedModelPins(isCustom),
        readStoredGlobalKey: (key) => this.readStoredGlobalKey(key),
        updateGlobalSettings: (patch) => this.deviceConfig!.updateGlobalSettings(patch),
        redispatchNode: (nodeId) => this.placement!.redispatchCamerasOnAgent(nodeId),
        logger: this.ctx.logger,
      },
      trigger,
    )
  }

  // `writeDeviceOrchestratorSettings` moved to `DeviceConfigContributions`
  // (S11 Task 1) — private helper of `applyDeviceSettingsPatch`.

  // ── Device-details aggregator contribution (pipeline-orchestrator cap) ──
  // Delegates to `DeviceConfigContributions` (S11 Task 1 extraction, C13
  // remnant) — see `device-config-contributions.ts`.
  //
  // Contributes the pipeline routing tab (enables + source + routing +
  // rates) for every camera. Live contribution exposes the current
  // assignment (runner nodeId) and the cached metrics snapshot so the
  // device-details page can show where the camera is being processed
  // right now without an extra round-trip to pipeline-runner.

  async getDeviceSettingsContribution(input: {
    deviceId: number
  }): Promise<ConfigUISchemaWithValues | null> {
    return this.deviceConfig!.getDeviceSettingsContribution(input)
  }

  async getDeviceLiveContribution(input: {
    deviceId: number
  }): Promise<ConfigUISchemaWithValues | null> {
    return this.deviceConfig!.getDeviceLiveContribution(input)
  }

  async getCameraDetectionSource(input: {
    readonly deviceId: number
  }): ReturnType<DeviceConfigContributions['getCameraDetectionSource']> {
    return this.deviceConfig!.getCameraDetectionSource(input)
  }

  async setCameraDetectionSource(input: {
    readonly deviceId: number
    readonly source: CameraDetectionSource
  }): Promise<{ success: true }> {
    return this.deviceConfig!.setCameraDetectionSource(input)
  }

  // `isCameraDevice` moved to `DeviceConfigContributions` (S11 Task 1) —
  // private helper of `getDeviceSettingsContribution`.

  async applyDeviceSettingsPatch(input: {
    deviceId: number
    patch: Record<string, unknown>
  }): Promise<{ success: true }> {
    return this.deviceConfig!.applyDeviceSettingsPatch(input)
  }

  /**
   * The one typed write path of a camera's attached sensors (G5, D676) — see
   * `camera-sensors/write.ts`. Its refusals run first; the store write then
   * goes THROUGH `applyDeviceSettingsPatch`, so the D672 patch gate, the
   * parsed value, the key and the `OrchestrationSettingsUpdated` event are the
   * one path a camera configured through the device page already takes.
   */
  async setCameraSensors(input: SetCameraSensorsInput): Promise<CameraSensorsWriteResult> {
    const ctx = this.ctx
    const deviceConfig = this.deviceConfig
    if (deviceConfig === null) {
      throw new Error('pipeline-orchestrator: not initialised — camera sensors not saved')
    }
    const api = ctx.api
    return writeCameraSensors(
      {
        readDevice: async (deviceId) => {
          if (!api) throw new Error('the device registry is not reachable')
          const dev = await api.deviceManager.getDevice.query({ deviceId })
          return dev === null || dev === undefined
            ? null
            : { type: dev.type, addonId: dev.addonId, stableId: dev.stableId }
        },
        writeDeviceStore: async (deviceId, patch) => {
          await deviceConfig.applyDeviceSettingsPatch({ deviceId, patch })
        },
        logger: ctx.logger.child('camera-sensors'),
      },
      input,
    )
  }

  // `splitPipelinePatch`/`applyPipelinePatch`/`tryParseJson` moved to
  // `DeviceConfigContributions` (S11 Task 1) — private helpers of
  // `applyDeviceSettingsPatch`.

  /**
   * Apply the subset of global settings that affect runtime behaviour
   * (balancer thresholds, broker timeout, failover policy) into the
   * in-memory state so subsequent `balance()` / `handleNodeDisconnect`
   * calls use the new values immediately.
   */
  private applyRuntimeSettings(config: Record<string, unknown>): void {
    const derived = deriveRuntimeSettings(config)
    this.failoverPolicy = derived.failoverPolicy
    // Cluster singleton roles (placement-model §6). Each is a single
    // node-select; an absent / non-string value falls back to the hub —
    // the schema default and the only node guaranteed to exist.
    this.topology!.setClusterRoles(derived.clusterRoles)
    // Node eligibility (`enabledNodes` / `enabledDecoderNodes` /
    // `enabledAudioNodes`) is DERIVED from the per-node capability store, not
    // from this global config — see `NodeTopologyService.refreshNodeCapabilities`.
    // It reads a durable-state blob (async) so it cannot run inside this
    // synchronous hook; `onInitialize` awaits it right after this call, and
    // every capability write re-runs it. `remoteSourcingNodes` stays empty
    // (the cross-node frame transport is a later activation phase).
    // Node eligibility may have widened — sweep any cameras stranded
    // no-frame-source. Debounced + api-guarded, so the boot-time call
    // (before api is ready) is harmless.
    this.reconcile!.schedulePendingRetry()
  }

  // ==========================================================================
  // Detection wiring handlers (moved from kernel DetectionWiringService)
  // ==========================================================================

  private get api() {
    return this.ctx.api ?? null
  }

  /**
   * Resolve this addon's own per-device detection settings — combines the
   * raw device store with the device schema defaults via `hydrateSchema()`,
   * then narrows to a typed DTO. Replaces the old call to
   * `this.ctx.settings!.getDevice` which used the deleted multi-level resolver
   * (the new model has no overlap between addon-level and device-level
   * keys, so there's no merge across levels — only schema defaults are
   * applied to fill in keys missing from the device store).
   */

  /**
   * True when `capName` is bound (`kind:'wrapped'`) for `deviceId` via
   * `device-manager.getBindings`. Single source of truth for the
   * "binding-gated cap" checks sprinkled around this addon (detection
   * pipeline, audio analysis, …). Failures log-and-return `true` — the
   * safe default is "cap on" unless the operator has explicitly toggled
   * the wrapper off via `device-manager.setWrapperActive`.
   */
  private async isCapActiveForDevice(deviceId: number, capName: string): Promise<boolean> {
    const api = this.api
    if (!api) return true
    try {
      const bindings = await api.deviceManager.getBindings.query({ deviceId })
      return bindings.entries.some((e) => e.capName === capName && e.kind === 'wrapped')
    } catch (err: unknown) {
      this.ctx.logger.warn('binding lookup failed — defaulting cap:active', {
        tags: { deviceId },
        meta: { capName, error: errMsg(err) },
      })
      return true
    }
  }

  // `isDetectionPipelineActive`/`isMotionDetectionActive` moved to
  // `DetectionWiringController` (S11 Task 3 extraction, C14) — detection-
  // wiring-only wrappers over `isCapActiveForDevice` (which stays here — see
  // `isAudioAnalysisActive` below, its other consumer).
  private isAudioAnalysisActive(deviceId: number): Promise<boolean> {
    return this.isCapActiveForDevice(deviceId, 'audio-analysis')
  }

  // `lookupDeviceFeatures` moved to `DetectionWiringController` (S11 Task 3
  // extraction, C14) — it was read ONLY by `resolveDeviceDetectionSettings`.

  /**
   * True when the device has a native `motion` or `native-object-detection`
   * cap registered by its driver — i.e. the camera does motion detection
   * itself (Reolink Baichuan onboard PIR, ONVIF event-driven, etc.).
   * Drives the dynamic `motionSources` default in
   * `resolveDeviceDetectionSettings`: when the operator hasn't pinned a
   * value, `['onboard']` is preferred over `['analyzer']` so we don't
   * burn CPU running a redundant motion pipeline.
   *
   * Detection is via `device-manager.getBindings`: any binding entry of
   * kind `'native'` whose capName is `motion` or
   * `native-object-detection` qualifies. Failures default to `false` so
   * we err toward the analyzer (never lose detection coverage when the
   * binding lookup hiccups).
   */
  /**
   * True when the device's driver registered `recording-signal` — the cap a
   * device uses to say, itself, that it is working (a robot vacuum cleaning).
   * Drives the `device-activity` entry in the `motionSources` DEFAULT (D392),
   * so the source arrives on exactly the devices that can raise it and on no
   * other camera in the fleet.
   *
   * Same failure discipline as `deviceHasOnboardMotionCap`: a binding lookup
   * that throws answers `false`, which loses the DEFAULT and never the
   * operator's explicit choice (this is asked only when they pinned nothing).
   */
  private async deviceHasActivitySignalCap(deviceId: number): Promise<boolean> {
    const api = this.api
    if (!api) return false
    try {
      const bindings = await api.deviceManager.getBindings.query({ deviceId })
      return bindings.entries.some((e) => e.kind === 'native' && e.capName === 'recording-signal')
    } catch {
      return false
    }
  }

  private async deviceHasOnboardMotionCap(deviceId: number): Promise<boolean> {
    const api = this.api
    if (!api) return false
    try {
      const bindings = await api.deviceManager.getBindings.query({ deviceId })
      return bindings.entries.some(
        (e) =>
          e.kind === 'native' &&
          (e.capName === 'motion' || e.capName === 'native-object-detection'),
      )
    } catch {
      return false
    }
  }

  /**
   * Returns true when the camera has a native `native-object-detection`
   * binding (i.e. the driver registered the cap). Used to gate the
   * "Use onboard object detection" toggle in `getDeviceSettingsContribution`.
   */
  private async deviceHasNativeObjectDetectionCap(deviceId: number): Promise<boolean> {
    const api = this.api
    if (!api) return false
    try {
      const bindings = await api.deviceManager.getBindings.query({ deviceId })
      return bindings.entries.some(
        (e) => e.kind === 'native' && e.capName === 'native-object-detection',
      )
    } catch {
      return false
    }
  }

  // `resolveDeviceDetectionSettings` (I/O half)/`fetchAssignedProfiles`/
  // `buildDetectionConfig` moved to `DetectionWiringController` (S11 Task 3
  // extraction, C14) — call `this.detectionWiring!.buildDetectionConfig(deviceId)`.

  // `ensureMotionWatch` moved to `SessionDispatchController` (S11 Task 2
  // extraction, C16) — call `this.session!.ensureMotionWatch(deviceId, config)`.

  /**
   * Start detection for a camera — thin delegate onto
   * `DetectionWiringController` (S11 Task 3 extraction, C14). Kept as a
   * public method on the addon: it's part of `startDetection`/`stopDetection`'s
   * long-standing direct-call test seam (`addon.startDetection(...)` in
   * `on-motion-session-cutover.spec.ts` / `standing-machinery-on-motion-
   * scope.spec.ts`) and the `ensureMotionWatch`/`dispatchCamera` callers
   * that predate this extraction.
   */
  async startDetection(deviceId: number, config: CameraDetectionConfig): Promise<void> {
    return this.detectionWiring!.startDetection(deviceId, config)
  }

  /** Stop detection for a camera — thin delegate onto `DetectionWiringController` (S11 Task 3, C14). */
  async stopDetection(deviceId: number): Promise<void> {
    return this.detectionWiring!.stopDetection(deviceId)
  }

  /** Stop detection and purge all persisted config for a removed device — thin delegate (S11 Task 3, C14). */
  private async handleDeviceUnregistered(deviceId: number): Promise<void> {
    return this.detectionWiring!.handleDeviceUnregistered(deviceId)
  }

  /** Handle a profile-slot change — thin delegate onto `DetectionWiringController` (S11 Task 3, C14). */
  private async handleDeviceRegistered(deviceId: number): Promise<void> {
    return this.detectionWiring!.handleDeviceRegistered(deviceId)
  }

  /** Handle an orchestration settings update — thin delegate (S11 Task 3, C14). */
  private async handleSettingsChanged(deviceId: number): Promise<void> {
    return this.detectionWiring!.handleSettingsChanged(deviceId)
  }

  /** Hot-reload the runner hosting `deviceId` with a fresh pipeline config — thin delegate (S11 Task 3, C14). */
  private async handlePipelineCameraUpdated(
    deviceId: number,
    config: CameraPipelineConfig,
  ): Promise<void> {
    return this.detectionWiring!.handlePipelineCameraUpdated(deviceId, config)
  }

  /** Re-emit `PipelineInferenceResult` as `DetectionResult` — thin delegate (S11 Task 3, C14). */
  private async handleInferenceResult(payload: PipelineInferenceResultPayload): Promise<void> {
    return this.detectionWiring!.handleInferenceResult(payload)
  }

  // `enforceLoadManagement`/`shedOrRelocate`/`tryClusterRelocate`/
  // `ensureLoadShedResumeTimer`/`loadShedResumeSweep` moved to
  // `LoadShedController` (S8 extraction, cluster C15).

  // `handleLazyAudioMotion` moved to `AudioSubscriptionController` (S7
  // extraction) — call `this.audio!.handleLazyAudioMotion(deviceId, detected, config)`.

  /**
   * True when `deviceId` is an `on-motion` (session-time) camera. Task 3
   * guard (Phase 3 slice 2): the STANDING placement machinery (disconnect
   * failover, reconnect restore, stale-assignment drop) must treat a
   * session camera's placement as never durable — regardless of whether a
   * session happens to be active right now, the next motion event
   * re-dispatches it via `dispatchDetectionSession`, so those subsystems
   * must not migrate/restore/retry it as if it were a standing attach.
   *
   * `protected` (not `private`) — mirrors the `pendingReasons` test seam:
   * a test subclass exposes this predicate directly so the guard's exact
   * condition can be asserted without re-deriving it from `activeDetections`
   * in every test.
   */
  protected isSessionCamera(deviceId: number): boolean {
    return this.detectionWiring!.getActiveDetectionConfig(deviceId)?.detectionMode === 'on-motion'
  }

  /**
   * True when `deviceId` is an on-motion camera currently IDLE (no active
   * session). Task 3 guard (Phase 3 slice 2): the standing placement
   * SWEEPS (stranded/pending retry, auto-rebalance) must skip an idle
   * session camera — it is SUPPOSED to be unassigned between motion
   * events; its gap is filled by motion (`handleSessionMotion`), not by
   * these sweeps. An on-motion camera WITH an active session is a real
   * attachment and stays eligible for those sweeps.
   *
   * `protected` — see {@link isSessionCamera}.
   *
   * T3-1: deliberately does NOT compensate for the `pendingReasons` term in
   * `handleSessionMotion`'s `hasStandingAttach` check. An idle on-motion
   * camera with a `pendingReasons` entry set (currently unreachable — nothing
   * on the on-motion path ever populates `pendingReasons`, that's a
   * standing-camera-only state) would read as idle here yet be treated as
   * "has a standing attach" there, so both the sweeps (via this predicate)
   * and the motion subscriber (via `hasStandingAttach`) would ignore it. Not
   * fixed pre-emptively — flagged so a future change that starts setting
   * `pendingReasons` for on-motion cameras doesn't silently reintroduce a
   * stuck-idle camera.
   */
  protected isIdleSessionCamera(deviceId: number): boolean {
    return this.isSessionCamera(deviceId) && !this.session!.hasActiveSession(deviceId)
  }

  // `handleSessionMotion`/`dispatchDetectionSession`/`scheduleSessionTeardown`
  // moved to `SessionDispatchController` (S11 Task 2 extraction, C16) — call
  // `this.session!.handleSessionMotion(deviceId, detected, emittedAt, trigger, triggeredBy)`
  // (wired as the `MotionOnMotionChanged` subscriber, block 9b of
  // `orchestrator-subscriptions.ts`). The C1
  // concurrency fix (dispatch always enters the session lock + re-reads
  // `activeDetections` inside it) moved byte-for-byte — see that class's
  // doc comment.

  // `buildWatchdogCamera`/`recoverPipelineStage` moved to
  // `DetectionWiringController` (S11 Task 3 extraction, C14) — reached via
  // the `placement`/`pipelineWatchdog` construction closures in `onInitialize`
  // (`this.detectionWiring!.buildWatchdogCamera(...)` /
  // `this.detectionWiring!.recoverPipelineStage(...)`), no longer reachable
  // from the addon class directly.

  // `storeAudioSub`/`withAudioSubLock`/`subscribeAudioStream` moved to
  // `AudioSubscriptionController` (S7 extraction) — internal to the
  // controller now (no longer reachable from the addon class).
  // `withSessionLock` moved to `SessionDispatchController` (S11 Task 2
  // extraction, C16) — backed by its internal `KeyedAsyncLock`, no longer
  // reachable from the addon class.
}

export type { BalancerDecision, BalancerInput } from './load-balancer.js'
// Re-exports for tests / consumers that want direct access to the balancer.
export { balance, computeCapacityScore } from './load-balancer.js'

/** The derived mean for one closed bucket — see `node-stress-history-producer.ts`. */
function withStatsMean(row: {
  readonly subject: string
  readonly series: string
  readonly scope: string
  readonly bucketStart: number
  readonly samples: number
  readonly sum: number
  readonly min: number
  readonly max: number
}): NodeStressStatsOutput['rows'][number] {
  return { ...row, mean: row.samples > 0 ? row.sum / row.samples : 0 }
}
