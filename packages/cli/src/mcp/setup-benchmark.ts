/**
 * `setup_benchmark` (read): the node benchmark and the detector-latency status
 * per node x device, in one answer. It composes two tools that already exist —
 * `support_benchmark_status` (the hub's own node benchmark) and
 * `ops_accelerators` (which node x device cells the Auto-tune latency table
 * holds) — and adds the proposal: which cells to measure next. The measurement
 * itself is `support_benchmark_run`, already gated; there is no second writer.
 */
import type { McpContext } from './context.js'
import type { NoSessionResult, RefusedResult } from './ops-hub.js'
import { opsAccelerators, type NodeAccelerators } from './ops-accelerators.js'
import {
  supportBenchmarkStatus,
  BENCHMARK_RUN_TOOL,
  type BenchmarkStatusResult,
} from './support-benchmark.js'

export interface BenchmarkTarget {
  readonly tool: typeof BENCHMARK_RUN_TOOL
  readonly nodeId: string
  readonly deviceKey: string
  readonly reason: string
}

export interface SetupBenchmarkResult {
  readonly status: 'ok'
  readonly run: BenchmarkStatusResult['run']
  readonly storedResults: BenchmarkStatusResult['storedResults']
  readonly nodes: readonly NodeAccelerators[]
  readonly proposal: {
    readonly measure: readonly BenchmarkTarget[]
    readonly notes: readonly string[]
  }
  readonly unavailable: { readonly [part: string]: string }
}

/** Pure: the cells worth measuring — a usable device whose latency row is not measured. */
export function proposeBenchmarks(
  nodes: readonly NodeAccelerators[],
): SetupBenchmarkResult['proposal'] {
  const measure: BenchmarkTarget[] = []
  const notes: string[] = []
  for (const node of nodes) {
    if (!node.online) {
      notes.push(`${node.nodeId}: offline`)
      continue
    }
    if (node.devices === null) {
      notes.push(`${node.nodeId}: devices could not be read, nothing proposed`)
      continue
    }
    for (const d of node.devices) {
      if (!d.available || d.exclusion !== null) continue
      if (d.benchmark === null) {
        notes.push(
          `${node.nodeId} ${d.key}: hardware class unknown, cannot tell whether it is measured`,
        )
        continue
      }
      if (d.benchmark.state === 'measured') continue
      measure.push({
        tool: BENCHMARK_RUN_TOOL,
        nodeId: node.nodeId,
        deviceKey: d.key,
        reason:
          d.benchmark.state === 'estimated-only'
            ? 'the latency table has only estimates for this hardware class'
            : 'no latency cell for this hardware class',
      })
    }
  }
  return { measure, notes }
}

export async function setupBenchmark(
  ctx: McpContext,
  args: { readonly nodeId?: string },
): Promise<SetupBenchmarkResult | NoSessionResult | RefusedResult> {
  const [status, accelerators] = await Promise.all([
    supportBenchmarkStatus(ctx, args.nodeId !== undefined ? { nodeId: args.nodeId } : {}),
    opsAccelerators(ctx),
  ])
  if (status.status !== 'ok') return status
  if (accelerators.status !== 'ok') return accelerators
  const nodes =
    args.nodeId !== undefined
      ? accelerators.nodes.filter((n) => n.nodeId === args.nodeId)
      : accelerators.nodes
  return {
    status: 'ok',
    run: status.run,
    storedResults: status.storedResults,
    nodes,
    proposal: proposeBenchmarks(nodes),
    unavailable: { ...status.unavailable, ...accelerators.unavailable },
  }
}
