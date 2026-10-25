/**
 * `AgentLoadService` — agent load & metrics collection (C5, S6 extraction).
 *
 * Owns `cachedAgentLoad` (last observed agent-load snapshot per runner) and
 * the per-node decode-hwaccel cache `decodeHwaccelByNode` — extracted
 * verbatim (mechanical, zero logic change) from `index.ts`, including the
 * `decodeHwaccelByNode` field that used to sit 1,800 lines away from the
 * class's other field declarations (smell #22).
 *
 * `api`/`logger` are injected closures (mirrors the `PipelineSettingsStore`/
 * `CameraStatusService` deps pattern — `api: () => AddonApi | null` backed by
 * the non-throwing `ctxIfReady`), so a call landing before `initialize()` or
 * after `dispose()` degrades gracefully instead of throwing through a nulled
 * ctx. The original methods used the throwing `this.ctx` getter but every
 * call site already tolerated a missing api (`if (!api) continue` /
 * `if (!api) throw`), so this is not an observable behavior change.
 */
import type { AddonApi, AgentLoadSummary, RunnerLocalLoad } from '@camstack/types'
import { errMsg, type IScopedLogger, nodePin } from '@camstack/types'
import type { RunnerLoadAnswer } from './camera-sensors/motion-slice-gate.js'
import { attributeDefaultPoolSessions } from './default-pool-attribution.js'
import { type RunnerCensusEntry, raceBudget } from './dispatch-timing.js'
import { computeCapacityScore } from './load-balancer.js'
import type { NodeTopologyService } from './node-topology.js'

/** One runner's answer to the load census: what it cost, and the load if it reported. */
interface LoadCensusEntry extends RunnerCensusEntry {
  readonly load: RunnerLocalLoad | null
  readonly error?: string
}

/** The per-node cost as the skipped-runner line carries it. */
type LoadCensusReport = Record<
  string,
  { readonly ms: number; readonly outcome: RunnerCensusEntry['outcome']; readonly error?: string }
>

export interface AgentLoadServiceDeps {
  readonly api: () => AddonApi | null
  readonly topology: NodeTopologyService
  readonly logger: IScopedLogger
  /** Live read accessor for the addon's in-memory global settings snapshot. */
  readonly readGlobalSettings: () => Record<string, unknown>
  /**
   * Every census, answered or not, per node: the camera `motion` slice's
   * writer gate reads each runner's `motionSliceWriter` off it (D696).
   */
  readonly onCensus?: (entries: readonly RunnerLoadAnswer[]) => void
  /**
   * A node's eligible inference device keys, for {@link reportedAgentLoad}'s
   * default-pool attribution. Must not block on the node (a cached read);
   * null or a throw = not known, and the runner's answer is reported as is.
   */
  readonly eligibleDeviceKeys?: (nodeId: string) => Promise<readonly string[] | null>
}

export class AgentLoadService {
  private static readonly DEFAULT_AGENT_LOAD_TIMEOUT_MS = 4_000

  /** Last observed agent-load snapshot per runner, populated during each dispatch. */
  private cachedAgentLoad = new Map<string, AgentLoadSummary>()
  /**
   * Per-node decode hwaccel cache (`nodeId` → backend), refreshed by
   * {@link refreshDecodeHwaccels} before a UI-facing `getAgentLoad`. Read
   * from the decoder addon's per-node `probedBestHwaccel@<node>` setting — a
   * node-LOCAL probe published to a per-node setting — via `addonSettings`,
   * NEVER the `platform-probe` singleton (whose pin answers with hub hardware).
   */
  private readonly decodeHwaccelByNode = new Map<string, string | null>()

  constructor(private readonly deps: AgentLoadServiceDeps) {}

  // ── Snapshot accessors ────────────────────────────────────────────────

  getAgentLoadSummaries(): readonly AgentLoadSummary[] {
    return [...this.cachedAgentLoad.values()]
  }

  /**
   * The cached summaries as the load REPORT (`getAgentLoad`) carries them: a
   * single-device node's default-pool sessions credited to its one device
   * (`default-pool-attribution.ts`). The balancer's census
   * ({@link collectAgentLoad}) stays the runner's raw answer.
   */
  async reportedAgentLoad(): Promise<readonly AgentLoadSummary[]> {
    const resolve = this.deps.eligibleDeviceKeys
    const summaries = this.getAgentLoadSummaries()
    if (resolve === undefined) return summaries
    return Promise.all(
      summaries.map(async (summary) => {
        const eligible = await resolve(summary.nodeId).catch(() => null)
        const load = attributeDefaultPoolSessions(summary.load, eligible)
        return load === summary.load ? summary : { ...summary, load }
      }),
    )
  }

  cachedAgentLoadNodeIds(): readonly string[] {
    return [...this.cachedAgentLoad.keys()]
  }

  /** Drop a node from the cached load snapshot (node disconnect / failover cleanup). */
  dropNode(nodeId: string): void {
    this.cachedAgentLoad.delete(nodeId)
  }

  // ── Collection ────────────────────────────────────────────────────────

  /**
   * Query every online runner in the cluster for its current load, plus the
   * local runner if co-located. Refreshes the `cachedAgentLoad` snapshot.
   *
   * `{onlyEnabled: true}` applies the `enabledNodes` whitelist filter —
   * used when the caller is the dispatcher / balancer and must only see
   * runners eligible for new camera assignments. The default (unfiltered)
   * collects every known runner, which is what the UI wants.
   */
  async collectAgentLoad(options?: {
    readonly onlyEnabled?: boolean
  }): Promise<readonly RunnerLocalLoad[]> {
    const onlyEnabled = options?.onlyEnabled ?? false
    const nodeIds = this.deps.topology.knownRunnerNodeIds().filter((nodeId) => {
      if (!onlyEnabled || this.deps.topology.isNodeEnabled(nodeId)) return true
      this.deps.logger.debug('runner excluded by enabledNodes whitelist', {
        tags: { nodeId },
      })
      return false
    })

    // In PARALLEL, each under the per-node budget: the census costs the
    // slowest node, never the sum. Two wedged nodes in sequence cost 8 s and
    // showed up as `balanceMs 9205` on three cameras at once (D441).
    const budgetMs = this.agentLoadBudgetMs()
    const entries = await Promise.all(nodeIds.map((nodeId) => this.censusNode(nodeId, budgetMs)))
    const loads = entries.flatMap((e) => (e.load === null ? [] : [e.load]))
    const skipped = entries.filter((e) => e.load === null).map((e) => e.nodeId)
    if (skipped.length > 0) {
      // A node skipped from balancing is a branch that drops work: the hub
      // writes `info` and up, so this cannot live at `debug`.
      const nodes: LoadCensusReport = Object.fromEntries(
        entries.map((e) => [
          e.nodeId,
          { ms: e.ms, outcome: e.outcome, ...(e.error === undefined ? {} : { error: e.error }) },
        ]),
      )
      this.deps.logger.warn('agent load census skipped a runner', {
        meta: { budgetMs, skipped, nodes },
      })
    }

    this.refreshAgentLoadCache(loads)
    this.deps.onCensus?.(entries.map((e) => ({ nodeId: e.nodeId, load: e.load })))
    return loads
  }

  /**
   * One runner's load under `budgetMs`. A wedged runner (transport up enough
   * to stay in the registry, but whose call neither resolves nor rejects) is
   * counted as `budget-exceeded` and skipped exactly like an offline one; the
   * in-flight call is left to settle on its own, as before.
   */
  private async censusNode(nodeId: string, budgetMs: number): Promise<LoadCensusEntry> {
    const api = this.deps.api()
    const startedAt = Date.now()
    if (!api)
      return { nodeId, ms: 0, outcome: 'failed', load: null, error: 'addon not initialized' }
    const outcome = await raceBudget(api.pipelineRunner.getLocalLoad.query({ nodeId }), budgetMs)
    const ms = Date.now() - startedAt
    if (outcome.kind === 'settled') return { nodeId, ms, outcome: 'reported', load: outcome.value }
    if (outcome.kind === 'rejected') {
      return { nodeId, ms, outcome: 'failed', load: null, error: errMsg(outcome.error) }
    }
    return { nodeId, ms, outcome: 'budget-exceeded', load: null }
  }

  private refreshAgentLoadCache(loads: readonly RunnerLocalLoad[]): void {
    const next = new Map<string, AgentLoadSummary>()
    for (const load of loads) {
      next.set(load.nodeId, {
        nodeId: load.nodeId,
        online: true,
        load,
        score: computeCapacityScore(load),
        decodeHwaccel: this.decodeHwaccelByNode.get(load.nodeId) ?? null,
      })
    }
    this.cachedAgentLoad = next
  }

  /** Refresh {@link decodeHwaccelByNode} for every known runner node. */
  async refreshDecodeHwaccels(): Promise<void> {
    await Promise.all(
      this.deps.topology.knownRunnerNodeIds().map(async (nodeId) => {
        const hwaccel = await this.readNodeDecodeHwaccel(nodeId)
        if (hwaccel !== undefined) this.decodeHwaccelByNode.set(nodeId, hwaccel)
      }),
    )
  }

  /**
   * Read a node's `probedBestHwaccel` from whatever decoder backend is ACTIVE
   * on that node — via the `decoder` cap (`getInfo`, nodePin), NOT an addon-id
   * lookup. Returns `null` when the value is empty/unset, `undefined` on a
   * read failure (keep the last known).
   */
  private async readNodeDecodeHwaccel(nodeId: string): Promise<string | null | undefined> {
    try {
      const api = this.deps.api()
      if (!api) return undefined
      const info = await api.decoder.getInfo.query(undefined, nodePin(nodeId))
      if (!info) return undefined
      const probed = info.probedBestHwaccel
      return typeof probed === 'string' && probed.length > 0 ? probed : null
    } catch {
      return undefined
    }
  }

  /**
   * Per-node `getLocalLoad` budget (ms). Bounds a WEDGED runner (transport up
   * enough to stay in the service registry, but whose `broker.call` neither
   * resolves nor rejects) so it can't stall `collectAgentLoad` indefinitely.
   * Tunable via the `agentLoadTimeoutMs` global setting.
   */
  private agentLoadBudgetMs(): number {
    const cfg = this.deps.readGlobalSettings() ?? {}
    const value = cfg.agentLoadTimeoutMs
    return typeof value === 'number' && value > 0
      ? value
      : AgentLoadService.DEFAULT_AGENT_LOAD_TIMEOUT_MS
  }

  // ── Disposal ──────────────────────────────────────────────────────────

  /** Mirrors the former `onShutdown`'s `this.cachedAgentLoad.clear()`. */
  dispose(): void {
    this.cachedAgentLoad.clear()
  }
}
