/**
 * `LoadShedController` — per-camera low-fps load shedding (C15, S8 extraction).
 *
 * Owns `cameraFpsMap` (last-seen actualFps per device), `loadShedState`
 * (pause/relocate bookkeeping), `shedInFlight` (per-device relocate/pause
 * guard), `loadShedResumeTimer` (auto-resume sweep handle), and
 * `firstSeenByDevice` — the cold-start grace-period tracker.
 *
 * **Smell #1 fix:** the former dynamic-property hack —
 * `(this via an unsafe cast to Record<string, number>)[`_loadMgmt_firstSeen_${deviceId}`]`
 * — stashed the grace-period timestamp as an ad-hoc enumerable property
 * directly on the addon instance, keyed by string-interpolated deviceId. It
 * is replaced here by a real `Map<number, number>`. Read/write semantics are
 * IDENTICAL: `enforceLoadManagement` still seeds the timestamp on first
 * metrics sample and gates on `Date.now() - firstSeen < 30_000` exactly as
 * before; `loadShedResumeSweep` still resets it on auto-resume so the camera
 * gets a fresh 30s warm-up. The hack additionally never freed the key when a
 * device was permanently removed (`handleDeviceUnregistered` never touched
 * it) — every camera that ever passed through the grace gate left a
 * dangling property on `this` for the lifetime of the process. `forgetDevice`
 * closes that leak by deleting the device's map entry on unregister.
 *
 * Extracted verbatim (mechanical, zero logic change) from `index.ts` — every
 * method body, log message, and control-flow branch is unchanged; only the
 * storage backing (`this.<field>` → `this.deps.<accessor>`) and the
 * `_loadMgmt_firstSeen_*` representation differ.
 */
import type { AddonApi, CameraMetrics, RunnerCameraConfig } from '@camstack/types'
import { errMsg, type IScopedLogger } from '@camstack/types'
import type { AgentLoadService } from './agent-load-service.js'
import { balance } from './load-balancer.js'
import type { NodeTopologyService } from './node-topology.js'
import type { PipelineSettingsStore } from './pipeline-settings-store.js'
import type { PipelineWatchdog } from './pipeline-watchdog.js'
import type { PlacementLedger } from './placement-ledger.js'

/** Per-camera load-shed bookkeeping — mirrors the former inline `loadShedState` entry shape. */
export interface LoadShedState {
  lowSinceTs: number | null
  pausedAt: number | null
  resumeAttempts: number
}

/** Per-camera last-seen fps sample — mirrors the former inline `cameraFpsMap` entry shape. */
export interface CameraFpsEntry {
  readonly fps: number
  readonly nodeId: string
  readonly lastSeen: number
}

export interface LoadShedControllerDeps {
  readonly ledger: PlacementLedger
  readonly loadService: AgentLoadService
  readonly topology: NodeTopologyService
  readonly settingsStore: PipelineSettingsStore
  /** Thin seam onto `PlacementService.attachOn` — set as a lazy closure at construction (loadShed is built before placement). */
  readonly attach: (nodeId: string, config: RunnerCameraConfig) => Promise<void>
  /** Thin seam onto `PlacementService.detachOn` — see {@link attach}. */
  readonly detach: (nodeId: string, deviceId: number) => Promise<void>
  readonly watchdog: () => PipelineWatchdog | null
  readonly api: () => AddonApi | null
  readonly logger: IScopedLogger
  /** Thin seam onto `PlacementService.redispatchSingleCamera` — see {@link attach}. */
  readonly redispatchSingleCamera: (deviceId: number) => Promise<void>
  readonly readPipelinePin: (deviceId: number) => Promise<string | null>
  /** Live read accessor for the addon's in-memory global settings snapshot. */
  readonly readGlobalSettings: () => Record<string, unknown>
  /** Live read accessor for the addon's `onInitialize` timestamp (dispatch-deferral cold-start gate). */
  readonly getInitTimestamp: () => number
}

export class LoadShedController {
  /** Default min-FPS low-window before a sustained-slow camera is shed. */
  private static readonly DEFAULT_FPS_LOW_WINDOW_MS = 60_000
  /**
   * `0` = DISABLED by default — see the original field doc: a single slow
   * camera (e.g. an on-motion camera idling at <1 fps between motion events)
   * must NOT be detached or block new dispatches. `public` — also read by
   * `index.ts`'s `globalSettingsSchema()` to seed the operator-facing form
   * field default (mirrors the original `PipelineOrchestratorAddon.DEFAULT_FPS_MIN_THRESHOLD`
   * cross-reference).
   */
  static readonly DEFAULT_FPS_MIN_THRESHOLD = 0
  /** Base cooldown before first auto-resume attempt. */
  private static readonly LOAD_SHED_BASE_COOLDOWN_MS = 30_000
  /** Maximum backoff cap. */
  private static readonly LOAD_SHED_MAX_COOLDOWN_MS = 5 * 60_000
  /** How often the auto-resume sweep runs. */
  private static readonly LOAD_SHED_SWEEP_INTERVAL_MS = 10_000

  /** Per-camera last-seen actualFps for load management enforcement. */
  private readonly cameraFpsMap = new Map<number, CameraFpsEntry>()
  /** Load-shed state per camera — see {@link LoadShedState}. */
  private readonly loadShedState = new Map<number, LoadShedState>()
  /** Timer for the auto-resume sweep. */
  private loadShedResumeTimer: ReturnType<typeof setInterval> | null = null
  /** Per-camera guard so repeated low-fps snapshots don't stack relocate/pause. */
  private readonly shedInFlight = new Set<number>()
  /**
   * Per-device grace-period start (cold-start model-loading warm-up before
   * load management can enforce). Real `Map` replacing the former dynamic-
   * property hack — see the class doc for the leak this fixes.
   */
  private readonly firstSeenByDevice = new Map<number, number>()

  constructor(private readonly deps: LoadShedControllerDeps) {}

  // ── Metrics subscriber body ──────────────────────────────────────────

  /** Mirrors the former `PipelineCameraMetricsSnapshot` subscriber body exactly. */
  noteMetrics(deviceId: number, nodeId: string | undefined, metrics: CameraMetrics): void {
    this.cameraFpsMap.set(deviceId, {
      fps: metrics.actualFps,
      nodeId: nodeId ?? 'hub',
      lastSeen: Date.now(),
    })
    this.enforceLoadManagement(deviceId, metrics)
  }

  // ── Dispatch-deferral check (used by `PlacementService.dispatchCamera`) ──

  /**
   * Mirrors the former inline block at the top of `dispatchCamera`: defer a
   * new dispatch when any camera has been below threshold for at least half
   * the configured window, or is already load-shed paused — so we don't pile
   * new attaches on a struggling node. Sets the pending reason + logs as a
   * side effect (same as the original inline block); returns `true` when the
   * caller should return a `'pending'` `DispatchResult` immediately.
   */
  dispatchDeferralCheck(deviceId: number): boolean {
    const cfg = this.deps.readGlobalSettings() ?? {}
    const minThreshold =
      typeof cfg.fpsMinThreshold === 'number'
        ? cfg.fpsMinThreshold
        : LoadShedController.DEFAULT_FPS_MIN_THRESHOLD
    const windowMs =
      typeof cfg.fpsLowWindowMs === 'number' && cfg.fpsLowWindowMs > 0
        ? cfg.fpsLowWindowMs
        : LoadShedController.DEFAULT_FPS_LOW_WINDOW_MS
    const initTimestamp = this.deps.getInitTimestamp()
    if (minThreshold > 0 && initTimestamp && Date.now() - initTimestamp > 30_000) {
      const now = Date.now()
      const halfWindow = windowMs / 2
      for (const [did, state] of this.loadShedState) {
        const lowDurationMs = state.lowSinceTs !== null ? now - state.lowSinceTs : 0
        if (state.pausedAt !== null || lowDurationMs >= halfWindow) {
          this.deps.logger.info('dispatchCamera deferred: node under sustained load', {
            tags: { deviceId },
            meta: {
              blockedBy: did,
              lowDurationMs,
              paused: state.pausedAt !== null,
              threshold: minThreshold,
              windowMs,
            },
          })
          this.deps.ledger.setPendingReason(deviceId, 'load-shed')
          return true
        }
      }
    }
    return false
  }

  // ── Queries ───────────────────────────────────────────────────────────

  /** Live read-only view — for pure-function inputs that want `ReadonlyMap` semantics (e.g. `evaluateRemoteHealth`, mirrors `PlacementLedger.assignmentsView`). */
  fpsMapView(): ReadonlyMap<number, CameraFpsEntry> {
    return this.cameraFpsMap
  }

  /** True when any node is currently load-shed paused (used to skip churny retries). */
  isAnyNodeLoadShed(): boolean {
    for (const state of this.loadShedState.values()) {
      if (state.pausedAt !== null) return true
    }
    return false
  }

  /** True when `deviceId` is currently load-shed paused (synthetic-metrics gate for `getCameraMetrics`). */
  isPaused(deviceId: number): boolean {
    const state = this.loadShedState.get(deviceId)
    return state?.pausedAt !== null && state?.pausedAt !== undefined
  }

  // ── Settings-change hook ─────────────────────────────────────────────

  /**
   * Mirrors the former inline block inside `updateGlobalSettings`: clear
   * load-shed pauses so suspended cameras get re-evaluated with the new
   * thresholds on the next dispatch cycle, then re-dispatch each of them.
   */
  clearOnSettingsChange(): void {
    const pausedIds = [...this.loadShedState.entries()]
      .filter(([, s]) => s.pausedAt !== null)
      .map(([id]) => id)
    if (pausedIds.length === 0) return
    this.loadShedState.clear()
    this.deps.logger.info('Settings updated — cleared load-shed pauses, re-dispatching cameras', {
      meta: { deviceIds: pausedIds },
    })
    for (const deviceId of pausedIds) {
      void this.deps.redispatchSingleCamera(deviceId).catch(() => {
        /* best-effort */
      })
    }
  }

  // ── Device lifecycle ──────────────────────────────────────────────────

  /**
   * Free the grace-period entry for a permanently-removed device — closes
   * the leak the former dynamic-property hack left open (see class doc).
   * `cameraFpsMap`/`loadShedState`/`shedInFlight` are intentionally left
   * alone (mirrors the original: nothing cleared them on unregister either,
   * and doing so now would be an observable behavior change beyond the
   * authorized leak fix).
   */
  forgetDevice(deviceId: number): void {
    this.firstSeenByDevice.delete(deviceId)
  }

  // ── Test seam ─────────────────────────────────────────────────────────

  /** Raw fps-map write, mirroring `PlacementLedger.seedAssignment` — used by specs that stage state directly. */
  seedCameraFps(deviceId: number, entry: CameraFpsEntry): void {
    this.cameraFpsMap.set(deviceId, entry)
  }

  // ── Internals ─────────────────────────────────────────────────────────

  /**
   * Load management enforcement — called on every camera metrics snapshot.
   * Time-based window: a camera must stay below `fpsMinThreshold` for at
   * least `fpsLowWindowMs` (default 60s) before it is paused. The window
   * resets the moment fps recovers above threshold.
   */
  private enforceLoadManagement(deviceId: number, metrics: CameraMetrics): void {
    const cfg = this.deps.readGlobalSettings() ?? {}
    const threshold =
      typeof cfg.fpsMinThreshold === 'number'
        ? cfg.fpsMinThreshold
        : LoadShedController.DEFAULT_FPS_MIN_THRESHOLD
    const windowMs =
      typeof cfg.fpsLowWindowMs === 'number' && cfg.fpsLowWindowMs > 0
        ? cfg.fpsLowWindowMs
        : LoadShedController.DEFAULT_FPS_LOW_WINDOW_MS

    if (threshold <= 0) return
    if (metrics.phase !== 'active') return

    // Grace period: don't enforce during the first 30s after a camera
    // starts detecting. Cold-start model loading causes very low fps
    // initially which would trigger false kill.
    const info = this.cameraFpsMap.get(deviceId)
    if (!info) return
    const firstSeen = this.firstSeenByDevice.get(deviceId)
    if (!firstSeen) {
      this.firstSeenByDevice.set(deviceId, Date.now())
      return
    }
    if (Date.now() - firstSeen < 30_000) return

    // Require a meaningful sample: actualFps must be > 0 (not idle)
    if (metrics.actualFps <= 0) return

    let state = this.loadShedState.get(deviceId)
    if (!state) {
      state = { lowSinceTs: null, pausedAt: null, resumeAttempts: 0 }
      this.loadShedState.set(deviceId, state)
    }

    // Already paused — nothing to do (auto-resume timer handles recovery)
    if (state.pausedAt !== null) return

    const now = Date.now()

    if (metrics.actualFps >= threshold) {
      // FPS healthy — reset the time window
      if (state.lowSinceTs !== null) {
        state.lowSinceTs = null
      }
      return
    }

    // FPS below threshold — start (or extend) the timer
    if (state.lowSinceTs === null) {
      state.lowSinceTs = now
    }

    const lowDurationMs = now - state.lowSinceTs
    if (lowDurationMs < windowMs) {
      this.deps.logger.debug('Load management: low fps sample', {
        tags: { deviceId },
        meta: { actualFps: metrics.actualFps, threshold, lowDurationMs, windowMs },
      })
      return
    }

    // Window elapsed — the camera is sustained-slow. Cluster-wide policy: try to
    // RELOCATE it to a spare-capacity node first (respecting each node's ceiling
    // + weight), and only PAUSE it if the cluster genuinely has no room. Fired
    // async + guarded so repeated snapshots don't stack relocations/detaches.
    if (this.shedInFlight.has(deviceId)) return
    this.shedInFlight.add(deviceId)
    this.deps.logger.warn('Load management: sustained low fps — relocating or pausing', {
      tags: { deviceId },
      meta: { actualFps: metrics.actualFps, threshold, lowDurationMs, windowMs },
    })
    void this.shedOrRelocate(deviceId, state).finally(() => this.shedInFlight.delete(deviceId))
  }

  /**
   * Cluster-wide load-shed action: relocate the sustained-slow camera to a
   * less-loaded node if the balancer (ceiling + weight aware) finds one,
   * otherwise pause it. Reuses `balance()` / attach / detach — no custom
   * placement logic.
   */
  private async shedOrRelocate(deviceId: number, state: LoadShedState): Promise<void> {
    if (state.pausedAt !== null) return
    const relocated = await this.tryClusterRelocate(deviceId).catch((err: unknown) => {
      this.deps.logger.warn('Load management: cluster relocate failed', {
        tags: { deviceId },
        meta: { error: errMsg(err) },
      })
      return false
    })
    if (relocated) {
      // Moved to a spare-capacity node — reset the window and give it a chance
      // there. NOT paused.
      state.lowSinceTs = null
      return
    }

    // No spare capacity cluster-wide — pause (detach) as the last resort.
    this.deps.logger.warn('Load management: pausing camera detection (no spare cluster capacity)', {
      tags: { deviceId },
    })
    state.pausedAt = Date.now()
    state.lowSinceTs = null
    // Stop watching a deliberately load-shed-paused camera (see auto-resume).
    this.deps.watchdog()?.unregister(deviceId)
    void this.deps
      .api()
      ?.pipelineRunner.detachCamera.mutate({ deviceId })
      .catch((err: unknown) => {
        this.deps.logger.warn('Load management: detachCamera failed', {
          tags: { deviceId },
          meta: { error: errMsg(err) },
        })
      })
    this.ensureLoadShedResumeTimer()
  }

  /**
   * Try to move a sustained-slow camera to a less-loaded node CLUSTER-WIDE.
   * Runs the same `balance()` the dispatcher uses; returns `true` iff the
   * camera was moved to a DIFFERENT node. A manually pinned camera never
   * relocates.
   */
  private async tryClusterRelocate(deviceId: number): Promise<boolean> {
    const current = this.deps.ledger.getAssignment(deviceId)
    const cached = this.deps.ledger.getConfig(deviceId)
    if (!current || !cached) return false
    const currentNode = current.agentNodeId
    // A manual pin is authoritative — never relocate a pinned camera.
    if (await this.deps.readPipelinePin(deviceId)) return false

    const loads = await this.deps.loadService.collectAgentLoad({ onlyEnabled: true })
    const decision = balance({
      nodes: loads,
      preferredAgent: null,
      nodeCaps: await this.deps.settingsStore.buildNodeCaps(),
      weights: await this.deps.settingsStore.buildNodeWeights(),
      eligibleNodes: this.deps.topology.detectionEligibleNodes(deviceId),
    })
    if (!decision || decision.kind !== 'assigned') return false
    const target = decision.agentNodeId
    if (target === currentNode) return false // current node is still the best — no spare capacity

    await this.deps.detach(currentNode, deviceId).catch((err: unknown) => {
      this.deps.logger.debug('Load management: relocate detach-old failed', {
        tags: { deviceId },
        meta: { from: currentNode, error: errMsg(err) },
      })
    })
    await this.deps.attach(target, cached)
    this.deps.ledger.recordAssignment(deviceId, target, 'rebalance', false)
    this.deps.logger.info(
      'Load management: relocated camera to spare-capacity node (cluster-wide)',
      {
        tags: { deviceId },
        meta: { from: currentNode, to: target, score: decision.score },
      },
    )
    return true
  }

  // ── Auto-resume sweep ─────────────────────────────────────────────────

  private ensureLoadShedResumeTimer(): void {
    if (this.loadShedResumeTimer) return
    this.loadShedResumeTimer = setInterval(() => {
      void this.loadShedResumeSweep()
    }, LoadShedController.LOAD_SHED_SWEEP_INTERVAL_MS)
  }

  private async loadShedResumeSweep(): Promise<void> {
    const now = Date.now()
    const baseCooldown = LoadShedController.LOAD_SHED_BASE_COOLDOWN_MS
    const maxCooldown = LoadShedController.LOAD_SHED_MAX_COOLDOWN_MS
    let anyPaused = false

    for (const [deviceId, state] of this.loadShedState) {
      if (state.pausedAt === null) continue
      anyPaused = true

      // Exponential backoff: 30s, 60s, 120s, ... capped at 5min
      const cooldown = Math.min(baseCooldown * Math.pow(2, state.resumeAttempts), maxCooldown)
      if (now - state.pausedAt < cooldown) continue

      state.resumeAttempts++
      state.pausedAt = null
      state.lowSinceTs = null

      this.deps.logger.info('Load management: auto-resuming camera', {
        tags: { deviceId },
        meta: { attempt: state.resumeAttempts },
      })

      // Reset the grace-period first-seen so the camera gets another
      // 30s warm-up before load management can kill it again.
      this.firstSeenByDevice.delete(deviceId)

      void this.deps.redispatchSingleCamera(deviceId).catch((err: unknown) => {
        this.deps.logger.warn('Load management: auto-resume dispatch failed', {
          tags: { deviceId },
          meta: { error: errMsg(err) },
        })
      })
    }

    // Stop the timer when no cameras are paused
    if (!anyPaused && this.loadShedResumeTimer) {
      clearInterval(this.loadShedResumeTimer)
      this.loadShedResumeTimer = null
    }
  }

  // ── Disposal ──────────────────────────────────────────────────────────

  /**
   * Mirrors the former `onShutdown` clears exactly: `cameraFpsMap.clear()`,
   * `loadShedState.clear()`, and the resume timer teardown. `shedInFlight`
   * was NEVER cleared on shutdown in the original — preserved as-is.
   */
  dispose(): void {
    this.cameraFpsMap.clear()
    this.loadShedState.clear()
    if (this.loadShedResumeTimer) {
      clearInterval(this.loadShedResumeTimer)
      this.loadShedResumeTimer = null
    }
  }
}
