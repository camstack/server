/**
 * Benchmark mode (D791) — the pure rules of "one node under test". Pure.
 *
 * While the cluster is in benchmark mode for node N:
 *  - N is not a detection candidate for any camera that another node can
 *    serve ({@link eligibleUnderBenchmark});
 *  - a node pin naming N is ignored for such a camera
 *    ({@link pinUnderBenchmark}) — the stored pin is never rewritten, so it
 *    is "restored" the moment the mode ends;
 *  - a camera whose ONLY frame source is N stays on N (never blind) and the
 *    run is flagged contaminated.
 */
import {
  NODE_BENCHMARK_DEFAULTS,
  type NodeBenchmarkMovingCamera,
  type NodeBenchmarkPlan,
  type NodeBenchmarkRefusal,
  type NodeBenchmarkStayingCamera,
} from './schemas.js'

/** The detection candidates of one camera while `benchNodeId` is under test. */
export function eligibleUnderBenchmark(
  eligible: readonly string[],
  benchNodeId: string | null,
): readonly string[] {
  if (benchNodeId === null || !eligible.includes(benchNodeId)) return eligible
  const others = eligible.filter((n) => n !== benchNodeId)
  // The node under test is the camera's only frame source: it stays there.
  return others.length > 0 ? others : eligible
}

/** A camera's node pin while `benchNodeId` is under test (null = no pin). */
export function pinUnderBenchmark(
  pin: string | null,
  benchNodeId: string | null,
  eligible: readonly string[],
): string | null {
  if (pin === null || benchNodeId === null || pin !== benchNodeId) return pin
  return eligible.some((n) => n !== benchNodeId) ? null : pin
}

/** One camera as the preflight sees it. */
export interface BenchmarkCameraFacts {
  readonly deviceId: number
  /** The node its detection is placed on now; null = not placed. */
  readonly placedNodeId: string | null
  /** Its stored node pin; null = none. */
  readonly nodePin: string | null
  /** Nodes that can obtain its frames (before the benchmark). */
  readonly frameSourceNodes: readonly string[]
}

/** Which cameras leave the node for the run, and which cannot. */
export function classifyCamerasForBenchmark(
  nodeId: string,
  cameras: readonly BenchmarkCameraFacts[],
): {
  readonly moving: readonly NodeBenchmarkMovingCamera[]
  readonly staying: readonly NodeBenchmarkStayingCamera[]
} {
  const moving: NodeBenchmarkMovingCamera[] = []
  const staying: NodeBenchmarkStayingCamera[] = []
  for (const cam of cameras.toSorted((a, b) => a.deviceId - b.deviceId)) {
    const placedOnNode = cam.placedNodeId === nodeId
    const pinnedToNode = cam.nodePin === nodeId
    if (!placedOnNode && !pinnedToNode) continue
    const onlySource = !cam.frameSourceNodes.some((n) => n !== nodeId)
    if (onlySource) staying.push({ deviceId: cam.deviceId, reason: 'only-frame-source' })
    else moving.push({ deviceId: cam.deviceId, placedOnNode, pinnedToNode })
  }
  return { moving, staying }
}

/** Ramp steps the runner tries per cell, at most. */
export const DEVICE_RAMP: readonly number[] = [1, 2, 4, 6, 8, 12, 16, 24, 32]
export const PIPELINE_RAMP: readonly number[] = [1, 2, 3, 4, 6, 8, 10, 12, 16]

/** Fixed costs around the measurement: drain, clip, warm-ups, restore. */
const OVERHEAD_MS = 3 * 60_000
const WARMUP_PER_CELL_MS = 20_000

/**
 * An upper bound on how long the run takes: every ramp step of every cell,
 * plus the drain, the clip and the restore — capped at the budget, which is
 * the hard deadline anyway. A ramp usually stops well before its last step.
 */
export function estimateNodeBenchmarkDurationMs(
  plan: NodeBenchmarkPlan,
  timing: { readonly settleSec?: number; readonly measureSec?: number } = {},
): number {
  const stepMs =
    ((timing.settleSec ?? NODE_BENCHMARK_DEFAULTS.settleSec) +
      (timing.measureSec ?? NODE_BENCHMARK_DEFAULTS.measureSec)) *
    1000
  let total = OVERHEAD_MS
  if (plan.phases.includes('device')) {
    for (const device of plan.devices) {
      total += device.modelIds.length * (WARMUP_PER_CELL_MS + DEVICE_RAMP.length * stepMs)
    }
  }
  if (plan.phases.includes('pipeline')) {
    total += plan.devices.length * (WARMUP_PER_CELL_MS + PIPELINE_RAMP.length * stepMs)
  }
  return Math.min(total, plan.budgetMinutes * 60_000)
}

/** Why a run cannot start, in the order the operator should read them. */
export function nodeBenchmarkRefusals(input: {
  readonly plan: NodeBenchmarkPlan
  /** The node a run is active for, if any. */
  readonly activeRunNodeId: string | null
  readonly online: boolean
  /** Inference devices the node reports. */
  readonly knownDeviceKeys: readonly string[]
  /** Parallel sessions the cluster runs now. */
  readonly sessionsNow: number
  /** Sessions the OTHER nodes can carry; null = unknown. */
  readonly otherNodesCapacitySessions: number | null
}): readonly NodeBenchmarkRefusal[] {
  const out: NodeBenchmarkRefusal[] = []
  if (input.activeRunNodeId !== null) {
    out.push({
      kind: 'benchmark-active',
      detail: `A benchmark of ${input.activeRunNodeId} is running — one node at a time.`,
      overridable: false,
    })
  }
  if (!input.online) {
    out.push({
      kind: 'node-offline',
      detail: `${input.plan.nodeId} is not online.`,
      overridable: false,
    })
  }
  const unknown = input.plan.devices
    .map((d) => d.deviceKey)
    .filter((k) => !input.knownDeviceKeys.includes(k))
  if (unknown.length > 0) {
    out.push({
      kind: 'unknown-device',
      detail: `${input.plan.nodeId} reports no device ${unknown.join(', ')}.`,
      overridable: false,
    })
  }
  if (input.plan.phases.length === 0) {
    out.push({ kind: 'no-phase', detail: 'Choose at least one measurement.', overridable: false })
  }
  const capacity = input.otherNodesCapacitySessions
  if (capacity !== null && input.sessionsNow > capacity && !input.plan.acceptInsufficientHeadroom) {
    out.push({
      kind: 'insufficient-headroom',
      detail: `The cluster runs ${input.sessionsNow} sessions now; the other nodes can carry ${capacity}.`,
      overridable: true,
    })
  }
  return out
}
