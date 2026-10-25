/**
 * Node-stress long-term statistics via device-history (D850, LTS P4).
 */

import type { DeviceHistoryIngestResult, IScopedLogger } from '@camstack/types'
import { BucketAccumulator, type ClosedHistoryBucket } from '@camstack/types'
import type { NodeStressSignals } from './node-stress.js'

export type NodeStressHistorySeries =
  | 'node-score'
  | 'node-queue-pressure'
  | 'node-drop-ratio'
  | 'node-fps-deficit'

const SERIES_KEYS: Record<NodeStressHistorySeries, string> = {
  'node-score': 'addon:pipeline-orchestrator/node-score',
  'node-queue-pressure': 'addon:pipeline-orchestrator/node-queue-pressure',
  'node-drop-ratio': 'addon:pipeline-orchestrator/node-drop-ratio',
  'node-fps-deficit': 'addon:pipeline-orchestrator/node-fps-deficit',
}

export interface NodeStressHistoryClient {
  declareSeries(input: {
    name: string
    subjectKind: 'device' | 'node'
    kind: 'gauge' | 'counter' | 'boolean'
    displayName: string
    ingest: 'points' | 'buckets'
  }): Promise<{ key: string }>
  recordBuckets(input: {
    buckets: readonly ClosedHistoryBucket[]
  }): Promise<DeviceHistoryIngestResult>
  queryNode(input: {
    forNodeId: string
    key: string
    from: number
    to: number
    resolution: '5m'
    maxPoints?: number
  }): Promise<{
    series: ReadonlyArray<{
      scope: string
      points: ReadonlyArray<{
        t: number
        samples: number
        sum: number
        min: number
        max: number
      }>
    }>
  }>
}

import type { AddonApi } from '@camstack/types'

export function nodeStressHistoryClient(api: AddonApi['deviceHistory']): NodeStressHistoryClient {
  return {
    declareSeries: (input) => api.declareSeries.mutate(input),
    recordBuckets: (input) => api.recordBuckets.mutate({ buckets: [...input.buckets] }),
    queryNode: async (input) => {
      const result = await api.queryNode.query(input)
      return {
        series: result.series.map((s) => ({
          scope: s.scope,
          points: s.points.flatMap((p) => {
            // mean null is UNKNOWN (D393) — never invent sum=0 from samples>0.
            if (p.mean === null) return []
            return [
              {
                t: p.t,
                samples: p.samples,
                sum: p.mean * p.samples,
                min: p.min,
                max: p.max,
              },
            ]
          }),
        })),
      }
    },
  }
}

export interface NodeStressHistoryProducerDeps {
  readonly deviceHistory: NodeStressHistoryClient
  readonly logger: IScopedLogger
  readonly now?: () => number
}

const SERIES_META: ReadonlyArray<{ name: NodeStressHistorySeries; displayName: string }> = [
  { name: 'node-score', displayName: 'Node stress score' },
  { name: 'node-queue-pressure', displayName: 'Node queue pressure' },
  { name: 'node-drop-ratio', displayName: 'Node drop ratio' },
  { name: 'node-fps-deficit', displayName: 'Node FPS deficit' },
]

function refusalCounts(result: DeviceHistoryIngestResult): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const r of result.refused) counts[r.reason] = (counts[r.reason] ?? 0) + r.count
  return counts
}

export class NodeStressHistoryProducer {
  private readonly accum = new BucketAccumulator()
  private readonly deviceHistory: NodeStressHistoryClient
  private readonly logger: IScopedLogger
  private readonly nowFn: () => number
  private declared = false

  constructor(deps: NodeStressHistoryProducerDeps) {
    this.deviceHistory = deps.deviceHistory
    this.logger = deps.logger
    this.nowFn = deps.now ?? ((): number => Date.now())
  }

  async declare(): Promise<void> {
    if (this.declared) return
    for (const meta of SERIES_META) {
      await this.deviceHistory.declareSeries({
        name: meta.name,
        subjectKind: 'node',
        kind: 'gauge',
        displayName: meta.displayName,
        ingest: 'buckets',
      })
    }
    this.declared = true
  }

  noteSignals(nodeId: string, signals: NodeStressSignals, at: number): void {
    const subject = { kind: 'node' as const, nodeId }
    this.accum.note(SERIES_KEYS['node-score'], subject, '', signals.score, at)
    this.accum.note(SERIES_KEYS['node-queue-pressure'], subject, '', signals.queuePressure, at)
    this.accum.note(SERIES_KEYS['node-drop-ratio'], subject, '', signals.dropRatio, at)
    this.accum.note(SERIES_KEYS['node-fps-deficit'], subject, '', signals.fpsDeficit, at)
  }

  async flushDue(now?: number): Promise<number> {
    const closed = this.accum.takeClosed(now ?? this.nowFn())
    if (closed.length === 0) return 0
    try {
      await this.declare()
      const result = await this.deviceHistory.recordBuckets({ buckets: closed })
      if (result.refused.length > 0) {
        if (result.refused.some((r) => r.reason === 'undeclared')) {
          this.declared = false
          this.accum.requeue(closed)
        }
        this.logger.warn('node-stress history buckets refused', {
          meta: {
            buckets: closed.length,
            accepted: result.accepted,
            refused: refusalCounts(result),
          },
        })
      }
      return result.accepted
    } catch (err: unknown) {
      const dropped = this.accum.requeue(closed)
      this.logger.warn('node-stress history flush failed — requeued', {
        meta: {
          buckets: closed.length,
          dropped: dropped.length,
          error: err instanceof Error ? err.message : String(err),
        },
      })
      return 0
    }
  }

  async read(input: {
    subject?: string
    series?: string
    from?: number
    to?: number
    maxPoints?: number
  }): Promise<
    ReadonlyArray<{
      subject: string
      series: string
      scope: string
      bucketStart: number
      samples: number
      sum: number
      min: number
      max: number
    }>
  > {
    const nodeId = input.subject
    if (nodeId === undefined || input.series === undefined) return []
    const key = SERIES_KEYS[input.series as NodeStressHistorySeries]
    if (key === undefined) return []
    const result = await this.deviceHistory.queryNode({
      forNodeId: nodeId,
      key,
      from: input.from ?? 0,
      to: input.to ?? Date.now(),
      resolution: '5m',
      ...(input.maxPoints !== undefined ? { maxPoints: input.maxPoints } : {}),
    })
    const rows: Array<{
      subject: string
      series: string
      scope: string
      bucketStart: number
      samples: number
      sum: number
      min: number
      max: number
    }> = []
    for (const s of result.series) {
      for (const p of s.points) {
        rows.push({
          subject: nodeId,
          series: input.series,
          scope: s.scope,
          bucketStart: p.t,
          samples: p.samples,
          sum: p.sum,
          min: p.min,
          max: p.max,
        })
      }
    }
    return rows
  }

  openBuckets(): readonly [] {
    return []
  }
}
