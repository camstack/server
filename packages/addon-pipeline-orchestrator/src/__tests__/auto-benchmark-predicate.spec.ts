/**
 * "Has results" for the automatic benchmark is the automatic shares' own
 * predicate: a fresh cell for the model the device runs NOW. A result for
 * another model does not count, so the device is measured again.
 */
import {
  measuredCapacityFromResults,
  type NodeBenchCell,
  type NodeBenchmarkResult,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  benchKey,
  benchmarkedDevices,
  planAutoBenchmark,
} from '../node-benchmark/auto-benchmark.js'

const DAY = 86_400_000
const NOW = 100 * DAY

function deviceRow(
  nodeId: string,
  deviceKey: string,
  modelId: string,
  kMax: number,
): NodeBenchmarkResult {
  const cell: NodeBenchCell = {
    phase: 'device',
    deviceKey,
    modelId,
    p50Ms: 10,
    p95Ms: 12,
    p99Ms: 14,
    fps: 80,
    kMax,
    limitedBy: 'p95',
    warmupMs: 0,
    ramp: [],
  }
  return {
    id: `${nodeId}:${deviceKey}:${modelId}`,
    runId: 'r',
    nodeId,
    cell,
    fpsPerStream: 10,
    fingerprint: null,
    clip: null,
    contaminated: false,
    stayingCameras: [],
    partialRun: false,
    measuredAtMs: NOW - DAY,
  }
}

const measured = (rows: readonly NodeBenchmarkResult[]) =>
  measuredCapacityFromResults(rows, ['mac', 'agent-a'], { nowMs: NOW, currentPools: {} })

describe('benchmarkedDevices', () => {
  it('the Mac: a device-phase result for the model it runs counts', () => {
    const set = benchmarkedDevices(
      [{ nodeId: 'mac', deviceKey: 'coreml:all', modelId: 'yolov9m-640' }],
      measured([deviceRow('mac', 'coreml:all', 'yolov9m-640', 8)]),
    )
    expect(set.has(benchKey('mac', 'coreml:all'))).toBe(true)
  })

  it('agent-a: a result for another model does not count, so the device is measured again', () => {
    const rows = [deviceRow('agent-a', 'openvino:gpu', 'yolov9m-320-int8', 0)]
    const set = benchmarkedDevices(
      [{ nodeId: 'agent-a', deviceKey: 'openvino:gpu', modelId: 'yolov9s-320-int8' }],
      measured(rows),
    )
    expect(set.has(benchKey('agent-a', 'openvino:gpu'))).toBe(false)
    const plan = planAutoBenchmark({
      nodes: [
        {
          nodeId: 'agent-a',
          online: true,
          camerasOnNode: 0,
          devices: [{ key: 'openvino:gpu', available: true, exclusion: null }],
        },
      ],
      benchmarked: set,
      runActive: false,
      attempts: new Map(),
      nowMs: NOW,
    })
    expect(plan.start).toEqual({ nodeId: 'agent-a', deviceKeys: ['openvino:gpu'] })
  })

  it('a device whose model is unknown has no usable result', () => {
    const set = benchmarkedDevices(
      [{ nodeId: 'mac', deviceKey: 'coreml:all', modelId: null }],
      measured([deviceRow('mac', 'coreml:all', 'yolov9m-640', 8)]),
    )
    expect(set.size).toBe(0)
  })
})
