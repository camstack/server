import type {
  AddonContext,
  AddonInstance,
  ConfigUISchema,
  ContainerMemoryPoint,
  ContainerMemorySnapshot,
  IMetricsProvider,
  NodeLoadSeries,
  NodeProcess,
  ProviderRegistration,
  ReadinessScope,
} from '@camstack/types'
import { BaseAddon, createEvent, EventCategory, metricsProviderCapability } from '@camstack/types'

/** The hub's node id — `isHub` below is the same test; device-history lives there. */
const HUB_NODE_ID = 'hub'
import { ContainerMemoryProbe } from './cgroup-memory.js'
import { ContainerPidsProbe } from './cgroup-pids.js'
import {
  ContainerMemoryRing,
  mergeContainerMemory,
  reduceContainerMemory,
} from './container-memory-ring.js'
import {
  DEFAULT_CADENCE_SEC,
  DEFAULT_MAX_ROWS,
  DEFAULT_RETENTION_HOURS,
  describeLoadSeriesCost,
  type LoadSeriesConfig,
  MAX_CADENCE_SEC,
  MAX_RETENTION_HOURS,
  MIN_CADENCE_SEC,
  MIN_RETENTION_HOURS,
  projectLoadSeriesCost,
  resolveLoadSeriesConfig,
} from './load-series-config.js'
import { mergeLoadSeries } from './load-series-reader.js'
import type { RetainedProcess, RetainedSample } from './load-series-types.js'
import {
  NodeMetricsHistoryRecorder,
  nodeMetricsHistoryClient,
} from './node-metrics-history-recorder.js'
import { NativeMetricsProvider } from './native-metrics-provider.js'
import { NodeLoadRing } from './node-load-ring.js'
import { readProcessTable } from './proc-process-table.js'
import {
  buildNodeProcesses,
  CAMSTACK_CMD_RE,
  type ManagedProcessEntry,
  type PsProcessRow,
} from './process-classification.js'
import { ThreadCpuTracker } from './thread-cpu-sampler.js'

interface NativeMetricsConfig {
  readonly samplingIntervalMs: number
  /**
   * Fixed cadence of the process-tree snapshot, in SECONDS. 5-60, refused
   * outside — `load-series-config.ts` explains why refused and not clamped.
   */
  readonly loadSeriesCadenceSec: number
  /** How long the durable series is KEPT, in hours. Retention is enforced by
   *  device-history (see `node-metrics-history-recorder.ts`). */
  readonly loadSeriesRetentionHours: number
}

/**
 * Cadence for the per-node metric snapshot bus events. ~5 s matches
 * the existing UI polling cadence (ProcessesTab, ProcessResources)
 * and stays within the sampling interval so consumers always see a
 * fresh-from-OS payload.
 */
const METRICS_SNAPSHOT_INTERVAL_MS = 5_000
/**
 * Force a RESOURCES-snapshot emit at least every 60s even when the
 * coarsened payload looks unchanged. Without this an idle node
 * (steady CPU within ±5%, no process churn) goes silent on the
 * bus and the UI's "node alive" chip can stale out.
 *
 * The PROCESS-tree snapshot has no such heartbeat and no dedup: it is
 * fixed-cadence — see `startProcessSnapshotTimer`.
 */
const METRICS_SNAPSHOT_HEARTBEAT_MS = 60_000

/**
 * Coarsen CPU/mem percentages to integer buckets before deduping.
 * Without this every 5s tick differs by ±0.3% and the equality check
 * always fails, so the snapshot fans out unconditionally.
 */
function coarsenResourcesSnapshot(snapshot: unknown): string {
  if (!snapshot || typeof snapshot !== 'object') return JSON.stringify(snapshot)
  // Walk the object and round any value that looks like a percent.
  const round = (v: unknown): unknown => {
    if (typeof v === 'number') {
      // CPU% / mem% / disk% all sit in 0..100. Bucket to nearest 5%.
      // Anything outside (uptime, byte counts) gets rounded to 100k
      // so byte deltas under that don't fire emits.
      if (v >= 0 && v <= 100) return Math.round(v / 5) * 5
      return Math.round(v / 100_000) * 100_000
    }
    if (Array.isArray(v)) return v.map(round)
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        out[k] = round(val)
      }
      return out
    }
    return v
  }
  return JSON.stringify(round(snapshot))
}

// Shape of the ProcessInfo returned by the kernel `$process.list` Moleculer action.
// Not imported from @camstack/system — core cannot depend on kernel. Keep the shape
// minimal + narrow the state field at the boundary.
interface KernelProcessInfo {
  readonly pid: number
  readonly nodeId: string
  readonly addonId: string
  readonly state: string
  readonly cpuPercent: number
  readonly memoryRss: number
  readonly uptimeSeconds: number
}

type WorkerState = 'starting' | 'running' | 'stopping' | 'stopped' | 'crashed'

function narrowWorkerState(state: string): WorkerState {
  switch (state) {
    case 'starting':
    case 'running':
    case 'stopping':
    case 'stopped':
    case 'crashed':
      return state
    default:
      return 'running'
  }
}

/**
 * Native metrics — CPU, memory, disk usage sampling.
 * Settings appear under Cluster → NodeDetail → Settings.
 */
export default class NativeMetricsAddon extends BaseAddon<NativeMetricsConfig> {
  private provider: NativeMetricsProvider | null = null
  private startedAtMs: number = Date.now()
  private snapshotTimer: ReturnType<typeof setInterval> | null = null
  private processSnapshotTimer: ReturnType<typeof setInterval> | null = null
  /**
   * Snapshot-equality cache for the resources + processes emit.
   * Stores the coarsened JSON and timestamp; a tick where the
   * coarsened payload matches the cache (and the heartbeat hasn't
   * elapsed) is skipped.
   */
  private lastResourcesEmit: { coarse: string; emittedAt: number } | null = null
  /**
   * Holds the previous `/proc/<pid>/task/*` tick counts so each process scan
   * can turn them into an instantaneous CPU rate split between the process's
   * own threads and V8's helper pool. Self-bounding — see `ThreadCpuTracker`.
   */
  private readonly threadCpu = new ThreadCpuTracker()
  /**
   * Retention for the snapshots this addon emits. Fed by SUBSCRIBING to
   * `metrics.node-processes-snapshot`, never by a second sampler — on the hub
   * that bus carries every node, so the hub's ring is the cluster's. Bounds and
   * measured cost live in `node-load-ring.ts`.
   */
  private readonly loadRing = new NodeLoadRing<RetainedProcess>()
  /**
   * The COLD tier, and it exists only on the HUB.
   *
   * The table is hub-resident and the hub already hears every node's snapshot
   * on its bus, so the hub's writer is the cluster's. An agent writing through
   * the `settings-store` singleton would ship its rows over Moleculer, once
   * per sample, to reach that very same table.
   */
  private metricsHistory: NodeMetricsHistoryRecorder | null = null
  /**
   * The container's OWN memory, sampled on the process-snapshot tick.
   *
   * It rides that tick rather than a timer of its own so a memory reading and
   * the process rows it must be compared against carry the SAME timestamp —
   * the whole question is a subtraction, and two clocks make it an estimate.
   * Constructed in `onInitialize`, where the logger exists; it resolves the
   * cgroup once and latches.
   */
  private memoryProbe: ContainerMemoryProbe | null = null
  private pidsProbe: ContainerPidsProbe | null = null
  /** Hot tier for the container reading. Bounds in `container-memory-ring.ts`. */
  private readonly memoryRing = new ContainerMemoryRing()
  /** The resolved knobs. Re-resolved on every settings write. */
  private loadConfig: LoadSeriesConfig = {
    cadenceSec: DEFAULT_CADENCE_SEC,
    retentionHours: DEFAULT_RETENTION_HOURS,
    maxRows: DEFAULT_MAX_ROWS,
  }
  /**
   * Process rows seen in each node's most recent snapshot — the OBSERVED
   * numbers the settings form projects its cost from. A constant here would be
   * a projection that stops being true the first time the fleet changes.
   */
  private readonly observedRowsByNode = new Map<string, number>()

  constructor() {
    super({
      samplingIntervalMs: 5000,
      loadSeriesCadenceSec: DEFAULT_CADENCE_SEC,
      loadSeriesRetentionHours: DEFAULT_RETENTION_HOURS,
    })
  }

  /** Is this the hub? The same test every other addon uses (`addon-ai`). */
  private get isHub(): boolean {
    return (this.ctx.kernel.cluster?.broker?.nodeID ?? HUB_NODE_ID) === HUB_NODE_ID
  }

  /** Process rows observed across the whole fleet, for the cost projection. */
  private observedFleetRows(): number {
    let total = 0
    for (const rows of this.observedRowsByNode.values()) total += rows
    return total
  }

  /**
   * Project a `NodeProcess` onto the series' own row.
   *
   * `command`, `ppid`, `pgid`, `nodeId`, `threadCount` and `uptimeSec` are
   * dropped here, at the single point both tiers pass through, so the hot ring
   * and the cold table carry the SAME shape and the merged read cannot tell
   * them apart. `command` in particular is the fattest field in a snapshot and
   * the same identical string on every runner — the runner id travels in the
   * environment, not in argv — and nothing that draws this series reads it.
   */
  private static toRetained(process: NodeProcess): RetainedProcess {
    return {
      pid: process.pid,
      addonId: process.addonId,
      classification: process.classification,
      cpuPercent: process.cpuPercent,
      memoryRssBytes: process.memoryRssBytes,
      cpuMainPercent: process.cpuMainPercent,
      cpuGcPercent: process.cpuGcPercent,
    }
  }

  protected async onInitialize(): Promise<ProviderRegistration[]> {
    const provider = new NativeMetricsProvider()
    provider.setDiagnostics({
      warn: (message, meta) => this.ctx.logger.warn(message, { meta: meta ?? {} }),
    })
    provider.startSampling(this.config.samplingIntervalMs)
    this.provider = provider
    this.startedAtMs = Date.now()
    this.ctx.logger.info('Native metrics provider started', {
      meta: { intervalMs: this.config.samplingIntervalMs },
    })

    const composed: IMetricsProvider = {
      collectSnapshot: () => provider.collectSnapshot(),
      getCached: () => provider.getCached(),
      getCurrent: () => provider.getCurrent(),
      getDiskSpace: (params) => provider.getDiskSpace(params),
      getGpuInfo: () => provider.getGpuInfo(),
      getCpuTemperature: () => provider.getCpuTemperature(),
      getProcessStats: (params) => provider.getProcessStats(params),
      listAddonInstances: () => this.listAddonInstances(),
      getAddonStats: (params) => this.getAddonStats(params.addonId),
      listNodeProcesses: () => this.listNodeProcesses(),
      getLoadSeries: (params) => this.readLoadSeries(params),
    }

    this.applyLoadSeriesConfig()

    // The durable tier, on the hub only. `device-history` is a sibling builtin
    // that may register AFTER this one (it did on `.50`: "Service
    // 'device-history.device-history.declareSeries' is not found"), so the
    // series are declared when the REGISTRY says it is ready — at once when it
    // already is, else on its ready transition. No timer, no retry (D3); a
    // sample that lands before then is not stored, and says so.
    if (this.isHub) {
      const historyScope: ReadinessScope = { type: 'node', nodeId: HUB_NODE_ID }
      const historyHandle = this.ctx.useCapability('device-history', historyScope)
      const recorder = new NodeMetricsHistoryRecorder({
        deviceHistory: nodeMetricsHistoryClient(this.ctx.api.deviceHistory),
        logger: this.ctx.logger.child('NodeMetricsHistory'),
        historyReady: () => historyHandle.isReady,
      })
      this.metricsHistory = recorder
      const declareNow = (): void => {
        void recorder.declare().catch((err: unknown) => {
          this.ctx.logger.warn('node metrics history declare failed', {
            meta: { error: err instanceof Error ? err.message : String(err) },
          })
        })
      }
      this.ctx.addDisposer(
        this.ctx.onCapabilityStateChange('device-history', historyScope, (state) => {
          if (state === 'ready') declareNow()
        }),
      )
      if (historyHandle.isReady) declareNow()
    }

    // Resolves the cgroup on its first sample and says, once, what it found —
    // including "nothing", which is the honest answer on a developer Mac.
    this.memoryProbe = new ContainerMemoryProbe({
      logger: this.ctx.logger.child('ContainerMemory'),
    })

    // The pid ceiling. A container cgroup counts THREADS, and this hub was
    // measured refusing 22 clone() calls in 45 minutes with nothing in the
    // product reading the counter — the only trace was media that stopped.
    // It logs on its OWN cadence, not this tick's: the operator wants a day of
    // regular readings before deciding whether to raise `--pids-limit`.
    this.pidsProbe = new ContainerPidsProbe({
      logger: this.ctx.logger.child('ContainerPids'),
    })

    // Periodic snapshot emission — UI dashboards subscribe to these
    // categories instead of polling `getCached` / `listNodeProcesses`.
    // The cheap resources snapshot (cached sample) fires every 5s and still
    // dedups; the heavy process-tree scan fires on the operator's FIXED
    // cadence and never dedups — see the constant's docblock.
    if (this.snapshotTimer) clearInterval(this.snapshotTimer)
    this.snapshotTimer = setInterval(
      () => this.runTick('resources snapshot', () => this.emitResourcesSnapshot()),
      METRICS_SNAPSHOT_INTERVAL_MS,
    )
    this.startProcessSnapshotTimer()

    // Node totals (CPU %, memory %, temperatures) ride the resources fan-out,
    // on the hub only — the same reason as the process tier above.
    if (this.metricsHistory !== null) {
      const history = this.metricsHistory
      this.ctx.addDisposer(
        this.ctx.eventBus.subscribe(
          { category: EventCategory.MetricsNodeResourcesSnapshot },
          (event) => {
            void history.recordTotals(event.data.nodeId, event.data.timestamp, event.data.snapshot)
          },
        ),
      )
    }

    // Retention rides the fan-out — no timer, no probe, no second sampler.
    this.ctx.addDisposer(
      this.ctx.eventBus.subscribe(
        { category: EventCategory.MetricsNodeProcessesSnapshot },
        (event) =>
          this.retainSnapshot(
            event.data.nodeId,
            event.data.timestamp,
            event.data.processes,
            event.data.containerMemory,
          ),
      ),
    )

    return [{ capability: metricsProviderCapability, provider: composed }]
  }

  /**
   * Retain one arriving snapshot in BOTH tiers.
   *
   * The ring is written FIRST and it is the gate: `record` refuses a timestamp
   * this node has already delivered, and only an accepted sample reaches the
   * table. That is what makes the append idempotent without a unique index
   * over two million rows — the composite key it replaces was measured at ~40
   * bytes per row (measured on the old SQLite tier; see D850).
   *
   * The durable append is fire-and-forget: a storage stall must cost a gap in
   * the cold window, never a blocked event-bus handler. Every failure logs.
   */
  private retainSnapshot(
    nodeId: string,
    atMs: number,
    processes: readonly NodeProcess[],
    containerMemory: ContainerMemorySnapshot | null,
  ): void {
    const retained = processes.map((p) => NativeMetricsAddon.toRetained(p))
    const accepted = this.loadRing.record(nodeId, atMs, retained)
    if (!accepted) return
    this.observedRowsByNode.set(nodeId, retained.length)
    // A node with NO cgroup retains nothing — never a zeroed reading. Absent
    // has to stay distinguishable from a container using no memory.
    if (containerMemory !== null) this.memoryRing.record(nodeId, atMs, containerMemory)
    const history = this.metricsHistory
    if (history === null) return
    void history.recordSample(nodeId, atMs, retained, containerMemory)
  }

  /**
   * The ONE reader, over both tiers.
   *
   * Cold first, hot second, merged and deduped on `atMs` — see
   * `load-series-reader.ts`. The cold read is bounded in ROWS, because rows
   * are what a query costs, and the fold + reduction happen HERE rather than
   * in the browser: six hours at the 10 s cadence is 2 160 snapshots, and
   * shipping them to a page that will discard most of them is precisely the
   * cost this subsystem exists to avoid.
   */
  private async readLoadSeries(params: {
    readonly forNodeId: string
    readonly sinceMs?: number
    readonly maxPoints?: number
  }): Promise<NodeLoadSeries> {
    const cadenceMs = this.loadConfig.cadenceSec * 1000
    const sinceMs = params.sinceMs ?? 0
    const hot = this.loadRing.read(params.forNodeId, params.sinceMs)
    const hotSamples: readonly RetainedSample[] = hot.samples.map((sample) => ({
      atMs: sample.atMs,
      processes: sample.processes,
    }))
    const history = this.metricsHistory
    const cold =
      history === null
        ? []
        : await history.readProcessSamples(params.forNodeId, sinceMs, this.loadConfig.maxRows)
    const merged = mergeLoadSeries({
      cold,
      hot: hotSamples,
      cadenceMs,
      ...(params.maxPoints !== undefined ? { maxPoints: params.maxPoints } : {}),
    })
    return {
      nodeId: params.forNodeId,
      series: merged.series,
      containerMemory: await this.readContainerMemory({
        forNodeId: params.forNodeId,
        sinceMs,
        ...(params.sinceMs !== undefined ? { exclusiveSinceMs: params.sinceMs } : {}),
        bucketMs: merged.bucketMs,
        cadenceMs,
        origin: merged.oldestAtMs,
      }),
      bucketMs: merged.bucketMs,
      retainedSamples: merged.retainedSamples,
      oldestAtMs: merged.oldestAtMs,
      cadenceMs,
      durable: history !== null,
    }
  }

  /**
   * The container's memory over the same window, on the same x-axis.
   *
   * Both tiers, merged and deduped on `atMs` like the process series, then
   * reduced against the SAME `bucketMs` and the SAME origin — otherwise the
   * two series in one answer would sit on two different axes and the
   * subtraction they exist for would be an eyeball.
   *
   * An EMPTY answer means the node has no cgroup, or nothing has been retained
   * for it yet. It never means zero.
   */
  private async readContainerMemory(params: {
    readonly forNodeId: string
    readonly sinceMs: number
    readonly exclusiveSinceMs?: number
    readonly bucketMs: number
    readonly cadenceMs: number
    readonly origin: number | null
  }): Promise<readonly ContainerMemoryPoint[]> {
    const hot = this.memoryRing.read(params.forNodeId, params.exclusiveSinceMs)
    const history = this.metricsHistory
    const cold =
      history === null
        ? []
        : await history.readContainerPoints(params.forNodeId, params.sinceMs, 5000)
    const merged = mergeContainerMemory(cold, hot)
    if (params.bucketMs <= params.cadenceMs) return merged
    return reduceContainerMemory(merged, params.bucketMs, params.origin ?? 0)
  }

  /**
   * Re-resolve the knobs and restate the fixed cadence.
   *
   * A REFUSED value (out of 5-60 s, or out of 1-72 h) leaves the previous
   * configuration in force and says so. Refused, never clamped: storing 10
   * when the operator typed 2 and reading 10 back is a knob and a readback
   * agreeing on a value nobody chose.
   */
  private applyLoadSeriesConfig(): void {
    try {
      const next = resolveLoadSeriesConfig({
        loadSeriesCadenceSec: this.config.loadSeriesCadenceSec,
        loadSeriesRetentionHours: this.config.loadSeriesRetentionHours,
      })
      const changed =
        next.cadenceSec !== this.loadConfig.cadenceSec ||
        next.retentionHours !== this.loadConfig.retentionHours
      this.loadConfig = next
      if (changed) {
        const projection = projectLoadSeriesCost({
          config: next,
          observedProcessRows: this.observedFleetRows(),
        })
        this.ctx.logger.info('load series configuration applied', {
          meta: {
            nodeId: this.ctx.kernel.localNodeId ?? this.ctx.id,
            cadenceSec: next.cadenceSec,
            retentionHours: next.retentionHours,
            maxRows: next.maxRows,
            projectedRows: projection.intendedRows,
            projectedMib: Math.round((projection.estimatedBytes / 1_048_576) * 10) / 10,
            capBites: projection.capBites,
          },
        })
      }
    } catch (err) {
      this.ctx.logger.warn('load series configuration REFUSED — keeping the previous values', {
        meta: {
          nodeId: this.ctx.kernel.localNodeId ?? this.ctx.id,
          cadenceSec: this.loadConfig.cadenceSec,
          retentionHours: this.loadConfig.retentionHours,
          error: err instanceof Error ? err.message : String(err),
        },
      })
    }
  }

  /**
   * (Re)arm the process-tree timer at the configured interval.
   *
   * The process-tree snapshot is FIXED-CADENCE, and its cadence is the
   * operator's `loadSeriesCadenceSec` (5-60 s, 10 by default).
   *
   * It used to emit only ON A CHANGE, with a 60 s fallback heartbeat, and the
   * dedup is gone rather than tuned. A conditional emit makes a hole in the
   * series mean two different things — "nothing changed" and "nobody reported"
   * — and telling those apart is the entire reason an operator opens this chart
   * after a spike. Now a gap means exactly one thing.
   *
   * It is not free: the emit rate is deterministic, so the durable table's row
   * count is too (nodes x processes / cadence, no discount for a quiet fleet).
   * The measured cost of that is in `docs/architecture/load-ledger.md`, and it
   * is why the retention default is six hours rather than three days.
   */
  private startProcessSnapshotTimer(): void {
    if (this.processSnapshotTimer) clearInterval(this.processSnapshotTimer)
    this.processSnapshotTimer = null
    // Never arm a timer for an addon that is not (or no longer) initialized:
    // every tick it fired would be a tick with no context.
    if (!this.ctxIfReady) return
    this.processSnapshotTimer = setInterval(
      () => this.runTick('process snapshot', () => this.emitProcessesSnapshot()),
      this.loadConfig.cadenceSec * 1000,
    )
  }

  /**
   * Run one periodic tick so that it can NEVER become an unhandled rejection.
   *
   * `clearInterval` in `onShutdown` stops FUTURE ticks; it cannot recall one
   * already in flight. A process tick awaits a `/proc` read and a
   * `$process.list` broker call, and a graceful stop shuts this addon down
   * (nulling `ctx`) while the agent goes on to stop its other addons and the
   * broker — so the tick resumed with no context, its catch block reached for
   * `this.ctx.logger`, threw again, and the rejection of the timer callback
   * killed `docker stop CamStack-Agent` with exit code 1 (agent-a,
   * 2026-10-07 04:22Z). The ticks themselves now capture their context once
   * and stand down when it is gone; this wrapper is the backstop.
   *
   * A tick before `initialize()` or after `shutdown()` is a no-op.
   */
  private runTick(name: string, tick: () => Promise<void>): void {
    if (!this.ctxIfReady) return
    tick().catch((err: unknown) => {
      // Logged through the addon logger while there still is one; after
      // shutdown there is nobody to tell and nothing left to do.
      this.ctxIfReady?.logger.warn('native-metrics tick failed — this interval will be missing', {
        meta: { tick: name, error: err instanceof Error ? err.message : String(err) },
      })
    })
  }

  protected async onShutdown(): Promise<void> {
    if (this.snapshotTimer) {
      clearInterval(this.snapshotTimer)
      this.snapshotTimer = null
    }
    if (this.processSnapshotTimer) {
      clearInterval(this.processSnapshotTimer)
      this.processSnapshotTimer = null
    }
    this.provider?.stopSampling()
    this.provider = null
  }

  /**
   * Resolve this node's short id (strips any `nodeId/addonId` suffix).
   * Returns null when the provider or event bus isn't available yet.
   */
  private resolveSnapshotNodeId(ctx: AddonContext): string | null {
    if (!this.provider || !ctx.eventBus) return null
    const rawNodeId = ctx.kernel.localNodeId ?? ctx.id
    return rawNodeId.includes('/') ? rawNodeId.split('/')[0]! : rawNodeId
  }

  /**
   * Emit one `metrics.node-resources-snapshot` for this node. Cheap —
   * reads the cached sample (the provider's background sampler already
   * runs at samplingIntervalMs). Fires on METRICS_SNAPSHOT_INTERVAL_MS.
   */
  private async emitResourcesSnapshot(): Promise<void> {
    // Captured ONCE: `shutdown()` nulls `ctx` and may do so while this tick
    // is suspended on the sample below.
    const ctx = this.ctxIfReady
    if (!ctx) return
    const provider = this.provider
    const eventBus = ctx.eventBus
    const nodeId = this.resolveSnapshotNodeId(ctx)
    if (!provider || !eventBus || !nodeId) return
    const timestamp = Date.now()

    try {
      const cached = await provider.getCached()
      const snapshot = cached ?? (await provider.collectSnapshot())
      // Shut down while sampling: the snapshot belongs to nobody now.
      if (this.ctxIfReady !== ctx) return
      const coarse = coarsenResourcesSnapshot(snapshot)
      const prev = this.lastResourcesEmit
      const heartbeatDue = !prev || timestamp - prev.emittedAt >= METRICS_SNAPSHOT_HEARTBEAT_MS
      if (!prev || prev.coarse !== coarse || heartbeatDue) {
        this.lastResourcesEmit = { coarse, emittedAt: timestamp }
        eventBus.emit(
          createEvent(
            EventCategory.MetricsNodeResourcesSnapshot,
            { type: 'node', id: nodeId, nodeId },
            { nodeId, snapshot, timestamp },
          ),
        )
      }
    } catch {
      // Soft-fail: dashboards tolerate a missing tick.
    }
  }

  /**
   * Emit one `metrics.node-processes-snapshot` for this node.
   *
   * Heavy — a full process-table read (`/proc` on Linux, `ps -eo` elsewhere;
   * `proc-process-table.ts`) plus a `$process.list` broker call — and
   * UNCONDITIONAL. The change-detection that used to guard it is gone: with a
   * fixed cadence a missing interval means exactly one thing, and that is the
   * property an operator investigating a spike is actually looking for.
   *
   * A failed scan emits nothing, which is the same signal: nobody reported.
   */
  private async emitProcessesSnapshot(): Promise<void> {
    // Captured ONCE: `shutdown()` nulls `ctx`, and it does so while this tick
    // is suspended on the process-table read or the broker call — see
    // `runTick`. Everything below reads the captured context.
    const ctx = this.ctxIfReady
    if (!ctx) return
    const eventBus = ctx.eventBus
    const nodeId = this.resolveSnapshotNodeId(ctx)
    if (!this.provider || !eventBus || !nodeId) return
    const timestamp = Date.now()

    try {
      const processes = await this.listNodeProcesses()
      if (this.ctxIfReady !== ctx) {
        // The addon shut down while this tick was scanning. Emitting now would
        // publish on behalf of a stopped addon; the interval is simply missing.
        ctx.logger.debug('process snapshot dropped — addon shut down mid-tick', {
          meta: { nodeId },
        })
        return
      }
      // Read on THIS tick, stamped with THIS timestamp: the container total and
      // the per-process rows are only subtractable if they share an instant.
      // `null` on a node with no cgroup — absent, never zero.
      const containerMemory = this.memoryProbe?.sample() ?? null
      // Sampled on the same tick, reported on its own schedule. The snapshot
      // is not carried on the event yet — nothing renders it — but the reading
      // must happen here, where a tick already exists, rather than in a timer
      // of its own.
      this.pidsProbe?.sample()
      eventBus.emit(
        createEvent(
          EventCategory.MetricsNodeProcessesSnapshot,
          { type: 'node', id: nodeId, nodeId },
          { nodeId, processes, timestamp, containerMemory },
        ),
      )
    } catch (err) {
      // A dropped tick is a GAP, and a gap is now readable as one. Saying so
      // is not optional: a branch that drops work logs it.
      ctx.logger.warn('process snapshot skipped — this interval will be missing', {
        meta: { nodeId, error: err instanceof Error ? err.message : String(err) },
      })
    }
  }

  protected async onConfigChanged(): Promise<void> {
    // A settings write that lands before `initialize()` or after `shutdown()`
    // has nothing to reconfigure — and must not re-arm a timer on a context
    // that does not exist. `initialize()` resolves the stored config itself.
    if (!this.ctxIfReady) return
    this.provider?.stopSampling()
    this.provider?.startSampling(this.config.samplingIntervalMs)
    this.applyLoadSeriesConfig()
    this.startProcessSnapshotTimer()
  }

  private async listWorkerInstances(): Promise<readonly KernelProcessInfo[]> {
    // `ctxIfReady`: a process tick calls this after an await, possibly past
    // shutdown — no context means no broker to ask.
    const broker = this.ctxIfReady?.kernel.cluster?.broker
    if (!broker) return []
    try {
      return await broker.call<void, readonly KernelProcessInfo[]>('$process.list')
    } catch {
      // $process service not running on this node (workers, remote agents) —
      // a benign empty list.
      return []
    }
  }

  private async listAddonInstances() {
    const broker = this.ctx.kernel.cluster?.broker
    const hubNodeId = broker?.nodeID ?? 'hub'
    const uptimeSec = Math.max(0, Math.floor((Date.now() - this.startedAtMs) / 1000))
    const instances: AddonInstance[] = [
      {
        addonId: '$hub',
        nodeId: hubNodeId,
        role: 'hub',
        pid: process.pid,
        state: 'running',
        uptimeSec,
      },
    ]
    const workers = await this.listWorkerInstances()
    for (const w of workers) {
      instances.push({
        addonId: w.addonId,
        nodeId: w.nodeId,
        role: 'worker',
        pid: w.pid,
        state: narrowWorkerState(w.state),
        uptimeSec: w.uptimeSeconds,
      })
    }
    return instances
  }

  private async getAddonStats(addonId: string) {
    const provider = this.provider
    if (!provider) return null
    if (addonId === '$hub') {
      const stats = await provider.getProcessStats({ pids: [process.pid] })
      return stats[0] ?? null
    }
    const workers = await this.listWorkerInstances()
    const target = workers.find((w) => w.addonId === addonId)
    if (!target) return null
    const stats = await provider.getProcessStats({ pids: [target.pid] })
    return stats[0] ?? null
  }

  /**
   * Walk the OS process table and classify each camstack-shaped process.
   *
   * Classification is IDENTITY-driven: `root` is this pid, `managed` is a pid
   * the kernel's `$process.list` names, and every other camstack-shaped
   * process is `system`. The rules — and why there is no longer an ancestry
   * walk behind them — live in `process-classification.ts`.
   */
  private async listNodeProcesses(): Promise<readonly NodeProcess[]> {
    // Read BEFORE the awaits below: a shutdown during them nulls `ctx`.
    const selfNodeId = this.ctx.kernel.cluster?.broker?.nodeID ?? 'hub'
    const ps = await this.runPs()
    if (ps.length === 0) return []

    const managed = new Map<number, ManagedProcessEntry>()
    const workers = await this.listWorkerInstances()
    for (const w of workers) {
      managed.set(w.pid, { addonId: w.addonId, nodeId: w.nodeId })
    }

    // Thread-level CPU split, for the camstack-shaped pids ONLY. It rides
    // this tick (no timer of its own) and is strictly cheaper than the
    // whole-process-table read above, which has already run.
    const camstackPids = ps.filter((p) => CAMSTACK_CMD_RE.test(p.command)).map((p) => p.pid)
    const cpuSplits = await this.threadCpu.sample(camstackPids)

    return buildNodeProcesses({
      psRows: ps,
      selfPid: process.pid,
      selfNodeId,
      managed,
      cpuSplits,
    })
  }

  // REMOVED 2026-09-03 — `dumpHeapSnapshot`.
  //
  // It signalled a runner (SIGUSR2) to serialise its V8 heap, and reported
  // `success: true` for having SENT the signal — it never knew whether a
  // snapshot was written, because the runner only writes when an env flag is
  // explicitly on. So the operator got a success and a file path that might not
  // exist, which is the same shape as D333.
  //
  // Twice, reaching for it preceded the hub going unreachable — SSH timing out
  // during banner exchange while the host still answered ping. The operator's
  // instruction after the second time (2026-09-03) was to remove it completely.
  // `scripts/check-no-heap-dump-command.ts` keeps it gone.
  //
  // The recorder still retains ~900 MB of large objects nothing in its tree can
  // account for. Naming them now needs a recorder that is NOT serving cameras,
  // not a button aimed at production.

  /**
   * Every pid + command + resource stats on this node.
   *
   * From `/proc` on Linux — no fork. This used to be a `ps -eo` child on every
   * tick, i.e. a synchronous `fork()` of hub-main at p50 91 ms (D441, D452).
   * `ps` remains the source only on a platform without `/proc`.
   */
  private async runPs(): Promise<readonly PsProcessRow[]> {
    try {
      return await readProcessTable()
    } catch (err) {
      // `ctxIfReady`: this catch runs after an await, possibly past shutdown.
      this.ctxIfReady?.logger.warn('process table read failed', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
      return []
    }
  }

  /**
   * The knobs live HERE, on the document this addon already owns.
   *
   * Fields on an existing document, never a method per knob —
   * `system.getLoggingSettings` / `setLoggingSettings` set that precedent.
   * They are deliberately NOT in the logging document: that one is about
   * levels and diagnostic windows, and two documents both claiming a knob is
   * how this repo has already shipped a switch nobody read.
   *
   * Cluster-wide, not per-node: every node must emit on the same cadence or
   * the fleet's series cannot be laid over each other, and the table is single
   * and hub-resident, so a per-node retention would be a promise nothing could
   * keep.
   *
   * The cost line is computed from OBSERVED numbers — the nodes and process
   * counts the cluster is actually reporting — so an operator raising the
   * retention sees what it costs BEFORE applying it, not afterwards.
   */
  protected globalSettingsSchema(): ConfigUISchema {
    const projection = projectLoadSeriesCost({
      config: this.loadConfig,
      observedProcessRows: this.observedFleetRows(),
    })
    return this.schema({
      sections: [
        {
          id: 'native-metrics-settings',
          title: 'System Metrics',
          titleKey: 'server:globalSettings.s_native-metrics-settings.title',
          fields: [
            this.field({
              type: 'number',
              key: 'samplingIntervalMs',
              label: 'Sampling Interval',
              labelKey: 'server:globalSettings.s_native-metrics-settings.samplingIntervalMs.label',
              description: 'How often to collect system metrics',
              descriptionKey:
                'server:globalSettings.s_native-metrics-settings.samplingIntervalMs.description',
              min: 1000,
              max: 60000,
              step: 1000,
              default: 5000,
              unit: 'ms',
            }),
          ],
        },
        {
          id: 'native-metrics-load-series',
          title: 'Load history',
          titleKey: 'server:globalSettings.s_native-metrics-load-series.title',
          fields: [
            this.field({
              type: 'number',
              key: 'loadSeriesCadenceSec',
              label: 'Sampling cadence',
              labelKey:
                'server:globalSettings.s_native-metrics-load-series.loadSeriesCadenceSec.label',
              description:
                'How often every node reports its process tree. FIXED — a sample is emitted on every interval whether or not anything changed, so a gap in the chart means one thing only: nobody reported. Outside 5-60 s the value is refused.',
              descriptionKey:
                'server:globalSettings.s_native-metrics-load-series.loadSeriesCadenceSec.description',
              min: MIN_CADENCE_SEC,
              max: MAX_CADENCE_SEC,
              step: 1,
              default: DEFAULT_CADENCE_SEC,
              unit: 's',
            }),
            this.field({
              type: 'number',
              key: 'loadSeriesRetentionHours',
              label: 'Retention',
              labelKey:
                'server:globalSettings.s_native-metrics-load-series.loadSeriesRetentionHours.label',
              description:
                'How long the load history is kept on disk (the hub database, on the NVMe cache — never the recordings disk). This is the INTENTION; the row cap below is the guarantee.',
              descriptionKey:
                'server:globalSettings.s_native-metrics-load-series.loadSeriesRetentionHours.description',
              min: MIN_RETENTION_HOURS,
              max: MAX_RETENTION_HOURS,
              step: 1,
              default: DEFAULT_RETENTION_HOURS,
              unit: 'h',
            }),
            {
              type: 'info',
              key: 'load-series-cost',
              label: 'What this configuration costs',
              labelKey: 'server:globalSettings.s_native-metrics-load-series.load-series-cost.label',
              content: describeLoadSeriesCost(projection),
              variant: projection.capBites ? 'warning' : 'info',
            },
            {
              type: 'info',
              key: 'load-series-cap',
              label: 'Hard row cap',
              labelKey: 'server:globalSettings.s_native-metrics-load-series.load-series-cap.label',
              content: `The table never exceeds ${this.loadConfig.maxRows.toLocaleString('en-US')} rows. When it would, the OLDEST samples are evicted and a warning is logged — so raising the retention can never turn into an incident, only into a shorter effective window.`,
              variant: 'info',
            },
          ],
        },
      ],
    })
  }
}
