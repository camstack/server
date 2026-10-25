/**
 * `ReconcileController` — dispatch reconcile + pending/stranded retry sweep +
 * remote-assignment health loop (C8, S9 extraction).
 *
 * Owns the debounce/in-flight/rerun flags for both the RPC snapshot-reconcile
 * pass and the pending-retry sweep, both per-device retry timer maps
 * (`slotReadRetryTimers`/`slotReadRetryAttempts`), the subtractive-reconcile
 * in-flight guard (`attachmentReconcileInFlight`), and the T7 remote-health
 * backoff ledger (`remoteHealthAttempts`).
 *
 * Extracted verbatim (mechanical, zero logic change) from `index.ts` — every
 * method body, log message, and control-flow branch is unchanged; only the
 * storage backing (`this.<field>` → `this.<field>` on this class, `this.X`
 * addon calls → `this.deps.X` injected closures) differs. It already
 * delegates every DECISION to the pure modules (`dispatch-reconcile.ts` /
 * `pending-retry.ts` / `remote-health.ts`) — this class is plumbing only:
 * timers, in-flight guards, and wiring the pure results into RPC calls.
 *
 * `scheduleReconcile`/`schedulePendingRetry`/`scheduleSlotReadRetry`/
 * `clearSlotReadRetry`/`reconcilePlacementFromRunners`/
 * `retryPendingDispatches`/`evaluateRemoteAssignmentHealth` are all PUBLIC —
 * called from the C14 detection-wiring handlers (now on
 * `DetectionWiringController`, S11 Task 3), from `PlacementService`'s
 * injected `reconcilePlacementFromRunners` closure, from the periodic
 * `pendingRetryTimer`/eager-reconcile call sites in
 * `orchestrator-bootstrap.ts` (S11 Task 4), and from the
 * `evaluateRemoteAssignmentHealth`/`remoteHealthAttempts` protected
 * test-seam wrapper on `index.ts` that `remote-health.spec.ts` subclasses
 * onto.
 */
import type { AddonApi, ProfileSlot, RunnerCameraConfig } from '@camstack/types'
import { errMsg, type IScopedLogger, nodePin } from '@camstack/types'
import {
  computeDispatchGap,
  desiredDeviceIdsFromSlots,
  reconcilePlacement,
  reconcileVanishedDevices,
  runnerAttachmentKey,
  type RunnerCameras,
  splitDesiredByExistence,
  type VanishedDeviceState,
} from './dispatch-reconcile.js'
import {
  raceBudget,
  RECONCILE_NODE_BUDGET_MS,
  RECONCILE_SLOW_MS,
  type RunnerCensusEntry,
} from './dispatch-timing.js'
import type { LoadShedController } from './load-shed-controller.js'
import type { NodeTopologyService } from './node-topology.js'
import {
  type DispatchResult,
  PENDING_RETRY_DEBOUNCE_MS,
  RECONCILE_DEBOUNCE_MS,
  REMOTE_HEALTH_MAX_ATTEMPTS,
  REMOTE_HEALTH_WINDOW_MS,
} from './orchestrator-types.js'
import { computeStrandedDevices } from './pending-retry.js'
import type { PlacementLedger } from './placement-ledger.js'
import {
  DEFAULT_REMOTE_HEALTH_OPTS,
  evaluateRemoteHealth,
  type RemoteHealthAction,
} from './remote-health.js'

export interface ReconcileControllerDeps {
  readonly api: () => AddonApi | null
  readonly ledger: PlacementLedger
  readonly topology: NodeTopologyService
  /** Direct instance (mirrors the `ledger`/`topology` pattern) — read for `fpsMapView()`/`isAnyNodeLoadShed()`. */
  readonly loadShed: LoadShedController
  readonly logger: IScopedLogger
  /** Thin seam onto `DetectionWiringController.handleDeviceRegistered` (via the addon's own delegate — the C14 handler bodies moved there in S11 Task 3). */
  readonly handleDeviceRegistered: (deviceId: number) => Promise<void>
  /**
   * Thin seam onto `DetectionWiringController.handleDeviceUnregistered` (via
   * the addon's own delegate). The reconcile runs the SAME teardown the
   * `DeviceUnregistered` event runs — stopDetection → releaseCamera →
   * watchdog.unregister → ledger/settings cleanup — for a desired device the
   * device registry no longer has. Never a second, parallel teardown path.
   */
  readonly handleDeviceUnregistered: (deviceId: number) => Promise<void>
  /**
   * `PlacementService.redispatchCamera` — the NON-BLOCKING re-place (D650
   * round 2). Both callers here are sweeps that run cameras serially; a
   * re-place that waited for a wedged node's catalog would hold every camera
   * after it, forever.
   */
  readonly redispatchCamera: (config: RunnerCameraConfig) => Promise<DispatchResult>
  /** Thin seam onto `PlacementService.detachOn` (via the addon's own delegate). */
  readonly detachOn: (nodeId: string, deviceId: number) => Promise<void>
  /** Live read accessor — `this.localNodeId` on the addon. */
  readonly localNodeId: () => string
  /** Live read accessor — `DetectionWiringController.activeDeviceIds()` (the `activeDetections` key set, owned there since S11 Task 3). */
  readonly activeDeviceIds: () => ReadonlySet<number>
  /** Phase 3 slice 2 guard predicate — `this.isSessionCamera` on the addon. */
  readonly isSessionCamera: (deviceId: number) => boolean
  /** Phase 3 slice 2 guard predicate — `this.isIdleSessionCamera` on the addon. */
  readonly isIdleSessionCamera: (deviceId: number) => boolean
  /** True only for the intentional analyzer watch attach kept outside the placement ledger. */
  readonly isMotionWatchAttachment: (deviceId: number, nodeId: string) => boolean
  /** Thin seam onto `SessionDispatchController.sessionRegistry.deregister` (wired directly in the bootstrap since S11 Task 2). */
  readonly deregisterSession: (deviceId: number) => void
}

export class ReconcileController {
  private static readonly SLOT_READ_MAX_RETRIES = 6
  private static readonly SLOT_READ_RETRY_BASE_MS = 500

  /** Pending `scheduleReconcile` debounce timer. */
  private reconcileTimer: ReturnType<typeof setTimeout> | null = null
  /** True while `reconcileDispatch` is awaiting the RPC round-trip. */
  private reconcileInFlight = false
  /** Set to true when a reconcile is requested while one is already in-flight; triggers a follow-up pass. */
  private reconcileRerunRequested = false
  /** Shared in-flight pass so a session dispatch waits for runner truth instead of racing it. */
  private attachmentReconcilePromise: Promise<void> | null = null

  /**
   * Desired-but-nonexistent devices and how far their vanish streak has got
   * (`dispatch-reconcile.ts`). PURELY in-memory and seeded EMPTY on boot: it is
   * a confirmation counter, not a record — after a restart the first pass only
   * ever re-observes, never destroys. Cleared whenever the registry read fails,
   * so a failed read can never advance a device toward teardown.
   */
  private vanishedDevices: ReadonlyMap<number, VanishedDeviceState> = new Map()

  /**
   * Per-device backoff for retrying `handleDeviceRegistered` after a
   * TRANSIENT profile-slot read failure. Timers are `unref`'d and cleared on
   * shutdown / device removal.
   */
  private readonly slotReadRetryTimers = new Map<number, ReturnType<typeof setTimeout>>()
  private readonly slotReadRetryAttempts = new Map<number, number>()

  /** Pending `schedulePendingRetry` debounce timer (T3). */
  private pendingRetryDebounceTimer: ReturnType<typeof setTimeout> | null = null
  /** True while `retryPendingDispatches` is running. */
  private pendingRetryInFlight = false
  /** Set when a pending-retry is requested while one is already in-flight; triggers a follow-up pass. */
  private pendingRetryRerunRequested = false

  /**
   * Remote-assignment health loop (T7) per-device backoff ledger. Each entry
   * tracks how many times a remote camera has been re-placed inside the
   * current rolling window (`REMOTE_HEALTH_WINDOW_MS`). Bounds churn: once
   * the count hits `REMOTE_HEALTH_MAX_ATTEMPTS`, the camera is left pending
   * (`'unhealthy'`) for the operator instead of being re-placed again.
   * `readonly` (not `private`) — the addon exposes a `protected
   * remoteHealthAttempts` getter delegating here so `remote-health.spec.ts`'s
   * subclass test seam keeps reading/writing the SAME live Map instance the
   * controller itself reads on its next evaluation pass.
   */
  readonly remoteHealthAttempts = new Map<number, { count: number; windowStart: number }>()

  constructor(private readonly deps: ReconcileControllerDeps) {}

  // ── Dispatch reconcile ───────────────────────────────────────────────

  /**
   * Coalesce bursts of topology/slot-change signals into a single
   * `reconcileDispatch` pass. Mirrors `scheduleRehydrate` in
   * `packages/kernel/src/moleculer/readiness-context.ts`.
   */
  scheduleReconcile(): void {
    if (this.reconcileTimer !== null) clearTimeout(this.reconcileTimer)
    this.reconcileTimer = setTimeout(() => {
      this.reconcileTimer = null
      void this.reconcileDispatch()
    }, RECONCILE_DEBOUNCE_MS)
  }

  /**
   * RPC snapshot-reconcile: pull the current broker fleet over
   * `listAllProfileSlots`, diff against `cameraConfigs`, and dispatch
   * the gap via `handleDeviceRegistered`.
   *
   * Additive only — never retracts or re-dispatches a known device.
   * Guards against re-entrant calls: a trailing request schedules one
   * extra pass after the in-flight one completes.
   */
  private async reconcileDispatch(): Promise<void> {
    if (this.reconcileInFlight) {
      this.reconcileRerunRequested = true
      return
    }
    this.reconcileInFlight = true
    try {
      const api = this.deps.api()
      if (!api) {
        this.deps.logger.debug('dispatch reconcile skipped — ctx.api not yet available')
        return
      }

      let slots: readonly ProfileSlot[]
      try {
        slots = await api.streamBroker.listAllProfileSlots.query()
      } catch (err: unknown) {
        this.deps.logger.debug('dispatch reconcile skipped — stream-broker not ready', {
          meta: { error: errMsg(err) },
        })
        return
      }

      const desired = desiredDeviceIdsFromSlots(slots)

      // The broker keeps a DELETED device's profile slots forever, so `desired`
      // alone re-proposes cameras the operator already removed (live evidence:
      // 3217, 3218 — both deleted, both re-dispatched here). Filter it against
      // the live device registry before anything is dispatched.
      const liveDeviceIds = await this.readLiveDeviceIds()
      const { existing, vanished } =
        liveDeviceIds === null
          ? { existing: desired, vanished: new Set<number>() }
          : splitDesiredByExistence(desired, liveDeviceIds)
      if (liveDeviceIds === null) {
        // D49: a read that fails changes NOTHING. Behave exactly as before the
        // filter existed — dispatch everything desired — and say so, because a
        // silently-skipped gate reads as a gate that passed.
        this.deps.logger.warn(
          'dispatch reconcile: device existence filter SKIPPED — registry read failed',
          { meta: { desired: desired.size } },
        )
        this.vanishedDevices = new Map()
      }

      const known = new Set(this.deps.ledger.listConfigIds())
      const gap = computeDispatchGap(existing, known)

      this.deps.logger.info('dispatch reconcile', {
        meta: { desired: desired.size, known: known.size, gap, vanished: vanished.size },
      })

      await this.tearDownVanishedDevices(vanished)

      for (const deviceId of gap) {
        try {
          await this.deps.handleDeviceRegistered(deviceId)
        } catch (err: unknown) {
          this.deps.logger.warn('dispatch reconcile: handleDeviceRegistered failed', {
            tags: { deviceId },
            meta: { error: errMsg(err) },
          })
        }
      }

      // Subtractive pass — detach orphan attachments the additive gap-fill
      // above can never remove (a swallowed detach or a hub respawn leaves a
      // camera attached on a runner it is no longer assigned to → phantom load).
      await this.reconcilePlacementFromRunners()
    } finally {
      this.reconcileInFlight = false
      if (this.reconcileRerunRequested) {
        this.reconcileRerunRequested = false
        this.scheduleReconcile()
      }
    }
  }

  /**
   * The live device registry as an id set, or `null` when the read FAILED.
   * `null` is the caller's signal to skip the existence filter entirely — it
   * must never be confused with "the registry is empty", which would prune the
   * whole fleet.
   *
   * Asks for the slim projection: this needs identity only, never
   * `config`/`sourceInfo` (a full listing of 293 devices measured 271 KB).
   */
  private async readLiveDeviceIds(): Promise<ReadonlySet<number> | null> {
    const api = this.deps.api()
    if (!api) return null
    try {
      const devices = await api.deviceManager.listAll.query({ projection: 'slim' })
      return new Set(devices.map((device) => device.id))
    } catch (err: unknown) {
      this.deps.logger.debug('dispatch reconcile: deviceManager.listAll failed', {
        meta: { error: errMsg(err) },
      })
      return null
    }
  }

  /**
   * Tear down the desired devices the registry no longer has — but only once
   * TWO consecutive passes agree they are gone (`reconcileVanishedDevices`,
   * D49). Teardown destroys work, so a single listing that omits a device
   * (which a partial or racy read looks exactly like) is not enough.
   *
   * Runs the SAME `handleDeviceUnregistered` the `DeviceUnregistered` event
   * runs, so there is exactly one teardown path.
   */
  private async tearDownVanishedDevices(vanished: ReadonlySet<number>): Promise<void> {
    const { tearDown, nextState } = reconcileVanishedDevices(vanished, this.vanishedDevices)
    this.vanishedDevices = nextState
    for (const deviceId of tearDown) {
      this.deps.logger.warn(
        'dispatch reconcile: device no longer exists — tearing down instead of dispatching',
        { tags: { deviceId }, meta: { confirmedPasses: 2 } },
      )
      try {
        await this.deps.handleDeviceUnregistered(deviceId)
      } catch (err: unknown) {
        this.deps.logger.warn('dispatch reconcile: teardown of vanished device failed', {
          tags: { deviceId },
          meta: { error: errMsg(err) },
        })
      }
    }
  }

  /**
   * Converge the in-memory `assignments` map to runner truth (Phase 1 of the
   * placement-derived-state design). Runner attachments (`getLocalCameras`) are
   * authoritative: detach duplicates/orphans, and drop stale assignments
   * (assigned-but-not-attached) so the additive dispatch path re-establishes
   * them. Runs on the reconcile triggers ($node.connected + the 60 s net) with
   * its own in-flight guard; `dispatchingDevices` excludes in-flight placements
   * so a detach/drop never races an attach.
   *
   * Public — `PlacementService` reaches this via an injected closure
   * (`reconcilePlacementFromRunners: () => this.reconcile!.reconcilePlacementFromRunners()`).
   */
  async reconcilePlacementFromRunners(): Promise<void> {
    if (this.attachmentReconcilePromise) return this.attachmentReconcilePromise
    const run = this.runPlacementReconcile()
    this.attachmentReconcilePromise = run
    try {
      await run
    } finally {
      if (this.attachmentReconcilePromise === run) this.attachmentReconcilePromise = null
    }
  }

  private async runPlacementReconcile(): Promise<void> {
    const api = this.deps.api()
    if (!api) return
    // The census: every runner asked for its attached cameras, IN PARALLEL
    // and each under `RECONCILE_NODE_BUDGET_MS` (D440). It was sequential and
    // unbounded, and it ran at the head of every motion dispatch — so one
    // node's busy event loop was every camera's dispatch latency, and a
    // census that merely took long logged nothing at all. A node that did
    // not report is left alone by `reconcilePlacement` (its assignments are
    // never dropped), so skipping it costs one pass of orphan cleanup there.
    const censusStartedAt = Date.now()
    const runners: RunnerCameras[] = []
    const census: RunnerCensusEntry[] = []
    await Promise.all(
      this.deps.topology.collectRunnerNodeIds().map(async (nodeId) => {
        const startedAt = Date.now()
        const outcome = await raceBudget(
          api.pipelineRunner.getLocalCameras.query(undefined, nodePin(nodeId)),
          RECONCILE_NODE_BUDGET_MS,
        )
        const ms = Date.now() - startedAt
        if (outcome.kind === 'settled') {
          runners.push({ nodeId, attached: outcome.value })
          census.push({ nodeId, ms, outcome: 'reported' })
          return
        }
        census.push({
          nodeId,
          ms,
          outcome: outcome.kind === 'rejected' ? 'failed' : 'budget-exceeded',
        })
        this.deps.logger.debug('placement reconcile skipped node — getLocalCameras failed', {
          tags: { nodeId },
          meta: {
            error: outcome.kind === 'rejected' ? errMsg(outcome.error) : 'budget exceeded',
            ms,
          },
        })
      }),
    )
    const censusMs = Date.now() - censusStartedAt
    if (censusMs >= RECONCILE_SLOW_MS || census.some((entry) => entry.outcome !== 'reported')) {
      // A census that cost a second says so, per node: the only way to tell
      // "the Mac was busy" from "the hub was busy" is to have both numbers.
      this.deps.logger.info('placement reconcile: runner census was slow', {
        meta: { censusMs, nodes: census, budgetMs: RECONCILE_NODE_BUDGET_MS },
      })
    }

    const { assignedNodeById, dispatching } = this.deps.ledger.snapshotForReconcile()
    const idleSessionDeviceIds = new Set(
      [...this.deps.activeDeviceIds()].filter((deviceId) =>
        this.deps.isIdleSessionCamera(deviceId),
      ),
    )
    const motionWatchAttachments = new Set<string>()
    for (const { nodeId, attached } of runners) {
      for (const deviceId of attached) {
        if (this.deps.isMotionWatchAttachment(deviceId, nodeId)) {
          motionWatchAttachments.add(runnerAttachmentKey(nodeId, deviceId))
        }
      }
    }

    const { detach, dropStaleAssignment } = reconcilePlacement({
      runners,
      assignedNodeById,
      dispatching,
      idleSessionDeviceIds,
      motionWatchAttachments,
    })

    if (detach.length > 0) {
      this.deps.logger.info('placement reconcile: detaching orphans/duplicates', {
        meta: { detach },
      })
      // Independent RPCs to independent (node, device) pairs: in parallel, so
      // a pass that finds three orphans costs one round trip, not three.
      await Promise.all(
        detach.map(({ nodeId, deviceId }) =>
          this.deps.detachOn(nodeId, deviceId).catch((err: unknown) => {
            this.deps.logger.warn('placement reconcile: detach failed', {
              tags: { nodeId, deviceId },
              meta: { error: errMsg(err) },
            })
          }),
        ),
      )
    }

    if (dropStaleAssignment.length > 0) {
      this.deps.logger.info('placement reconcile: dropping stale assignments', {
        meta: { deviceIds: dropStaleAssignment },
      })
      let standingDrops = 0
      for (const deviceId of dropStaleAssignment) {
        this.deps.ledger.dropAssignment(deviceId, 'silent')
        if (this.deps.isSessionCamera(deviceId)) {
          // A stale on-motion assignment just means the session already
          // ended (e.g. teardown raced a node hiccup) — deregister and
          // stop. The next motion event re-dispatches; force-retrying
          // here would standing-attach a camera that's supposed to be
          // idle (Task 3, Phase 3 slice 2).
          this.deps.deregisterSession(deviceId)
        } else {
          standingDrops++
        }
      }
      // Re-establish standing (always-on) drops via the additive path on
      // the next debounced pass.
      if (standingDrops > 0) this.schedulePendingRetry()
    }
  }

  // ── Pending / stranded retry sweep (T3) ──────────────────────────────

  /**
   * Bounded per-device retry of `handleDeviceRegistered` after a TRANSIENT
   * profile-slot read failure. The read (`listAllProfileSlots`) can time out
   * during a broker (re)start; we must neither stop a running camera nor
   * leave a not-yet-started camera stranded — so re-run the registration
   * handler with exponential backoff until the read succeeds or the budget
   * is exhausted. Reset on any successful read (`clearSlotReadRetry`).
   *
   * Public — called from the addon's C14 `handleDeviceRegistered`/
   * `handleSettingsChanged` (`this.reconcile!.scheduleSlotReadRetry(deviceId)`).
   */
  scheduleSlotReadRetry(deviceId: number): void {
    const attempts = this.slotReadRetryAttempts.get(deviceId) ?? 0
    if (attempts >= ReconcileController.SLOT_READ_MAX_RETRIES) {
      this.deps.logger.warn('slot-read retry budget exhausted — leaving detection as-is', {
        tags: { deviceId },
      })
      this.slotReadRetryAttempts.delete(deviceId)
      return
    }
    const existing = this.slotReadRetryTimers.get(deviceId)
    if (existing) clearTimeout(existing)
    const delay = ReconcileController.SLOT_READ_RETRY_BASE_MS * 2 ** attempts
    this.slotReadRetryAttempts.set(deviceId, attempts + 1)
    const timer = setTimeout(() => {
      this.slotReadRetryTimers.delete(deviceId)
      void this.deps.handleDeviceRegistered(deviceId).catch((err: unknown) => {
        this.deps.logger.debug('slot-read retry: handleDeviceRegistered failed', {
          tags: { deviceId },
          meta: { error: errMsg(err) },
        })
      })
    }, delay)
    if (typeof timer === 'object' && timer !== null && 'unref' in timer) timer.unref()
    this.slotReadRetryTimers.set(deviceId, timer)
  }

  /**
   * Cancel any pending slot-read retry + reset the budget for a device.
   * Public — called from the addon's C14 handlers (see {@link scheduleSlotReadRetry}).
   */
  clearSlotReadRetry(deviceId: number): void {
    const existing = this.slotReadRetryTimers.get(deviceId)
    if (existing) {
      clearTimeout(existing)
      this.slotReadRetryTimers.delete(deviceId)
    }
    this.slotReadRetryAttempts.delete(deviceId)
  }

  /**
   * Coalesce bursts of capacity/eligibility/readiness signals into a single
   * `retryPendingDispatches` pass. Mirrors `scheduleReconcile`, but on a
   * dedicated (longer) debounce so a raise-cap / node-connect flurry doesn't
   * hammer `dispatchCamera`.
   *
   * Public — called from `applyRuntimeSettings`/`handleNodeConnect`/many
   * other C14 + node-lifecycle call sites via `this.reconcile!.schedulePendingRetry()`.
   */
  schedulePendingRetry(): void {
    if (this.pendingRetryDebounceTimer !== null) clearTimeout(this.pendingRetryDebounceTimer)
    this.pendingRetryDebounceTimer = setTimeout(() => {
      this.pendingRetryDebounceTimer = null
      void this.retryPendingDispatches()
    }, PENDING_RETRY_DEBOUNCE_MS)
  }

  /**
   * Re-dispatch every KNOWN-but-UNASSIGNED camera. `reconcileDispatch` is
   * additive-only over `cameraConfigs` and never revisits a camera that is
   * tracked but has no live assignment (left pending by over-cap /
   * no-frame-source / load-shed), so those cameras would otherwise stay
   * stranded until an unrelated live event happens to touch them. This sweep
   * closes that gap.
   *
   * `dispatchCamera` re-reads pins, re-balances with the frame-source
   * predicate, and re-returns pending harmlessly when nothing changed —
   * so a no-op sweep is cheap and side-effect-free. Serialized with an
   * in-flight flag + trailing-rerun bit (mirrors `reconcileDispatch`).
   *
   * Public — driven by the addon's periodic `pendingRetryTimer` (T3 safety net).
   */
  async retryPendingDispatches(): Promise<void> {
    if (this.pendingRetryInFlight) {
      this.pendingRetryRerunRequested = true
      return
    }
    // Skip while a full reconcile is mid-flight — it may be attaching the very
    // cameras we'd otherwise double-dispatch.
    if (this.reconcileInFlight) return
    if (!this.deps.api()) return
    this.pendingRetryInFlight = true
    try {
      const known = new Set(this.deps.ledger.listConfigIds())
      const assigned = new Set(this.deps.ledger.listAssignedDeviceIds())
      // Idle on-motion cameras are SUPPOSED to be unassigned between motion
      // events — their "gap" is filled by motion (`handleSessionMotion`),
      // not by this sweep. Excluding them (Task 3, Phase 3 slice 2) stops
      // the sweep from force-dispatching a standing attach onto a session
      // camera. A camera WITH an active session is already in `assigned`,
      // so it was never in `stranded` to begin with — this filter only
      // ever removes idle ones.
      const stranded = computeStrandedDevices(known, assigned).filter(
        (deviceId) => !this.deps.isIdleSessionCamera(deviceId),
      )

      if (stranded.length > 0) {
        const loadShedActive = this.deps.loadShed.isAnyNodeLoadShed()
        let retried = 0
        let stillPending = 0
        for (const deviceId of stranded) {
          // Skip load-shed-stranded cameras while load-shed is still active: the
          // `dispatchCamera` deferral re-checks anyway, so this only avoids log
          // churn during a sustained-load window.
          if (this.deps.ledger.getPendingReason(deviceId) === 'load-shed' && loadShedActive) {
            stillPending++
            continue
          }
          const cfg = this.deps.ledger.getConfig(deviceId)
          if (!cfg) continue
          try {
            const result = await this.deps.redispatchCamera(cfg)
            retried++
            if (result.kind === 'pending') stillPending++
          } catch (err: unknown) {
            this.deps.logger.warn('pending retry: dispatchCamera failed', {
              tags: { deviceId },
              meta: { error: errMsg(err) },
            })
            stillPending++
          }
        }
        this.deps.logger.info('pending retry sweep', {
          meta: { stranded: stranded.length, retried, stillPending },
        })
      }

      // T7: after retrying pending, evaluate the health of REMOTE assignments —
      // a remote runner that accepted an attach but produces nothing (0-fps) or
      // has gone metrics-silent is re-placed (bounded backoff) or, once retries
      // are exhausted, left visibly pending. Runs every tick regardless of
      // whether anything was stranded (a healthy-looking cluster can still have
      // a silently-broken remote camera).
      await this.evaluateRemoteAssignmentHealth()
    } finally {
      this.pendingRetryInFlight = false
      if (this.pendingRetryRerunRequested) {
        this.pendingRetryRerunRequested = false
        this.schedulePendingRetry()
      }
    }
  }

  // ── Remote-assignment health loop (T7) ───────────────────────────────

  /**
   * Evaluate the health of every REMOTE pipeline assignment and act on the
   * cameras the pure `evaluateRemoteHealth` flags. The hub watchdog covers
   * local cameras; this is its remote-node equivalent (gap i). Called from the
   * T3 sweep tick after retrying pending dispatches.
   *
   * Public so `remote-health.spec.ts`'s orchestrator subclass can drive one
   * evaluation pass deterministically (mirrors the `pendingReasons`/
   * `audioSubLocks` test-seam convention in this codebase) without waiting
   * on the periodic timer — reached via the addon's `protected
   * evaluateRemoteAssignmentHealth()` wrapper.
   */
  async evaluateRemoteAssignmentHealth(): Promise<void> {
    if (!this.deps.api()) return
    const actions = evaluateRemoteHealth({
      assignments: this.deps.ledger.assignmentsView(),
      fpsMap: this.deps.loadShed.fpsMapView(),
      activeDeviceIds: new Set(this.deps.activeDeviceIds()),
      localNodeId: this.deps.localNodeId(),
      now: Date.now(),
      opts: DEFAULT_REMOTE_HEALTH_OPTS,
    })
    for (const action of actions) {
      await this.handleRemoteHealthReplace(action)
    }
  }

  /**
   * Re-place a single unhealthy remote camera with bounded per-device backoff.
   * Under budget: detach from the unhealthy node + re-dispatch (inherits the
   * T2 frame-source predicate). Over budget: log an error, drop the dead
   * assignment, and mark the camera `'unhealthy'`-pending for the operator so
   * `getCameraStatus` surfaces it (R2 "bounded-retry ... state visible").
   */
  private async handleRemoteHealthReplace(action: RemoteHealthAction): Promise<void> {
    const { deviceId, why } = action
    const assignment = this.deps.ledger.getAssignment(deviceId)
    if (!assignment) return
    const cfg = this.deps.ledger.getConfig(deviceId)
    if (!cfg) return

    const now = Date.now()
    const prior = this.remoteHealthAttempts.get(deviceId)
    const windowFresh = prior !== undefined && now - prior.windowStart < REMOTE_HEALTH_WINDOW_MS
    const count = windowFresh ? prior.count : 0

    if (count >= REMOTE_HEALTH_MAX_ATTEMPTS) {
      this.deps.logger.error('remote assignment unhealthy — retries exhausted, leaving pending', {
        tags: { deviceId, nodeId: assignment.agentNodeId },
        meta: { why, attempts: count, windowMs: REMOTE_HEALTH_WINDOW_MS },
      })
      // Drop the dead assignment + detach so the camera surfaces as pending.
      this.deps.ledger.dropAssignment(deviceId, 'silent')
      this.deps.ledger.setPendingReason(deviceId, 'unhealthy')
      await this.deps.detachOn(assignment.agentNodeId, deviceId).catch((err: unknown) => {
        this.deps.logger.debug('remote-health exhausted-detach failed', {
          tags: { deviceId },
          meta: { error: errMsg(err) },
        })
      })
      return
    }

    this.remoteHealthAttempts.set(deviceId, {
      count: count + 1,
      windowStart: windowFresh ? prior.windowStart : now,
    })
    this.deps.logger.warn('remote assignment unhealthy — re-placing camera', {
      tags: { deviceId, nodeId: assignment.agentNodeId },
      meta: { why, attempt: count + 1, maxAttempts: REMOTE_HEALTH_MAX_ATTEMPTS },
    })

    // Detach from the unhealthy node, drop the stale assignment, then let
    // `dispatchCamera` re-balance. Dropping first means a pending re-dispatch
    // (no eligible node) leaves the camera correctly UNASSIGNED rather than
    // pointing at a node we just detached from.
    await this.deps.detachOn(assignment.agentNodeId, deviceId).catch((err: unknown) => {
      this.deps.logger.warn('remote-health detach failed', {
        tags: { deviceId },
        meta: { error: errMsg(err) },
      })
    })
    this.deps.ledger.dropAssignment(deviceId, 'silent')
    await this.deps.redispatchCamera(cfg).catch((err: unknown) => {
      this.deps.logger.warn('remote-health re-dispatch failed', {
        tags: { deviceId },
        meta: { error: errMsg(err) },
      })
    })
  }

  /**
   * Cancel every pending timer (reconcile debounce, pending-retry debounce,
   * slot-read retries) and clear the remote-health ledger. Mirrors the
   * former inline `onShutdown` block exactly. Does NOT touch the addon's own
   * `pendingRetryTimer`/`autoRebalanceTimer` periodic intervals — those stay
   * addon-owned fields (mirrors `PlacementService.runAutoRebalance`'s periodic
   * timer, which is also addon-owned even though the method lives on the
   * controller).
   */
  dispose(): void {
    if (this.reconcileTimer !== null) {
      clearTimeout(this.reconcileTimer)
      this.reconcileTimer = null
    }
    if (this.pendingRetryDebounceTimer !== null) {
      clearTimeout(this.pendingRetryDebounceTimer)
      this.pendingRetryDebounceTimer = null
    }
    for (const t of this.slotReadRetryTimers.values()) clearTimeout(t)
    this.slotReadRetryTimers.clear()
    this.slotReadRetryAttempts.clear()
    this.remoteHealthAttempts.clear()
    this.vanishedDevices = new Map()
  }
}
