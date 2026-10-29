/**
 * `orchestrator-bootstrap.ts` — the controller-construction body of
 * `onInitialize` (S11 Task 4, last extraction of the S11 series).
 *
 * `buildOrchestratorControllers(deps)` constructs all ~16 controllers the
 * addon owns, in the EXACT order `onInitialize` built them in before this
 * extraction (ledger → topology → loadService → audio → settingsStore →
 * loadShed → placement → session → deviceConfig → cameraStatusService →
 * reconcile → [settings load + localNodeId resolve] → nodeLifecycle →
 * [event subs + readiness seed] → pipelineWatchdog → [timers + legacy
 * migration] → zoneRulesProvider → zonesProvider →
 * [wireOrchestratorSubscriptions + eager reconcile] → detectionWiring).
 * Every dep closure is carried over byte-for-byte — only `this.X` became
 * either a local variable (for a controller already constructed earlier in
 * THIS function) or a `deps.X` accessor (for addon-owned state/methods that
 * stay on `PipelineOrchestratorAddon`, or for a controller referenced
 * before its own construction point — a genuine forward ref, always via a
 * LAZY closure, exactly as it was in `onInitialize`).
 *
 * Three things could not simply become local variables, because an EXISTING
 * (unmoved) addon method reads the REAL class field synchronously, mid-
 * construction, not through a lazy closure:
 *   - `applyRuntimeSettings` (stays on the addon) reads `this.topology!`
 *     and `this.reconcile!` directly — called synchronously from the
 *     settings-load block below. `deps.setTopology`/`deps.setReconcile`
 *     progressively sync the REAL addon fields the instant each is built,
 *     so `applyRuntimeSettings` sees them.
 *   - `subscribeToAudioAnalyzerReadiness` (stays on the addon) reads
 *     `this.nodeLifecycle!.readinessRegistry` AND `this.audio!` directly —
 *     called synchronously right after `nodeLifecycle` is built (readiness
 *     seed + the `AgentOnline` handler). `deps.setNodeLifecycle` /
 *     `deps.setAudio` cover it the same way. This one bit LIVE: `audio` is
 *     constructed early (fourth) but `subscribeToAudioAnalyzerReadiness`
 *     wasn't called until much later (after `nodeLifecycle` exists), so the
 *     old code never noticed `this.audio` was still unsynced — until
 *     `ReadinessRegistry.onReadyState`'s `queueMicrotask` hydration replay
 *     (an already-`ready` cap fires the handler once, asynchronously, on
 *     subscribe) won the race against the `await buildOrchestratorControllers(...)`
 *     continuation in `onInitialize` that assigns `this.audio` — both are
 *     microtasks, and the replay's `queueMicrotask` was enqueued (during
 *     this still-synchronous function body) strictly before this function's
 *     `return` resolves the outer promise, so it always runs first. Fixed
 *     by syncing `this.audio` the instant it's constructed, exactly like
 *     `topology`/`reconcile`/`nodeLifecycle` — no lazy closure ever reads a
 *     controller before this function has assigned its real field.
 * Every other controller-to-controller reference in this function — even
 * ones that look like a forward ref (e.g. `loadShed`'s `attach` closure
 * onto `placement`, built one step later) — is a LAZY closure that is
 * never invoked synchronously during construction (only later, off
 * event-bus subscriptions, timers, or RPC handlers), so a plain local
 * `let` variable captured by reference is sufficient and exactly
 * preserves the original semantics: see each field's inline comment in
 * `index.ts` for the original construction-order reasoning, unchanged
 * here.
 *
 * `globalSettings` is a purely local variable — read/written ONLY by
 * closures built inside this same function (the one exception,
 * `deviceConfig`'s `setGlobalSettings`, is ALSO built here, so the local
 * variable stays the single source of truth for every reader). No code
 * outside this closure network ever read the former `this.globalSettings`
 * class field, so it isn't part of the returned `OrchestratorControllers`
 * — the field was removed from the class entirely (S11 Task 4 cleanup).
 * `localNodeId` IS returned — `index.ts` still reads `this.localNodeId`
 * from a couple of unrelated cap methods (`dumpDiagnostics`,
 * `getDecoderAssignments`), so the class field is populated once, from the
 * returned `OrchestratorControllers`, after this function returns.
 * `failoverPolicy` is the opposite case from `globalSettings` —
 * `applyRuntimeSettings` (unmoved) writes the REAL field on every future
 * settings change, so `nodeLifecycle`'s `failoverPolicy` closure MUST keep
 * reading through `deps.failoverPolicy()` (never a local snapshot) to see
 * those later updates.
 */
import { randomUUID } from 'node:crypto'
import type {
  AddonContext,
  CameraPipelineConfig,
  ConfigUISchema,
  DurableState,
  PipelineInferenceResultPayload,
  RunnerCameraConfig,
  Unsubscribe,
} from '@camstack/types'
import {
  createEvent,
  EventCategory,
  errMsg,
  makeSourceBrokerId,
  nodePin,
  parseSessionPlacementPolicy,
  parseShareSource,
  SESSION_PLACEMENT_SETTING_KEY,
  SHARE_SOURCE_SETTING_KEY,
  type SessionPlacementPolicy,
  type ShareSource,
} from '@camstack/types'
import type { ZodType } from 'zod'
import { AgentLoadService } from './agent-load-service.js'
import { selectAudioCamStream } from './audio-stream-selection.js'
import { AudioSubscriptionController } from './audio-subscription-controller.js'
import { type AudioTrackProbe, classifyAudioTrackProbe } from './audio-track-probe.js'
import { CameraSensorsController } from './camera-sensors/controller.js'
import { buildCameraSensorsPorts } from './camera-sensors/resolver.js'
import { readCameraSensorsSetting } from './camera-sensors/settings.js'
import { withForwarding } from './camera-sensors/forwarding.js'
import { CameraMotionSlice, camerasTheSliceOwns } from './camera-sensors/motion-slice.js'
import { hubMotionSliceStore } from './camera-sensors/motion-slice-hub.js'
import { isRunnerProcess, MotionSliceWriterGate } from './camera-sensors/motion-slice-gate.js'
import { ProviderSliceGate } from './camera-sensors/motion-slice-provider-gate.js'
import {
  CAMERA_SENSORS_SOURCE,
  CameraSensorsSource,
  effectiveWindowMs,
} from './camera-sensors/source.js'
import type { CameraIdsRead } from './camera-sensors/controller.js'
import { CameraStatusService } from './camera-status-service.js'
import { CameraSwitchService } from './camera-switch-service.js'
import { DetectionBlindMonitor } from './detection-blind-monitor.js'
import { DetectionWiringController } from './detection-wiring-controller.js'
import { RoundRobinInferenceDeviceRotation } from './device-balancer.js'
import { ShareElectionHistory } from './share-election-history.js'
import { SessionAffinityMemory } from './session-affinity.js'
import { DEFAULT_MOTION_COOLDOWN_MS, sustainIntervalMs } from './device-activity-source.js'
import { DeviceConfigContributions } from './device-config-contributions.js'
import { migrateLegacyFlagsToBindings } from './legacy-migrations.js'
import { LoadShedController } from './load-shed-controller.js'
import { NodeLifecycleHandler } from './node-lifecycle-handler.js'
import { NodeStressController } from './node-stress-controller.js'
import {
  NodeStressHistoryProducer,
  nodeStressHistoryClient,
} from './node-stress-history-producer.js'
import { NodeStressMoveLedger } from './node-stress-move-ledger.js'
import { orchestratorRecordKinds } from './record-kinds.js'
import { NodeTopologyService } from './node-topology.js'
import { wireOrchestratorSubscriptions } from './orchestrator-subscriptions.js'
import {
  AUTO_REBALANCE_INTERVAL_MS,
  type EligibilityCatalogRead,
  type EligibilityIfCached,
  type FailoverPolicy,
  PENDING_RETRY_INTERVAL_MS,
} from './orchestrator-types.js'
import { PackageZoneGate } from './package-zone-gate.js'
import { reattachAfterPackageZoneChange } from './package-zone-reattach.js'
import { PipelineSettingsStore } from './pipeline-settings-store.js'
import type { SessionPlacementStats } from './session-placement-stats.js'
import { DEFAULT_WATCHDOG_THRESHOLDS, PipelineWatchdog } from './pipeline-watchdog.js'
import { PlacementLedger } from './placement-ledger.js'
import { PlacementService } from './placement-service.js'
import { ReconcileController } from './reconcile-controller.js'
import { RepeatWarnSampler } from './repeat-warn-sampler.js'
import {
  DEFAULT_MAX_SESSION_HOLD_MS,
  SessionDispatchController,
} from './session-dispatch-controller.js'
import { readSwitchAuthorities } from './switch-authorities.js'
import { hydrateZoneMirrorsAtBoot } from './zone-mirror-hydration.js'
import { ZoneRulesProvider } from './zone-rules-provider.js'
import { ZonesProvider } from './zones-provider.js'

/**
 * Addon-owned state/methods every controller-construction closure below
 * reaches back into — everything that stays a method or private field on
 * `PipelineOrchestratorAddon` (never moved). Built once, in `onInitialize`,
 * from `this` (full privileged access there); this function only ever
 * calls through it.
 */
export interface OrchestratorBootstrapDeps {
  /** Throwing ctx accessor — mirrors the pre-extraction `this.ctx` getter (same object, same throw). */
  readonly ctx: () => AddonContext
  /** Non-throwing ctx accessor — mirrors `this.ctxIfReady`. */
  readonly ctxIfReady: () => AddonContext | null
  /** Live read accessor — `this.failoverPolicy` (mutated by `applyRuntimeSettings` on every future settings change). */
  readonly failoverPolicy: () => FailoverPolicy
  /** `this.initTimestamp` — set once, before construction begins; safe to snapshot as a plain value. */
  readonly initTimestamp: number
  /** `PipelineOrchestratorAddon.WATCHDOG_INTERVAL_MS` — private static, threaded as a plain value. */
  readonly watchdogIntervalMs: number

  readonly attachOn: (nodeId: string, config: RunnerCameraConfig) => Promise<void>
  readonly detachOn: (nodeId: string, deviceId: number) => Promise<void>
  readonly readPipelinePin: (deviceId: number) => Promise<string | null>
  readonly getEligibleInferenceDevices: (
    nodeId: string,
    read: EligibilityCatalogRead,
  ) => Promise<Record<string, number>>
  readonly getEligibleInferenceDevicesIfCached: (nodeId: string) => Promise<EligibilityIfCached>
  /** `PipelineOrchestratorAddon.forgetInferenceDeviceProbe` — on `AgentOffline`. */
  readonly forgetInferenceDeviceProbe: (nodeId: string) => void
  /**
   * A node joined or left: recompute the automatic shares now (D750). The
   * periodic reconcile backs this up — the event may be lost.
   */
  readonly noteShareTopologyChange: (trigger: string) => void
  readonly isNodeInferenceUsable: (nodeId: string) => boolean
  readonly getInferenceDeviceCaps: (nodeId: string) => Promise<Record<string, number>>
  readonly readPipelineDevicePin: (deviceId: number) => Promise<string | null>
  readonly subscribeToAudioAnalyzerReadiness: (nodeId: string) => void
  readonly emitResolvedCameraUpdated: (deviceId: number) => Promise<void>
  /** `this.applyRuntimeSettings` — stays on the addon; ALSO invoked synchronously during this bootstrap. */
  readonly applyRuntimeSettings: (config: Record<string, unknown>) => void
  readonly isCapActiveForDevice: (deviceId: number, capName: string) => Promise<boolean>
  readonly isAudioAnalysisActive: (deviceId: number) => Promise<boolean>
  readonly deviceHasOnboardMotionCap: (deviceId: number) => Promise<boolean>
  readonly deviceHasActivitySignalCap: (deviceId: number) => Promise<boolean>
  readonly deviceHasNativeObjectDetectionCap: (deviceId: number) => Promise<boolean>
  readonly handleDeviceRegistered: (deviceId: number) => Promise<void>
  readonly handleDeviceUnregistered: (deviceId: number) => Promise<void>
  readonly handleSettingsChanged: (deviceId: number) => Promise<void>
  readonly handlePipelineCameraUpdated: (
    deviceId: number,
    config: CameraPipelineConfig,
  ) => Promise<void>
  readonly handleInferenceResult: (payload: PipelineInferenceResultPayload) => Promise<void>
  readonly isSessionCamera: (deviceId: number) => boolean
  readonly isIdleSessionCamera: (deviceId: number) => boolean
  readonly deviceSettingsSchema: () => ConfigUISchema
  /** `this.resolveGlobalStore()` — the `BaseAddon` protected store reader. */
  readonly resolveGlobalStore: () => Promise<Record<string, unknown>>
  /** `super.updateGlobalSettings(patch)` — only spellable inside the class itself. */
  readonly baseUpdateGlobalSettings: (patch: Record<string, unknown>) => Promise<void>
  /** `this.watchCapability(...)` — the `BaseAddon` protected capability-down watcher. */
  readonly watchCapability: (
    capNames: string | readonly string[],
    handlers: {
      readonly onDown?: (nodeId: string, capName: string) => void
      readonly onReady?: (nodeId: string, capName: string) => void
    },
  ) => void
  /** `this.state.bind(this)` — the `BaseAddon` protected durable-state factory. */
  readonly state: <T>(key: string, schema: ZodType<T>, fallback: T) => DurableState<T>
  readonly rebalance: (opts?: { readonly minImprovement?: number }) => Promise<{ migrated: number }>
  readonly maintenancePaused: () => boolean
  /** The node the cluster is in benchmark mode for (D791), null when none. */
  readonly benchmarkNodeId?: () => string | null
  /** What session placement did (D748) — owned by the addon, fed by the dispatcher. */
  readonly placementStats: SessionPlacementStats

  // ── Progressive real-field sync (see class doc above) ──────────────────
  readonly setTopology: (topology: NodeTopologyService) => void
  readonly setReconcile: (reconcile: ReconcileController) => void
  readonly setNodeLifecycle: (nodeLifecycle: NodeLifecycleHandler) => void
  readonly setAudio: (audio: AudioSubscriptionController) => void
}

/** The full controller set `buildOrchestratorControllers` constructs, in build order. */
export interface OrchestratorControllers {
  readonly ledger: PlacementLedger
  readonly topology: NodeTopologyService
  readonly loadService: AgentLoadService
  readonly audio: AudioSubscriptionController
  readonly settingsStore: PipelineSettingsStore
  readonly loadShed: LoadShedController
  readonly nodeStress: NodeStressController
  /** Node-stress LTS + its flush timer, so `onShutdown` can stop the timer. */
  readonly nodeStressLts: NodeStressHistoryProducer
  readonly nodeStressLtsTimer: ReturnType<typeof setInterval>
  readonly placement: PlacementService
  readonly session: SessionDispatchController
  readonly deviceConfig: DeviceConfigContributions
  readonly cameraStatusService: CameraStatusService
  readonly cameraSwitchService: CameraSwitchService
  /** Attached sensors as the camera's onboard motion (D672). Stopped by the subscriptions' teardown. */
  readonly cameraSensors: CameraSensorsController
  readonly reconcile: ReconcileController
  readonly nodeLifecycle: NodeLifecycleHandler
  readonly pipelineWatchdog: PipelineWatchdog
  readonly zoneRulesProvider: ZoneRulesProvider
  readonly zonesProvider: ZonesProvider
  readonly detectionWiring: DetectionWiringController
  readonly localNodeId: string
  readonly unsubAgentOnline: Unsubscribe
  readonly unsubAgentOffline: Unsubscribe
  readonly unsubOrchestratorSubscriptions: Unsubscribe
  readonly pendingRetryTimer: ReturnType<typeof setInterval>
  readonly autoRebalanceTimer: ReturnType<typeof setInterval>
  /** The stored session placement policy (D748), read from the live global settings. */
  readonly sessionPlacement: () => SessionPlacementPolicy
  /** Where the shares come from (D750), read from the live global settings. */
  readonly shareSource: () => ShareSource
}

/**
 * Construct every orchestrator controller, wire the agent-lifecycle event
 * subscriptions + readiness seed + detection-wiring subscriptions, and
 * kick the eager reconcile — the ENTIRE former `onInitialize` body between
 * "Constructed FIRST" and the `detectionWiring` construction, moved
 * verbatim. Async only because the pre-existing settings-load `await`s
 * (unchanged, same position) require it — no NEW `await` is introduced
 * anywhere in this function, so the region from
 * `wireOrchestratorSubscriptions` through the eager `scheduleReconcile()`
 * call stays fully synchronous, exactly as documented at its call site.
 */
export async function buildOrchestratorControllers(
  deps: OrchestratorBootstrapDeps,
): Promise<OrchestratorControllers> {
  // ── Boot-safety rule (the `setAudio` lesson — commit 7e5715c3) ─────────
  // If ANY addon-class code reads a controller field synchronously during
  // boot (a NON-lazy read: `applyRuntimeSettings` → `this.topology!`/
  // `this.reconcile!`, `subscribeToAudioAnalyzerReadiness` → `this.audio!`/
  // `this.nodeLifecycle!`), that field MUST be assigned onto the REAL addon
  // instance via a `deps.setX(...)` call synchronously, right after the
  // controller's constructor returns — NEVER by relying on `onInitialize`'s
  // post-`await` field assignments. A readiness replay (`ReadinessRegistry.
  // onReadyState`'s `queueMicrotask` hydration for an already-`ready` cap)
  // is enqueued during this function body and runs BEFORE the awaited
  // bootstrap promise resolves, so an unsynced boot-critical field is
  // observed as null at that point (the S11 boot crash: null `this.audio`).
  // When adding a controller with a boot-time non-lazy reader, add the
  // matching progressive `deps.setX` sync here.

  // Constructed FIRST — every other controller below reads the shared
  // placement state through it via closures (S6: `placement-ledger.ts`).
  const ledger: PlacementLedger = new PlacementLedger({
    eventBus: deps.ctx().eventBus,
    logger: deps.ctx().logger,
  })

  // Constructed SECOND (S6: `node-topology.ts`) — `refreshNodeCapabilities()`
  // a few lines below (and every cap method once init returns) needs it.
  const topology: NodeTopologyService = new NodeTopologyService({
    readAgentSettingsMap: () => settingsStore!.readAgentSettingsMap(),
    eventBus: deps.ctx().eventBus,
    logger: deps.ctx().logger,
    localNodeId: () => localNodeId,
    addonId: () => deps.ctx().id,
    benchmarkNodeId: () => deps.benchmarkNodeId?.() ?? null,
  })
  // Progressive real-field sync (see class doc) — `applyRuntimeSettings`
  // (unmoved on the addon) reads `this.topology!` synchronously below.
  deps.setTopology(topology)

  // Constructed THIRD (S6: `agent-load-service.ts`) — depends on `topology`
  // (`knownRunnerNodeIds`/`isNodeEnabled`). `api` reads through `ctxIfReady`
  // (non-throwing) so a call landing after `dispose()` degrades gracefully.
  // The camera `motion` slice's writer gate (D696) reads every runner's answer
  // off this census; it is constructed with the camera sensors below.
  let motionSliceGate: MotionSliceWriterGate | null = null
  // The per-camera provider half of that gate (D696 amended); constructed with it.
  let providerSliceGate: ProviderSliceGate | null = null
  const loadService: AgentLoadService = new AgentLoadService({
    api: () => deps.ctxIfReady()?.api ?? null,
    topology,
    logger: deps.ctx().logger,
    readGlobalSettings: () => globalSettings,
    onCensus: (entries) => {
      motionSliceGate?.noteCensus(entries)
      // Every runner census (each session dispatch, the admin load view) also
      // re-asks the camera providers once their last census is stale: the
      // bound on a DROPPED `WorkerOnline` (telemetry, D8) for a rolled-back
      // provider whose cameras the orchestrator still writes.
      providerSliceGate?.refreshIfStale('runner-census')
    },
    // The load REPORT credits a single-device node's default-pool sessions to
    // its one device (D745's equivalence). The cached read never calls the node.
    eligibleDeviceKeys: async (nodeId) => {
      const read = await deps.getEligibleInferenceDevicesIfCached(nodeId)
      return read.kind === 'eligible' ? Object.keys(read.eligible) : null
    },
  })

  /**
   * THE audio-track read: what the broker that owns `camStreamId` knows about
   * its audio track, classified into present / absent / unknown by
   * `audio-track-probe.ts`. Two consumers, one reading — the audio
   * SUBSCRIPTION (refuses a stream with no track) and the watchdog's audio
   * STAGE (arms only where a signal is possible) — because two independent
   * readings of `BrokerStats.audio` is how a camera ends up refused by one and
   * watched by the other.
   *
   * Never throws: no api, an RPC error and a cold broker all answer `unknown`,
   * whose consumers both fail OPEN.
   */
  const resolveAudioTrackProbe = async (
    deviceId: number,
    camStreamId: string,
  ): Promise<AudioTrackProbe> => {
    const api = deps.ctxIfReady()?.api ?? null
    if (!api) return { kind: 'unknown', reason: 'no api' }
    try {
      const stats = await api.streamBroker.getBrokerStats.query(
        { brokerId: makeSourceBrokerId(deviceId, camStreamId) },
        nodePin(topology.assignSource(deviceId)),
      )
      return classifyAudioTrackProbe(stats)
    } catch (err: unknown) {
      return { kind: 'unknown', reason: errMsg(err) }
    }
  }

  // Constructed FOURTH (S7: `audio-subscription-controller.ts`) — depends
  // on `topology` (`enabledAudioNodes`/`clusterRoles.audioNode`). `api`
  // reads through `ctxIfReady` for the same shutdown-degrades-gracefully
  // reason as `loadService`. `getLedgerConfig`/`getActiveDetectionConfig`
  // are the ONLY two reads the controller has into ledger/detection-wiring
  // state — everything else is audio-owned.
  const audio: AudioSubscriptionController = new AudioSubscriptionController({
    api: () => deps.ctxIfReady()?.api ?? null,
    eventBus: deps.ctx().eventBus,
    logger: deps.ctx().logger,
    readDeviceStore: async (deviceId) =>
      (await deps.ctxIfReady()?.settings?.readDeviceStore(deviceId)) ?? {},
    probeAudioTrack: (deviceId, camStreamId) => resolveAudioTrackProbe(deviceId, camStreamId),
    // The SAME profile-slot read `buildDetectionConfig` uses, so the audio
    // plane picks its rung off the table the detection plane already trusts
    // (`null` = transient read failure, never "no slots"). Lazy closure onto
    // `detectionWiring`, which is constructed last — same forward-reference
    // pattern as the `isDetectionActive`/`getActiveDetectionConfig` deps below.
    assignedProfiles: (deviceId) => detectionWiring!.fetchAssignedProfiles(deviceId),
    ingestNode: () => topology.clusterRoles.ingestNode,
    localNodeId: () => localNodeId,
    enabledAudioNodes: () => topology.enabledAudioNodes,
    audioNodeRole: () => topology.clusterRoles.audioNode,
    isAudioAnalysisActive: (deviceId) => deps.isAudioAnalysisActive(deviceId),
    isDetectionActive: (deviceId) => detectionWiring!.isDetectionActive(deviceId),
    getActiveDetectionConfig: (deviceId) => detectionWiring!.getActiveDetectionConfig(deviceId),
    getLedgerConfig: (deviceId) => ledger.getConfig(deviceId),
    scheduleReconcile: () => reconcile!.scheduleReconcile(),
  })
  // Progressive real-field sync (see class doc) — `subscribeToAudioAnalyzerReadiness`
  // (unmoved on the addon) reads `this.audio!` directly, and can fire as
  // early as the readiness-registry hydration replay a few lines below —
  // strictly before `onInitialize`'s post-await field assignment ever runs
  // (both are microtasks; this one is queued first). Sync it here, the
  // instant it's built, so no boot-time reader can ever observe null.
  deps.setAudio(audio)

  // `api`/`acquireCapability` read through `ctxIfReady` (non-throwing) rather
  // than the throwing `ctx` getter, so a call that lands after
  // `dispose()` degrades gracefully instead of throwing through a
  // nulled ctx (see `waitForAgentAndCatalog`'s shutdown-abort in
  // `pipeline-settings-store.ts`, smell #20).
  // Late-bound so the settings store's `hasPackageZone` dep can read package
  // zone rules off the zone-rules provider, which is constructed further down
  // (after agent + readiness wiring). The closure is only ever INVOKED at
  // runtime (`resolvePipelineForDevice`), long after both are built — mirrors
  // the `placement!` forward-reference pattern below.
  let zoneRulesProviderRef: ZoneRulesProvider | null = null

  // Zone-driven activation of `package-detection` runs through a per-device
  // MIRROR, not a raw read. `listRules` folds a store failure into `[]`, which
  // is indistinguishable from "the operator deleted the zone" — and that answer
  // STRIPS the step from the resolved pipeline with nothing logged. Same shape
  // as the doorbell that rang 0/3 (D49). See `package-zone-gate.ts` for what
  // each branch errs towards and why.
  const packageZoneGate = new PackageZoneGate({
    logger: deps.ctx().logger,
    readPackageRules: async (deviceId) => {
      const provider = zoneRulesProviderRef
      if (!provider) {
        // Only reachable before the provider is constructed a few lines below;
        // `resolvePipelineForDevice` is a runtime path, so this is a wiring
        // fault rather than a real state. It is still a read that produced no
        // information — never a "no zones".
        return { ok: false, error: 'zone-rules provider not constructed yet' }
      }
      return provider.listRulesChecked({ deviceId, stage: 'package' })
    },
  })

  const settingsStore: PipelineSettingsStore = new PipelineSettingsStore({
    state: deps.state,
    api: () => deps.ctxIfReady()?.api ?? null,
    acquireCapability: (capName, scope, opts) => {
      const ctx = deps.ctxIfReady()
      if (!ctx) {
        return Promise.reject(
          new Error('PipelineOrchestrator: acquireCapability called after shutdown'),
        )
      }
      return ctx.acquireCapability(capName, scope, opts)
    },
    getAssignmentNode: (deviceId) => ledger.getAssignment(deviceId)?.agentNodeId ?? localNodeId,
    hasPackageZone: (deviceId) => packageZoneGate.isActive(deviceId),
    logger: deps.ctx().logger,
  })

  // `loadShed`/`placement` (S8 extraction, clusters C15/C3) — see their
  // field docs in `index.ts` for construction-order reasoning. `loadShed.attach`/
  // `.detach`/`.redispatchSingleCamera` are lazy closures onto `placement`
  // (constructed next), safe because they're only INVOKED later, never
  // during either constructor.
  const loadShed: LoadShedController = new LoadShedController({
    ledger,
    loadService,
    topology,
    settingsStore,
    attach: (nodeId, config) => placement!.attachOn(nodeId, config),
    detach: (nodeId, deviceId) => placement!.detachOn(nodeId, deviceId),
    watchdog: () => pipelineWatchdog,
    api: () => deps.ctxIfReady()?.api ?? null,
    logger: deps.ctx().logger,
    redispatchSingleCamera: (deviceId) => placement!.redispatchSingleCamera(deviceId),
    readPipelinePin: (deviceId) => deps.readPipelinePin(deviceId),
    readGlobalSettings: () => globalSettings,
    getInitTimestamp: () => deps.initTimestamp,
  })

  // Per-NODE saturation verdict (task 19). Shares the camera-metrics
  // subscription with `loadShed` but keeps the fields that one discards (queue
  // depth, dropped frames) — `LoadShedController` reasons per CAMERA against an
  // absolute fps floor, which is why it ships disabled; this one reasons per
  // NODE against a corroborated composite. Default mode is `observe`: it logs a
  // node changing state and moves nothing.
  //
  // The move history is DURABLE (`node-stress-move-ledger.ts`). Before this,
  // every restart granted a fresh 4-moves/hour budget and cleared every
  // cooldown and return ban — the guards that are the whole safety argument for
  // `failover` mode did not survive the event they most needed to survive.
  // `ctx.records` is guaranteed non-null here: the hub declares the orchestrator
  // record kinds at the top of `onInitialize`, before this function is called.
  const orchestratorRecords = deps.ctx().records
  if (orchestratorRecords === undefined)
    throw new Error('pipeline-orchestrator (hub) needs ctx.records — not reached on an agent')
  const nodeStressMoves = new NodeStressMoveLedger({
    kind: orchestratorRecords.kind(orchestratorRecordKinds['node-stress-moves']),
    logger: deps.ctx().logger.child('node-stress'),
  })
  // Node-stress long-term statistics — `observe` finally gets a baseline.
  const nodeStressLts = new NodeStressHistoryProducer({
    deviceHistory: nodeStressHistoryClient(deps.ctx().api.deviceHistory),
    logger: deps.ctx().logger.child('node-stress-history'),
  })
  const nodeStress: NodeStressController = new NodeStressController({
    ledger,
    moves: nodeStressMoves,
    lts: nodeStressLts,
    topology,
    settingsStore,
    logger: deps.ctx().logger,
    attach: (nodeId, config) => placement!.attachOn(nodeId, config),
    detach: (nodeId, deviceId) => placement!.detachOn(nodeId, deviceId),
    readPipelinePin: (deviceId) => deps.readPipelinePin(deviceId),
    readGlobalSettings: () => globalSettings,
    // Share placement's failover target (D750): the healthy node furthest
    // below its EFFECTIVE share. Read at sweep time, after boot completed.
    readFailoverShares: async () =>
      readSessionPlacement() === 'share' ? settingsStore.buildNodeWeights() : null,
  })
  // Reseed BEFORE the sweep can act. The kind was declared at the top of
  // onInitialize (ctx.records.declare). A failure here leaves an empty history
  // — the pre-existing behaviour — and says so; it must never abort boot,
  // because a controller that cannot read its budget still has a `hold` path
  // and the operator still has a running orchestrator.
  await nodeStress.hydrate().catch((err: unknown) => {
    deps.ctx().logger.warn('node-stress move history unavailable — this boot starts cold', {
      meta: { error: errMsg(err) },
    })
  })
  await nodeStressLts.declare().catch((err: unknown) => {
    deps.ctx().logger.warn('node-stress statistics unavailable — no baseline this boot', {
      meta: { error: errMsg(err) },
    })
  })
  // Closed buckets are written once a minute; four ticks in five write nothing.
  const nodeStressLtsTimer = setInterval(() => {
    void nodeStressLts.flushDue().catch((err: unknown) => {
      deps.ctx().logger.warn('node-stress statistics flush failed', {
        meta: { error: errMsg(err) },
      })
    })
  }, 60_000)
  nodeStress.start()
  // ONE rotation for the whole orchestrator, shared by the standing-attach
  // (`PlacementService`) and on-motion (`SessionDispatchController`) dispatch
  // paths: both consume the same physical accelerators, so two independent
  // rotations would each believe they were spreading load while together
  // re-creating the imbalance.
  const inferenceRotation = new RoundRobinInferenceDeviceRotation()
  // What the share elections remember, so on-motion sessions that never
  // overlap still split by weight instead of all going to the first key.
  const shareHistory = new ShareElectionHistory()
  // Where each camera's last session ran: the share election keeps it there
  // while it is within one session of the turn holder (D916).
  const sessionAffinity = new SessionAffinityMemory()
  // The cluster session placement policy (D748), read from the live global
  // settings on every dispatch; anything unset or unknown is `share` (D750).
  const readSessionPlacement = (): SessionPlacementPolicy =>
    parseSessionPlacementPolicy(globalSettings?.[SESSION_PLACEMENT_SETTING_KEY])
  // Where the shares come from (D750); unset or unknown is `auto`.
  const readShareSource = (): ShareSource =>
    parseShareSource(globalSettings?.[SHARE_SOURCE_SETTING_KEY])

  /**
   * Can the watchdog's audio stage ever receive a signal for this camera?
   * Only `absent` — POSITIVE evidence of no audio track — disarms it.
   *
   * This used to read `BrokerStats.audio !== null` directly, and that is a
   * false negative on every COLD broker: `getStats()` answers `audio: null`
   * until a track is observed, and dispatch normally runs while the stream is
   * idle. So the audio stage armed only for cameras that happened to be hot at
   * dispatch — which is why camera 108's derived stream delivered zero audio
   * chunks for four days without a single watchdog line. A stage armed on a
   * camera that turns out to have no audio is BOUNDED: the watchdog disarms a
   * stage that never produced one signal, with one line.
   */
  const resolveHasAudioSource = async (deviceId: number, camStreamId: string): Promise<boolean> =>
    (await resolveAudioTrackProbe(deviceId, camStreamId)).kind !== 'absent'

  /**
   * The cam-stream a camera's audio subscription rides — `selectAudioCamStream`
   * over the same profile-slot read the detection plane uses. `null` when the
   * selection refuses (every rung is a `derived:*` transcode, or nothing is
   * assigned): an audio-only consumer never causes a video transcode, so there
   * is genuinely no stream and the watchdog must not arm its audio stage.
   */
  const resolveAudioCamStream = async (config: RunnerCameraConfig): Promise<string | null> => {
    const selection = selectAudioCamStream({
      // The SAME pick the subscription reads — `buildRunnerConfig` carries it
      // onto the runner config precisely so the watchdog cannot resolve a
      // different stream than the analyser is listening to. Absent ⇒ `auto`.
      pick: config.audioStreamPick ?? 'auto',
      motionStreamId: config.motionStreamId,
      assigned: await detectionWiring!.fetchAssignedProfiles(config.deviceId),
    })
    return selection.kind === 'selected' ? selection.camStreamId : null
  }

  const placement: PlacementService = new PlacementService({
    benchmarkNodeId: () => deps.benchmarkNodeId?.() ?? null,
    ctx: () => deps.ctx(),
    ctxIfReady: () => deps.ctxIfReady(),
    ledger,
    topology,
    loadService,
    settingsStore,
    loadShed,
    watchdog: () => pipelineWatchdog,
    localNodeId: () => localNodeId,
    readPipelinePin: (deviceId) => deps.readPipelinePin(deviceId),
    // orch-F5 standing-attach device balancer seams (same closures the
    // session-time dispatcher below receives).
    getEligibleInferenceDevices: (nodeId) =>
      deps.getEligibleInferenceDevices(nodeId, 'await-catalog'),
    getEligibleInferenceDevicesIfCached: (nodeId) =>
      deps.getEligibleInferenceDevicesIfCached(nodeId),
    isNodeInferenceUsable: (nodeId) => deps.isNodeInferenceUsable(nodeId),
    getInferenceDeviceCaps: (nodeId) => deps.getInferenceDeviceCaps(nodeId),
    readPipelineDevicePin: (deviceId) => deps.readPipelineDevicePin(deviceId),
    inferenceRotation,
    buildWatchdogCamera: (config, deviceName, audio) =>
      detectionWiring!.buildWatchdogCamera(config, deviceName, audio),
    hasAudioSource: (deviceId, camStreamId) => resolveHasAudioSource(deviceId, camStreamId),
    // ONE audio-stream decision in the orchestrator, shared by the plane that
    // subscribes and the stage that watches it. Anything else and the watchdog
    // arms on a stream the analyser is not on.
    audioCamStreamFor: (config) => resolveAudioCamStream(config),
    isIdleSessionCamera: (deviceId) => deps.isIdleSessionCamera(deviceId),
    // Lazy closures onto `session` (constructed right below — boot-safe,
    // same forward-reference pattern as the `detectionWiring!` closures).
    activeSessionNode: (deviceId) => session.activeSessionNode(deviceId),
    closeActiveSession: (deviceId) => session.closeSessionForReassign(deviceId),
    reconcilePlacementFromRunners: () => reconcile!.reconcilePlacementFromRunners(),
    emitResolvedCameraUpdated: (deviceId) => deps.emitResolvedCameraUpdated(deviceId),
    maintenancePaused: () => deps.maintenancePaused(),
  })

  // Session-time dispatch for `on-motion` cameras (S11 Task 2: `session-
  // dispatch-controller.ts`, C16). Constructed here — right after
  // `placement` — because `ledger`/`topology`/`loadService`/`settingsStore`
  // are passed as direct object references (must already exist);
  // `attachOn`/`detachOn`/`listZones`/`readPipelinePin` are lazy closures
  // (safe regardless of construction order, same as `loadShed`'s
  // `attach`/`detach` closures onto `placement` above).
  // Blind-camera monitor (D907): a camera that MOVED, was analysed, and whose
  // detector produced nothing at all. Frames come from `handleInferenceResult`
  // (every frame, empty ones included), motion from the session registry's
  // open/close edges — an in-memory mirror, no read on the event path (D49) —
  // and it is swept on the pending-retry tick below, so it costs no timer.
  // Declared before the session controller that feeds it.
  const blindMonitor = new DetectionBlindMonitor()

  const session: SessionDispatchController = new SessionDispatchController({
    onSessionEdge: (edge) =>
      edge.edge === 'open'
        ? blindMonitor.noteSessionOpen(edge.deviceId, edge.at)
        : blindMonitor.noteSessionClose(edge.deviceId, edge.at),
    ledger,
    topology,
    loadService,
    settingsStore,
    attachOn: (nodeId, config) => deps.attachOn(nodeId, config),
    detachOn: (nodeId, deviceId) => deps.detachOn(nodeId, deviceId),
    // The recheck's burst producer (D547): the runner's out-of-band burst,
    // pinned to the node the recheck registration was attached on.
    requestBurstOn: async (nodeId, deviceId, frames, reason) =>
      deps
        .ctx()
        .api.pipelineRunner.requestOccupancyBurst.mutate(
          { deviceId, frames, reason },
          nodePin(nodeId),
        ),
    recordAssignment: (deviceId, agentNodeId, reason, pinned) =>
      ledger.recordAssignment(deviceId, agentNodeId, reason, pinned),
    dropAssignment: (deviceId, emit) => ledger.dropAssignment(deviceId, emit),
    reconcilePlacementFromRunners: () => reconcile!.reconcilePlacementFromRunners(),
    // Lazy closures onto `detectionWiring` (constructed LAST — see its
    // field doc in `index.ts` for why this forward reference is boot-safe).
    getActiveDetectionConfig: (deviceId) => detectionWiring!.getActiveDetectionConfig(deviceId),
    // Lazy onto `cameraSensors` (constructed below); only called on a dispatch,
    // after boot has finished.
    sensorNameOf: (cameraId, sensorId) => cameraSensors.sensorNameOf(cameraId, sensorId),
    dropActiveDetection: (deviceId) => {
      detectionWiring!.dropActiveDetection(deviceId)
    },
    listZones: async (deviceId) => (await zonesProvider?.listZones({ deviceId })) ?? [],
    readPipelinePin: (deviceId) => deps.readPipelinePin(deviceId),
    getEligibleInferenceDevices: (nodeId, read) => deps.getEligibleInferenceDevices(nodeId, read),
    isNodeInferenceUsable: (nodeId) => deps.isNodeInferenceUsable(nodeId),
    getInferenceDeviceCaps: (nodeId) => deps.getInferenceDeviceCaps(nodeId),
    readPipelineDevicePin: (deviceId) => deps.readPipelineDevicePin(deviceId),
    inferenceRotation,
    shareHistory,
    sessionAffinity,
    sessionPlacement: () => readSessionPlacement(),
    placementStats: deps.placementStats,
    logger: deps.ctx().logger,
  })

  // Device-details aggregator contributions (S11 Task 1: `device-config-
  // contributions.ts`, C13 remnant). Constructed here — AFTER `settingsStore`/
  // `topology`/`placement`/`loadShed` all exist — even though `placement`/
  // `loadShed` are only reached via lazy closures below (so construction
  // order against them isn't strictly required); `settingsStore` and
  // `topology` ARE passed as direct object references, so those two must
  // already exist.
  const deviceConfig: DeviceConfigContributions = new DeviceConfigContributions({
    ctx: () => deps.ctx(),
    topology,
    getAssignment: (deviceId) => ledger.getAssignment(deviceId),
    deviceSettingsSchema: () => deps.deviceSettingsSchema(),
    deviceHasOnboardMotionCap: (deviceId) => deps.deviceHasOnboardMotionCap(deviceId),
    deviceHasActivitySignalCap: (deviceId) => deps.deviceHasActivitySignalCap(deviceId),
    deviceHasNativeObjectDetectionCap: (deviceId) =>
      deps.deviceHasNativeObjectDetectionCap(deviceId),
    baseUpdateGlobalSettings: (patch) => deps.baseUpdateGlobalSettings(patch),
    resolveGlobalStore: () => deps.resolveGlobalStore(),
    setGlobalSettings: (settings) => {
      globalSettings = settings
    },
    applyRuntimeSettings: (config) => deps.applyRuntimeSettings(config),
    redispatchAllActiveCameras: (reason) => placement.redispatchAllActiveCameras(reason),
    clearOnSettingsChange: () => loadShed.clearOnSettingsChange(),
  })

  // Per-camera FUNCTION SWITCH group — DEPRECATED compatibility shim (D113).
  // It serves `getCameraSwitches` / `setCameraSwitch` for shipped viewers
  // (v1.0.305) and the current admin UI ONLY, over the same
  // `readSwitchAuthorities` pass the status badge uses, so the two surfaces
  // cannot disagree while both exist. Nothing on this server reads it.
  // ONE sampler for the whole process, shared by both surfaces that read the
  // authorities — two would each let the same flood through. It exists because
  // `getCameraStatuses` runs the authority pass PER CAMERA on a call the admin
  // Cameras page polls every 5 seconds, which without it was 337 WARN lines in
  // one minute (2026-08-21). There is deliberately no CACHE beside it: the one
  // authority that reaches a camera keeps its freshness in the provider, where
  // the write that changes it lands (D221).
  const switchWarnSampler: RepeatWarnSampler = new RepeatWarnSampler()

  const cameraSwitchService: CameraSwitchService = new CameraSwitchService({
    api: () => deps.ctx().api ?? null,
    logger: deps.ctx().logger,
    // `broker-audio` (D83) reads and writes a per-NODE singleton cap, so it
    // needs the same source-owner pin `CameraStatusService` uses for every
    // other stream-broker call.
    assignSource: (deviceId) => topology.assignSource(deviceId),
    warnSampler: switchWarnSampler,
  })

  // Camera sensors (D672): an attached sensor's rise is the CAMERA's onboard
  // motion. Constructed before `cameraStatusService` (the status names every
  // attachment from `statusFor`). The hot path reads only memory; every read
  // below runs off the event path, lifecycle-driven (R9).
  const cameraSensorsSource = new CameraSensorsSource({
    logger: deps.ctx().logger,
    emitMotion: (motion) =>
      deps.ctx().eventBus.emit(
        createEvent(
          EventCategory.MotionOnMotionChanged,
          { type: 'device', id: motion.deviceId, deviceId: motion.deviceId },
          {
            deviceId: motion.deviceId,
            detected: motion.detected,
            timestamp: motion.timestamp,
            source: CAMERA_SENSORS_SOURCE,
            triggeredBy: motion.triggeredBy,
            ...(motion.regions === undefined ? {} : { regions: motion.regions }),
          },
        ),
      ),
    motionSourcesFor: (id) => detectionWiring!.getActiveDetectionConfig(id)?.motionSources ?? null,
    sustainMsFor: (id) =>
      sustainIntervalMs(detectionWiring!.getActiveDetectionConfig(id)?.motionCooldownMs),
    cooldownMsFor: (id) =>
      detectionWiring!.getActiveDetectionConfig(id)?.motionCooldownMs ?? DEFAULT_MOTION_COOLDOWN_MS,
    maxHoldMsFor: (id) =>
      detectionWiring!.getActiveDetectionConfig(id)?.maxSessionHoldMs ??
      DEFAULT_MAX_SESSION_HOLD_MS,
    now: () => Date.now(),
  })
  const listCameraIds = async (): Promise<CameraIdsRead> => {
    try {
      const rows = await deps
        .ctx()
        .api.deviceManager.listAll.query({ isCamera: true, projection: 'slim' })
      return { kind: 'ids', ids: rows.map((r) => r.id) }
    } catch (err: unknown) {
      return { kind: 'unreadable', error: errMsg(err) }
    }
  }
  const cameraSensors = new CameraSensorsController({
    logger: deps.ctx().logger,
    source: cameraSensorsSource,
    listCameraIds,
    readSetting: (id) => {
      const settings = deps.ctx().settings
      if (!settings) {
        return Promise.resolve({ state: 'unreadable', reason: 'no settings store in this context' })
      }
      return readCameraSensorsSetting(() => settings.readDeviceStore(id))
    },
    ports: buildCameraSensorsPorts(() => deps.ctx().api, deps.ctx().logger),
  })

  // The camera's `motion` runtime slice (D696): written ONLY here, with the
  // effective motion, fed by block 9d of the subscriptions. It writes nothing
  // until the gate says no runner node still writes the slice (a runner older
  // than D696), so the slice never has two writers; when the gate opens, every
  // camera is re-published (`camera-sensors/motion-slice.ts`). Per camera it
  // also waits for the PROVIDER gate: a camera of a provider that wrote the
  // slice before D696 is written only once that provider answered that it no
  // longer does (D696 amended 2026-10-02, `motion-slice-provider-gate.ts`).
  const motionCooldownMsFor = (id: number): number =>
    detectionWiring!.getActiveDetectionConfig(id)?.motionCooldownMs ?? DEFAULT_MOTION_COOLDOWN_MS
  const cameraMotionSlice = new CameraMotionSlice({
    logger: deps.ctx().logger,
    ...hubMotionSliceStore(() => deps.ctx().api),
    listCameraIds: async (): Promise<CameraIdsRead> => {
      try {
        const rows = await deps
          .ctx()
          .api.deviceManager.listAll.query({ isCamera: true, projection: 'slim' })
        return { kind: 'ids', ids: camerasTheSliceOwns(rows) }
      } catch (err: unknown) {
        return { kind: 'unreadable', error: errMsg(err) }
      }
    },
    motionSourcesFor: (id) => detectionWiring!.getActiveDetectionConfig(id)?.motionSources ?? null,
    windowMsFor: (id) =>
      effectiveWindowMs(
        motionCooldownMsFor(id),
        sustainIntervalMs(detectionWiring!.getActiveDetectionConfig(id)?.motionCooldownMs),
      ),
    maxHoldMsFor: (id) =>
      detectionWiring!.getActiveDetectionConfig(id)?.maxSessionHoldMs ??
      DEFAULT_MAX_SESSION_HOLD_MS,
    now: () => Date.now(),
    onEdgeWhileClosed: () => {
      motionSliceGate?.refreshIfStale()
      providerSliceGate?.refreshIfStale('motion-edge')
    },
    isCameraOpen: (id) => providerSliceGate?.isCameraOpen(id) ?? false,
  })
  providerSliceGate = new ProviderSliceGate({
    logger: deps.ctx().logger,
    listCameraOwners: async () => {
      try {
        const rows = await deps
          .ctx()
          .api.deviceManager.listAll.query({ isCamera: true, projection: 'slim' })
        return { kind: 'rows', rows: rows.map((r) => ({ id: r.id, addonId: r.addonId })) }
      } catch (err: unknown) {
        return { kind: 'unreadable', error: errMsg(err) }
      }
    },
    readProviderStatus: async (addonId) => {
      try {
        const status = await deps.ctx().api.deviceProvider.getStatus.query({ addonId })
        return {
          kind: 'answered',
          motionSliceWriter: status.motionSliceWriter === 'orchestrator' ? 'orchestrator' : null,
        }
      } catch (err: unknown) {
        return { kind: 'unreadable', error: errMsg(err) }
      }
    },
    now: () => Date.now(),
    onChange: (ids) => {
      void cameraMotionSlice.camerasChanged(ids)
    },
  })
  const providerGate = providerSliceGate
  motionSliceGate = new MotionSliceWriterGate({
    logger: deps.ctx().logger,
    runnerNodeIds: () => topology.collectRunnerNodeIds(),
    census: async () => {
      await loadService.collectAgentLoad()
    },
    // The hub's own registry (D315: ask the registry, never `nodes.topology`).
    readDirectory: async () => {
      const directory = await deps.ctx().api.nodes.directory.query()
      return directory.nodes.map((n) => ({ id: n.id, isOnline: n.isOnline }))
    },
    now: () => Date.now(),
    onChange: (open) => {
      void cameraMotionSlice.setWriterOpen(open)
    },
  })
  const sliceGate = motionSliceGate

  // Read-only per-camera status aggregator — see `camera-status-service.ts`
  // (S5 extraction). Every closure reads live state, so construction here
  // (before `refreshNodeCapabilities`/settings load below) is safe even
  // though those maps are still empty at this point.
  const cameraStatusService: CameraStatusService = new CameraStatusService({
    api: () => deps.ctx().api,
    logger: deps.ctx().logger,
    warnSampler: switchWarnSampler,
    getAssignment: (deviceId) => ledger.getAssignment(deviceId),
    getAudioAssignment: (deviceId) => audio.getAssignment(deviceId),
    getCameraConfig: (deviceId) => ledger.getConfig(deviceId),
    hasCameraConfig: (deviceId) => ledger.hasConfig(deviceId),
    // A standing camera's pending reason, or — for an on-motion camera, which
    // never has one in the ledger — the reason its last session was REFUSED
    // (D650 round 4). Same field, same vocabulary, so the operator sees a
    // `root-unrunnable` camera the same way whichever path placed it.
    getPendingReason: (deviceId) =>
      ledger.getPendingReason(deviceId) ?? session.refusalReason(deviceId),
    assignSource: (deviceId) => topology.assignSource(deviceId),
    listAssignedDeviceIds: () => [
      ...new Set([...ledger.listAssignedDeviceIds(), ...detectionWiring!.activeDeviceIds()]),
    ],
    // An on-motion camera holds no cached config between motion events, so
    // without this predicate an ARMED camera reported exactly like a camera
    // the orchestrator had never heard of.
    isSessionCamera: (deviceId) => deps.isSessionCamera(deviceId),
    // The RAW AUTHORITY READS, not the deprecated switch group (D113). The
    // badge that separates DISABLED from BROKEN must outlive the aggregate cap
    // it used to be derived from, and only the raw facts can say which
    // authority dropped out of the read — an id list that cannot say so gets
    // rendered as "the operator turned nothing off" (D62).
    // `pass` is the caller's FleetReadPass — the device row, the binding table
    // and the fleet mute list are read ONCE for the whole poll rather than once
    // per camera. It is scoped to the single call and holds nothing after it.
    switchAuthoritiesFor: async (deviceId, pass) =>
      (
        await readSwitchAuthorities(
          deps.ctx().api ?? null,
          deviceId,
          {
            logger: deps.ctx().logger,
            assignSource: (id) => topology.assignSource(id),
            warnSampler: switchWarnSampler,
          },
          pass,
        )
      ).derivation,
    // D672: memory only — an unseen camera reads NOT LOADED and is queued.
    // Folds in whether the bridge would forward at all — the same predicate its
    // emit gate asks — so a ready sensor that can never fire is not shown healthy.
    cameraSensorsFor: (deviceId) =>
      withForwarding(
        cameraSensors.statusFor(deviceId),
        detectionWiring!.getActiveDetectionConfig(deviceId)?.motionSources ?? null,
      ),
  })

  // Dispatch reconcile + pending/stranded retry + remote-health (S9:
  // `reconcile-controller.ts`, cluster C8). Constructed here — BEFORE the
  // settings-load block below — because `applyRuntimeSettings` (called
  // synchronously inside that block) invokes `schedulePendingRetry()`.
  const reconcile: ReconcileController = new ReconcileController({
    api: () => deps.ctx().api ?? null,
    ledger,
    topology,
    loadShed,
    logger: deps.ctx().logger,
    handleDeviceRegistered: (deviceId) => deps.handleDeviceRegistered(deviceId),
    handleDeviceUnregistered: (deviceId) => deps.handleDeviceUnregistered(deviceId),
    redispatchCamera: (config) => placement.redispatchCamera(config),
    detachOn: (nodeId, deviceId) => deps.detachOn(nodeId, deviceId),
    localNodeId: () => localNodeId,
    activeDeviceIds: () => detectionWiring!.activeDeviceIds(),
    isSessionCamera: (deviceId) => deps.isSessionCamera(deviceId),
    isIdleSessionCamera: (deviceId) => deps.isIdleSessionCamera(deviceId),
    isMotionWatchAttachment: (deviceId, nodeId) =>
      session.isMotionWatchAttachment(deviceId, nodeId),
    deregisterSession: (deviceId) => session.sessionRegistry.deregister(deviceId),
  })
  // Progressive real-field sync (see class doc) — `applyRuntimeSettings`
  // (unmoved on the addon) reads `this.reconcile!` synchronously below.
  deps.setReconcile(reconcile)

  // Pull the persisted addon-level settings into memory (balancer config,
  // failover policy, capability bindings) before any cap method can run.
  // `applyRuntimeSettings` derives the runtime state (`balancerConfig`,
  // `failoverPolicy`, etc.) from that raw snapshot — no defaults are
  // injected here, the merge with schema defaults happens at hydration
  // time inside `getAddonSettings()`. The runtime state derivation uses
  // `?? DEFAULT_*` fallbacks for missing keys so it's safe to read raw.
  let globalSettings: Record<string, unknown> = {}
  try {
    const stored = await deps.resolveGlobalStore()
    globalSettings = { ...stored }
    deps.applyRuntimeSettings(globalSettings)
    // Derive the enabled-node sets from the per-node capability store. Must
    // run before the `knownRunnerNodes` seed below reads `topology.enabledNodes`.
    await topology.refreshNodeCapabilities()
  } catch (err: unknown) {
    const msg = errMsg(err)
    deps.ctx().logger.warn('orchestrator settings load failed — using defaults', {
      meta: { error: msg },
    })
  }

  // When this addon runs inside a group-runner subprocess the broker
  // nodeID is hierarchical (`hub/pipeline`, `dev-agent-0/pipeline`).
  // The orchestrator's "local node" semantic is the cluster-visible
  // PARENT node, so strip the `/<group>` suffix. In legacy in-process
  // mode there's no slash and this is a no-op.
  const rawNodeId = deps.ctx().kernel.localNodeId ?? 'hub'
  let localNodeId = rawNodeId.includes('/') ? rawNodeId.split('/')[0]! : rawNodeId
  topology.clearKnownRunnerNodes()
  topology.addKnownRunnerNode(localNodeId)
  // Seed knownRunnerNodes from the persisted enabledNodes whitelist so the
  // orchestrator can dispatch immediately on restart without waiting for
  // AgentOnline events to arrive (production: Moleculer fires $node.connected
  // for already-online nodes, but timing isn't guaranteed before subscriptions
  // are set up). Nodes that are actually offline simply fail getLocalLoad
  // and are silently skipped in collectAgentLoad.
  for (const nodeId of topology.enabledNodes) {
    topology.addKnownRunnerNode(nodeId)
  }

  // Runner disconnect/reconnect failover + `detection-pipeline` readiness
  // plumbing (S9: `node-lifecycle-handler.ts`, cluster C6 + C7-detection).
  // Constructed here — AFTER `localNodeId` is resolved just above (its
  // owned `ReadinessRegistry` fallback snapshots `localNodeId()` as
  // `sourceNodeId` at construction time) and AFTER `reconcile` (whose
  // `scheduleReconcile`/`schedulePendingRetry` it depends on) — immediately
  // before the AgentOnline/AgentOffline subscriptions below, which are the
  // first thing that can call into it.
  const nodeLifecycle: NodeLifecycleHandler = new NodeLifecycleHandler({
    ledger,
    topology,
    loadService,
    settingsStore,
    attachOn: (nodeId, config) => deps.attachOn(nodeId, config),
    resolveAttachPipeline: (input) => placement.resolveAttachPipelineOnDevice(input),
    rebalance: (opts) => deps.rebalance(opts),
    scheduleReconcile: () => reconcile.scheduleReconcile(),
    schedulePendingRetry: () => reconcile.schedulePendingRetry(),
    failoverPolicy: () => deps.failoverPolicy(),
    localNodeId: () => localNodeId,
    writeDeviceStore: (deviceId, patch) =>
      deps.ctx().settings?.writeDeviceStore(deviceId, patch) ?? Promise.resolve(),
    isSessionCamera: (deviceId) => deps.isSessionCamera(deviceId),
    deregisterSession: (deviceId) => session.sessionRegistry.deregister(deviceId),
    logger: deps.ctx().logger,
    eventBus: deps.ctx().eventBus,
    sharedRegistry: deps.ctx().kernel?.readinessRegistry ?? null,
    // The node's runner came up (new readiness epoch): forget its answer BEFORE
    // the re-attach, and ask — never await — a census (D696, review F1).
    onRunnerReady: (nodeId) => {
      sliceGate.forgetNode(nodeId)
      void sliceGate.refresh('runner-ready')
    },
  })
  // Progressive real-field sync (see class doc) — `subscribeToAudioAnalyzerReadiness`
  // (unmoved on the addon) reads `this.nodeLifecycle!` synchronously below.
  deps.setNodeLifecycle(nodeLifecycle)

  // Subscribe to agent lifecycle via the event bus (forwarded from Moleculer
  // $node.connected/$node.disconnected by agent-registry.service.ts).
  // Both AgentOnline and AgentOffline carry `data: { agentId: string }`.
  const unsubAgentOffline = deps
    .ctx()
    .eventBus.subscribe({ category: EventCategory.AgentOffline }, (event) => {
      const nodeId = event.data.agentId
      if (!nodeId.includes('/')) {
        topology.removeKnownRunnerNode(nodeId)
      }
      // The registry's POSITIVE statement that the node is gone: it stops
      // counting for the motion-slice gate (an offline node cannot reach the
      // hub's `setCapSlice`), until it reconnects and answers (D696, D58).
      sliceGate.noteOffline(nodeId)
      void sliceGate.refresh('agent-offline')
      nodeLifecycle.unsubscribeDetectionPipelineReadiness(nodeId)
      audio.markNodeOffline(nodeId)
      // The device list the node left with is not the one it may return with.
      deps.forgetInferenceDeviceProbe(nodeId)
      if (!nodeId.includes('/')) deps.noteShareTopologyChange(`node-offline:${nodeId}`)
      nodeLifecycle.handleNodeDisconnect(nodeId).catch((err: unknown) => {
        const msg = errMsg(err)
        deps.ctx().logger.error('failover after disconnect failed', {
          tags: { nodeId },
          meta: { error: msg },
        })
      })
    }) as Unsubscribe

  // A FORKED process (`<node>/<group>`, on the hub or on an agent) gets
  // `WorkerOnline` / `WorkerOffline` from its parent's UDS registry, at its
  // pre-init register and after its teardown — never `AgentOnline`. The RUNNER
  // gate forgets only for the runner's own child (`<node>/detection`, R1-M1);
  // its readiness epoch (`onRunnerReady`) forgets too, so a dropped event loses
  // nothing. The PROVIDER gate keys on its four provider ids.
  const unsubWorkerOnline = deps
    .ctx()
    .eventBus.subscribe({ category: EventCategory.WorkerOnline }, (event) => {
      // Only the RUNNER's own child can bring a slice writer back (R1-M1).
      if (isRunnerProcess(event.data.workerId)) {
        sliceGate.forgetNode(event.data.workerId)
        void sliceGate.refresh('worker-online')
      }
      // A provider process coming (back) up — a rolled-back one included — is
      // forgotten BEFORE it can restore a device and seed or write a slice.
      providerGate.forgetProcess(event.data.workerId)
      void providerGate.refresh('worker-online')
    }) as Unsubscribe
  const unsubWorkerOffline = deps
    .ctx()
    .eventBus.subscribe({ category: EventCategory.WorkerOffline }, (event) => {
      // Only the RUNNER's own child can bring a slice writer back (R1-M1).
      if (isRunnerProcess(event.data.workerId)) {
        sliceGate.forgetNode(event.data.workerId)
        void sliceGate.refresh('worker-offline')
      }
      // The registry's word that this process left: a provider that is gone cannot write.
      providerGate.noteProcessGone(event.data.workerId)
      void providerGate.refresh('worker-offline')
    }) as Unsubscribe

  const unsubAgentOnlineEvent = deps
    .ctx()
    .eventBus.subscribe({ category: EventCategory.AgentOnline }, (event) => {
      const nodeId = event.data.agentId
      // Only track top-level cluster agents (hub, dev-agent-0, etc.).
      // Child processes have hierarchical nodeIds with '/' (e.g.
      // hub/decoder-nodeav, dev-agent-0/motion-wasm) — these are
      // forkable services, not dispatchable pipeline nodes. They DO
      // however carry the detection-pipeline provider when they
      // represent a forked child (e.g. `hub/detection-pipeline`);
      // the readiness subscription handler below covers those via
      // its top-level nodeId scope subscription — the forked
      // child's `ready` emit is keyed on its parent nodeId.
      if (!nodeId.includes('/')) topology.addKnownRunnerNode(nodeId)
      // A new agent has no stored settings: re-derive the enabled sets so it
      // enters detect/audio/ingest balancing (default ON) without waiting for a
      // capability edit.
      if (!nodeId.includes('/')) {
        void topology.refreshNodeCapabilities().catch((err: unknown) => {
          deps.ctx().logger.warn('refreshNodeCapabilities after agent online failed', {
            tags: { nodeId },
            meta: { error: errMsg(err) },
          })
        })
      }
      // Before anything below can re-attach a camera: a (re)connecting process
      // may be a respawned runner, a rolled-back one included, that writes the
      // motion slice. Its node's answer is forgotten, so the motion-slice gate
      // closes now and reopens only on a fresh answer (D696).
      sliceGate.forgetNode(nodeId)
      void sliceGate.refresh('agent-online')
      providerGate.forgetProcess(nodeId)
      void providerGate.refresh('agent-online')
      if (!nodeId.includes('/')) {
        nodeLifecycle.subscribeToDetectionPipelineReadiness(nodeId)
        deps.subscribeToAudioAnalyzerReadiness(nodeId)
      }
      nodeLifecycle.handleNodeConnect(nodeId).catch((err: unknown) => {
        const msg = errMsg(err)
        deps.ctx().logger.error('reconnect handling failed', {
          tags: { nodeId },
          meta: { error: msg },
        })
      })
      // Agent (re)connect → reconcile in case slot-changed events were
      // dropped while this node was offline.
      reconcile.scheduleReconcile()
      if (!nodeId.includes('/')) deps.noteShareTopologyChange(`node-online:${nodeId}`)
    }) as Unsubscribe
  const unsubAgentOnline: Unsubscribe = () => {
    unsubAgentOnlineEvent()
    unsubWorkerOnline()
    unsubWorkerOffline()
  }

  // Capability-level failover: a forked worker or remote agent can lose a
  // single critical cap (pipeline-executor / analysis-pipeline) while the
  // hosting node itself stays online — AgentOffline never fires in that
  // case. Subscribe to synthetic `system.ready-state` `down` events so we
  // can failover cameras off a node whose execution pipeline collapsed.
  //
  // Decoder `down` is intentionally NOT handled here — stream-broker owns
  // its own decoder rotation via the same event stream (see addon.ts).
  deps.watchCapability(['pipeline-executor', 'analysis-pipeline'], {
    onDown: (nodeId, capName) => {
      // Don't skip localNodeId: a forked-worker-on-hub dying emits
      // scope.nodeId='hub' and we DO want failover for that case.
      deps.ctx().logger.warn('Critical pipeline cap went down — running camera failover', {
        tags: { nodeId },
        meta: { capName },
      })
      nodeLifecycle.handleNodeDisconnect(nodeId).catch((err: unknown) => {
        const msg = errMsg(err)
        deps.ctx().logger.error('failover after cap-down failed', {
          tags: { nodeId },
          meta: { capName, error: msg },
        })
      })
    },
  })

  // Legacy pipeline keys (`pipelines`, `pipelineDefaults`) from the
  // pre-3-level model stay in the store as a last-resort fallback for
  // `resolvePipelineForDevice`. They get overwritten by the new
  // agent/camera settings on the first operator edit. Never auto-drop:
  // the orchestrator's job is to degrade gracefully across upgrades.

  // Readiness-driven agent seed. The orchestrator keeps a
  // per-process `ReadinessRegistry` subscribed to
  // `system.ready-state` events; whenever the detection-pipeline
  // provider for a node transitions to `ready` (including forked
  // children like `hub/detection-pipeline`, and every reconnect),
  // we re-seed that node's `agentAddonDefaults` from its fresh
  // catalog and redispatch cameras assigned there. Fixes the
  // detection-never-starts race: the old init-time seed missed
  // providers that connected AFTER the orchestrator booted.
  // (S9: the registry itself now lives inside `nodeLifecycle`,
  // constructed above — this block only drives the SEED subscriptions,
  // at the exact same point in `onInitialize` as before.)
  nodeLifecycle.subscribeToDetectionPipelineReadiness(localNodeId)
  // Seed readyAudioNodes with localNodeId — audio-analyzer starts on hub.
  audio.seedReadyNode(localNodeId)
  deps.subscribeToAudioAnalyzerReadiness(localNodeId)
  // Remote agents that were already online when the orchestrator
  // booted (Moleculer fires $node.connected for existing peers on
  // subscribe, but only for the lifetime after subscribe was wired):
  // seed readiness-subscriptions for the persisted whitelist too, so
  // we don't miss their initial `ready` emission.
  for (const nodeId of topology.enabledNodes) {
    if (nodeId === localNodeId) continue
    nodeLifecycle.subscribeToDetectionPipelineReadiness(nodeId)
    deps.subscribeToAudioAnalyzerReadiness(nodeId)
  }

  deps.ctx().logger.info('Pipeline orchestrator initialized', {
    tags: { nodeId: localNodeId },
  })

  // Detection-wiring event-bus subscriptions moved to
  // `wireOrchestratorSubscriptions` (S9 extraction) — wired near the end
  // of this function, LAST, after every controller it delegates onto
  // (`reconcile`, `nodeLifecycle`, `audio`, `loadShed`, `pipelineWatchdog`)
  // already exists. Safe to be later than its original position here:
  // this whole region (subscription wiring through the eager reconcile
  // call) is fully synchronous — no `await` — so no event could ever land
  // in the gap regardless of exactly where the `eventBus.subscribe(...)`
  // calls happen to run.

  // Per-camera pipeline watchdog. Tracks freshness of each camera's
  // continuous stages (always-on audio, analyzer motion, always-on
  // detection), emits a consolidated heartbeat per camera every tick,
  // and triggers bounded auto-recovery for stalled stages.
  const pipelineWatchdog: PipelineWatchdog = new PipelineWatchdog({
    now: () => Date.now(),
    logger: deps.ctx().logger,
    recover: (deviceId, stage, streamId, attempt) =>
      detectionWiring!.recoverPipelineStage(deviceId, stage, streamId, attempt),
    thresholds: DEFAULT_WATCHDOG_THRESHOLDS,
  })
  pipelineWatchdog.start(deps.watchdogIntervalMs)

  // Periodic pending/stranded retry sweep (T3). Recovers cameras that
  // `reconcileDispatch` (additive-only) can never revisit — those left
  // UNASSIGNED by over-cap / no-frame-source / load-shed. Cleared in
  // `onShutdown`. Event triggers (capacity/eligibility/readiness/node-connect)
  // call `schedulePendingRetry` for faster recovery than this 60 s net.
  const pendingRetryTimer = setInterval(() => {
    void reconcile.retryPendingDispatches()
    // Same tick, different question — piggybacked deliberately rather than
    // arming a second interval for one map scan.
    const sweepAt = Date.now()
    for (const noise of blindMonitor.sweepMotion(sweepAt)) {
      const dutyPct = Math.round(noise.duty * 100)
      const line =
        noise.phase === 'noisy'
          ? 'camera motion is constant and finds no subject — tune its motion zones or sensitivity'
          : 'camera motion calmed down'
      const extras = {
        tags: { deviceId: noise.deviceId },
        meta: { dutyPct, sessions: noise.sessions, windowMs: noise.windowMs },
      }
      if (noise.phase === 'noisy') deps.ctx().logger.warn(line, extras)
      else deps.ctx().logger.info(line, extras)
      deps.ctx().eventBus.emit({
        id: randomUUID(),
        timestamp: new Date(),
        source: { type: 'device', id: noise.deviceId, deviceId: noise.deviceId },
        category:
          noise.phase === 'noisy'
            ? EventCategory.PipelineMotionNoisy
            : EventCategory.PipelineMotionCalm,
        data: {
          deviceId: noise.deviceId,
          windowMs: noise.windowMs,
          dutyPct,
          sessions: noise.sessions,
        },
      })
    }
    for (const blind of blindMonitor.sweep(sweepAt)) {
      deps.ctx().logger.error('camera moved, was analysed, and the detector produced NOTHING', {
        tags: { deviceId: blind.deviceId },
        meta: {
          motionMs: blind.motionMs,
          sessions: blind.sessions,
          belowFloor: blind.belowFloor,
          blindForMs: blind.blindForMs,
        },
      })
      deps.ctx().eventBus.emit({
        id: randomUUID(),
        timestamp: new Date(),
        source: { type: 'device', id: blind.deviceId, deviceId: blind.deviceId },
        category: EventCategory.PipelineDetectionBlind,
        data: {
          deviceId: blind.deviceId,
          blindForMs: blind.blindForMs,
          thresholdMs: blind.thresholdMs,
          motionMs: blind.motionMs,
          sessions: blind.sessions,
          belowFloor: blind.belowFloor,
        },
      })
    }
  }, PENDING_RETRY_INTERVAL_MS)

  // Periodic auto-rebalance: correct placement drift toward the per-node
  // weights. Cleared in `onShutdown`. Cheap + a no-op on a balanced cluster
  // (hysteresis) and skipped entirely when only one node can detect.
  const autoRebalanceTimer = setInterval(
    () => void placement.runAutoRebalance(),
    AUTO_REBALANCE_INTERVAL_MS,
  )

  deps.ctx().logger.info('Pipeline orchestrator detection-wiring subscriptions installed')
  // Kick off the one-shot audioEnabled/pipelineEnabled/disableInference →
  // bindings migration in the background. Fire-and-forget so this function
  // resolves immediately; the migration awaits api availability internally.
  void migrateLegacyFlagsToBindings({
    api: () => deps.ctx().api ?? null,
    settings: deps.ctx().settings,
    cameraSettingsStore: () => settingsStore.readCameraSettingsMap(),
    doneFlag: settingsStore.bindingsMigrationDoneState,
    logger: deps.ctx().logger,
  }).catch((err: unknown) => {
    // `ctxIfReady`: the background task can lose the race with
    // `shutdown()` (tests tear the addon down quickly) — a nulled ctx
    // must not turn the warn itself into an unhandled rejection.
    deps.ctxIfReady()?.logger.warn('bindings migration failed — will retry on next boot', {
      meta: { error: errMsg(err) },
    })
  })
  // Per-camera zones CRUD — backed by the orchestrator's per-device
  // settings store, mirrored into `dev.state.zones` on every mutation.
  // Constructed here (after agent + readiness wiring) because it
  // captures `ctx` for settings access and uses a lazy api
  // accessor for the slice-mirror write — that keeps construction
  // safe even when `api` is still null at this point.
  const zoneRulesProvider: ZoneRulesProvider = new ZoneRulesProvider({
    logger: deps.ctx().logger.child('zone-rules'),
    settings: {
      readDeviceStore: (deviceId) => deps.ctx().settings!.readDeviceStore(deviceId),
      writeDeviceStore: (deviceId, patch) => deps.ctx().settings!.writeDeviceStore(deviceId, patch),
    },
    fetchDevice: (deviceId) => deps.ctx().fetchDevice(deviceId),
    // `motion`/`detection` stage changes need no re-attach — those consumers
    // read the dev-state mirror directly. The `package` stage is different:
    // it flips `package-detection` on/off via zone-driven activation
    // (`applyPackageZoneActivation`), which changes the resolved STEP tree, so
    // it must RE-RESOLVE + re-dispatch the runner config for the step to
    // activate/deactivate without waiting for the next natural attach.
    onRulesChanged: (deviceId, stage) => {
      if (stage !== 'package') return
      void reattachAfterPackageZoneChange(
        {
          ledger,
          resolveAttachPipeline: (input) => placement.resolveAttachPipelineOnDevice(input),
          attachOn: (nodeId, config) => deps.attachOn(nodeId, config),
          logger: deps.ctx().logger,
        },
        deviceId,
      )
    },
  })
  // Publish the provider to the settings store's late-bound `hasPackageZone`
  // closure now that it exists (see the forward-reference note above).
  zoneRulesProviderRef = zoneRulesProvider
  const zonesProvider: ZonesProvider = new ZonesProvider({
    logger: deps.ctx().logger.child('zones'),
    settings: {
      readDeviceStore: (deviceId) => deps.ctx().settings!.readDeviceStore(deviceId),
      writeDeviceStore: (deviceId, patch) => deps.ctx().settings!.writeDeviceStore(deviceId, patch),
    },
    fetchDevice: (deviceId) => deps.ctx().fetchDevice(deviceId),
    onZonesChanged: (deviceId, zones) => {
      // Re-dispatch the runner config so motion-wasm + pipeline-executor
      // pick up the new zones without waiting for the next attach. No-op
      // when the camera isn't attached yet — startDetection picks the
      // fresh list up via listZones in that case.
      const cached = ledger.getConfig(deviceId)
      const assignment = ledger.getAssignment(deviceId)
      if (!cached || !assignment) return
      const next: RunnerCameraConfig = { ...cached, zones }
      ledger.setConfig(deviceId, next)
      deps.attachOn(assignment.agentNodeId, next).catch((err: unknown) => {
        deps.ctx().logger.warn('zones change re-dispatch failed', {
          tags: { deviceId, nodeId: assignment.agentNodeId },
          meta: { error: errMsg(err) },
        })
      })
    },
  })

  // Seed the device-state `zones` + `zone-rules` MIRRORS for every camera,
  // once, at boot. Without this a mirror only ever existed for cameras an
  // operator had mutated since the runtime-state row was last written — camera
  // 102 had a drawn zone the mirror had never heard of, so occupancy, the two
  // runner-side zone gates and the admin Zones tab all read "no zones"
  // (2026-08-12). Both slices are swept because they gate together.
  // Fire-and-forget: hydration must never gate the orchestrator's boot, and
  // `ZonesProvider.listZones` keeps any later-adopted camera reconciled.
  void hydrateZoneMirrorsAtBoot({
    api: () => deps.ctx().api ?? null,
    hydrators: [
      { mirror: 'zones', hydrate: (deviceId) => zonesProvider.hydrateMirror(deviceId) },
      { mirror: 'zone-rules', hydrate: (deviceId) => zoneRulesProvider.hydrateMirror(deviceId) },
    ],
    logger: deps.ctx().logger.child('zones'),
  }).catch((err: unknown) => {
    // `ctxIfReady`: the background task can lose the race with `shutdown()`
    // (tests tear the addon down quickly) — a nulled ctx must not turn the
    // warn itself into an unhandled rejection.
    deps.ctxIfReady()?.logger.warn('zones mirror boot hydration failed', {
      meta: { error: errMsg(err) },
    })
  })

  // Detection-wiring event-bus subscriptions (S9: `orchestrator-subscriptions.ts`).
  // Wired LAST — every target it delegates onto (`reconcile`, `audio`,
  // `loadShed`, `pipelineWatchdog`, the C14 handlers) already exists by
  // this point.
  const unsubOrchestratorSubscriptions = wireOrchestratorSubscriptions({
    eventBus: deps.ctx().eventBus,
    logger: deps.ctx().logger,
    scheduleReconcile: () => reconcile.scheduleReconcile(),
    handleDeviceRegistered: (deviceId) => deps.handleDeviceRegistered(deviceId),
    handleDeviceUnregistered: (deviceId) => deps.handleDeviceUnregistered(deviceId),
    handleSettingsChanged: (deviceId) => deps.handleSettingsChanged(deviceId),
    handlePipelineCameraUpdated: (deviceId, config) =>
      deps.handlePipelineCameraUpdated(deviceId, config),
    handleInferenceResult: (payload) => {
      // The recheck reads every result for its found/empty verdict (D547);
      // telemetry-lossy by design, like the subject-presence tap beside it.
      session.noteInferenceResult(
        payload.deviceId,
        payload.occasion,
        payload.frame.detections?.length ?? 0,
      )
      return deps.handleInferenceResult(payload)
    },
    noteMetrics: (deviceId, nodeId, metrics) => {
      loadShed.noteMetrics(deviceId, nodeId, metrics)
      nodeStress.noteMetrics(deviceId, nodeId, metrics)
    },
    handleLazyAudioMotion: (deviceId, detected, config) =>
      audio.handleLazyAudioMotion(deviceId, detected, config),
    getActiveDetectionConfig: (deviceId) => detectionWiring!.getActiveDetectionConfig(deviceId),
    handleSessionMotion: (deviceId, detected, emittedAt, trigger, triggeredBy) =>
      session.handleSessionMotion(deviceId, detected, emittedAt, trigger, triggeredBy),
    noteSessionSubjectPresent: (deviceId) => session.noteSubjectPresent(deviceId),
    noteSessionTrackedFrame: (deviceId, liveTrackCount) =>
      session.noteTrackedFrame(deviceId, liveTrackCount),
    noteWatchdogSignal: (deviceId, stage) => pipelineWatchdog?.noteSignal(deviceId, stage),
    cameraSensors,
    cameraMotionSlice,
  })
  // The first runner census: the motion-slice gate opens only on answers (D696).
  void sliceGate.refresh('boot')
  void providerGate.refresh('boot')

  // Eager reconcile: schedule one pass after all subscriptions are wired
  // so cameras whose slot-changed event fired before this addon subscribed
  // are caught immediately rather than waiting for the next live event.
  reconcile.scheduleReconcile()

  // Detection-wiring coordination layer (S11 Task 3: `detection-wiring-
  // controller.ts`, C14). Constructed LAST — it depends on every other
  // controller (`ledger`/`placement`/`audio`/`session`/`settingsStore`/
  // `reconcile`/`loadShed`), all of which already exist by this point.
  // Every EARLIER controller/closure above that reads `activeDetections`
  // (`audio`/`session`/`reconcile`/`wireOrchestratorSubscriptions`/
  // `pipelineWatchdog`'s `recover`/`placement`'s `buildWatchdogCamera`)
  // was wired with a LAZY closure onto `detectionWiring!` — safe because
  // none of those closures are invoked synchronously during this bootstrap
  // (only later, off event-bus subscriptions, timers, or RPC handlers),
  // so `detectionWiring` is always set by the time any of them actually
  // runs.
  const detectionWiring: DetectionWiringController = new DetectionWiringController({
    ctx: () => deps.ctx(),
    // Durable last-known device features — closes the cold-boot hole that
    // dialled a sleeping battery camera awake (census §1.1 #18).
    persistFeatures: true,
    ledger,
    placement,
    audio,
    session,
    settingsStore,
    reconcile,
    loadShed,
    nodeStress,
    watchdog: () => pipelineWatchdog,
    blindMonitor: () => blindMonitor,
    api: () => deps.ctx().api ?? null,
    eventBus: deps.ctx().eventBus,
    logger: deps.ctx().logger,
    localNodeId: () => localNodeId,
    attachOn: (nodeId, config) => deps.attachOn(nodeId, config),
    listZones: (deviceId) => zonesProvider.listZones({ deviceId }) ?? Promise.resolve([]),
    forgetDeviceZones: (deviceId) => zonesProvider.forgetDevice(deviceId),
    forgetDeviceZoneRules: (deviceId) => {
      zoneRulesProvider.forgetDevice(deviceId)
      // The mirror is per-device state keyed by the same id — a removed device
      // must not leave a stale "this camera had a package zone" behind for a
      // future device that reuses the id.
      packageZoneGate.forgetDevice(deviceId)
    },
    isCapActiveForDevice: (deviceId, capName) => deps.isCapActiveForDevice(deviceId, capName),
    deviceHasOnboardMotionCap: (deviceId) => deps.deviceHasOnboardMotionCap(deviceId),
    deviceHasActivitySignalCap: (deviceId) => deps.deviceHasActivitySignalCap(deviceId),
    deviceHasNativeObjectDetectionCap: (deviceId) =>
      deps.deviceHasNativeObjectDetectionCap(deviceId),
    deviceSettingsSchema: () => deps.deviceSettingsSchema(),
  })

  // Seed the device-features mirror from the last session. Awaited: the whole
  // point of the row is to be there BEFORE the first `startDetection` read,
  // and a failure only costs the pre-existing cold behaviour.
  await detectionWiring.hydrateFeaturesMirror().catch((err: unknown) => {
    deps.ctx().logger.warn('device-features mirror not restored — this boot starts cold', {
      meta: { error: errMsg(err) },
    })
  })

  // Camera sensors' boot pass. NOT awaited: boot latency must not grow, and
  // the status says "not loaded" until it lands (R18).
  void cameraSensors.start().catch((err: unknown) => {
    deps
      .ctx()
      .logger.warn('camera sensors: boot refresh failed — waiting for the next lifecycle event', {
        meta: { error: errMsg(err) },
      })
  })

  return {
    ledger,
    topology,
    loadService,
    nodeStressLts,
    nodeStressLtsTimer,
    audio,
    settingsStore,
    loadShed,
    nodeStress,
    placement,
    session,
    deviceConfig,
    cameraStatusService,
    cameraSwitchService,
    cameraSensors,
    reconcile,
    nodeLifecycle,
    pipelineWatchdog,
    zoneRulesProvider,
    zonesProvider,
    detectionWiring,
    localNodeId,
    unsubAgentOnline,
    unsubAgentOffline,
    unsubOrchestratorSubscriptions,
    pendingRetryTimer,
    autoRebalanceTimer,
    sessionPlacement: () => readSessionPlacement(),
    shareSource: () => readShareSource(),
  }
}
