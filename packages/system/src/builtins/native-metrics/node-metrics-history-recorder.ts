/**
 * Node load history via device-history (D850, LTS P4) — hub only: the hub's
 * bus carries every node's snapshots, so the hub's writer is the cluster's.
 *
 * Per RUNNER, never per PID. A series was once scoped by process id, and a pid
 * changes on every runner restart: the hub held ~11.8k node series, most of
 * them one restart long, and no chart could follow a runner across a respawn.
 * The scope is now the fold's own function key (`load-series-fold.ts`): the
 * runner's addon id, or `__root__` / `__unattributed__`, so a runner keeps ONE
 * series for life and the cold tier folds exactly like the hot ring. The old
 * `process-*` keys are no longer written; their rows age out by retention.
 *
 * Node TOTALS ride the resources snapshot: CPU %, memory %, CPU temperature
 * and, when the node has one, GPU utilisation and temperature. A reading the
 * node did not take (`null`) is no point — never 0 (D393).
 *
 * The in-memory rings still serve the last hour for charts.
 */

import {
  type AddonApi,
  type ContainerMemoryPoint,
  type ContainerMemorySnapshot,
  type DeviceHistoryIngestResult,
  type IScopedLogger,
  type SystemResourceSnapshot,
  ROOT_BUCKET_KEY,
  UNATTRIBUTED_BUCKET_KEY,
} from '@camstack/types'
import type { RetainedProcess, RetainedSample } from './load-series-types.js'

const ADDON_ID = 'metrics-native' as const
const MIB = 1_048_576

type MetricsKey<N extends string> = `addon:${typeof ADDON_ID}/${N}`
function keyOf<N extends string>(name: N): MetricsKey<N> {
  return `addon:${ADDON_ID}/${name}`
}

/** Per-runner series (scope = the fold key). */
export const RUNNER_CPU_MAIN_KEY: MetricsKey<'runner-cpu-main-percent'> =
  keyOf('runner-cpu-main-percent')
export const RUNNER_CPU_GC_KEY: MetricsKey<'runner-cpu-gc-percent'> = keyOf('runner-cpu-gc-percent')
export const RUNNER_CPU_LIFETIME_KEY: MetricsKey<'runner-cpu-lifetime-percent'> = keyOf(
  'runner-cpu-lifetime-percent',
)
export const RUNNER_RSS_KEY: MetricsKey<'runner-rss-mib'> = keyOf('runner-rss-mib')
export const RUNNER_PROCESSES_KEY: MetricsKey<'runner-processes'> = keyOf('runner-processes')

/** Node totals (scope ''). */
export const NODE_CPU_KEY: MetricsKey<'node-cpu-percent'> = keyOf('node-cpu-percent')
export const NODE_MEMORY_KEY: MetricsKey<'node-memory-percent'> = keyOf('node-memory-percent')
export const NODE_CPU_TEMPERATURE_KEY: MetricsKey<'node-cpu-temperature'> =
  keyOf('node-cpu-temperature')
export const NODE_GPU_KEY: MetricsKey<'node-gpu-percent'> = keyOf('node-gpu-percent')
export const NODE_GPU_TEMPERATURE_KEY: MetricsKey<'node-gpu-temperature'> =
  keyOf('node-gpu-temperature')
export const NODE_CONTAINER_CURRENT_KEY: MetricsKey<'container-current-mib'> =
  keyOf('container-current-mib')

/**
 * The PID-scoped keys of the earlier build. NOT written any more; kept only so
 * a spec can pin that nothing writes them again.
 */
export const NODE_PROCESS_CPU_KEY: MetricsKey<'process-cpu-percent'> = keyOf('process-cpu-percent')
export const NODE_PROCESS_RSS_KEY: MetricsKey<'process-rss-mib'> = keyOf('process-rss-mib')

/**
 * Node totals are written at most this often per node. The resources snapshot
 * fires on any coarse change (every 5 s at worst) and device-history refuses a
 * point closer than 10 s to the previous one of its series (`rate`).
 */
export const NODE_TOTALS_MIN_INTERVAL_MS = 15_000

/**
 * The per-runner series are downsampled to device-history's point cadence:
 * one point per series per this many ms, sustained. Process snapshots arrive
 * at the load-series cadence (5–60 s, `load-series-config.ts`), and at 5 s
 * writing each one has every other batch refused whole for `rate`.
 *
 * These two numbers MIRROR `RECORD_MIN_INTERVAL_MS` / `RECORD_RATE_SLACK_MS`
 * of the ingest door (`device-history/ingest/producer-ingest.ts`) — a builtin
 * does not import another — and `node-metrics-history-cadence.spec.ts` pins
 * them equal, so the door moving fails a spec instead of a day of history.
 */
export const RUNNER_SAMPLE_MIN_INTERVAL_MS = 10_000
export const RUNNER_SAMPLE_RATE_SLACK_MS = 1_000

/** The producer's copy of the door's slot for one node's batch. */
interface SampleSlot {
  readonly lastTs: number
  readonly nextDue: number
}

/** True when the door would take a point at `ts` after `slot`. */
function sampleIsDue(slot: SampleSlot | undefined, ts: number): boolean {
  if (slot === undefined || ts < slot.lastTs) return true
  return ts >= slot.nextDue - RUNNER_SAMPLE_RATE_SLACK_MS
}

/** The slot after a batch at `ts` was accepted — the door's own grid rule. */
function nextSampleSlot(slot: SampleSlot | undefined, ts: number): SampleSlot {
  if (slot === undefined) return { lastTs: ts, nextDue: ts + RUNNER_SAMPLE_MIN_INTERVAL_MS }
  if (ts < slot.lastTs) return slot
  return { lastTs: ts, nextDue: Math.max(slot.nextDue, ts) + RUNNER_SAMPLE_MIN_INTERVAL_MS }
}

interface SeriesDeclaration {
  readonly name: string
  readonly displayName: string
  readonly unit: string
}

const DECLARATIONS: readonly SeriesDeclaration[] = [
  { name: 'runner-cpu-main-percent', displayName: 'Runner CPU % (main thread)', unit: '%' },
  { name: 'runner-cpu-gc-percent', displayName: 'Runner CPU % (GC)', unit: '%' },
  {
    name: 'runner-cpu-lifetime-percent',
    displayName: 'Runner CPU % (lifetime average)',
    unit: '%',
  },
  { name: 'runner-rss-mib', displayName: 'Runner RSS (MiB)', unit: 'MiB' },
  { name: 'runner-processes', displayName: 'Runner processes', unit: 'count' },
  { name: 'node-cpu-percent', displayName: 'Node CPU %', unit: '%' },
  { name: 'node-memory-percent', displayName: 'Node memory %', unit: '%' },
  { name: 'node-cpu-temperature', displayName: 'Node CPU temperature', unit: '°C' },
  { name: 'node-gpu-percent', displayName: 'Node GPU %', unit: '%' },
  { name: 'node-gpu-temperature', displayName: 'Node GPU temperature', unit: '°C' },
  { name: 'container-current-mib', displayName: 'Container memory current (MiB)', unit: 'MiB' },
]

export interface NodeHistoryPoint {
  readonly key: string
  readonly subject: { readonly kind: 'node'; readonly nodeId: string }
  readonly scope: string
  readonly ts: number
  readonly value: number
}

export interface NodeHistoryQueryInput {
  readonly forNodeId: string
  readonly key: string
  readonly from: number
  readonly to: number
  readonly resolution: 'raw'
  readonly maxPoints?: number
}

export interface NodeHistoryQueryAnswer {
  readonly series: ReadonlyArray<{
    readonly scope: string
    readonly points: ReadonlyArray<{ t: number; value: number | null; samples: number }>
  }>
}

export interface NodeMetricsHistoryClient {
  declareSeries(input: {
    name: string
    subjectKind: 'node'
    kind: 'gauge'
    displayName: string
    ingest: 'points'
    unit?: string
  }): Promise<{ key: string }>
  record(input: { points: readonly NodeHistoryPoint[] }): Promise<DeviceHistoryIngestResult>
  queryNode(input: NodeHistoryQueryInput): Promise<NodeHistoryQueryAnswer>
}

export function nodeMetricsHistoryClient(api: AddonApi['deviceHistory']): NodeMetricsHistoryClient {
  return {
    declareSeries: (input) => api.declareSeries.mutate(input),
    record: (input) => api.record.mutate({ points: [...input.points] }),
    queryNode: async (input) => {
      const result = await api.queryNode.query({ ...input })
      return {
        series: result.series.map((s) => ({
          scope: s.scope,
          points: s.points.map((p) => ({
            t: p.t,
            samples: p.samples,
            value: p.last ?? p.mean,
          })),
        })),
      }
    },
  }
}

export interface NodeMetricsHistoryRecorderDeps {
  readonly deviceHistory: NodeMetricsHistoryClient
  readonly logger: IScopedLogger
  /**
   * The registry's answer to "is device-history up?" — read without blocking.
   * While it is not, a sample is not stored (logged once per wait) and no
   * declare is attempted: a declare against an absent provider is a failure
   * line per sample, not a wait. Omitted ⇒ always ready (specs).
   */
  readonly historyReady?: () => boolean
}

function refusalCounts(result: DeviceHistoryIngestResult): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const r of result.refused) counts[r.reason] = (counts[r.reason] ?? 0) + r.count
  return counts
}

/** The fold's function key of a process: the same rule as `foldSnapshotByFunction`. */
export function runnerScopeOf(process: RetainedProcess): string {
  if (process.addonId !== null) return process.addonId
  return process.classification === 'root' ? ROOT_BUCKET_KEY : UNATTRIBUTED_BUCKET_KEY
}

interface RunnerTotals {
  main: number
  gc: number
  splitKnown: boolean
  lifetime: number
  rss: number
  count: number
}

function round1(value: number): number {
  return Math.round(value * 10) / 10
}

export class NodeMetricsHistoryRecorder {
  private declared = false
  private readonly lastTotalsAt = new Map<string, number>()
  /** Per node: the door's slot for the per-runner batch (see {@link sampleIsDue}). */
  private readonly sampleSlots = new Map<string, SampleSlot>()
  /** A not-ready skip was logged and device-history has not been ready since. */
  private waitLogged = false
  constructor(private readonly deps: NodeMetricsHistoryRecorderDeps) {}

  async declare(): Promise<void> {
    if (this.declared) return
    for (const d of DECLARATIONS) {
      await this.deps.deviceHistory.declareSeries({
        name: d.name,
        subjectKind: 'node',
        kind: 'gauge',
        displayName: d.displayName,
        ingest: 'points',
        unit: d.unit,
      })
    }
    this.declared = true
  }

  /** One process snapshot: per-runner sums plus the container's memory. */
  async recordSample(
    nodeId: string,
    atMs: number,
    processes: readonly RetainedProcess[],
    containerMemory: ContainerMemorySnapshot | null,
  ): Promise<void> {
    // Downsampled to the door's cadence: a snapshot between slots is held by
    // the hot ring only, by design — not a refusal, so not a log line.
    if (!sampleIsDue(this.sampleSlots.get(nodeId), atMs)) return
    const subject = { kind: 'node', nodeId } as const
    const point = (key: string, scope: string, value: number): NodeHistoryPoint => ({
      key,
      subject,
      scope,
      ts: atMs,
      value,
    })
    const byRunner = new Map<string, RunnerTotals>()
    for (const p of processes) {
      const scope = runnerScopeOf(p)
      const t = byRunner.get(scope) ?? {
        main: 0,
        gc: 0,
        splitKnown: true,
        lifetime: 0,
        rss: 0,
        count: 0,
      }
      const known = p.cpuMainPercent !== null && p.cpuGcPercent !== null
      byRunner.set(scope, {
        main: t.main + (p.cpuMainPercent ?? 0),
        gc: t.gc + (p.cpuGcPercent ?? 0),
        splitKnown: t.splitKnown && known,
        lifetime: t.lifetime + p.cpuPercent,
        rss: t.rss + p.memoryRssBytes,
        count: t.count + 1,
      })
    }
    const points: NodeHistoryPoint[] = []
    for (const [scope, t] of byRunner) {
      // A split only one process reported is not this runner's CPU — no point, never a partial sum.
      if (t.splitKnown) {
        points.push(point(RUNNER_CPU_MAIN_KEY, scope, round1(t.main)))
        points.push(point(RUNNER_CPU_GC_KEY, scope, round1(t.gc)))
      }
      points.push(point(RUNNER_CPU_LIFETIME_KEY, scope, round1(t.lifetime)))
      points.push(point(RUNNER_RSS_KEY, scope, Math.round(t.rss / MIB)))
      points.push(point(RUNNER_PROCESSES_KEY, scope, t.count))
    }
    if (containerMemory !== null) {
      points.push(
        point(NODE_CONTAINER_CURRENT_KEY, '', Math.round(containerMemory.currentBytes / MIB)),
      )
    }
    const accepted = await this.write(nodeId, atMs, points)
    // Only a batch the door TOOK spends the slot: an undeclared or failed
    // write leaves the next snapshot free to land.
    if (accepted > 0) {
      this.sampleSlots.set(nodeId, nextSampleSlot(this.sampleSlots.get(nodeId), atMs))
    }
  }

  /** One resources snapshot: the node's totals, at most every {@link NODE_TOTALS_MIN_INTERVAL_MS}. */
  async recordTotals(
    nodeId: string,
    atMs: number,
    snapshot: SystemResourceSnapshot,
  ): Promise<void> {
    const last = this.lastTotalsAt.get(nodeId)
    if (last !== undefined && atMs >= last && atMs - last < NODE_TOTALS_MIN_INTERVAL_MS) return
    this.lastTotalsAt.set(nodeId, atMs)
    const subject = { kind: 'node', nodeId } as const
    const points: NodeHistoryPoint[] = []
    const add = (key: string, value: number | null): void => {
      if (value === null || !Number.isFinite(value)) return
      points.push({ key, subject, scope: '', ts: atMs, value: round1(value) })
    }
    add(NODE_CPU_KEY, snapshot.cpu.total)
    add(NODE_MEMORY_KEY, snapshot.memory.percent)
    add(NODE_CPU_TEMPERATURE_KEY, snapshot.cpuTemperature)
    add(NODE_GPU_KEY, snapshot.gpu?.utilization ?? null)
    add(NODE_GPU_TEMPERATURE_KEY, snapshot.gpu?.temperature ?? null)
    await this.write(nodeId, atMs, points)
  }

  private async write(
    nodeId: string,
    atMs: number,
    points: readonly NodeHistoryPoint[],
  ): Promise<number> {
    if (points.length === 0) return 0
    if (!(await this.ensureDeclared())) return 0
    try {
      const result = await this.deps.deviceHistory.record({ points })
      if (result.refused.length > 0) {
        if (result.refused.some((r) => r.reason === 'undeclared')) this.declared = false
        this.deps.logger.warn('node metrics history points refused', {
          meta: { nodeId, accepted: result.accepted, refused: refusalCounts(result) },
        })
      }
      return result.accepted
    } catch (err: unknown) {
      this.deps.logger.warn('node metrics history sample not stored', {
        meta: { nodeId, atMs, error: err instanceof Error ? err.message : String(err) },
      })
      return 0
    }
  }

  async readContainerPoints(
    nodeId: string,
    sinceMs: number,
    maxPoints: number,
  ): Promise<readonly ContainerMemoryPoint[]> {
    if (!(await this.ensureDeclared())) return []
    const result = await this.deps.deviceHistory.queryNode({
      forNodeId: nodeId,
      key: NODE_CONTAINER_CURRENT_KEY,
      from: sinceMs + 1,
      to: Date.now(),
      resolution: 'raw',
      maxPoints,
    })
    const out: ContainerMemoryPoint[] = []
    for (const s of result.series) {
      for (const p of s.points) {
        if (p.value === null || !Number.isFinite(p.value)) continue
        out.push({
          atMs: p.t,
          source: 'cgroup-v2',
          currentBytes: p.value * MIB,
          limitBytes: null,
          anonBytes: null,
          fileBytes: null,
          shmemBytes: null,
          slabBytes: null,
          gpuShmemBytes: null,
        })
      }
    }
    return out.toSorted((a, b) => a.atMs - b.atMs)
  }

  /**
   * The cold tier as process samples the fold reads like the hot ring's. A
   * runner's sums come back as `processes` equal rows (sums preserved, count
   * right); its CPU split is `null` where it was not recorded.
   */
  async readProcessSamples(
    nodeId: string,
    sinceMs: number,
    maxPoints: number,
  ): Promise<readonly RetainedSample[]> {
    if (!(await this.ensureDeclared())) return []
    const to = Date.now()
    const read = (key: string): Promise<NodeHistoryQueryAnswer> =>
      this.deps.deviceHistory.queryNode({
        forNodeId: nodeId,
        key,
        from: sinceMs + 1,
        to,
        resolution: 'raw',
        maxPoints,
      })
    const [main, gc, lifetime, rss, count] = await Promise.all([
      read(RUNNER_CPU_MAIN_KEY),
      read(RUNNER_CPU_GC_KEY),
      read(RUNNER_CPU_LIFETIME_KEY),
      read(RUNNER_RSS_KEY),
      read(RUNNER_PROCESSES_KEY),
    ])
    return assembleRunnerSamples({ main, gc, lifetime, rss, count })
  }

  private async ensureDeclared(): Promise<boolean> {
    if (this.deps.historyReady !== undefined && !this.deps.historyReady()) {
      if (!this.waitLogged) {
        this.waitLogged = true
        this.deps.logger.info(
          'node metrics history waits for device-history — samples until it is ready are not stored',
        )
      }
      return false
    }
    this.waitLogged = false
    try {
      await this.declare()
      return true
    } catch (err: unknown) {
      this.deps.logger.warn('node metrics history declare failed', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
      return false
    }
  }
}

/** `atMs -> scope -> value` of one key's answer, finite values only. */
function indexAnswer(answer: NodeHistoryQueryAnswer): Map<number, Map<string, number>> {
  const out = new Map<number, Map<string, number>>()
  for (const s of answer.series) {
    for (const p of s.points) {
      if (p.value === null || !Number.isFinite(p.value)) continue
      const at = out.get(p.t) ?? new Map<string, number>()
      at.set(s.scope, p.value)
      out.set(p.t, at)
    }
  }
  return out
}

export interface RunnerAnswers {
  readonly main: NodeHistoryQueryAnswer
  readonly gc: NodeHistoryQueryAnswer
  readonly lifetime: NodeHistoryQueryAnswer
  readonly rss: NodeHistoryQueryAnswer
  readonly count: NodeHistoryQueryAnswer
}

/**
 * Per-runner cold points back into process rows. A sample exists where the
 * runner's lifetime CPU and RSS were both recorded (always written together).
 */
export function assembleRunnerSamples(answers: RunnerAnswers): readonly RetainedSample[] {
  const main = indexAnswer(answers.main)
  const gc = indexAnswer(answers.gc)
  const rss = indexAnswer(answers.rss)
  const count = indexAnswer(answers.count)
  const samples: RetainedSample[] = []
  for (const [atMs, lifetimeByScope] of indexAnswer(answers.lifetime)) {
    const processes: RetainedProcess[] = []
    for (const [scope, lifetime] of lifetimeByScope) {
      const rssMib = rss.get(atMs)?.get(scope)
      if (rssMib === undefined) continue
      const n = Math.max(1, Math.round(count.get(atMs)?.get(scope) ?? 1))
      const m = main.get(atMs)?.get(scope)
      const g = gc.get(atMs)?.get(scope)
      const split = m !== undefined && g !== undefined
      const isRoot = scope === ROOT_BUCKET_KEY
      const isUnattributed = scope === UNATTRIBUTED_BUCKET_KEY
      for (let i = 0; i < n; i += 1) {
        processes.push({
          pid: 0,
          addonId: isRoot || isUnattributed ? null : scope,
          classification: isRoot ? 'root' : isUnattributed ? 'system' : 'managed',
          cpuPercent: lifetime / n,
          memoryRssBytes: (rssMib * MIB) / n,
          cpuMainPercent: split ? m / n : null,
          cpuGcPercent: split ? g / n : null,
        })
      }
    }
    if (processes.length > 0) samples.push({ atMs, processes })
  }
  return samples.toSorted((a, b) => a.atMs - b.atMs)
}
