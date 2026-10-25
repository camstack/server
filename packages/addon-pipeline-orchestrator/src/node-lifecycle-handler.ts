/**
 * `NodeLifecycleHandler` — runner disconnect/reconnect failover +
 * detection-pipeline readiness plumbing (C6 + C7-detection, S9 extraction).
 *
 * Owns the `detection-pipeline` readiness registry wiring
 * (`readinessSubsByNode`/`lastSeenReadinessEpochByNode`, plus the shared-vs-
 * local `ReadinessRegistry` instance itself) and consumes the persisted
 * `failoverPolicy` to decide how a runner disconnect/reconnect is handled.
 *
 * Extracted verbatim (mechanical, zero logic change) from `index.ts` — every
 * method body, log message, and control-flow branch is unchanged; only the
 * storage backing (`this.<field>` → `this.<field>` on this class, `this.X`
 * addon calls → `this.deps.X` injected closures) differs, with one
 * intentional simplification: the former `if (!this.readinessRegistry)
 * return` null-guards are dropped because this class constructs its
 * registry unconditionally in its own constructor (the addon field used to
 * stay `null` until the readiness-seed block of the boot sequence; now the
 * whole controller — constructed at that same point in
 * `buildOrchestratorControllers` (`orchestrator-bootstrap.ts`) — is `null`
 * beforehand instead, guarded once via `this.nodeLifecycle!` like every
 * sibling controller).
 *
 * **Phase 3 slice 2 guards** (`isSessionCamera` skips inside
 * `handleNodeDisconnect`/`handleNodeConnect`'s `'restore'` path) moved
 * VERBATIM — they are live production behavior (proved by
 * `standing-machinery-on-motion-scope.spec.ts`), not touched by this
 * extraction beyond the mechanical `this.isSessionCamera` →
 * `this.deps.isSessionCamera` / `this.sessionRegistry.deregister` →
 * `this.deps.deregisterSession` storage-backing swap.
 */
import type {
  IEventBus,
  IReadinessRegistry,
  ReadinessTransition,
  RunnerCameraConfig,
} from '@camstack/types'
import {
  errMsg,
  type IScopedLogger,
  pipelineExecutorCapability,
  ReadinessRegistry,
} from '@camstack/types'
import type { AgentLoadService } from './agent-load-service.js'
import { type AttachPipelineOutcome, withAttachPipeline } from './attach-pipeline.js'
import { balance } from './load-balancer.js'
import type { NodeTopologyService } from './node-topology.js'
import type { FailoverPolicy } from './orchestrator-types.js'
import { PREFERRED_AGENT_SETTING } from './placement-service.js'
import type { PipelineSettingsStore } from './pipeline-settings-store.js'
import type { PlacementLedger } from './placement-ledger.js'

export interface NodeLifecycleHandlerDeps {
  readonly ledger: PlacementLedger
  readonly topology: NodeTopologyService
  readonly loadService: AgentLoadService
  readonly settingsStore: PipelineSettingsStore
  /** Thin seam onto `PlacementService.attachOn` (via the addon's own delegate). */
  readonly attachOn: (nodeId: string, config: RunnerCameraConfig) => Promise<void>
  /**
   * `PlacementService.resolveAttachPipelineOnDevice` — the one owner of an
   * attach's steps (D650). A re-attach replaces steps only through it.
   */
  readonly resolveAttachPipeline: (input: {
    readonly deviceId: number
    readonly nodeId: string
    readonly deviceKey: string | undefined
  }) => Promise<AttachPipelineOutcome>
  /** Thin seam onto `PlacementService.rebalance` (via the addon's own delegate). */
  readonly rebalance: (opts?: { readonly minImprovement?: number }) => Promise<{ migrated: number }>
  /** Thin seam onto `ReconcileController.scheduleReconcile`. */
  readonly scheduleReconcile: () => void
  /** Thin seam onto `ReconcileController.schedulePendingRetry`. */
  readonly schedulePendingRetry: () => void
  /** Live read accessor — `this.failoverPolicy` on the addon (mutated by `applyRuntimeSettings`). */
  readonly failoverPolicy: () => FailoverPolicy
  /** Live read accessor — `this.localNodeId` on the addon. */
  readonly localNodeId: () => string
  /** Best-effort per-device settings write — mirrors the original `this.ctx.settings?.writeDeviceStore(...).catch(...)` optional-chain short-circuit. */
  readonly writeDeviceStore: (deviceId: number, patch: Record<string, unknown>) => Promise<void>
  /** Phase 3 slice 2 guard predicate — `this.isSessionCamera` on the addon. */
  readonly isSessionCamera: (deviceId: number) => boolean
  /** Thin seam onto `SessionDispatchController.sessionRegistry.deregister` (wired directly in the bootstrap since S11 Task 2). */
  readonly deregisterSession: (deviceId: number) => void
  readonly logger: IScopedLogger
  readonly eventBus: IEventBus
  /** `ctx.kernel?.readinessRegistry ?? null` — read ONCE at construction, mirrors the original `onInitialize` snapshot read. */
  readonly sharedRegistry: IReadinessRegistry | null
  /**
   * The node's `detection` group (the runner's process) came up with a new
   * readiness epoch. Called SYNCHRONOUSLY before any re-attach: the camera
   * motion-slice gate forgets that node's answer, so a runner that writes the
   * slice (a rolled-back one) is never a second writer beside the orchestrator
   * (D696). It must not wait on anything: re-attach never waits on a census.
   */
  readonly onRunnerReady?: (nodeId: string) => void
}

export class NodeLifecycleHandler {
  /** Prefers the kernel-shared registry; falls back to a local instance for contexts without a kernel (tests). */
  private readonly registry: IReadinessRegistry
  /** True when this handler owns the registry (local fallback) and must `close()` it on `dispose()`. */
  private readonly ownsRegistry: boolean
  /** Per-node readiness subscription unsubs — torn down on AgentOffline / shutdown. */
  private readonly readinessSubsByNode = new Map<string, () => void>()
  /** Per-node idempotency guard — re-seed only when the producer's epoch advances. */
  private readonly lastSeenReadinessEpochByNode = new Map<string, number>()

  constructor(private readonly deps: NodeLifecycleHandlerDeps) {
    this.registry =
      deps.sharedRegistry ??
      new ReadinessRegistry({
        eventBus: deps.eventBus,
        sourceNodeId: deps.localNodeId(),
        logger: deps.logger,
      })
    this.ownsRegistry = deps.sharedRegistry === null
  }

  /**
   * Read-only accessor for the single shared/local readiness registry this
   * handler owns — the addon still directly subscribes `audio-analyzer`
   * readiness (`subscribeToAudioAnalyzerReadiness`, a sibling C7 concern
   * that stayed on `index.ts` because its business logic already lives in
   * `AudioSubscriptionController.handleAudioAnalyzerReadiness`, S7). Rather
   * than construct a second parallel `ReadinessRegistry` instance for that
   * one subscription, it reaches the SAME registry through this accessor —
   * single owner, no shadow registry.
   */
  get readinessRegistry(): IReadinessRegistry {
    return this.registry
  }

  // ── Failover / reconnect ─────────────────────────────────────────────

  /**
   * Failover handler. When a runner node goes offline, the behaviour is
   * driven by the persisted failover policy (`failoverPolicy`):
   *  - `onDisconnect: 'migrate'` → move non-pinned cameras to another runner
   *  - `onDisconnect: 'leave-unassigned'` → drop all assignments for the node
   *  - `pinnedOnDisconnect: 'leave-pinned'` → pinned cameras stay unassigned
   *  - `pinnedOnDisconnect: 'unpin-and-migrate'` → clear the pin + migrate
   */
  async handleNodeDisconnect(nodeId: string): Promise<void> {
    const failoverPolicy = this.deps.failoverPolicy()

    if (failoverPolicy.onDisconnect === 'leave-unassigned') {
      let dropped = 0
      for (const [deviceId, assignment] of this.deps.ledger.assignmentEntries()) {
        if (assignment.agentNodeId !== nodeId) continue
        this.deps.ledger.dropAssignment(deviceId, 'unassigned')
        // Session camera (Task 3, Phase 3 slice 2): also deregister so a
        // stale "active" session entry doesn't linger and wedge
        // `handleSessionMotion`'s dispatch gate — the next motion event
        // re-dispatches via `dispatchDetectionSession`.
        if (this.deps.isSessionCamera(deviceId)) this.deps.deregisterSession(deviceId)
        dropped++
      }
      if (dropped > 0) {
        this.deps.logger.warn("Runner disconnected — policy is 'leave-unassigned'", {
          tags: { nodeId },
          meta: { dropped },
        })
      }
      this.deps.loadService.dropNode(nodeId)
      return
    }

    const affected: Array<{ deviceId: number; config: RunnerCameraConfig }> = []
    for (const [deviceId, assignment] of this.deps.ledger.assignmentEntries()) {
      if (assignment.agentNodeId !== nodeId) continue
      // Session camera (Task 3, Phase 3 slice 2): dropping the session is
      // enough — there is no durable placement to fail over. The next
      // motion event re-dispatches via `dispatchDetectionSession` on a
      // live node, so this deliberately skips the migrate loop below.
      if (this.deps.isSessionCamera(deviceId)) {
        this.deps.ledger.dropAssignment(deviceId, 'unassigned')
        this.deps.deregisterSession(deviceId)
        continue
      }
      const config = this.deps.ledger.getConfig(deviceId)
      if (!config) continue
      if (assignment.pinned && failoverPolicy.pinnedOnDisconnect === 'leave-pinned') {
        this.deps.logger.warn(
          'Runner disconnected — pinned camera leaving unassigned until user unpins',
          { tags: { nodeId, deviceId } },
        )
        continue
      }
      // `unpin-and-migrate` path: clear BOTH pin keys so subsequent balancer
      // passes treat this camera like any other non-pinned assignment. Clearing
      // only `preferredAgent` would let a surviving `pipelineNodeId` pin
      // resurrect the pin on the next dispatch and defeat the failover policy
      // (mirror of `unassignPipeline`).
      if (assignment.pinned && failoverPolicy.pinnedOnDisconnect === 'unpin-and-migrate') {
        await this.deps
          .writeDeviceStore(deviceId, { [PREFERRED_AGENT_SETTING]: null, pipelineNodeId: 'auto' })
          .catch(() => {
            /* best effort */
          })
      }
      affected.push({ deviceId, config })
    }
    if (affected.length === 0) {
      this.deps.loadService.dropNode(nodeId)
      return
    }

    this.deps.logger.warn('Runner disconnected — failing over cameras', {
      tags: { nodeId },
      meta: { affected: affected.length },
    })

    // Drop the dead node from the cached load snapshot + query the rest fresh.
    this.deps.loadService.dropNode(nodeId)
    const loads = (await this.deps.loadService.collectAgentLoad({ onlyEnabled: true })).filter(
      (l) => l.nodeId !== nodeId,
    )

    for (const { deviceId, config } of affected) {
      const decision = balance({
        nodes: loads,
        preferredAgent: null,
        nodeCaps: await this.deps.settingsStore.buildNodeCaps(),
        weights: await this.deps.settingsStore.buildNodeWeights(),
        eligibleNodes: this.deps.topology.detectionEligibleNodes(deviceId),
      })
      if (!decision) {
        this.deps.logger.error('Failover: no online runner', {
          tags: { deviceId },
        })
        this.deps.ledger.dropAssignment(deviceId, 'silent')
        continue
      }
      if (decision.kind === 'pending') {
        // No valid node to fail over to — leave the camera pending + visible
        // (T3 retries) rather than stranding it on a node that cannot obtain
        // its frames (R8). `no-frame-source` here is THE cam-104 case: with
        // `enabledDecoderNodes=['hub']`, disconnecting the hub leaves no
        // frame-source node, so the camera goes pending instead of landing on
        // a decoder-ineligible agent.
        this.deps.ledger.setPendingReason(deviceId, decision.reason)
        this.deps.logger.warn('Failover: camera left pending — no eligible node', {
          tags: { deviceId },
          meta: { reason: decision.reason },
        })
        this.deps.ledger.dropAssignment(deviceId, 'silent')
        continue
      }
      try {
        await this.deps.attachOn(decision.agentNodeId, config)
        this.deps.ledger.recordAssignment(deviceId, decision.agentNodeId, 'failover', false)
        this.deps.logger.info('Failover', {
          tags: { deviceId, nodeId: decision.agentNodeId },
        })
      } catch (err: unknown) {
        const msg = errMsg(err)
        this.deps.logger.error('Failover: attach failed', {
          tags: { deviceId, nodeId: decision.agentNodeId },
          meta: { error: msg },
        })
      }
    }
  }

  /**
   * Reconnect handler. When a runner node comes back online, the behaviour
   * is driven by the `onReconnect` policy:
   *  - `restore` → re-attach cameras previously assigned to that node
   *    (only the ones still known in `cameraConfigs`)
   *  - `rebalance` → run a full `rebalance()` pass so non-pinned cameras
   *    can migrate back onto the newly-available runner
   */
  async handleNodeConnect(nodeId: string): Promise<void> {
    if (nodeId === this.deps.localNodeId()) return // Our own node, no failover needed
    // Forkable addons expose themselves as child Moleculer nodes like
    // `hub/detection-pipeline`. They're not
    // runners — they don't host `pipeline-runner.attachCamera`, so
    // the 'restore' path would fail on every such connect with a
    // "service not found" error. Filter them out on the way in.
    if (nodeId.includes('/')) return

    const failoverPolicy = this.deps.failoverPolicy()
    this.deps.logger.info('Runner connected — applying reconnect policy', {
      tags: { nodeId },
      meta: { policy: failoverPolicy.onReconnect },
    })

    // A node came online — retry cameras stranded because no runner could take
    // them. Runs regardless of the reconnect policy branch below.
    this.deps.schedulePendingRetry()

    if (failoverPolicy.onReconnect === 'rebalance') {
      await this.deps.rebalance().catch((err: unknown) => {
        const msg = errMsg(err)
        this.deps.logger.error('rebalance after reconnect failed', {
          meta: { error: msg },
        })
      })
      return
    }

    // 'restore' path — re-attach cameras whose last known assignment was
    // this node. Cameras currently attached elsewhere stay put.
    //
    // Guard: if the reconnected node is not detection-eligible (not a
    // frame-source node), do NOT restore detection onto it — that would
    // re-strand cameras on a node that cannot obtain their frames. Leave them
    // pending for the T3 sweep instead. NODE-scoped by design (no deviceId):
    // this asks "can this node source frames for ANY camera" — with P2a's
    // undefined source-owner the answer is camera-independent; when P2d makes
    // ownership per-camera, this guard moves inside the restore loop.
    if (!this.deps.topology.detectionEligibleNodes().includes(nodeId)) {
      this.deps.logger.warn('restore skipped — node not frame-source eligible', {
        tags: { nodeId },
        meta: { eligibleNodes: this.deps.topology.detectionEligibleNodes().join(',') },
      })
      for (const [deviceId, assignment] of this.deps.ledger.assignmentEntries()) {
        if (assignment.agentNodeId !== nodeId) continue
        this.deps.ledger.setPendingReason(deviceId, 'no-frame-source')
      }
      return
    }
    let restored = 0
    for (const [deviceId, config] of this.deps.ledger.configEntries()) {
      // Session camera (Task 3, Phase 3 slice 2): no durable placement to
      // restore — the reconnected node just becomes eligible for the NEXT
      // motion event via `dispatchDetectionSession`. Without this guard an
      // idle session camera (no `assignments` entry, so `current` below is
      // `undefined`) would fall through the `current &&` check and get
      // force-attached here as if it were a standing camera.
      if (this.deps.isSessionCamera(deviceId)) continue
      const current = this.deps.ledger.getAssignment(deviceId)
      if (current && current.agentNodeId !== nodeId) continue
      try {
        await this.deps.attachOn(nodeId, config)
        this.deps.ledger.recordAssignment(deviceId, nodeId, 'failover', false)
        restored++
      } catch (err: unknown) {
        const msg = errMsg(err)
        this.deps.logger.error('restore attach failed', {
          tags: { deviceId, nodeId },
          meta: { error: msg },
        })
      }
    }
    if (restored > 0) {
      this.deps.logger.info('Runner reconnected — restored cameras', {
        tags: { nodeId },
        meta: { restored },
      })
    }
  }

  // ── Readiness protocol plumbing ──────────────────────────────────────

  /**
   * Subscribe to `detection-pipeline` readiness transitions for `nodeId`.
   * Idempotent: re-subscribing the same node is a no-op. The handler
   * skips same-epoch replays so repeated `ready` emits don't force
   * redundant reseeds.
   */
  subscribeToDetectionPipelineReadiness(nodeId: string): void {
    if (this.readinessSubsByNode.has(nodeId)) return
    const unsub = this.registry.onReadyState(
      pipelineExecutorCapability.name,
      { type: 'node', nodeId },
      (t) => {
        void this.handleDetectionPipelineReadiness(t)
      },
    )
    this.readinessSubsByNode.set(nodeId, unsub)
  }

  unsubscribeDetectionPipelineReadiness(nodeId: string): void {
    const unsub = this.readinessSubsByNode.get(nodeId)
    if (!unsub) return
    unsub()
    this.readinessSubsByNode.delete(nodeId)
    this.lastSeenReadinessEpochByNode.delete(nodeId)
  }

  /**
   * Act on a `detection-pipeline` transition: on `ready` with a new
   * epoch (= producer restart or first-time ready), invalidate the
   * catalog cache, re-seed that node's `agentAddonDefaults`, and
   * redispatch every camera currently assigned to it. Everything else
   * (down, starting, same-epoch keepalive) is skipped.
   */
  private async handleDetectionPipelineReadiness(t: ReadinessTransition): Promise<void> {
    if (t.state !== 'ready') return
    if (t.scope.type !== 'node') return
    const nodeId = t.scope.nodeId
    const lastEpoch = this.lastSeenReadinessEpochByNode.get(nodeId) ?? 0
    if (t.epoch <= lastEpoch) return
    this.lastSeenReadinessEpochByNode.set(nodeId, t.epoch)
    // Before the first await below — nothing can re-attach until the gate closed (D696).
    this.deps.onRunnerReady?.(nodeId)

    try {
      // Wipe BOTH `*::*` (key without engine) AND any per-engine cache
      // entries for this node. The previous `delete(nodeId)` only matched
      // the literal nodeId key — but `getCatalogForAgent` keys cache as
      // `${nodeId}::${engine}` or `${nodeId}::*`. With the literal-only
      // delete, stale empty-catalog cache entries from BEFORE the addon
      // was ready survived the reseed and resolvePipelineForDevice kept
      // returning empty steps even after `seedAgentSettingsFromCatalog`
      // succeeded. (S4: prefix-delete now lives in
      // `PipelineSettingsStore.invalidateCatalog` — smell #21.)
      this.deps.settingsStore.invalidateCatalog(nodeId)
      await this.deps.settingsStore.seedAgentSettingsFromCatalog(nodeId)
      // Direct re-attach for every camera assigned to this node — bypasses
      // the eventBus subscriber path so transient debouncing / dropped
      // events don't leave a camera stuck with empty steps. Cameras
      // attached BEFORE the addon was ready picked up the `node/cpu`
      // fallback engine + empty steps; this loop replaces their attach
      // payload with the newly-resolved one.
      // Build candidate set from BOTH `assignments` (typical case) and
      // `cameraConfigs` (fallback for cameras still mid-dispatch when the
      // readiness event landed). Some restart paths (profile-slot change,
      // motion stream re-pick) tear down `assignments` briefly while
      // `cameraConfigs` retains the runner config — catching both ensures
      // every hub-targeted camera gets the freshly-resolved attach.
      const candidates = new Set<number>()
      for (const [deviceId, assignment] of this.deps.ledger.assignmentEntries()) {
        if (assignment.agentNodeId === nodeId) candidates.add(deviceId)
      }
      for (const [deviceId, cfg] of this.deps.ledger.configEntries()) {
        // cameraConfigs has no agent binding — assume hub-local when no
        // assignment exists. The runner attach is idempotent so a
        // stale add here is at worst a no-op.
        if (!this.deps.ledger.hasAssignment(deviceId) && nodeId === this.deps.localNodeId()) {
          candidates.add(deviceId)
        }
        void cfg
      }
      const affected: Array<{ deviceId: number; config: RunnerCameraConfig }> = []
      for (const deviceId of candidates) {
        const cached = this.deps.ledger.getConfig(deviceId)
        if (!cached) continue
        if (this.isUnplacedPlaceholder(deviceId, cached, nodeId)) continue
        // D650: resolved for the device the camera is ALREADY elected onto,
        // with its roster and provisioning — never the node default format.
        const outcome = await this.deps.resolveAttachPipeline({
          deviceId,
          nodeId,
          deviceKey: cached.deviceKey,
        })
        if (this.refusedReattach(deviceId, nodeId, outcome)) continue
        const pipeline = outcome.pipeline
        if (pipeline.steps.length === 0) continue
        const next = withAttachPipeline(cached, pipeline)
        this.deps.ledger.setConfig(deviceId, next)
        affected.push({ deviceId, config: next })
      }
      for (const { deviceId, config } of affected) {
        try {
          await this.deps.attachOn(nodeId, config)
          this.deps.logger.info('readiness: re-attached with hydrated steps', {
            tags: { deviceId, nodeId },
            meta: { stepCount: config.steps?.length ?? 0 },
          })
        } catch (err) {
          this.deps.logger.warn('readiness: re-attach failed', {
            tags: { deviceId, nodeId },
            meta: { error: errMsg(err) },
          })
        }
      }
      this.deps.logger.info(
        'readiness: detection-pipeline reseeded agent defaults + redispatched cameras',
        { tags: { nodeId }, meta: { epoch: t.epoch, reattached: affected.length } },
      )
      // Deferred sweep — a camera that arrived between the assignments
      // iteration above and the catalog cache populating gets caught
      // here. 3 seconds is enough for the detection-pipeline catalog to
      // fully publish all step definitions across forked workers.
      setTimeout(() => {
        void this.reattachStaleEmpties(nodeId).catch((err: unknown) => {
          this.deps.logger.debug('readiness deferred sweep failed', {
            tags: { nodeId },
            meta: { error: errMsg(err) },
          })
        })
      }, 3_000)
      // Reconcile in case cameras were stranded while this provider was offline.
      this.deps.scheduleReconcile()
      // The node just became usable — retry any camera left pending because no
      // node could run its detection pipeline yet.
      this.deps.schedulePendingRetry()
    } catch (err: unknown) {
      this.deps.logger.debug('readiness seed+redispatch failed', {
        tags: { nodeId },
        meta: { epoch: t.epoch, error: errMsg(err) },
      })
    }
  }

  /**
   * A re-attach whose elected device cannot run the camera's root is REFUSED
   * (D650 round 3): the live attach is left as it is rather than replaced by
   * one that detects nothing. Said once per pass, with the roots.
   */
  private refusedReattach(
    deviceId: number,
    nodeId: string,
    outcome: AttachPipelineOutcome,
  ): outcome is Extract<AttachPipelineOutcome, { kind: 'root-refused' }> {
    if (outcome.kind !== 'root-refused') return false
    this.deps.logger.error('re-attach refused — the elected device cannot run the camera root', {
      tags: { deviceId, nodeId },
      meta: {
        deviceKey: outcome.deviceKey ?? null,
        droppedRoots: outcome.droppedRoots.join(','),
      },
    })
    return true
  }

  /**
   * A ledger config with no assignment AND no elected device is the standing
   * path's PLACEHOLDER (D650 round 2): a camera the balancer has not placed,
   * hydrated before any election. Attaching it here would place it on this
   * node behind the balancer's back, on no device — the pending-retry sweep
   * owns it. Skipped, and said so.
   */
  private isUnplacedPlaceholder(
    deviceId: number,
    cached: RunnerCameraConfig,
    nodeId: string,
  ): boolean {
    if (this.deps.ledger.hasAssignment(deviceId) || cached.deviceKey !== undefined) return false
    this.deps.logger.info('readiness: skipped an unplaced placeholder config', {
      tags: { deviceId, nodeId },
      meta: { reason: 'no assignment and no elected device — the pending-retry sweep places it' },
    })
    return true
  }

  /**
   * Walk every cached RunnerCameraConfig and re-attach any whose stored
   * `steps` are empty AND whose latest resolve produces a non-empty
   * pipeline. Catches the "camera dispatched mid-readiness" race where
   * the initial attach landed BEFORE the catalog was cached but the
   * subsequent readiness sweep already finished iterating.
   */
  private async reattachStaleEmpties(nodeId: string): Promise<void> {
    for (const [deviceId, cached] of this.deps.ledger.configEntries()) {
      const stepsCount = cached.steps?.length ?? 0
      if (stepsCount > 0) continue
      const assignment = this.deps.ledger.getAssignment(deviceId)
      const targetNode = assignment?.agentNodeId ?? this.deps.localNodeId()
      if (targetNode !== nodeId) continue
      if (this.isUnplacedPlaceholder(deviceId, cached, nodeId)) continue
      const outcome = await this.deps.resolveAttachPipeline({
        deviceId,
        nodeId,
        deviceKey: cached.deviceKey,
      })
      if (this.refusedReattach(deviceId, nodeId, outcome)) continue
      const pipeline = outcome.pipeline
      if (pipeline.steps.length === 0) continue
      const next = withAttachPipeline(cached, pipeline)
      this.deps.ledger.setConfig(deviceId, next)
      try {
        await this.deps.attachOn(nodeId, next)
        this.deps.logger.info('deferred sweep: re-attached stale empty', {
          tags: { deviceId, nodeId },
          meta: { stepCount: next.steps?.length ?? 0 },
        })
      } catch (err) {
        this.deps.logger.warn('deferred sweep: attach failed', {
          tags: { deviceId, nodeId },
          meta: { error: errMsg(err) },
        })
      }
    }
  }

  /**
   * Tear down every readiness subscription + close the registry if this
   * handler owns it (local fallback, not the kernel-shared singleton).
   * Mirrors the former inline `onShutdown` block exactly.
   */
  dispose(): void {
    for (const unsub of this.readinessSubsByNode.values()) unsub()
    this.readinessSubsByNode.clear()
    this.lastSeenReadinessEpochByNode.clear()
    if (this.ownsRegistry && 'close' in this.registry) {
      ;(this.registry as { close(): void }).close()
    }
  }
}
