/**
 * `NodeStressController` — the impure half of `node-stress.ts`.
 *
 * It owns three things and nothing else: the per-camera sample ring, the
 * per-node state carriers, and the move history the anti-flap guards read. All
 * of the reasoning lives in the pure module; this class collects, calls, logs
 * and — only in `failover` mode — applies.
 *
 * ## Modes, and why the default acts
 *
 * `off` does nothing. `observe` computes and LOGS the verdict. `failover` (the
 * default) additionally moves one camera at a time under the guards.
 *
 * `observe` was the default only while the thresholds were being measured on
 * this fleet. The stress history is now recorded (device-history series
 * `node-score` and friends) and saturation is rare there, so balancing is
 * automatic; the guards (per-camera cooldown, no return to the node a camera
 * just left, 4 moves an hour cluster-wide, never a pause) bound the churn.
 *
 * ## Every line carries the node, and a camera line carries `tags.deviceId`
 *
 * The question a stress report always gets is "why is 102 worse than 101" (or,
 * here, "why is the Mac worse than the hub"), and a line that cannot be grouped
 * cannot answer it.
 */
import type { CameraMetrics, RunnerCameraConfig } from '@camstack/types'
import { errMsg, type IScopedLogger } from '@camstack/types'
import {
  type CameraStressSample,
  DEFAULT_NODE_STRESS_THRESHOLDS,
  DEFAULT_STRESS_FAILOVER_GUARDS,
  evaluateNodeStress,
  type NodeStressInput,
  type NodeStressMemory,
  type NodeStressSignals,
  type NodeStressState,
  type NodeStressThresholds,
  type NodeStressVerdict,
  planStressFailover,
  reduceNodeStress,
  type StressFailoverCandidate,
  type StressFailoverGuards,
  type StressFailoverHistoryEntry,
} from './node-stress.js'
import type { NodeStressHistoryProducer } from './node-stress-history-producer.js'
import type { NodeStressMoveLedger } from './node-stress-move-ledger.js'
import type { NodeTopologyService } from './node-topology.js'
import type { PipelineSettingsStore } from './pipeline-settings-store.js'
import type { PlacementLedger } from './placement-ledger.js'

/** What the controller is allowed to do. */
export type NodeStressMode = 'off' | 'observe' | 'failover'

/** Narrow an unknown settings value to a {@link NodeStressMode}. */
export function parseNodeStressMode(value: unknown): NodeStressMode | null {
  return value === 'off' || value === 'observe' || value === 'failover' ? value : null
}

/** The mode a store with nothing set resolves to — move one camera off a saturated node, under the guards. */
export const DEFAULT_NODE_STRESS_MODE: NodeStressMode = 'failover'

/** One camera's last observation, kept until it goes stale. */
interface CameraSampleEntry {
  readonly nodeId: string
  readonly metrics: CameraMetrics
  readonly at: number
  readonly previousDroppedFrames: number | null
  readonly previousAt: number | null
}

export interface NodeStressControllerDeps {
  readonly ledger: PlacementLedger
  /**
   * The DURABLE move history the anti-flap guards read (cooldown, return ban,
   * the 4-moves/hour budget). Required, not optional: a controller constructed
   * without it would silently grant a fresh budget on every restart, which is
   * the exact bug `node-stress-move-ledger.ts` exists to close.
   */
  readonly moves: NodeStressMoveLedger
  /**
   * Five-minute long-term statistics. Optional so a test harness that has no
   * store still exercises the sweep — but in production it is the whole reason
   * `observe` mode stops writing only to the log.
   */
  readonly lts?: NodeStressHistoryProducer
  readonly topology: NodeTopologyService
  readonly settingsStore: PipelineSettingsStore
  readonly logger: IScopedLogger
  /** Thin seam onto `PlacementService.attachOn` — same shape `LoadShedController` uses. */
  readonly attach: (nodeId: string, config: RunnerCameraConfig) => Promise<void>
  /** Thin seam onto `PlacementService.detachOn`. */
  readonly detach: (nodeId: string, deviceId: number) => Promise<void>
  readonly readPipelinePin: (deviceId: number) => Promise<string | null>
  /** Live read accessor for the addon's in-memory global settings snapshot. */
  readonly readGlobalSettings: () => Record<string, unknown>
  /**
   * The effective node shares when sessions are placed by share, else null
   * (D750). With shares, a failover target is the healthy node furthest below
   * its share — never one at or over it, never a stressed one.
   */
  readonly readFailoverShares?: () => Promise<Readonly<Record<string, number>> | null>
  /** Clock seam for tests. */
  readonly now?: () => number
}

export class NodeStressController {
  /** How often the sweep evaluates every node. */
  private static readonly SWEEP_INTERVAL_MS = 15_000
  /**
   * A sample older than this is not evidence about NOW. Three sweeps: long
   * enough that one missed metrics snapshot does not blank a node, short enough
   * that a detached camera stops counting quickly.
   */
  private static readonly SAMPLE_TTL_MS = 45_000
  /** Move history is only read inside the longest guard window; drop the rest. */
  private static readonly HISTORY_TTL_MS = 2 * 60 * 60_000
  /**
   * Heartbeat cadence. The controller only logs TRANSITIONS, so a healthy
   * cluster is indistinguishable from a dead sweep — and on 2026-08-12 the
   * observe path did produce zero lines for a whole night, which had to be
   * chased by hand to decide whether it meant "quiet" or "not running". One
   * line an hour with every node's score settles it, and the FIRST sweep emits
   * one immediately so a restart is visible at once.
   */
  private static readonly HEARTBEAT_MS = 60 * 60_000

  private readonly samples = new Map<number, CameraSampleEntry>()
  private readonly memories = new Map<string, NodeStressMemory>()
  /** When the last heartbeat went out. `null` ⇒ the next sweep emits one. */
  private lastHeartbeatAt: number | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  /** One move at a time, cluster-wide — a second sweep must not stack on it. */
  private moveInFlight = false

  constructor(private readonly deps: NodeStressControllerDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  private thresholds(): NodeStressThresholds {
    return DEFAULT_NODE_STRESS_THRESHOLDS
  }

  private guards(): StressFailoverGuards {
    return DEFAULT_STRESS_FAILOVER_GUARDS
  }

  /** The configured mode, defaulting to {@link DEFAULT_NODE_STRESS_MODE}. */
  mode(): NodeStressMode {
    const cfg = this.deps.readGlobalSettings() ?? {}
    return parseNodeStressMode(cfg.nodeStressMode) ?? DEFAULT_NODE_STRESS_MODE
  }

  // ── Collection ────────────────────────────────────────────────────────

  /**
   * Record one camera metrics snapshot. Shares the `PipelineCameraMetricsSnapshot`
   * subscription with `LoadShedController.noteMetrics` — this class keeps the
   * fields that one throws away (queue depth, dropped frames) plus the previous
   * dropped counter, so the pure reducer can derive a RATE without reading a
   * clock itself.
   */
  noteMetrics(deviceId: number, nodeId: string | undefined, metrics: CameraMetrics): void {
    const prior = this.samples.get(deviceId)
    const at = this.now()
    this.samples.set(deviceId, {
      nodeId: nodeId ?? 'hub',
      metrics,
      at,
      previousDroppedFrames: prior?.metrics.droppedFrames ?? null,
      previousAt: prior?.at ?? null,
    })
  }

  /** Drop a permanently-removed device so it can never age into a verdict. */
  forgetDevice(deviceId: number): void {
    this.samples.delete(deviceId)
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────

  /**
   * Recover the move history from disk BEFORE the first sweep can act.
   *
   * Best-effort by construction (the ledger keeps whatever it already has on a
   * read failure), and the count is logged out loud: a restart that recovers 0
   * moves while the operator remembers three is the line that says the budget
   * has been reset.
   */
  async hydrate(): Promise<void> {
    const recovered = await this.deps.moves.load()
    this.deps.logger.info('node-stress move history recovered', { meta: { moves: recovered } })
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      void this.sweep().catch((err: unknown) => {
        this.deps.logger.warn('node-stress sweep failed', { meta: { error: errMsg(err) } })
      })
    }, NodeStressController.SWEEP_INTERVAL_MS)
  }

  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.samples.clear()
    this.memories.clear()
    // The move history is deliberately NOT cleared. It is the thing that must
    // outlive this process; wiping it here would re-create the free-budget bug
    // one `dispose()`/re-init cycle at a time.
  }

  // ── Queries (UI / diagnostics) ────────────────────────────────────────

  /** The last computed state per node — empty before the first sweep. */
  statesView(): ReadonlyMap<string, NodeStressState> {
    return new Map([...this.memories].map(([nodeId, m]) => [nodeId, m.state] as const))
  }

  /** The durable move history, newest first — the guards' own evidence, so an
   *  operator asking "why did nothing move" can read the budget. */
  historyView(): readonly StressFailoverHistoryEntry[] {
    return this.deps.moves.entries().toSorted((a, b) => b.at - a.at)
  }

  /**
   * The per-node stress signals as of `now`, for the LTS aggregator and for
   * diagnostics. Computed from the same live samples the sweep uses, so a
   * chart can never disagree with a verdict.
   */
  signalsView(now: number): ReadonlyMap<string, NodeStressSignals> {
    return new Map(this.buildInputs(now).map((input) => [input.nodeId, input.signals] as const))
  }

  // ── The sweep ─────────────────────────────────────────────────────────

  /** Group live samples by node and reduce each group. Exposed for tests. */
  buildInputs(now: number): readonly NodeStressInput[] {
    const byNode = new Map<string, CameraStressSample[]>()
    for (const [deviceId, entry] of this.samples) {
      if (now - entry.at > NodeStressController.SAMPLE_TTL_MS) continue
      const list = byNode.get(entry.nodeId) ?? []
      list.push({
        deviceId,
        active: entry.metrics.phase === 'active',
        configuredFps: entry.metrics.configuredFps,
        actualFps: entry.metrics.actualFps,
        queueDepth: entry.metrics.queueDepth,
        droppedFrames: entry.metrics.droppedFrames,
        previousDroppedFrames: entry.previousDroppedFrames,
        sinceMs: entry.previousAt === null ? 0 : entry.at - entry.previousAt,
      })
      byNode.set(entry.nodeId, list)
    }
    return [...byNode].map(([nodeId, list]) => ({ nodeId, signals: reduceNodeStress(list) }))
  }

  async sweep(): Promise<void> {
    const mode = this.mode()
    if (mode === 'off') return
    const now = this.now()
    const verdicts = evaluateNodeStress(
      this.memories,
      this.buildInputs(now),
      now,
      this.thresholds(),
    )
    for (const v of verdicts) {
      this.memories.set(v.nodeId, v.memory)
      // EVERY sweep contributes a sample, not only a transition: the point of
      // `observe` is a distribution to choose a threshold from, and a series
      // that only records the moments a threshold was already crossed cannot
      // tell anyone where to put it.
      this.deps.lts?.noteSignals(v.nodeId, v.signals, now)
      if (v.changed) this.logTransition(v)
    }
    this.maybeHeartbeat(mode, verdicts, now)
    if (mode !== 'failover') return
    await this.actOn(verdicts, now)
  }

  /**
   * "Still watching, and here is what I see." Emitted on the first sweep and
   * then hourly. Deliberately INFO and deliberately one line for the whole
   * cluster: its job is to make silence mean something, not to be a metrics
   * feed.
   */
  private maybeHeartbeat(
    mode: NodeStressMode,
    verdicts: readonly NodeStressVerdict[],
    now: number,
  ): void {
    const due =
      this.lastHeartbeatAt === null ||
      now - this.lastHeartbeatAt >= NodeStressController.HEARTBEAT_MS
    if (!due) return
    this.lastHeartbeatAt = now
    this.deps.logger.info(`node-stress ${mode} active`, {
      meta: {
        mode,
        nodes: verdicts.map((v) => ({
          nodeId: v.nodeId,
          state: v.state,
          score: Number(v.signals.score.toFixed(3)),
          queuePressure: Number(v.signals.queuePressure.toFixed(3)),
          dropRatio: Number(v.signals.dropRatio.toFixed(3)),
          fpsDeficit: Number(v.signals.fpsDeficit.toFixed(3)),
        })),
      },
    })
  }

  private logTransition(v: NodeStressVerdict): void {
    const meta = {
      nodeId: v.nodeId,
      state: v.state,
      score: Number(v.signals.score.toFixed(3)),
      queuePressure: Number(v.signals.queuePressure.toFixed(3)),
      dropRatio: Number(v.signals.dropRatio.toFixed(3)),
      fpsDeficit: Number(v.signals.fpsDeficit.toFixed(3)),
      deficitCorroborated: v.signals.deficitCorroborated,
    }
    if (v.state === 'ok') {
      this.deps.logger.info('node stress cleared', { tags: { nodeId: v.nodeId }, meta })
      return
    }
    this.deps.logger.warn(`node is ${v.state}`, { tags: { nodeId: v.nodeId }, meta })
  }

  /**
   * Plan and apply at most one move. Every non-move outcome is LOGGED — a
   * branch that drops work silently reads as "never happened", and "the node
   * was saturated and nothing moved" is precisely the state an operator will
   * ask about tomorrow.
   */
  private async actOn(verdicts: readonly NodeStressVerdict[], now: number): Promise<void> {
    if (this.moveInFlight) return
    if (!verdicts.some((v) => v.state === 'saturated')) return

    // Drop moves no guard can read any more, then read what remains. The prune
    // is behind the read on purpose: a slow delete must never delay a verdict.
    void this.deps.moves.pruneOlderThan(now - NodeStressController.HISTORY_TTL_MS)
    const history = this.deps.moves
      .entries()
      .filter((h) => now - h.at < NodeStressController.HISTORY_TTL_MS)
    const candidates = await this.collectCandidates(now)
    const shares = (await this.deps.readFailoverShares?.()) ?? null
    const plan = planStressFailover(
      {
        verdicts,
        candidates,
        history,
        nodeCaps: await this.deps.settingsStore.buildNodeCaps(),
        attachedByNode: this.attachedByNode(),
        ...(shares !== null ? { shares } : {}),
      },
      now,
      this.guards(),
    )

    if (plan.kind === 'hold') {
      this.deps.logger.warn('node saturated — no failover applied', {
        tags: {
          nodeId: plan.nodeId ?? '',
          ...(plan.deviceId !== undefined ? { deviceId: plan.deviceId } : {}),
        },
        meta: {
          reason: plan.reason,
          rule: shares !== null ? 'share-deficit' : 'fewest-cameras',
          ...(plan.reason === 'no-target' && shares !== null
            ? { why: 'no healthy node below its share can take it' }
            : {}),
        },
      })
      return
    }

    const config = this.deps.ledger.getConfig(plan.deviceId)
    if (!config) {
      this.deps.logger.warn('node stress failover: attach config vanished — not moving', {
        tags: { deviceId: plan.deviceId, nodeId: plan.fromNodeId },
      })
      return
    }

    this.moveInFlight = true
    try {
      await this.deps.detach(plan.fromNodeId, plan.deviceId)
      await this.deps.attach(plan.toNodeId, config)
      this.deps.ledger.recordAssignment(plan.deviceId, plan.toNodeId, 'rebalance', false)
      // Durable, and only on SUCCESS — see `node-stress-move-ledger.ts`.
      this.deps.moves.record({ deviceId: plan.deviceId, fromNodeId: plan.fromNodeId, at: now })
      this.deps.logger.warn('node stress failover: camera relocated', {
        tags: { deviceId: plan.deviceId, nodeId: plan.fromNodeId },
        meta: {
          from: plan.fromNodeId,
          to: plan.toNodeId,
          fromScore: Number(plan.fromScore.toFixed(3)),
          toScore: Number(plan.toScore.toFixed(3)),
        },
      })
    } catch (err: unknown) {
      // The move is recorded ONLY on success: a failed relocation must not
      // burn the device's cooldown, or one flaky attach silently disables
      // failover for that camera for ten minutes.
      this.deps.logger.warn('node stress failover: relocation failed', {
        tags: { deviceId: plan.deviceId, nodeId: plan.fromNodeId },
        meta: { from: plan.fromNodeId, to: plan.toNodeId, error: errMsg(err) },
      })
    } finally {
      this.moveInFlight = false
    }
  }

  private attachedByNode(): Record<string, number> {
    const counts: Record<string, number> = {}
    for (const [, assignment] of this.deps.ledger.assignmentsView()) {
      const nodeId = assignment.agentNodeId
      counts[nodeId] = (counts[nodeId] ?? 0) + 1
    }
    return counts
  }

  /**
   * The movable set. A camera with no cached attach CONFIG is excluded: the
   * relocation re-attaches from that config, so without it there is nothing to
   * move — offering it to the planner would produce a decision the applier then
   * has to drop, which is exactly the silent no-op this file forbids.
   *
   * A pin read that FAILS resolves to pinned (`true`), not unpinned. Pinning is
   * the operator's authority and a fallible read must never be the reason work
   * is taken off the node they chose.
   */
  private async collectCandidates(now: number): Promise<readonly StressFailoverCandidate[]> {
    const out: StressFailoverCandidate[] = []
    for (const [deviceId, entry] of this.samples) {
      if (now - entry.at > NodeStressController.SAMPLE_TTL_MS) continue
      const assignment = this.deps.ledger.getAssignment(deviceId)
      if (!assignment) continue
      if (!this.deps.ledger.getConfig(deviceId)) continue
      const pinned = await this.deps
        .readPipelinePin(deviceId)
        .then((pin) => pin !== null)
        .catch(() => true)
      out.push({
        deviceId,
        nodeId: assignment.agentNodeId,
        pinned,
        active: entry.metrics.phase === 'active',
        configuredFps: entry.metrics.configuredFps,
        eligibleNodes: this.deps.topology.detectionEligibleNodes(deviceId),
      })
    }
    return out
  }
}
