/**
 * `PlacementLedger` — the single owner of the shared placement state (C3/C6/
 * C7/C8/C10/C12/C13/C15/C16 "shared-state seams", S6 extraction).
 *
 * Four maps that every stateful placement subsystem consults used to live as
 * raw fields on the addon class: `assignments`, `cameraConfigs`,
 * `pendingReasons`, `dispatchingDevices`. Every caller reached in and
 * mutated them directly, which is exactly the seam that made every other
 * controller extraction (topology, load, audio, session…) impossible without
 * N modules sharing raw `Map`/`Set` references. This class gives that shared
 * state ONE owner behind a narrow method surface — extracted verbatim
 * (mechanical, zero logic change) from `index.ts`.
 *
 * `recordAssignment`/`dropAssignment` fold in the event-emitting bodies of
 * the former private `recordAssignment`/`emitUnassigned` methods —
 * `dropAssignment(deviceId, 'unassigned')` reproduces the exact
 * `assignments.delete(deviceId); emitUnassigned(assignment, 'unassigned')`
 * pair (delete always happens; the event fires iff an assignment existed);
 * `dropAssignment(deviceId, 'silent')` reproduces every call site that just
 * did `this.assignments.delete(deviceId)` with no event (failover cleanup,
 * remote-health replace, session teardown).
 *
 * Iteration accessors return SNAPSHOT arrays (`assignmentEntries` /
 * `configEntries`), not live Map/Set references, so a caller that deletes
 * the current entry mid-loop (a common pattern in the code being ported)
 * can never trip a "modified during iteration" concern — behaviorally
 * identical to a `for...of` over a live `Map` when the loop body never adds
 * new keys, which none of the ported call sites do. `assignmentsView()` is
 * the one exception — it returns the LIVE map by reference, because the
 * pure `evaluateRemoteHealth` (`remote-health.ts`) wants `ReadonlyMap`
 * input and never mutates it.
 */
import type {
  PipelineAssignment,
  PipelineCameraAssignmentPayload,
  RunnerCameraConfig,
} from '@camstack/types'
import { createEvent, EventCategory, type IEventBus, type IScopedLogger } from '@camstack/types'

/** Why a camera is currently unassigned (pending). */
export type PendingReason =
  | 'over-cap'
  | 'no-frame-source'
  | 'load-shed'
  | 'unhealthy'
  /** A re-place found no cached catalog for the node it chose (D650). */
  | `catalog-unavailable:${string}`
  /** A re-place found no answered device probe / pool health for the node (D650). */
  | `device-health-unavailable:${string}`
  /** The elected device cannot run a gated-on root of the camera (D650). */
  | `root-unrunnable:${string}`

/** RAII-style guard returned by {@link PlacementLedger.markDispatching}. */
export interface Disposable {
  readonly dispose: () => void
}

export interface PlacementLedgerDeps {
  readonly eventBus: IEventBus
  readonly logger: IScopedLogger
}

export class PlacementLedger {
  /** In-memory assignment map — mirrored into events + per-device settings for the pin. */
  private readonly assignments = new Map<number, PipelineAssignment>()
  /** Most recent RunnerCameraConfig per device — used by rebalance + re-dispatch. */
  private readonly cameraConfigs = new Map<number, RunnerCameraConfig>()
  /**
   * Why a camera is currently unassigned (pending), keyed by deviceId. Set on
   * every pending placement path (over-cap, no-frame-source, load-shed) and
   * cleared when the camera is (re)assigned or released.
   */
  private readonly pendingReasons = new Map<number, PendingReason>()
  /**
   * Devices whose placement is mid-flight (between attach and recordAssignment).
   * The subtractive attachment reconcile skips these so a detach of an
   * "orphan" can never race a dispatch/migration in progress.
   */
  private readonly dispatchingDevices = new Set<number>()

  constructor(private readonly deps: PlacementLedgerDeps) {}

  // ── Assignments ──────────────────────────────────────────────────────

  getAssignment(deviceId: number): PipelineAssignment | null {
    return this.assignments.get(deviceId) ?? null
  }

  hasAssignment(deviceId: number): boolean {
    return this.assignments.has(deviceId)
  }

  listAssignments(): readonly PipelineAssignment[] {
    return [...this.assignments.values()]
  }

  listAssignedDeviceIds(): readonly number[] {
    return [...this.assignments.keys()]
  }

  /** Snapshot `[deviceId, assignment]` pairs — safe to mutate the ledger while iterating the result. */
  assignmentEntries(): ReadonlyArray<readonly [number, PipelineAssignment]> {
    return [...this.assignments.entries()]
  }

  /** Live read-only view — for pure-function inputs that want `ReadonlyMap` semantics (e.g. `evaluateRemoteHealth`). */
  assignmentsView(): ReadonlyMap<number, PipelineAssignment> {
    return this.assignments
  }

  get assignmentCount(): number {
    return this.assignments.size
  }

  /** Record a placement decision. Mirrors the former `recordAssignment` body exactly, incl. the event emit + pendingReasons clear. */
  recordAssignment(
    deviceId: number,
    agentNodeId: string,
    reason: PipelineAssignment['reason'],
    pinned: boolean,
  ): void {
    const assignment: PipelineAssignment = {
      deviceId,
      agentNodeId,
      pinned,
      reason,
      assignedAt: Date.now(),
    }
    this.assignments.set(deviceId, assignment)
    // Camera is now placed — clear any stale pending reason.
    this.pendingReasons.delete(deviceId)

    const payload: PipelineCameraAssignmentPayload = {
      deviceId,
      agentNodeId,
      pinned,
      reason,
    }
    this.deps.eventBus.emit(
      createEvent(
        EventCategory.PipelineCameraAssigned,
        { type: 'device', id: deviceId, nodeId: agentNodeId },
        payload,
      ),
    )
  }

  /**
   * Drop an assignment. Always deletes the map entry (mirrors every prior
   * unconditional `this.assignments.delete(deviceId)` call site).
   * `emit: 'unassigned'` additionally fires `PipelineCameraUnassigned` —
   * but ONLY when an assignment existed to drop (mirrors the former
   * `if (current) { ...; emitUnassigned(current, 'unassigned') }` guard).
   * `emit: 'silent'` mirrors every call site that dropped the map entry
   * with no event (failover cleanup, remote-health replace, session
   * teardown — the M1 "symmetry with scheduleSessionTeardown" note).
   */
  dropAssignment(deviceId: number, emit: 'unassigned' | 'silent'): void {
    const assignment = this.assignments.get(deviceId)
    this.assignments.delete(deviceId)
    if (emit === 'unassigned' && assignment) {
      const payload: PipelineCameraAssignmentPayload = {
        deviceId: assignment.deviceId,
        agentNodeId: assignment.agentNodeId,
        pinned: assignment.pinned,
        reason: 'unassigned',
      }
      this.deps.eventBus.emit(
        createEvent(
          EventCategory.PipelineCameraUnassigned,
          { type: 'device', id: assignment.deviceId, nodeId: assignment.agentNodeId },
          payload,
        ),
      )
    }
  }

  /** Test-seam: raw assignment write (no event emit, no pendingReasons clear) — mirrors a direct `Map.set` on the pre-ledger `assignments` field, used by specs that stage state directly (e.g. an aged `assignedAt` to simulate past-grace). */
  seedAssignment(deviceId: number, assignment: PipelineAssignment): void {
    this.assignments.set(deviceId, assignment)
  }

  // ── Camera configs ───────────────────────────────────────────────────

  getConfig(deviceId: number): RunnerCameraConfig | null {
    return this.cameraConfigs.get(deviceId) ?? null
  }

  hasConfig(deviceId: number): boolean {
    return this.cameraConfigs.has(deviceId)
  }

  setConfig(deviceId: number, config: RunnerCameraConfig): void {
    this.cameraConfigs.set(deviceId, config)
  }

  deleteConfig(deviceId: number): void {
    this.cameraConfigs.delete(deviceId)
  }

  listConfigIds(): readonly number[] {
    return [...this.cameraConfigs.keys()]
  }

  /** Snapshot `[deviceId, config]` pairs — safe to mutate the ledger while iterating the result. */
  configEntries(): ReadonlyArray<readonly [number, RunnerCameraConfig]> {
    return [...this.cameraConfigs.entries()]
  }

  get configCount(): number {
    return this.cameraConfigs.size
  }

  // ── Pending reasons ──────────────────────────────────────────────────

  getPendingReason(deviceId: number): PendingReason | undefined {
    return this.pendingReasons.get(deviceId)
  }

  setPendingReason(deviceId: number, reason: PendingReason): void {
    this.pendingReasons.set(deviceId, reason)
  }

  clearPendingReason(deviceId: number): void {
    this.pendingReasons.delete(deviceId)
  }

  hasPending(deviceId: number): boolean {
    return this.pendingReasons.has(deviceId)
  }

  listPending(): ReadonlyArray<readonly [number, PendingReason]> {
    return [...this.pendingReasons.entries()]
  }

  // ── In-flight dispatch guard ─────────────────────────────────────────

  /**
   * Mark `deviceId` as mid-flight (between attach and `recordAssignment`) so
   * the subtractive attachment reconcile can't mistake it for an orphan.
   * Mirrors the `dispatchingDevices.add(id); try {...} finally {
   * dispatchingDevices.delete(id) }` pairs — call `.dispose()` in the
   * `finally` block.
   */
  markDispatching(deviceId: number): Disposable {
    this.dispatchingDevices.add(deviceId)
    let released = false
    return {
      dispose: () => {
        if (released) return
        released = true
        this.dispatchingDevices.delete(deviceId)
      },
    }
  }

  isDispatching(deviceId: number): boolean {
    return this.dispatchingDevices.has(deviceId)
  }

  /** Feeds the pure `reconcilePlacement` (`dispatch-reconcile.ts`). */
  snapshotForReconcile(): {
    readonly assignedNodeById: ReadonlyMap<number, string>
    readonly dispatching: ReadonlySet<number>
  } {
    const assignedNodeById = new Map<number, string>()
    for (const [deviceId, assignment] of this.assignments) {
      assignedNodeById.set(deviceId, assignment.agentNodeId)
    }
    return { assignedNodeById, dispatching: new Set(this.dispatchingDevices) }
  }

  // ── Disposal ──────────────────────────────────────────────────────────

  /** Mirrors the former `onShutdown` clears (`cameraConfigs.clear()` + `assignments.clear()`); also clears `pendingReasons`/`dispatchingDevices` for symmetry — neither was observable post-shutdown before, so this is not a behavior change. */
  dispose(): void {
    this.cameraConfigs.clear()
    this.assignments.clear()
    this.pendingReasons.clear()
    this.dispatchingDevices.clear()
  }
}
