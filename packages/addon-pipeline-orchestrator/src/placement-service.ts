/**
 * `PlacementService` — the standing camera placement core (C3, S8 extraction).
 *
 * Owns the dispatch/rebalance/attach/detach surface: `dispatchCamera`,
 * `releaseCamera`, `assignPipeline`, `unassignPipeline`, `runAutoRebalance`,
 * `rebalance`, `attachOn`, `detachOn`, `getPipelineAssignment(s)`,
 * `redispatchCamerasOnAgent`/`redispatchAllActiveCameras`/
 * `redispatchSingleCamera`. All shared placement STATE (`assignments`/
 * `cameraConfigs`/`pendingReasons`/`dispatchingDevices`) already lives in
 * `PlacementLedger` (S6) — this class holds only its own `autoRebalanceInFlight`
 * guard flag, everything else is read/written through `this.deps.ledger`.
 *
 * Extracted verbatim (mechanical, zero logic change) from `index.ts` — every
 * method body, log message, and control-flow branch, including the
 * `dispatchingDevices`/`ledger.markDispatching` guard windows and the exact
 * `recordAssignment`/`attachOn` ordering, is unchanged; only the storage
 * backing (`this.<field>` → `this.deps.<accessor>`) differs.
 *
 * `ctx`/`ctxIfReady` are injected as closures onto the REAL (throwing /
 * non-throwing) `BaseAddon` getters — `this.deps.ctx()` throws exactly like
 * the original `this.ctx` access would (same getter, same message), so every
 * ctx-null guard below (even ones that read as dead code today) behaves
 * identically to the pre-extraction class.
 *
 * **Smell #12 fix:** the `decision.kind === 'pending'` → `setPendingReason` +
 * `warn('camera left pending — no eligible node', ...)` + bail pattern was
 * duplicated 3× inside this cluster (`dispatchCamera`, `unassignPipeline`,
 * `rebalance` — all three share byte-identical message + tags/meta shape).
 * `handlePendingDecision` normalizes the always-identical "record + log"
 * half; each call site keeps its own bail semantics (return / fall-through /
 * continue) since those differ per site. A 4th occurrence of the same shape
 * lives in `handleNodeDisconnect` (C6 failover, `node-lifecycle-handler.ts`
 * since the S9 extraction) — out of this step's scope (different cluster,
 * different log message: `'Failover: ...'` prefix) and deliberately left
 * untouched.
 */
import type {
  AddonContext,
  PipelineAssignment,
  RunnerCameraConfig,
  RunnerLocalLoad,
} from '@camstack/types'
import { errMsg, nodePin } from '@camstack/types'
import type { AgentLoadService } from './agent-load-service.js'
import {
  type AttachPipelineOutcome,
  resolveAttachPipeline,
  resolveAttachPipelineIfCatalogCached,
  withAttachPipeline,
} from './attach-pipeline.js'
import type { InferenceDeviceRotation } from './device-balancer.js'
import { pickInferenceDevice, selectedDeviceKey } from './device-balancer.js'
import { balance, type BalancerDecision, capacityImprovement } from './load-balancer.js'
import type { LoadShedController } from './load-shed-controller.js'
import type { NodeTopologyService } from './node-topology.js'
import type {
  DispatchResult,
  DispatchResultAssigned,
  DispatchResultPending,
  EligibilityIfCached,
} from './orchestrator-types.js'
import { AUTO_REBALANCE_MIN_IMPROVEMENT } from './orchestrator-types.js'
import { pickMotionRolePlacement } from './dispatch-reconcile.js'
import type { PipelineSettingsStore } from './pipeline-settings-store.js'
import type { PipelineWatchdog, WatchdogCamera } from './pipeline-watchdog.js'
import type { WatchdogAudioSource } from './watchdog-camera.js'
import type { PendingReason, PlacementLedger } from './placement-ledger.js'
import { selectRunnerFrameSource } from './source-owner.js'

/** Key under which the orchestrator stores its per-device manual pin — shared with `readPipelinePin` (index.ts) and `handleNodeDisconnect` (`node-lifecycle-handler.ts`). */
export const PREFERRED_AGENT_SETTING = 'preferredAgent'

export interface PlacementServiceDeps {
  /** Throwing ctx accessor — mirrors the pre-extraction `this.ctx` getter (same object, same throw). */
  readonly ctx: () => AddonContext
  /** Non-throwing ctx accessor — mirrors `this.ctxIfReady`, used only by `runAutoRebalance`'s guard. */
  readonly ctxIfReady: () => AddonContext | null
  readonly ledger: PlacementLedger
  readonly topology: NodeTopologyService
  readonly loadService: AgentLoadService
  readonly settingsStore: PipelineSettingsStore
  readonly loadShed: LoadShedController
  readonly watchdog: () => PipelineWatchdog | null
  readonly localNodeId: () => string
  readonly readPipelinePin: (deviceId: number) => Promise<string | null>
  /** Enabled∧available inference devices for a node as `deviceKey → weight` — the
   *  standing-attach device balancer's eligibility (multi-device C4 / orch-F5). */
  readonly getEligibleInferenceDevices: (nodeId: string) => Promise<Record<string, number>>
  /**
   * The NON-BLOCKING eligibility read of the re-place paths (D650 round 3):
   * the node's last answered device probe + pool health and its cached
   * catalog, or `unavailable` — never a live call to the node.
   */
  readonly getEligibleInferenceDevicesIfCached: (nodeId: string) => Promise<EligibilityIfCached>
  /**
   * Can this node still infer? A node whose every ENABLED accelerator has gone
   * unavailable answers false and is dropped from the balancer's candidate
   * set — it stays online and keeps looking healthy while failing every
   * inference it is handed (agent-a, 283k errors in a day).
   *
   * Synchronous by design: placement runs over cached topology, and the answer
   * is a mirror refreshed by the eligibility read the dispatcher already
   * makes. An unknown node answers TRUE — see the mirror's docblock.
   */
  readonly isNodeInferenceUsable: (nodeId: string) => boolean
  /** Per-device concurrent-session caps (`deviceKey → maxSessions`) for the device balancer. */
  readonly getInferenceDeviceCaps: (nodeId: string) => Promise<Record<string, number>>
  /** Operator's per-device pin (`deviceKey`) for a camera, or null. */
  readonly readPipelineDevicePin: (deviceId: number) => Promise<string | null>
  /**
   * The node the cluster is in benchmark mode for (D791), null when none. A
   * camera PINNED onto that node is moved off it like any other (its pin is
   * ignored for the run, never rewritten). Absent = never.
   */
  readonly benchmarkNodeId?: () => string | null
  /**
   * Fair chooser among inference devices the capacity tier could not separate.
   * Shared with `SessionDispatchController` (one rotation per orchestrator) —
   * standing attaches and on-motion sessions consume the SAME accelerators.
   */
  readonly inferenceRotation: InferenceDeviceRotation
  readonly buildWatchdogCamera: (
    config: RunnerCameraConfig,
    deviceName: string,
    audio: WatchdogAudioSource,
  ) => WatchdogCamera
  /**
   * Does this camera's source actually carry an audio track
   * (`BrokerStats.audio !== null`)? Resolved ONCE per dispatch, never in a hot
   * loop, and only for a camera whose `audioMode` could arm the stage at all.
   * Fails OPEN (`true`) on an unknown or failed read — the watchdog audio stage
   * is diagnostic, so a false negative silently stops watching a working
   * camera, while a false positive only costs a stale heartbeat label.
   */
  readonly hasAudioSource: (deviceId: number, camStreamId: string) => Promise<boolean>
  /**
   * Which cam-stream this camera's audio subscription attaches to — the SAME
   * `selectAudioCamStream` decision `AudioSubscriptionController` makes, so the
   * watchdog can never watch a stream the analyser is not listening to.
   * `null` when the selection refused (every rung derived, nothing assigned).
   */
  readonly audioCamStreamFor: (config: RunnerCameraConfig) => Promise<string | null>
  readonly isIdleSessionCamera: (deviceId: number) => boolean
  /** Lazy closure onto `SessionDispatchController.activeSessionNode` (constructed after this service — boot-safe, called only post-boot). */
  readonly activeSessionNode: (deviceId: number) => string | null
  /** Lazy closure onto `SessionDispatchController.closeSessionForReassign`. */
  readonly closeActiveSession: (deviceId: number) => Promise<void>
  /** C8 concern — `ReconcileController.reconcilePlacementFromRunners` (S9 extraction) — invoked by `runAutoRebalance` before the balance pass. */
  readonly reconcilePlacementFromRunners: () => Promise<void>
  /** C11 concern (stays in index.ts) — invoked by `redispatchCamerasOnAgent`. */
  readonly emitResolvedCameraUpdated: (deviceId: number) => Promise<void>
  /** Reversible global maintenance gate owned by the addon shell. */
  readonly maintenancePaused?: () => boolean
}

/**
 * How a placement reads the node's catalog: `await-catalog` waits for the
 * executor (first placement); `cached-catalog` never waits (re-placement).
 */
type PlacementCatalogRead = { readonly kind: 'await-catalog' } | { readonly kind: 'cached-catalog' }

/**
 * A load snapshot with this rebalance pass's own (re)assignments applied — at
 * node level, and per device so a device election in the same pass sees the
 * sessions the pass already gave each accelerator.
 */
function tallyLoad(
  load: RunnerLocalLoad,
  nodeDelta: number,
  perDevice: ReadonlyMap<string, number> | undefined,
): RunnerLocalLoad {
  if (nodeDelta === 0 && (perDevice === undefined || perDevice.size === 0)) return load
  const known = new Set(load.devices.map((d) => d.deviceKey))
  const devices = [
    ...load.devices.map((d) => {
      const delta = perDevice?.get(d.deviceKey) ?? 0
      return delta === 0 ? d : { ...d, attachedCameras: Math.max(0, d.attachedCameras + delta) }
    }),
    // A device the snapshot never reported (no session yet) still counts
    // what this pass put on it.
    ...[...(perDevice ?? new Map<string, number>())]
      .filter(([deviceKey, delta]) => !known.has(deviceKey) && delta > 0)
      .map(([deviceKey, delta]) => ({
        deviceKey,
        backend: deviceKey.split(':')[0] ?? deviceKey,
        attachedCameras: delta,
      })),
  ]
  return {
    ...load,
    attachedCameras: Math.max(0, load.attachedCameras + nodeDelta),
    devices,
  }
}

/** A camera a rebalance pass wanted to move and could not. */
export interface RebalanceSkip {
  readonly deviceId: number
  readonly targetNodeId: string
  readonly reason: string
}

/** What a rebalance pass considers. */
export interface RebalanceOptions {
  /** Hysteresis margin; see {@link PlacementService.rebalance}. */
  readonly minImprovement?: number
  /**
   * Only these cameras are considered (benchmark drain and restore, D791).
   * Absent = every camera.
   */
  readonly onlyDeviceIds?: ReadonlySet<number>
  /**
   * Plan only: run the same decision loop (same balancer, same hysteresis,
   * same running tally) and report the moves it WOULD make, without detaching,
   * attaching or touching the ledger. The act and the plan share one loop so
   * they cannot disagree.
   */
  readonly dryRun?: boolean
}

/** One camera a rebalance pass moves (or, under `dryRun`, would move). */
export interface RebalanceMove {
  readonly deviceId: number
  /** The node it leaves; `null` for a camera with no current assignment. */
  readonly fromNodeId: string | null
  readonly toNodeId: string
}

/** What a rebalance pass did — and what it could not do. */
export interface RebalanceResult {
  readonly migrated: number
  readonly skipped: readonly RebalanceSkip[]
  /** The moves made — or, under `dryRun`, the moves that would be made. */
  readonly moves: readonly RebalanceMove[]
}

/** A node that has never answered what a re-place needs — see `EligibilityIfCached`. */
type NodeUnanswered = Extract<EligibilityIfCached, { kind: 'unavailable' }>

/** A device election and the eligibility it was made from — or the node that never answered. */
type InferenceDeviceElectionOutcome =
  | {
      readonly kind: 'elected'
      readonly deviceKey: string | undefined
      readonly eligible: Record<string, number>
      readonly caps: Record<string, number>
    }
  | NodeUnanswered

/** A whole placement decision: an attach pipeline, a root refusal, or an unanswering node. */
type PlacementResolution = AttachPipelineOutcome | NodeUnanswered

export class PlacementService {
  /** True while an auto-rebalance pass is running (skip overlap). */
  private autoRebalanceInFlight = false
  private inFlightAttaches = 0
  private readonly idleWaiters: Array<() => void> = []

  constructor(private readonly deps: PlacementServiceDeps) {}

  // ── In-process dispatch surface (local-only, not in cap def) ──────────

  /**
   * Drop nodes that cannot infer from a candidate set.
   *
   * Fails OPEN in one specific way that matters: if the filter would leave NO
   * candidate at all, the unfiltered set is used. Placing a camera on a node
   * that might fail its inference is bad; refusing to place it anywhere
   * because every node is currently mid-probe is worse, and that is the exact
   * shape a cold cluster start has.
   */
  private filterInferenceUsable(nodes: readonly string[], deviceId: number): readonly string[] {
    const usable = nodes.filter((nodeId) => this.deps.isNodeInferenceUsable(nodeId))
    if (usable.length === nodes.length) return nodes
    if (usable.length === 0) {
      this.deps
        .ctx()
        .logger.warn('every candidate node reports no usable inference device — placing anyway', {
          tags: { deviceId },
          meta: { nodes: [...nodes] },
        })
      return nodes
    }
    this.deps.ctx().logger.info('nodes dropped from placement — no usable inference device', {
      tags: { deviceId },
      meta: {
        dropped: nodes.filter((n) => !usable.includes(n)),
        kept: usable,
      },
    })
    return usable
  }

  /**
   * Pick which of `nodeId`'s enabled inference devices a camera runs on, and
   * log why (`inference device selection` — one line per placement, the same
   * message as the on-motion path so one grep covers both). Returns the
   * eligibility inputs too: the attach pipeline is resolved against the SAME
   * roster the device was elected from.
   */
  private async electInferenceDevice(input: {
    readonly deviceId: number
    readonly nodeId: string
    readonly loads: readonly RunnerLocalLoad[]
    readonly currentDeviceKey: string | null
    readonly path: 'standing' | 'rebalance'
    readonly read: PlacementCatalogRead
  }): Promise<InferenceDeviceElectionOutcome> {
    const targetLoad = input.loads.find((load) => load.nodeId === input.nodeId)
    // A first placement waits for the node's catalog and asks it live; a
    // re-place elects against the node's last answers and never waits (D650
    // round 3) — a node that has never answered leaves the camera pending.
    let eligible: Record<string, number>
    if (input.read.kind === 'await-catalog') {
      eligible = await this.deps.getEligibleInferenceDevices(input.nodeId)
    } else {
      const known = await this.deps.getEligibleInferenceDevicesIfCached(input.nodeId)
      if (known.kind === 'unavailable') return known
      eligible = known.eligible
    }
    const caps = await this.deps.getInferenceDeviceCaps(input.nodeId)
    const pinnedDeviceKey = await this.deps.readPipelineDevicePin(input.deviceId)
    const selection = pickInferenceDevice({
      eligible,
      loads: targetLoad?.devices ?? [],
      caps,
      pinnedDeviceKey,
      currentDeviceKey: input.currentDeviceKey,
      rotation: this.deps.inferenceRotation,
    })
    const deviceKey = selectedDeviceKey(selection)
    this.deps.ctx().logger.info('inference device selection', {
      tags: { deviceId: input.deviceId, nodeId: input.nodeId },
      meta: {
        path: input.path,
        eligible: selection.eligibleKeys,
        chosen: deviceKey ?? null,
        reason: selection.reason,
        ...(selection.kind === 'selected'
          ? { tied: selection.tiedKeys, tieBreak: selection.tieBreak }
          : {}),
        ...(pinnedDeviceKey ? { pin: pinnedDeviceKey } : {}),
      },
    })
    return { kind: 'elected', deviceKey, eligible, caps }
  }

  /**
   * Elect a device on `nodeId` and resolve the camera's attach pipeline for
   * it — the whole placement decision, for a first placement (`await-catalog`)
   * or a re-place (`cached-catalog`, never waits). Nothing is attached here.
   */
  private async resolvePlacement(input: {
    readonly deviceId: number
    readonly nodeId: string
    readonly loads: readonly RunnerLocalLoad[]
    readonly currentDeviceKey: string | null
    readonly path: 'standing' | 'rebalance'
    readonly read: PlacementCatalogRead
  }): Promise<PlacementResolution> {
    const election = await this.electInferenceDevice(input)
    if (election.kind === 'unavailable') return election
    const attachInput = {
      deviceId: input.deviceId,
      nodeId: input.nodeId,
      deviceKey: election.deviceKey,
      eligible: election.eligible,
      caps: election.caps,
    }
    if (input.read.kind === 'await-catalog') {
      return resolveAttachPipeline(attachInput, this.deps.settingsStore)
    }
    const outcome = await resolveAttachPipelineIfCatalogCached(attachInput, this.deps.settingsStore)
    if (outcome.kind === 'catalog-unavailable') {
      return { kind: 'unavailable', nodeId: outcome.nodeId, what: 'catalog' }
    }
    return outcome
  }

  /**
   * Re-resolve a camera's attach pipeline on the device it is ALREADY
   * elected onto (`deviceKey` from its ledger config; absent ⇒ default pool)
   * — the entry for every path that replaces the steps of a live attach
   * without re-electing (executor readiness, a package-zone change). Goes
   * through the same {@link resolveAttachPipeline} as a dispatch (D650).
   */
  async resolveAttachPipelineOnDevice(input: {
    readonly deviceId: number
    readonly nodeId: string
    readonly deviceKey: string | undefined
  }): Promise<AttachPipelineOutcome> {
    const [eligible, caps] = await Promise.all([
      this.deps.getEligibleInferenceDevices(input.nodeId),
      this.deps.getInferenceDeviceCaps(input.nodeId),
    ])
    return resolveAttachPipeline({ ...input, eligible, caps }, this.deps.settingsStore)
  }

  /**
   * FIRST placement of a standing camera: waits for the chosen node's catalog
   * (the resolve reconciles against its executor until it answers). Callers:
   * `startDetection`'s standing path — one camera, nothing to attach instead.
   */
  async dispatchCamera(runnerConfig: RunnerCameraConfig): Promise<DispatchResult> {
    return this.placeCamera(runnerConfig, { kind: 'await-catalog' })
  }

  /**
   * RE-placement from the ledger — the pending-retry sweep and the
   * remote-health re-place (D650 round 2). NEVER waits for a node: the
   * catalog is read from the cache only, and a node that has not answered
   * leaves THIS camera pending (`catalog-unavailable:<nodeId>`) for the next
   * round, instead of holding every camera after it in a serial sweep behind
   * one wedged executor (D3, D49).
   */
  async redispatchCamera(runnerConfig: RunnerCameraConfig): Promise<DispatchResult> {
    return this.placeCamera(runnerConfig, { kind: 'cached-catalog' })
  }

  private async placeCamera(
    runnerConfig: RunnerCameraConfig,
    catalog: PlacementCatalogRead,
  ): Promise<DispatchResult> {
    const ctx = this.deps.ctx()
    if (!ctx) throw new Error('PipelineOrchestrator: dispatchCamera called before initialize')
    if (this.deps.maintenancePaused?.() === true) {
      return { success: true, kind: 'pending' } satisfies DispatchResultPending
    }

    // Read the accelerator this camera is ALREADY attached to before the line
    // below overwrites the ledger config with the incoming (deviceKey-less)
    // `runnerConfig`. Fed to the device balancer as `currentDeviceKey` so a
    // re-dispatch of a live camera is idempotent — it stays on its accelerator
    // instead of being rotated onto another one and forcing a pool switch.
    const currentDeviceKey = this.deps.ledger.getConfig(runnerConfig.deviceId)?.deviceKey ?? null

    this.deps.ledger.setConfig(runnerConfig.deviceId, runnerConfig)

    // Load management: check if any camera has been below threshold
    // long enough (more than half the configured window) or is
    // already load-shed paused, and defer the dispatch in that case
    // so we don't pile new attaches on a struggling node.
    if (this.deps.loadShed.dispatchDeferralCheck(runnerConfig.deviceId)) {
      return { success: true, kind: 'pending' } satisfies DispatchResultPending
    }

    // Resolve the pipeline node pin from device settings. `pipelineNodeId` is
    // canonical; `preferredAgent` is a read-only legacy fallback — both are
    // resolved in one device-store read by `readPipelinePin`.
    const preferredAgent = await this.deps.readPipelinePin(runnerConfig.deviceId)

    const loads = await this.deps.loadService.collectAgentLoad({
      onlyEnabled: true,
    })
    const eligible = this.filterInferenceUsable(
      this.deps.topology.detectionEligibleNodes(runnerConfig.deviceId),
      runnerConfig.deviceId,
    )
    const nodeCaps = await this.deps.settingsStore.buildNodeCaps()

    // Analyzer-class cameras prefer the singleton `motionNode` role (mirrors
    // `dispatchAudio`'s audioNode preference). A per-device pin still wins; the
    // role node is used only while it is a currently-eligible detection node,
    // else this returns null and we fall back to the balancer (role failover).
    const motionRoleCandidate = pickMotionRolePlacement({
      isAnalyzer: runnerConfig.motionSources.includes('analyzer'),
      hasPin: Boolean(preferredAgent),
      motionNode: this.deps.topology.clusterRoles.motionNode,
      loadedNodeIds: loads.map((load) => load.nodeId),
      eligibleNodeIds: [...eligible],
    })
    // The role node must still respect the operator's per-node `maxCameras`
    // ceiling (T3 invariant — see agent-maxcameras-dispatch.spec.ts) — role
    // placement is a PREFERENCE among otherwise-eligible nodes, never a
    // bypass of a hard capacity cap. Mirrors `isEligible` in load-balancer.ts.
    const motionRoleLoad = motionRoleCandidate
      ? loads.find((load) => load.nodeId === motionRoleCandidate)
      : undefined
    const motionRoleCap = motionRoleCandidate ? (nodeCaps[motionRoleCandidate] ?? null) : null
    const motionRoleUnderCap =
      motionRoleCap === null || motionRoleCap <= 0
        ? true
        : (motionRoleLoad?.attachedCameras ?? 0) < motionRoleCap
    const motionRoleNode = motionRoleCandidate && motionRoleUnderCap ? motionRoleCandidate : null

    let targetNodeId: string
    let reason: PipelineAssignment['reason']
    // Balancer capacity score, kept only for the diagnostic log below —
    // undefined when placement came from the motionNode role (no balancer
    // scoring ran).
    let dispatchScore: number | undefined
    if (motionRoleNode) {
      targetNodeId = motionRoleNode
      reason = 'hardware-affinity'
    } else {
      const decision = balance({
        nodes: loads,
        preferredAgent,
        nodeCaps,
        weights: await this.deps.settingsStore.buildNodeWeights(),
        eligibleNodes: eligible,
      })

      if (!decision) {
        throw new Error(`dispatchCamera: no runner available for ${runnerConfig.deviceId}`)
      }
      if (decision.kind === 'pending') {
        this.handlePendingDecision(runnerConfig.deviceId, decision.reason)
        // Leave unassigned; the next dispatchCamera or rebalance will retry when
        // capacity frees / a frame-source node becomes eligible.
        return {
          success: true,
          kind: 'pending',
        } satisfies DispatchResultPending
      }

      targetNodeId = decision.agentNodeId
      reason = decision.reason
      dispatchScore = decision.score
    }

    // orch-F5: SECOND balance() pass over the target node's inference devices,
    // so a STANDING / always-on camera lands on a balanced accelerator (not just
    // the runner's single default pool) and is visible to per-device load
    // accounting. Then the pipeline is resolved FOR THAT DEVICE (D650): the
    // incoming `runnerConfig.steps` are never reused — they were hydrated for
    // the node default format before election, or are a previous attach's
    // already-provisioned tree (a re-dispatch from the ledger).
    const placement = await this.resolvePlacement({
      deviceId: runnerConfig.deviceId,
      nodeId: targetNodeId,
      loads,
      currentDeviceKey,
      path: 'standing',
      read: catalog,
    })
    if (placement.kind === 'unavailable') {
      this.leavePendingUnanswered(runnerConfig.deviceId, placement.nodeId, placement.what)
      return { success: true, kind: 'pending' } satisfies DispatchResultPending
    }
    if (placement.kind === 'root-refused') {
      this.leavePendingRootRefused(runnerConfig.deviceId, placement)
      return { success: true, kind: 'pending' } satisfies DispatchResultPending
    }
    const pipeline = placement.pipeline
    const attachConfig = withAttachPipeline(runnerConfig, pipeline)

    // Guard the attach→record window so the subtractive attachment reconcile
    // can't mistake an in-flight dispatch for an orphan and detach it.
    const dispatchGuard = this.deps.ledger.markDispatching(runnerConfig.deviceId)
    try {
      await this.attachOn(targetNodeId, attachConfig)
      this.deps.ledger.setConfig(runnerConfig.deviceId, attachConfig)

      // Register the camera with the pipeline watchdog ONLY now that it has
      // actually attached (the load-shed deferral path early-returns above and
      // never reaches here). Gated to a hub-local attach: the watchdog's signal
      // taps (audio/motion/detection `noteSignal`) and its recovery (audio
      // re-subscribe + source-refresh) are orchestrator-owned and hub-local, so
      // a camera attached to a remote agent runner would false-stall here.
      // `register` is idempotent — a re-dispatch with changed modes re-seeds.
      if (targetNodeId === this.deps.localNodeId()) {
        const audioSource = await this.resolveAudioSource(runnerConfig)
        this.deps
          .watchdog()
          ?.register(
            this.deps.buildWatchdogCamera(runnerConfig, String(runnerConfig.deviceId), audioSource),
          )
      }

      this.deps.ledger.recordAssignment(
        runnerConfig.deviceId,
        targetNodeId,
        reason,
        reason === 'manual',
      )
    } finally {
      dispatchGuard.dispose()
    }

    // No decoder placement step: decode is always co-located with its frame
    // consumer (detect ⇒ decode), so the detection node IS the decode node.
    this.deps.ctx().logger.info('dispatchCamera', {
      tags: { deviceId: runnerConfig.deviceId, nodeId: targetNodeId },
      meta: { reason, score: dispatchScore },
    })

    return {
      success: true,
      kind: 'assigned',
      agentNodeId: targetNodeId,
      reason,
    } satisfies DispatchResultAssigned
  }

  async releaseCamera(input: { deviceId: number }): Promise<{ success: true }> {
    const current = this.deps.ledger.getAssignment(input.deviceId)
    if (current) {
      await this.detachOn(current.agentNodeId, input.deviceId).catch((err: unknown) => {
        const msg = errMsg(err)
        this.deps.ctx().logger.debug('releaseCamera detach failed', {
          tags: { deviceId: input.deviceId },
          meta: { error: msg },
        })
      })
    } else {
      // Fallback: best-effort local detach for cameras we never tracked.
      const api = this.deps.ctx().api
      if (api) {
        await api.pipelineRunner.detachCamera
          .mutate({
            deviceId: input.deviceId,
            nodeId: this.deps.localNodeId(),
          })
          .catch(() => {
            /* swallow */
          })
      }
    }
    // `dropAssignment('unassigned')` deletes the map entry unconditionally
    // (mirrors the former unconditional `assignments.delete` below the
    // if/else) and fires `PipelineCameraUnassigned` iff `current` existed
    // (mirrors the former conditional `emitUnassigned(current, 'unassigned')`
    // call inside the `if (current)` branch above).
    this.deps.ledger.dropAssignment(input.deviceId, 'unassigned')
    this.deps.ledger.deleteConfig(input.deviceId)
    this.deps.ledger.clearPendingReason(input.deviceId)
    this.deps.watchdog()?.unregister(input.deviceId)
    return { success: true }
  }

  // ── IPipelineOrchestratorProvider (cap surface) ──────────────────────

  async assignPipeline(input: {
    deviceId: number
    agentNodeId: string
  }): Promise<{ success: true }> {
    const ctx = this.deps.ctx()
    if (!ctx) throw new Error('PipelineOrchestrator: assignPipeline called before initialize')

    // Fail fast: never persist a pin to a node that cannot obtain this camera's
    // decoded frames — that is exactly how detection gets stranded on a node
    // outside the frame-source set (the cam-104 failover hole). The generated
    // cap router surfaces this message to the admin-UI toast.
    const eligible = this.deps.topology.detectionEligibleNodes(input.deviceId)
    if (!eligible.includes(input.agentNodeId)) {
      throw new Error(
        `Cannot pin camera ${input.deviceId} detection to '${input.agentNodeId}': the node cannot obtain this camera's decoded frames (frame-source nodes: ${eligible.join(', ') || 'none'}). Add it to Enabled Decoder Nodes first.`,
      )
    }

    // Persist the manual pin so it survives hub restarts + future rebalances.
    // Write the canonical `pipelineNodeId` key and null out the legacy
    // `preferredAgent` so a stale value there can no longer silently override a
    // newer assign on the next dispatch (lazy migration onto the canonical key).
    await ctx.settings
      ?.writeDeviceStore(input.deviceId, {
        pipelineNodeId: input.agentNodeId,
        [PREFERRED_AGENT_SETTING]: null,
      })
      .catch((err: unknown) => {
        const msg = errMsg(err)
        ctx.logger.warn('assignPipeline: failed to persist pin', {
          tags: { deviceId: input.deviceId },
          meta: { error: msg },
        })
      })

    // Session-mode (on-motion) camera with an ACTIVE session: session cameras
    // never populate `ledger.setConfig`, so without this branch the pin fell
    // through to the "no cached config yet" early return below and the running
    // session stayed on the old node — indefinitely, when continuous motion
    // kept cancelling its cooldown teardown (cam-104). Same-node pin keeps the
    // session and just re-stamps the record as manual; different-node pin
    // closes the session (camera stays armed) so the next motion event
    // re-dispatches onto the pin via the balancer's manual affinity.
    const sessionNode = this.deps.activeSessionNode(input.deviceId)
    if (sessionNode !== null) {
      if (sessionNode === input.agentNodeId) {
        this.deps.ledger.recordAssignment(input.deviceId, input.agentNodeId, 'manual', true)
        return { success: true }
      }
      await this.deps.closeActiveSession(input.deviceId)
      ctx.logger.info(
        'assignPipeline: pinned — closed active session on old node; next motion re-dispatches onto the pin',
        {
          tags: { deviceId: input.deviceId, nodeId: input.agentNodeId },
          meta: { oldNodeId: sessionNode },
        },
      )
      return { success: true }
    }

    const cached = this.deps.ledger.getConfig(input.deviceId)
    if (!cached) {
      ctx.logger.info(
        'assignPipeline: pinned — will apply on next dispatch (no cached config yet)',
        { tags: { deviceId: input.deviceId, nodeId: input.agentNodeId } },
      )
      return { success: true }
    }

    const current = this.deps.ledger.getAssignment(input.deviceId)
    if (current && current.agentNodeId !== input.agentNodeId) {
      await this.detachOn(current.agentNodeId, input.deviceId).catch((err: unknown) => {
        const msg = errMsg(err)
        ctx.logger.debug('assignPipeline detach-old failed', {
          tags: { deviceId: input.deviceId },
          meta: { error: msg },
        })
      })
    }

    await this.attachOn(input.agentNodeId, cached)
    this.deps.ledger.recordAssignment(input.deviceId, input.agentNodeId, 'manual', true)

    return { success: true }
  }

  /**
   * Pin (or clear) a camera's per-session INFERENCE DEVICE affinity. Sibling of
   * {@link assignPipeline}: `assignPipeline` moves the camera between NODES;
   * this pins the accelerator WITHIN the node. The pin is a SOFT L1 affinity —
   * the per-session device `balance()` pass honours it; an ineligible key
   * (device not on the resolved node, or not enabled) is simply ignored, never
   * an error. `deviceKey === 'auto'` / empty clears the pin.
   */
  async setPipelineDevicePin(input: {
    deviceId: number
    deviceKey: string
  }): Promise<{ success: true }> {
    const ctx = this.deps.ctx()
    if (!ctx) throw new Error('PipelineOrchestrator: setPipelineDevicePin called before initialize')

    const clearing = input.deviceKey === '' || input.deviceKey === 'auto'
    await ctx.settings
      ?.writeDeviceStore(input.deviceId, {
        pipelineDeviceKey: clearing ? 'auto' : input.deviceKey,
      })
      .catch((err: unknown) => {
        ctx.logger.warn('setPipelineDevicePin: failed to persist device pin', {
          tags: { deviceId: input.deviceId },
          meta: { error: errMsg(err) },
        })
      })

    // The inference device is chosen per SESSION (the second `balance()` pass at
    // dispatch), so a running session already committed to a device pool. Close
    // it so the next dispatch re-picks — honouring (or, when clearing, dropping)
    // the pin. The camera stays on the SAME node (a device pin never migrates
    // between nodes), so no detach/attach is needed. A camera with no active
    // session applies the pin on its next dispatch.
    const sessionNode = this.deps.activeSessionNode(input.deviceId)
    if (sessionNode !== null) {
      await this.deps.closeActiveSession(input.deviceId)
      ctx.logger.info(
        'setPipelineDevicePin: closed active session — next dispatch honours the device pin',
        {
          tags: { deviceId: input.deviceId },
          meta: {
            deviceKey: clearing ? 'auto' : input.deviceKey,
            node: sessionNode,
          },
        },
      )
    }

    return { success: true }
  }

  async unassignPipeline(input: { deviceId: number }): Promise<{ success: true }> {
    const ctx = this.deps.ctx()
    if (!ctx) throw new Error('PipelineOrchestrator: unassignPipeline called before initialize')

    // Clear the pin in persisted settings — the canonical `pipelineNodeId`
    // key (set to the `'auto'` sentinel) and the legacy `preferredAgent` key
    // (null) so subsequent dispatches fall through to the auto-balancer.
    await ctx.settings
      ?.writeDeviceStore(input.deviceId, {
        [PREFERRED_AGENT_SETTING]: null,
        pipelineNodeId: 'auto',
      })
      .catch((err: unknown) => {
        const msg = errMsg(err)
        ctx.logger.warn('unassignPipeline: failed to clear pin', {
          tags: { deviceId: input.deviceId },
          meta: { error: msg },
        })
      })

    // If we have a cached config, re-dispatch via the auto-balancer so
    // the camera stays in the placement matrix (just unpinned). Earlier
    // semantics dropped the entry from `cameraConfigs` and `assignments`,
    // which made the row vanish from the pipeline page until the next
    // DeviceStreamsRegistered cycle — operators kept losing cameras.
    const cached = this.deps.ledger.getConfig(input.deviceId)
    const current = this.deps.ledger.getAssignment(input.deviceId)

    if (cached) {
      const loads = await this.deps.loadService.collectAgentLoad({
        onlyEnabled: true,
      })
      const decision: BalancerDecision | null = balance({
        nodes: loads,
        preferredAgent: null,
        nodeCaps: await this.deps.settingsStore.buildNodeCaps(),
        weights: await this.deps.settingsStore.buildNodeWeights(),
        eligibleNodes: this.deps.topology.detectionEligibleNodes(input.deviceId),
      })

      if (!decision) {
        // No runner available — fall through to the legacy detach path so
        // we don't leave a stale assignment record pointing at the old
        // agent without dropping detection on it.
        ctx.logger.warn('unassignPipeline: no runner available, leaving unassigned', {
          tags: { deviceId: input.deviceId },
        })
      } else if (decision.kind === 'pending') {
        this.handlePendingDecision(input.deviceId, decision.reason)
        // The operator explicitly requested unassign and all nodes are at
        // capacity. Fall through to the detach path below: the camera IS
        // detached from its current node and its assignment record IS
        // cleared — this is correct unassign semantics. It does NOT stay on
        // its current node. The rebalancer or next dispatchCamera will
        // re-assign it once a node has capacity.
      } else {
        const targetNodeId = decision.agentNodeId
        if (current && current.agentNodeId !== targetNodeId) {
          await this.detachOn(current.agentNodeId, input.deviceId).catch((err: unknown) => {
            const msg = errMsg(err)
            ctx.logger.debug('unassignPipeline detach-old failed', {
              tags: { deviceId: input.deviceId },
              meta: { error: msg },
            })
          })
        }
        if (!current || current.agentNodeId !== targetNodeId) {
          await this.attachOn(targetNodeId, cached)
        }
        const reason: PipelineAssignment['reason'] =
          decision.reason === 'manual' ? 'capacity' : decision.reason
        this.deps.ledger.recordAssignment(input.deviceId, targetNodeId, reason, false)
        ctx.logger.info('unassignPipeline: re-dispatched via auto', {
          tags: { deviceId: input.deviceId, nodeId: targetNodeId },
          meta: { reason },
        })
        return { success: true }
      }
    }

    if (current) {
      await this.detachOn(current.agentNodeId, input.deviceId).catch((err: unknown) => {
        const msg = errMsg(err)
        ctx.logger.debug('unassignPipeline detach failed', {
          tags: { deviceId: input.deviceId },
          meta: { error: msg },
        })
      })
    }

    // `dropAssignment('unassigned')` deletes the entry unconditionally
    // (mirrors the former unconditional `assignments.delete` below) and
    // fires `PipelineCameraUnassigned` iff `current` existed (mirrors the
    // former conditional `emitUnassigned(current, 'unassigned')` inside the
    // `if (current)` branch above).
    this.deps.ledger.dropAssignment(input.deviceId, 'unassigned')
    // Keep `cameraConfigs` so the next `dispatchCamera` / runner reconnect
    // cycle can re-attach without waiting for a fresh DeviceStreamsRegistered.

    return { success: true }
  }

  /**
   * Periodic auto-rebalance tick. Corrects placement drift toward the per-node
   * weights without operator action. Guards: never overlaps itself; skips when
   * fewer than two nodes can run detection (a hub-only cluster has nothing to
   * balance); migrates under {@link AUTO_REBALANCE_MIN_IMPROVEMENT} hysteresis
   * so a balanced cluster is a no-op. Errors are swallowed (best-effort net).
   */
  async runAutoRebalance(): Promise<void> {
    if (!this.deps.ctxIfReady()) return
    // Detach orphan attachments every tick, BEFORE the <2-node early-return and
    // before rebalancing — a runner can hold phantom attachments (poisoning the
    // load score) even on a single-node cluster, and rebalance must see clean
    // per-node load. Independently guarded + idempotent (detach is idempotent).
    await this.deps.reconcilePlacementFromRunners().catch((err: unknown) => {
      this.deps.ctx().logger.debug('auto-rebalance: attachment reconcile failed', {
        meta: { error: errMsg(err) },
      })
    })
    if (this.autoRebalanceInFlight) return
    // Nothing to balance across a single detect node.
    if (this.deps.topology.enabledNodes.length < 2) return
    this.autoRebalanceInFlight = true
    try {
      const { migrated } = await this.rebalance({
        minImprovement: AUTO_REBALANCE_MIN_IMPROVEMENT,
      })
      if (migrated > 0) {
        this.deps.ctx().logger.info('auto-rebalance: corrected placement drift', {
          meta: { migrated },
        })
      }
    } catch (err: unknown) {
      this.deps.ctx().logger.debug('auto-rebalance pass failed', {
        meta: { error: errMsg(err) },
      })
    } finally {
      this.autoRebalanceInFlight = false
    }
  }

  async rebalance(opts?: RebalanceOptions): Promise<RebalanceResult> {
    const ctx = this.deps.ctx()
    if (!ctx) throw new Error('PipelineOrchestrator: rebalance called before initialize')

    // Hysteresis margin: a migration is applied only when the target is at
    // least this much less loaded (weight-adjusted) than the camera's current
    // node. `0` (manual rebalance) = aggressive, re-home on any improvement;
    // the periodic auto-rebalance passes a >1 margin so it never churns an
    // already-balanced cluster (a 1-camera gap would just reverse on the move).
    const minImprovement = Math.max(opts?.minImprovement ?? 0, 0)

    const loads = await this.deps.loadService.collectAgentLoad({
      onlyEnabled: true,
    })
    const nodeCaps = await this.deps.settingsStore.buildNodeCaps()
    const nodeWeights = await this.deps.settingsStore.buildNodeWeights()

    // Running per-node tally. `collectAgentLoad` is a ONE-TIME snapshot, but
    // this pass makes assignments camera by camera — without live accounting
    // every `balance()` call would check the `maxCameras` cap and the L2
    // capacity score against pre-rebalance `attachedCameras` counts, so a
    // capped-but-snapshot-empty node kept winning EVERY camera in the pass
    // (the cap was silently ignored). Each (re)assignment records a delta
    // over the snapshot: +1 on the target for a new attachment, -1 old / +1
    // new on a migration; a camera that stays put is already counted in its
    // node's snapshot, so no change. Subsequent `balance()` calls then see
    // post-assignment reality.
    //
    // The same holds one level down: the device election reads each device's
    // session count from the same snapshot, so without a per-device delta one
    // pass could elect the same accelerator for every migrated camera and
    // overshoot its `maxSessions` (D650 round 2).
    const attachedDelta = new Map<string, number>()
    const deviceDelta = new Map<string, Map<string, number>>()
    const bumpAttached = (nodeId: string, by: number, deviceKey?: string): void => {
      attachedDelta.set(nodeId, (attachedDelta.get(nodeId) ?? 0) + by)
      if (deviceKey === undefined) return
      const perDevice = deviceDelta.get(nodeId) ?? new Map<string, number>()
      perDevice.set(deviceKey, (perDevice.get(deviceKey) ?? 0) + by)
      deviceDelta.set(nodeId, perDevice)
    }
    const talliedLoads = (): readonly RunnerLocalLoad[] =>
      loads.map((load) =>
        tallyLoad(load, attachedDelta.get(load.nodeId) ?? 0, deviceDelta.get(load.nodeId)),
      )

    let migrated = 0
    // Cameras the pass WANTED to move and could not, with why — returned so a
    // manual rebalance toward a node that has not answered yet does not look
    // like "nothing to do" (D650 round 3).
    const skipped: RebalanceSkip[] = []
    const moves: RebalanceMove[] = []
    const dryRun = opts?.dryRun === true

    for (const [deviceId, config] of this.deps.ledger.configEntries()) {
      // Idle on-motion cameras have no standing attach to rebalance until a
      // session exists; an ACTIVE session is a real attachment and stays
      // eligible for rebalance (Task 3, Phase 3 slice 2).
      if (opts?.onlyDeviceIds !== undefined && !opts.onlyDeviceIds.has(deviceId)) continue
      if (this.deps.isIdleSessionCamera(deviceId)) continue
      const current = this.deps.ledger.getAssignment(deviceId)
      const eligibleNodes = this.deps.topology.detectionEligibleNodes(deviceId)
      // Never migrate pinned cameras — except off the node under benchmark
      // (D791): its pin is ignored for the run, and the camera has somewhere
      // else to go (the eligible set no longer holds that node).
      const benchNode = this.deps.benchmarkNodeId?.() ?? null
      const pinnedOffBenchNode =
        current !== null &&
        current.agentNodeId === benchNode &&
        !eligibleNodes.includes(current.agentNodeId)
      if (current?.pinned && !pinnedOffBenchNode) continue

      const preferredAgent = await this.deps.readPipelinePin(deviceId)
      const decision: BalancerDecision | null = balance({
        nodes: talliedLoads(),
        preferredAgent,
        nodeCaps,
        weights: nodeWeights,
        eligibleNodes,
      })
      if (!decision) continue
      if (decision.kind === 'pending') {
        if (!dryRun) this.handlePendingDecision(deviceId, decision.reason)
        continue
      }
      if (current && current.agentNodeId === decision.agentNodeId) continue

      // Auto-rebalance hysteresis: for a MIGRATION (current node still online),
      // only move the camera when the target is at least `minImprovement`
      // less loaded — otherwise a periodic pass churns a balanced cluster
      // (equalizing a 1-camera gap just reverses it). A camera whose current
      // node is offline (absent from `loads`) always migrates. Manual
      // rebalance passes `minImprovement = 0`, so this is a no-op there.
      // A camera on a node it can no longer be placed on (benchmark mode,
      // D791) always moves: hysteresis protects a balanced cluster from churn,
      // not a camera from leaving a node it must leave.
      if (current && minImprovement > 0 && eligibleNodes.includes(current.agentNodeId)) {
        const tallied = talliedLoads()
        const currentLoad = tallied.find((l) => l.nodeId === current.agentNodeId)
        const targetLoad = tallied.find((l) => l.nodeId === decision.agentNodeId)
        if (
          currentLoad &&
          targetLoad &&
          capacityImprovement(currentLoad, targetLoad, nodeWeights) < minImprovement
        ) {
          continue
        }
      }

      if (dryRun) {
        // Plan: assume the move lands, so the tally the next camera sees is
        // the one the real pass would have produced.
        if (current) bumpAttached(current.agentNodeId, -1, config.deviceKey)
        bumpAttached(decision.agentNodeId, 1, config.deviceKey)
        moves.push({
          deviceId,
          fromNodeId: current?.agentNodeId ?? null,
          toNodeId: decision.agentNodeId,
        })
        continue
      }

      // The pipeline is PER-(node, device): elect the TARGET node's device and
      // resolve for it (D650). The source node's `deviceKey` / roster mean
      // nothing on the target, and `withAttachPipeline` strips them. An EMPTY
      // resolve attaches empty — see D650 on what an empty resolve means.
      // Resolved BEFORE the source is detached, and from the CACHED catalog
      // only (D650 round 2): a migration is a re-place inside a serial pass,
      // and a target whose executor never answers must cost this camera its
      // move — never the pass, and never a camera detached with nowhere to go.
      const placement = await this.resolvePlacement({
        deviceId,
        nodeId: decision.agentNodeId,
        loads: talliedLoads(),
        currentDeviceKey: null,
        path: 'rebalance',
        read: { kind: 'cached-catalog' },
      })
      if (placement.kind !== 'resolved') {
        const reason =
          placement.kind === 'root-refused'
            ? `root-unrunnable:${placement.nodeId}/${placement.deviceKey ?? 'default-pool'}`
            : `${placement.what}-unavailable:${placement.nodeId}`
        skipped.push({ deviceId, targetNodeId: decision.agentNodeId, reason })
        if (current) {
          this.noteMigrationSkipped(deviceId, current.agentNodeId, decision.agentNodeId, reason)
        } else if (placement.kind === 'root-refused') {
          this.leavePendingRootRefused(deviceId, placement)
        } else {
          this.leavePendingUnanswered(deviceId, placement.nodeId, placement.what)
        }
        continue
      }
      this.migrationSkips.delete(deviceId)
      const targetConfig = withAttachPipeline(config, placement.pipeline)

      if (current) {
        await this.detachOn(current.agentNodeId, deviceId).catch((err: unknown) => {
          const msg = errMsg(err)
          ctx.logger.debug('rebalance detach-old failed', {
            tags: { deviceId },
            meta: { error: msg },
          })
        })
        // Migration: the old node's slot (and its device's session) is freed
        // for later cameras in this pass.
        bumpAttached(current.agentNodeId, -1, config.deviceKey)
      }
      this.deps.ledger.setConfig(deviceId, targetConfig)
      // Guard the attach→record window against the subtractive reconcile (a
      // migration target is attached before its assignment is recorded).
      const dispatchGuard = this.deps.ledger.markDispatching(deviceId)
      try {
        await this.attachOn(decision.agentNodeId, targetConfig)
        // New attachment (or migration target): occupy a slot in the tally.
        bumpAttached(decision.agentNodeId, 1, targetConfig.deviceKey)
        this.deps.ledger.recordAssignment(deviceId, decision.agentNodeId, 'rebalance', false)
      } finally {
        dispatchGuard.dispose()
      }
      migrated++
      moves.push({
        deviceId,
        fromNodeId: current?.agentNodeId ?? null,
        toNodeId: decision.agentNodeId,
      })
    }

    if (dryRun) {
      ctx.logger.debug('rebalance: plan', {
        meta: { minImprovement, wouldMove: moves.length },
      })
      return { migrated: 0, skipped, moves }
    }
    ctx.logger.info('rebalance: migrated cameras', { meta: { migrated } })
    return { migrated, skipped, moves }
  }

  getPipelineAssignments(): readonly PipelineAssignment[] {
    return this.deps.ledger.listAssignments()
  }

  getPipelineAssignment(input: { deviceId: number }): PipelineAssignment | null {
    return this.deps.ledger.getAssignment(input.deviceId)
  }

  // ── Attach / detach choke point ──────────────────────────────────────

  /**
   * Call `attachCamera` on the target runner via `ctx.api`. The generated cap
   * router extracts `nodeId` from the input and routes to local or remote
   * runner transparently — no broker reference needed.
   *
   * SINGLE choke point for the per-target `frameSource` (P2d): every attach —
   * dispatch, failover, rebalance, zone/pipeline re-attach — flows through
   * here, so the payload's frame-source mode is always computed for the node
   * it is actually going to. With the `remoteSourcingNodes` knob empty
   * (default) this is always `local-broker` — identical to the schema default
   * an absent field would produce.
   */
  async attachOn(nodeId: string, config: RunnerCameraConfig): Promise<void> {
    if (this.deps.maintenancePaused?.() === true) {
      throw new Error('pipeline dispatch is paused for storage migration')
    }
    const ctx = this.deps.ctx()
    const api = ctx.api
    if (!api) throw new Error(`attachOn(${nodeId}, ${config.deviceId}): this.ctx.api not available`)
    const sourceOwnerNodeId = this.deps.topology.sourceOwner(config.deviceId)
    const ownerReachableHost =
      sourceOwnerNodeId !== undefined
        ? this.deps.topology.reachableHostByNode.get(sourceOwnerNodeId)
        : undefined
    const frameSource = selectRunnerFrameSource({
      targetNodeId: nodeId,
      sourceOwnerNodeId,
      remoteSourcingNodes: this.deps.topology.remoteSourcingNodes,
      ...(ownerReachableHost !== undefined ? { ownerReachableHost } : {}),
    })

    // Task G5 (Gate B) — config-correctness surfacing. Node-pinned to the
    // TARGET node so validation runs against THAT node's engine format, not
    // the hub's. PURE COMPUTE on the executor side — never writes node-global
    // state. FIRE-AND-FORGET: the surfacing must NEVER delay or block the
    // attach. Before the hub image mounts this method's router the call
    // fast-fails only at the broker discovery deadline (~30s); awaiting it
    // would serialize every attach behind that timeout. The runtime G2 guard
    // (`resolveInputSteps`) is the real backstop that drops bad steps per
    // frame, so this attach-time validation is best-effort diagnostics. Once
    // the router is mounted (image release) the call resolves in <100ms and
    // this surfaces issues effectively before frames flow.
    void api.pipelineExecutor.validatePipeline
      .query({ steps: [...(config.steps ?? [])] }, nodePin(nodeId))
      .then((validation) => {
        if (!validation || (validation.ok && validation.substitutions.length === 0)) return
        const logMeta = {
          nodeId,
          deviceId: config.deviceId,
          issues: validation.issues,
          substitutions: validation.substitutions,
        }
        if (!validation.ok) {
          ctx.logger.warn('attachOn: pre-init pipeline validation found issues', {
            tags: { nodeId, deviceId: config.deviceId },
            meta: logMeta,
          })
        } else {
          ctx.logger.info('attachOn: pre-init pipeline validation found model substitutions', {
            tags: { nodeId, deviceId: config.deviceId },
            meta: logMeta,
          })
        }
      })
      .catch(() => {})

    this.inFlightAttaches++
    try {
      await api.pipelineRunner.attachCamera.mutate({
        ...config,
        frameSource,
        nodeId,
      })
    } catch (err: unknown) {
      // Diagnostic: a "Maximum call stack size exceeded" here surfaces
      // a recursion bug somewhere between the tRPC proxy and the
      // runner's attachCamera handler. Log the full stack + the
      // config shape so we can trace it from the server log instead
      // of guessing. Keeps the throw intact for the caller.
      if (err instanceof RangeError || String(err).includes('Maximum call stack')) {
        const configSummary = {
          deviceId: config.deviceId,
          detectionMode: config.detectionMode,
          audioMode: config.audioMode,
          motionStreamId: config.motionStreamId,
          detectionStreamId: config.detectionStreamId,
          stepsCount: config.steps?.length ?? null,
          hasAudio: config.audio?.enabled ?? null,
        }
        ctx.logger.error('attachOn: stack overflow', {
          tags: { nodeId, deviceId: config.deviceId },
          meta: {
            configSummary,
            stack: (err as Error).stack ?? '<no stack>',
          },
        })
      }
      throw err
    } finally {
      this.inFlightAttaches--
      if (this.inFlightAttaches === 0) {
        for (const resolve of this.idleWaiters.splice(0)) resolve()
      }
    }
  }

  /** Wait until every attach that began before the maintenance gate closed has
   * settled. New attaches are rejected at the top of `attachOn`. */
  waitForMigrationIdle(): Promise<void> {
    if (this.inFlightAttaches === 0) return Promise.resolve()
    return new Promise((resolve) => this.idleWaiters.push(resolve))
  }

  async detachOn(nodeId: string, deviceId: number): Promise<void> {
    const api = this.deps.ctx().api
    if (!api) return
    await api.pipelineRunner.detachCamera.mutate({ deviceId, nodeId })
  }

  // ── Redispatch surface ────────────────────────────────────────────────

  /** Re-dispatch every camera currently assigned to `nodeId` — used when agent defaults change. */
  async redispatchCamerasOnAgent(nodeId: string): Promise<void> {
    const affected: number[] = []
    for (const [deviceId, assignment] of this.deps.ledger.assignmentEntries()) {
      if (assignment.agentNodeId === nodeId) affected.push(deviceId)
    }
    if (affected.length === 0) return
    this.deps.ctx().logger.info('agentSettings change — hot-reloading cameras', {
      tags: { nodeId },
      meta: { affected: affected.length },
    })
    for (const deviceId of affected) {
      await this.deps.emitResolvedCameraUpdated(deviceId)
    }
  }

  /**
   * Re-dispatch EVERY assigned camera through the REAL attach path
   * (`redispatchSingleCamera` → `attachOn`), so each camera's `frameSource`
   * (`local-broker` vs `remote-restream` naming the current ingest owner) is
   * RECOMPUTED and re-applied to its runner. Used when the cluster ingest owner
   * changes: `frameSource` is computed only in `attachOn` (the single choke
   * point), so a plain `emitCameraUpdated` config event would NOT move the
   * source — the runner would keep sourcing from the OLD owner. No-op when
   * nothing is assigned.
   */
  async redispatchAllActiveCameras(reason: string): Promise<void> {
    const deviceIds = this.deps.ledger.listAssignedDeviceIds()
    if (deviceIds.length === 0) return
    this.deps.ctx().logger.info('re-dispatching all cameras', {
      meta: { reason, count: deviceIds.length },
    })
    for (const deviceId of deviceIds) {
      await this.redispatchSingleCamera(deviceId)
    }
  }

  /**
   * Re-dispatch a single camera through the normal assignment pipeline.
   * Used by auto-resume and settings-change recovery.
   */
  async redispatchSingleCamera(deviceId: number): Promise<void> {
    const assignment = this.deps.ledger.getAssignment(deviceId)
    const nodeId = assignment?.agentNodeId ?? 'hub'
    const cached = this.deps.ledger.getConfig(deviceId)
    if (!cached) {
      this.deps.ctx().logger.debug('redispatchSingleCamera: no cached config, skipping', {
        tags: { deviceId },
      })
      return
    }
    await this.attachOn(nodeId, cached)

    // Re-register with the watchdog on auto-resume: this path attaches
    // directly via `attachOn` (it does NOT go through `dispatchCamera`), so it
    // must mirror dispatchCamera's hub-local register gate. Without this a
    // load-shed-paused camera (unregistered at pause) would resume unwatched.
    if (nodeId === this.deps.localNodeId()) {
      const audioSource = await this.resolveAudioSource(cached)
      this.deps
        .watchdog()
        ?.register(this.deps.buildWatchdogCamera(cached, String(cached.deviceId), audioSource))
    }
  }

  /**
   * Resolve the watchdog's audio plane for ONE dispatch: which stream audio
   * rides, and whether it carries a track. Skipped entirely (and answered
   * "nothing to watch") when `audioMode` could not arm the stage anyway, so a
   * camera with on-motion audio costs no broker round-trip.
   *
   * The stream comes from the SAME selection the subscription makes — reading
   * `motionStreamId` here would arm the stage on the derived rung the audio
   * analyser deliberately does not listen to, and both the label and the
   * recovery would name a stream nobody is on.
   */
  private async resolveAudioSource(config: RunnerCameraConfig): Promise<WatchdogAudioSource> {
    if (config.audioMode !== 'always-on') return { camStreamId: null, hasTrack: false }
    const camStreamId = await this.deps.audioCamStreamFor(config)
    if (camStreamId === null) return { camStreamId: null, hasTrack: false }
    return {
      camStreamId,
      hasTrack: await this.deps.hasAudioSource(config.deviceId, camStreamId),
    }
  }

  // ── Internals ─────────────────────────────────────────────────────────

  /**
   * A re-place found the node it chose has never answered what the placement
   * needs (its catalog, or its device probe + pool health): the camera stays
   * pending with the node NAMED, and the line fires once per change of pending
   * state — a sweep re-finding the same unanswering node every tick is not
   * news, a camera newly stuck on it (or on another node) is.
   */
  private leavePendingUnanswered(
    deviceId: number,
    nodeId: string,
    what: 'catalog' | 'device-health',
  ): void {
    const reason: PendingReason =
      what === 'catalog' ? `catalog-unavailable:${nodeId}` : `device-health-unavailable:${nodeId}`
    if (!this.setPendingIfChanged(deviceId, reason)) return
    this.deps.ctx().logger.warn('camera left pending — the chosen node has not answered', {
      tags: { deviceId, nodeId },
      meta: {
        reason,
        hint: 'a re-place never waits for a node; the next retry round places it once the node answers',
      },
    })
  }

  /**
   * The NAMED refusal of a root-less attach (D650 round 3): the elected
   * device cannot run a gated-on root of the camera, so the attach would
   * detect nothing and — once its assignment were recorded — nothing would
   * re-place it. The camera stays pending instead, once-per-change logged.
   */
  private leavePendingRootRefused(
    deviceId: number,
    refusal: Extract<AttachPipelineOutcome, { kind: 'root-refused' }>,
  ): void {
    const reason: PendingReason = `root-unrunnable:${refusal.nodeId}/${refusal.deviceKey ?? 'default-pool'}`
    if (!this.setPendingIfChanged(deviceId, reason)) return
    this.deps
      .ctx()
      .logger.error(
        'attach refused — the elected device cannot run the camera root; camera left pending',
        {
          tags: { deviceId, nodeId: refusal.nodeId },
          meta: {
            reason,
            deviceKey: refusal.deviceKey ?? null,
            droppedRoots: refusal.droppedRoots.join(','),
            hint: 'the root is never jumped: enable a device on this node whose format ships the root model, or disable the device that cannot',
          },
        },
      )
  }

  /** Last migration-skip reason per camera — the info line fires once per change. */
  private readonly migrationSkips = new Map<number, string>()

  private noteMigrationSkipped(
    deviceId: number,
    sourceNodeId: string,
    targetNodeId: string,
    reason: string,
  ): void {
    if (this.migrationSkips.get(deviceId) === reason) return
    this.migrationSkips.set(deviceId, reason)
    this.deps.ctx().logger.info('rebalance: migration skipped — camera stays on its source', {
      tags: { deviceId, nodeId: targetNodeId },
      meta: { sourceNodeId, reason },
    })
  }

  /** Record `reason`; `true` when it differs from the camera's previous pending reason. */
  private setPendingIfChanged(deviceId: number, reason: PendingReason): boolean {
    const prior = this.deps.ledger.getPendingReason(deviceId)
    this.deps.ledger.setPendingReason(deviceId, reason)
    return prior !== reason
  }

  /**
   * Normalizes the `decision.kind === 'pending'` → `setPendingReason` +
   * `warn` half shared by `dispatchCamera`/`unassignPipeline`/`rebalance`
   * (smell #12). Each call site keeps its own bail (return / fall-through /
   * continue) immediately after calling this.
   */
  private handlePendingDecision(deviceId: number, reason: 'over-cap' | 'no-frame-source'): void {
    this.deps.ledger.setPendingReason(deviceId, reason)
    this.deps.ctx().logger.warn('camera left pending — no eligible node', {
      tags: { deviceId },
      meta: { reason },
    })
  }
}
