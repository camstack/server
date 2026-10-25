/**
 * D791 — which stored measurement still beats the table: fresh (newest for
 * its cell, younger than the stale bound, measured on the pool the node runs
 * now) or not, and the two reductions Auto tune and the shares read.
 */
import { describe, expect, it } from 'vitest'
import { measuredCapacityFromResults, measuredDetectorCells, resultStandings } from '../results.js'
import type { NodeBenchCell, NodeBenchmarkResult } from '../schemas.js'

const DAY = 86_400_000
const NOW = 100 * DAY

function deviceCell(deviceKey: string, modelId: string, fps: number): NodeBenchCell {
  return {
    phase: 'device',
    deviceKey,
    modelId,
    p50Ms: 1000 / fps,
    p95Ms: 1000 / fps,
    p99Ms: 1000 / fps,
    fps,
    kMax: Math.floor(fps / 10),
    limitedBy: 'p95',
    warmupMs: 0,
    ramp: [],
  }
}

function pipelineCell(deviceKey: string, maxSessions: number): NodeBenchCell {
  return {
    phase: 'pipeline',
    deviceKey,
    modelId: 'yolov9s-640',
    steps: ['face-detection'],
    maxSessions,
    limitedBy: 'cpu',
    stepsFired: ['face-detection'],
    warmupMs: 0,
    ramp: [],
  }
}

function row(
  id: string,
  cell: NodeBenchCell,
  measuredAtMs: number,
  runtime = 'openvino',
  nodeId = 'hub',
): NodeBenchmarkResult {
  return {
    id,
    runId: id,
    nodeId,
    cell,
    fpsPerStream: 10,
    fingerprint: {
      pipelineVersion: '1.0.0',
      cpuModel: 'Intel Core Ultra',
      ramGb: 32,
      os: 'linux',
      pools: {
        [cell.deviceKey]: { runtime, numWorkers: 1, concurrency: 2, batchMode: 'none' },
      },
    },
    clip: null,
    contaminated: false,
    stayingCameras: [],
    partialRun: false,
    measuredAtMs,
  }
}

const pools = {
  hub: {
    'openvino:npu': { runtime: 'openvino', numWorkers: 1, concurrency: 2, batchMode: 'none' },
  },
}

describe('resultStandings', () => {
  it('fresh when newest for its cell, young, and on the same pool', () => {
    const r = row('a', deviceCell('openvino:npu', 'm', 100), NOW - DAY)
    expect(resultStandings([r], { nowMs: NOW, currentPools: pools }).get('a')).toEqual({
      standing: 'fresh',
      staleWhy: null,
    })
  })
  it('stale by age after the bound (30 days default)', () => {
    const r = row('a', deviceCell('openvino:npu', 'm', 100), NOW - 31 * DAY)
    expect(resultStandings([r], { nowMs: NOW, currentPools: pools }).get('a')).toEqual({
      standing: 'stale',
      staleWhy: 'age',
    })
  })
  it('stale when the runtime or the pool tuning changed', () => {
    const r = row('a', deviceCell('openvino:npu', 'm', 100), NOW - DAY, 'onnx')
    expect(resultStandings([r], { nowMs: NOW, currentPools: pools }).get('a')?.staleWhy).toBe(
      'runtime',
    )
    const tuned = {
      hub: { 'openvino:npu': { ...pools.hub['openvino:npu'], concurrency: 4 } },
    }
    const r2 = row('b', deviceCell('openvino:npu', 'm', 100), NOW - DAY)
    expect(resultStandings([r2], { nowMs: NOW, currentPools: tuned }).get('b')?.staleWhy).toBe(
      'pool-tuning',
    )
  })
  it('an unreadable current pool does not make a row stale', () => {
    const r = row('a', deviceCell('openvino:npu', 'm', 100), NOW - DAY)
    expect(resultStandings([r], { nowMs: NOW, currentPools: {} }).get('a')?.standing).toBe('fresh')
  })
  it('an older row for the same cell is superseded', () => {
    const old = row('old', deviceCell('openvino:npu', 'm', 90), NOW - 2 * DAY)
    const neu = row('new', deviceCell('openvino:npu', 'm', 100), NOW - DAY)
    const s = resultStandings([old, neu], { nowMs: NOW, currentPools: pools })
    expect(s.get('old')?.standing).toBe('superseded')
    expect(s.get('new')?.standing).toBe('fresh')
  })
})

describe('measuredDetectorCells', () => {
  it('per device, the fresh device cells of one node as latency cells', () => {
    const rows = [
      row('a', deviceCell('openvino:npu', 'yolov9s-640', 100), NOW - DAY),
      row('b', deviceCell('openvino:npu', 'yolov9m-640', 40), NOW - 40 * DAY),
      row('c', deviceCell('openvino:npu', 'yolov9t-640', 200), NOW - DAY, 'openvino', 'mac'),
    ]
    const cells = measuredDetectorCells(rows, 'hub', { nowMs: NOW, currentPools: pools })
    expect(Object.keys(cells)).toEqual(['openvino:npu'])
    expect(cells['openvino:npu']).toEqual({
      'yolov9s-640': { p50Ms: 10, fps: 100, resultId: 'a', measuredAtMs: NOW - DAY },
    })
  })
})

describe('measuredCapacityFromResults', () => {
  it('per node, each device at its newest fresh pipeline cell', () => {
    const rows = [
      row('p1', pipelineCell('openvino:npu', 3), NOW - 3 * DAY),
      row('p2', pipelineCell('openvino:npu', 5), NOW - DAY),
      row('d', deviceCell('openvino:npu', 'yolov9s-640', 100), NOW - DAY),
    ]
    const map = measuredCapacityFromResults(rows, ['hub', 'mac'], {
      nowMs: NOW,
      currentPools: pools,
    })
    expect([...map.keys()]).toEqual(['hub'])
    expect(map.get('hub')?.devices).toEqual([
      {
        deviceKey: 'openvino:npu',
        maxSessions: 5,
        modelId: 'yolov9s-640',
        measuredAtMs: NOW - DAY,
        phase: 'pipeline',
      },
    ])
  })
})
