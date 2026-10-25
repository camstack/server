/**
 * The node benchmark lifecycle (D791) — the orchestrator owns it because it
 * is the placement authority: entering benchmark mode is a placement change,
 * and only the owner of placement can promise to undo it.
 *
 *   start ─► preflight ─► MANIFEST (persisted first) ─► mode on ─► draining
 *        ─► measuring (the node's runner, polled) ─► restoring ─► done | failed | aborted
 *
 * Invariants:
 *  - ONE run cluster-wide; it does not matter which runner the request
 *    reached — the orchestrator drives the target node's runner by nodePin.
 *  - The manifest is written BEFORE anything changes and removed only AFTER
 *    the cluster is restored. Its presence without a live run — at boot, or
 *    on any reconcile tick — means "restore now" (registry-driven, never a
 *    timer or an event that may be lost).
 *  - Restoring always runs (`finally`): mode off, cameras pinned to the node
 *    re-placed, the runner told to stop, the results written, the run
 *    recorded. An abort leaves the cluster as it was.
 *  - Nothing the operator owns is written: no detect flag, no pin, no cap.
 *    Pins are ignored by the mode, never rewritten, so ending the mode IS the
 *    restore of the pins.
 */
import {
  type BenchmarkCameraFacts,
  classifyCamerasForBenchmark,
  errMsg,
  estimateNodeBenchmarkDurationMs,
  type IScopedLogger,
  NODE_BENCHMARK_DEFAULTS,
  type NodeBenchCell,
  type NodeBenchmarkEndReason,
  type NodeBenchmarkManifest,
  type NodeBenchmarkPlan,
  type NodeBenchmarkPlanInput,
  NodeBenchmarkPlanSchema,
  type NodeBenchmarkPreflight,
  type NodeBenchmarkResult,
  type NodeBenchmarkRun,
  type NodeBenchmarkStatus,
  type NodeBenchRunnerInputRaw,
  type NodeBenchRunnerStatus,
  nodeBenchmarkRefusals,
} from '@camstack/types'
import type { NodeBenchmarkPersistence } from './node-benchmark-store.js'

/** How the service drives the node's runner (nodePin'd cap calls in production). */
export interface NodeBenchRunnerClient {
  start(nodeId: string, input: NodeBenchRunnerInputRaw): Promise<void>
  /** null = the runner does not know the run (restarted, or never started it). */
  status(nodeId: string, runId: string): Promise<NodeBenchRunnerStatus | null>
  abort(nodeId: string, runId: string): Promise<void>
}

export interface NodeBenchmarkServiceDeps {
  readonly logger: IScopedLogger
  readonly persistence: NodeBenchmarkPersistence
  readonly runner: NodeBenchRunnerClient
  readonly isNodeOnline: (nodeId: string) => boolean
  readonly listDeviceKeys: (nodeId: string) => Promise<readonly string[]>
  /** Every known camera, read as if no benchmark ran. */
  readonly cameraFacts: () => Promise<readonly BenchmarkCameraFacts[]>
  readonly headroom: (
    nodeId: string,
  ) => Promise<{ readonly sessionsNow: number; readonly otherNodesCapacitySessions: number | null }>
  /** Move the given cameras off the node (a scoped rebalance; eligibility already excludes it). */
  readonly drain: (deviceIds: ReadonlySet<number>) => Promise<void>
  /** Cameras still placed on the node, by the placement ledger and the runner's census. */
  readonly camerasOnNode: (nodeId: string) => Promise<readonly number[]>
  /** Re-place the cameras pinned to the node once the mode is off. */
  readonly restorePins: (deviceIds: ReadonlySet<number>) => Promise<void>
  /** New results were written for this node: recompute what reads them (shares), and log it. */
  readonly onResultsWritten: (nodeId: string) => void
  /** The mode changed: placement reads it on the next decision. */
  readonly onModeChanged?: (nodeId: string | null) => void
  readonly now?: () => number
  readonly newRunId?: () => string
  readonly sleep?: (ms: number) => Promise<void>
  readonly pollIntervalMs?: number
  readonly drainTimeoutMs?: number
  /** Consecutive unknown answers from the runner before the run counts as lost. */
  readonly runnerLostAfter?: number
}

const DEFAULT_POLL_MS = 3000
/** After the deadline the runner gets this long to stop before the restore is forced. */
const DEADLINE_GRACE_MS = 2 * 60_000

/** The node whose duties never stop for a benchmark: its numbers always share the CPU. */
const HUB_NODE_ID = 'hub'

function toRun(manifest: NodeBenchmarkManifest): NodeBenchmarkRun {
  return {
    runId: manifest.runId,
    nodeId: manifest.nodeId,
    state: 'draining',
    plan: manifest.plan,
    startedAtMs: manifest.startedAtMs,
    deadlineAtMs: manifest.deadlineAtMs,
    finishedAtMs: null,
    endReason: null,
    error: null,
    moved: manifest.moved,
    staying: manifest.staying,
    contaminated: manifest.staying.length > 0 || manifest.nodeId === HUB_NODE_ID,
    progress: null,
    resultIds: [],
  }
}

/** Pipeline cells whose requested steps did not all fire measured something else — dropped. */
export function publishableCells(
  cells: readonly NodeBenchCell[],
  requestedSteps: readonly string[],
): { readonly kept: readonly NodeBenchCell[]; readonly unfired: readonly string[] } {
  const unfired = new Set<string>()
  const kept = cells.filter((cell) => {
    if (cell.phase !== 'pipeline') return true
    const missing = requestedSteps.filter((s) => !cell.stepsFired.includes(s))
    for (const s of missing) unfired.add(s)
    return missing.length === 0
  })
  return { kept, unfired: [...unfired].toSorted() }
}

export class NodeBenchmarkService {
  private active: { run: NodeBenchmarkRun; abortRequested: NodeBenchmarkEndReason | null } | null =
    null
  private modeNodeIdValue: string | null = null
  private lastRun: NodeBenchmarkRun | null = null
  private restoring: Promise<void> | null = null

  constructor(private readonly deps: NodeBenchmarkServiceDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  private sleep(ms: number): Promise<void> {
    if (this.deps.sleep) return this.deps.sleep(ms)
    return new Promise((resolve) => {
      const t = setTimeout(resolve, ms)
      t.unref?.()
    })
  }

  /** The node the cluster is in benchmark mode for (null = none). Read by placement. */
  modeNodeId(): string | null {
    return this.modeNodeIdValue
  }

  /** A run is active, or its mode is still on (the restore has not finished). */
  isRunActive(): boolean {
    return this.active !== null || this.modeNodeIdValue !== null || this.restoring !== null
  }

  /** Cameras placed on the node now (standing attaches and running sessions). */
  camerasOn(nodeId: string): Promise<readonly number[]> {
    return this.deps.camerasOnNode(nodeId)
  }

  private setMode(nodeId: string | null): void {
    if (this.modeNodeIdValue === nodeId) return
    this.modeNodeIdValue = nodeId
    this.deps.logger.info(
      nodeId === null ? 'benchmark mode off' : 'benchmark mode on — node out of placement',
      { meta: { nodeId } },
    )
    this.deps.onModeChanged?.(nodeId)
  }

  status(): NodeBenchmarkStatus {
    const run = this.active?.run ?? this.lastRun ?? this.deps.persistence.listRuns()[0] ?? null
    return { modeNodeId: this.modeNodeIdValue, run }
  }

  async preflight(planInput: NodeBenchmarkPlanInput): Promise<NodeBenchmarkPreflight> {
    const plan = NodeBenchmarkPlanSchema.parse(planInput)
    const online = this.deps.isNodeOnline(plan.nodeId)
    const knownDeviceKeys = online ? await this.deps.listDeviceKeys(plan.nodeId) : []
    const { moving, staying } = classifyCamerasForBenchmark(
      plan.nodeId,
      await this.deps.cameraFacts(),
    )
    const headroom = await this.deps.headroom(plan.nodeId)
    const refusals = nodeBenchmarkRefusals({
      plan,
      activeRunNodeId: this.active?.run.nodeId ?? this.modeNodeIdValue,
      online,
      knownDeviceKeys,
      sessionsNow: headroom.sessionsNow,
      otherNodesCapacitySessions: headroom.otherNodesCapacitySessions,
    })
    return {
      nodeId: plan.nodeId,
      online,
      moving,
      staying,
      estimatedDurationMs: estimateNodeBenchmarkDurationMs(plan),
      budgetMs: plan.budgetMinutes * 60_000,
      phases: plan.phases,
      steps: plan.steps,
      devices: plan.devices,
      headroom,
      refusals,
      canStart: refusals.length === 0,
    }
  }

  /** Start a run, or say why not (the preflight with its refusals). */
  async start(
    planInput: NodeBenchmarkPlanInput,
  ): Promise<
    | { readonly kind: 'started'; readonly runId: string }
    | { readonly kind: 'refused'; readonly preflight: NodeBenchmarkPreflight }
  > {
    const preflight = await this.preflight(planInput)
    // Re-checked synchronously after the awaits: two concurrent starts must
    // not both pass the lock.
    if (!preflight.canStart || this.active !== null || this.modeNodeIdValue !== null) {
      return {
        kind: 'refused',
        preflight: preflight.canStart
          ? {
              ...preflight,
              canStart: false,
              refusals: [
                {
                  kind: 'benchmark-active',
                  detail: 'Another benchmark started first — one node at a time.',
                  overridable: false,
                },
              ],
            }
          : preflight,
      }
    }
    const plan: NodeBenchmarkPlan = NodeBenchmarkPlanSchema.parse(planInput)
    const startedAtMs = this.now()
    const manifest: NodeBenchmarkManifest = {
      runId: this.deps.newRunId?.() ?? `nb-${startedAtMs.toString(36)}`,
      nodeId: plan.nodeId,
      startedAtMs,
      deadlineAtMs: startedAtMs + plan.budgetMinutes * 60_000,
      plan,
      moved: preflight.moving.map((c) => c.deviceId),
      staying: preflight.staying.map((c) => c.deviceId),
    }
    const run = toRun(manifest)
    // The lock is taken BEFORE the write so a second start cannot slip in.
    this.active = { run, abortRequested: null }
    try {
      // Persist FIRST: a crash from here on is restored from this row.
      await this.deps.persistence.writeManifest(manifest)
    } catch (err) {
      this.active = null
      throw new Error(
        `node benchmark: could not persist the restore manifest — nothing changed (${errMsg(err)})`,
        { cause: err },
      )
    }
    this.setMode(plan.nodeId)
    this.deps.logger.info('node benchmark started', {
      meta: {
        runId: run.runId,
        nodeId: run.nodeId,
        moving: manifest.moved.length,
        staying: manifest.staying.length,
        deadlineAtMs: manifest.deadlineAtMs,
      },
    })
    void this.execute(manifest)
    return { kind: 'started', runId: run.runId }
  }

  /** Ask the active run to stop; the restore follows. */
  abort(runId: string): { readonly aborted: boolean } {
    if (this.active === null || this.active.run.runId !== runId) return { aborted: false }
    this.active.abortRequested ??= 'operator-abort'
    this.deps.logger.info('node benchmark abort requested', { meta: { runId } })
    return { aborted: true }
  }

  private update(patch: Partial<NodeBenchmarkRun>): void {
    if (this.active === null) return
    this.active = { ...this.active, run: { ...this.active.run, ...patch } }
  }

  private stopReason(manifest: NodeBenchmarkManifest): NodeBenchmarkEndReason | null {
    if (this.active?.abortRequested) return this.active.abortRequested
    if (this.now() >= manifest.deadlineAtMs) return 'deadline'
    if (!this.deps.isNodeOnline(manifest.nodeId)) return 'node-lost'
    return null
  }

  private async drainPhase(
    manifest: NodeBenchmarkManifest,
  ): Promise<NodeBenchmarkEndReason | null> {
    this.update({ state: 'draining' })
    const moved = new Set(manifest.moved)
    if (moved.size > 0) await this.deps.drain(moved)
    const timeout = this.deps.drainTimeoutMs ?? NODE_BENCHMARK_DEFAULTS.drainTimeoutSec * 1000
    const until = this.now() + timeout
    const staying = new Set(manifest.staying)
    for (;;) {
      const stop = this.stopReason(manifest)
      if (stop !== null) return stop
      const left = (await this.deps.camerasOnNode(manifest.nodeId)).filter((id) => !staying.has(id))
      if (left.length === 0) return null
      if (this.now() >= until) {
        this.deps.logger.warn('node benchmark: drain timed out — cameras still on the node', {
          meta: { runId: manifest.runId, nodeId: manifest.nodeId, left },
        })
        return 'drain-timeout'
      }
      // A camera that started a session on the node meanwhile is moved too.
      await this.deps.drain(new Set(left))
      await this.sleep(this.deps.pollIntervalMs ?? DEFAULT_POLL_MS)
    }
  }

  private async measurePhase(manifest: NodeBenchmarkManifest): Promise<{
    readonly reason: NodeBenchmarkEndReason
    readonly status: NodeBenchRunnerStatus | null
  }> {
    this.update({ state: 'measuring' })
    const { plan } = manifest
    await this.deps.runner.start(manifest.nodeId, {
      runId: manifest.runId,
      devices: plan.devices,
      phases: plan.phases,
      steps: plan.steps,
      fpsPerStream: plan.fpsPerStream,
      deadlineAtMs: manifest.deadlineAtMs,
      keepDownloadedModels: plan.keepDownloadedModels,
    })
    let last: NodeBenchRunnerStatus | null = null
    let unknown = 0
    const lostAfter = this.deps.runnerLostAfter ?? 3
    for (;;) {
      await this.sleep(this.deps.pollIntervalMs ?? DEFAULT_POLL_MS)
      let status: NodeBenchRunnerStatus | null = null
      try {
        status = await this.deps.runner.status(manifest.nodeId, manifest.runId)
      } catch (err) {
        this.deps.logger.debug('node benchmark: runner status read failed', {
          meta: { runId: manifest.runId, error: errMsg(err) },
        })
      }
      if (status === null) {
        unknown += 1
        if (!this.deps.isNodeOnline(manifest.nodeId)) return { reason: 'node-lost', status: last }
        if (unknown >= lostAfter) return { reason: 'runner-lost', status: last }
      } else {
        unknown = 0
        last = status
        this.update({
          progress: status.progress,
          contaminated: this.active?.run.contaminated === true || status.activeCameraIds.length > 0,
        })
        if (status.state === 'done') return { reason: 'completed', status }
        if (status.state === 'failed') return { reason: 'failed', status }
        if (status.state === 'aborted') {
          return { reason: this.active?.abortRequested ?? 'deadline', status }
        }
      }
      const stop = this.stopReason(manifest)
      if (stop !== null) {
        await this.deps.runner.abort(manifest.nodeId, manifest.runId).catch(() => undefined)
        // One more read: what the runner finished before it stopped is kept.
        const final = await this.deps.runner
          .status(manifest.nodeId, manifest.runId)
          .catch(() => null)
        return { reason: stop, status: final ?? last }
      }
    }
  }

  private async execute(manifest: NodeBenchmarkManifest): Promise<void> {
    let reason: NodeBenchmarkEndReason = 'failed'
    let status: NodeBenchRunnerStatus | null = null
    let error: string | null = null
    try {
      const drained = await this.drainPhase(manifest)
      if (drained !== null) {
        reason = drained
      } else {
        const measured = await this.measurePhase(manifest)
        reason = measured.reason
        status = measured.status
        if (reason === 'failed') error = status?.error ?? 'the runner failed'
      }
    } catch (err) {
      reason = this.active?.abortRequested ?? 'failed'
      error = errMsg(err)
      this.deps.logger.warn('node benchmark failed', {
        meta: { runId: manifest.runId, error },
      })
      await this.deps.runner.abort(manifest.nodeId, manifest.runId).catch(() => undefined)
    } finally {
      await this.restore(manifest, reason, status, error)
    }
  }

  /**
   * Leave benchmark mode and put the cluster back. Idempotent; every step is
   * attempted whatever the previous one did.
   */
  private async restore(
    manifest: NodeBenchmarkManifest,
    reason: NodeBenchmarkEndReason,
    status: NodeBenchRunnerStatus | null,
    error: string | null,
  ): Promise<void> {
    this.update({ state: 'restoring' })
    this.setMode(null)
    const pinnedBack = new Set(manifest.moved)
    try {
      if (pinnedBack.size > 0) await this.deps.restorePins(pinnedBack)
    } catch (err) {
      this.deps.logger.warn(
        'node benchmark: re-placing the moved cameras failed — the reconcile retries',
        {
          meta: { runId: manifest.runId, error: errMsg(err) },
        },
      )
    }
    const finishedAtMs = this.now()
    const base = this.active?.run ?? toRun(manifest)
    const contaminated = base.contaminated || (status?.activeCameraIds.length ?? 0) > 0
    const { kept, unfired } = publishableCells(status?.cells ?? [], manifest.plan.steps)
    const rows: NodeBenchmarkResult[] = kept.map((cell, i) => ({
      id: `${manifest.runId}:${i}`,
      runId: manifest.runId,
      nodeId: manifest.nodeId,
      cell,
      fpsPerStream: manifest.plan.fpsPerStream,
      fingerprint: status?.fingerprint ?? null,
      clip: status?.clip ?? null,
      contaminated,
      stayingCameras: manifest.staying,
      partialRun: reason !== 'completed',
      measuredAtMs: finishedAtMs,
    }))
    const notes = [
      error,
      unfired.length > 0
        ? `Not stored: the pipeline measurement's steps ${unfired.join(', ')} never produced a result on the clip.`
        : null,
    ].filter((n): n is string => n !== null)
    try {
      if (rows.length > 0) await this.deps.persistence.writeResults(rows)
    } catch (err) {
      notes.push(`Results not stored: ${errMsg(err)}`)
    }
    const run: NodeBenchmarkRun = {
      ...base,
      state: reason === 'completed' ? 'done' : reason === 'failed' ? 'failed' : 'aborted',
      finishedAtMs,
      endReason: reason,
      error: notes.length > 0 ? notes.join(' ') : null,
      contaminated,
      resultIds: rows.map((r) => r.id),
    }
    try {
      await this.deps.persistence.recordRun(run)
    } catch (err) {
      this.deps.logger.warn('node benchmark: run record not stored', {
        meta: { runId: run.runId, error: errMsg(err) },
      })
    }
    // Removed LAST: until here a crash still restores from it.
    await this.deps.persistence.clearManifest().catch(() => undefined)
    this.lastRun = run
    this.active = null
    this.deps.logger.info('node benchmark ended', {
      meta: {
        runId: run.runId,
        nodeId: run.nodeId,
        endReason: reason,
        results: rows.length,
        contaminated,
        error: run.error,
      },
    })
    if (rows.length > 0) this.deps.onResultsWritten(manifest.nodeId)
  }

  /**
   * Registry-driven recovery: a manifest with no live run means the run died
   * with its process (hub restart) — restore now. A live run far past its
   * deadline is forced out of the mode. Called at boot and on every tick.
   */
  async reconcile(trigger: 'boot' | 'tick'): Promise<void> {
    if (this.restoring !== null) return this.restoring
    const work = async (): Promise<void> => {
      if (this.active !== null) {
        const { run } = this.active
        if (this.now() > run.deadlineAtMs + DEADLINE_GRACE_MS && this.modeNodeIdValue !== null) {
          this.deps.logger.warn(
            'node benchmark: past its deadline and still not restored — forcing benchmark mode off',
            {
              meta: { runId: run.runId, nodeId: run.nodeId },
            },
          )
          this.active.abortRequested ??= 'deadline'
          this.setMode(null)
        }
        return
      }
      if (this.modeNodeIdValue !== null) this.setMode(null)
      const manifest = this.deps.persistence.readManifest()
      if (manifest === null) return
      const known = this.deps.persistence.listRuns().find((r) => r.runId === manifest.runId)
      if (known !== undefined && known.finishedAtMs !== null) {
        await this.deps.persistence.clearManifest().catch(() => undefined)
        return
      }
      this.deps.logger.warn('node benchmark: restore owed from an interrupted run', {
        meta: { runId: manifest.runId, nodeId: manifest.nodeId, trigger },
      })
      await this.deps.runner.abort(manifest.nodeId, manifest.runId).catch(() => undefined)
      this.active = { run: toRun(manifest), abortRequested: 'hub-restart' }
      await this.restore(manifest, trigger === 'boot' ? 'hub-restart' : 'runner-lost', null, null)
    }
    this.restoring = work().finally(() => {
      this.restoring = null
    })
    return this.restoring
  }
}
