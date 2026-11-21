/**
 * D791 — which stored measurement still beats the table: fresh (newest for
 * its cell, younger than the stale bound, measured on the pool the node runs
 * now) or not, and the two reductions Auto tune and the shares read.
 */
import { describe, expect, it } from 'vitest'
import {
  decodeCapacityFromResults,
  measuredCapacityFromResults,
  measuredDetectorCells,
  nodeCapacityVerdictsFromResults,
  resultStandings,
} from '../results.js'
import type { NodeBenchCell, NodeBenchmarkResult, NodeDecodeProfile } from '../schemas.js'

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
      pools:
        cell.phase === 'decode'
          ? {}
          : {
              [cell.deviceKey]: {
                runtime,
                numWorkers: 1,
                concurrency: 2,
                batchMode: 'none',
              },
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

const UHD: NodeDecodeProfile = {
  width: 3840,
  height: 2160,
  fps: 15,
  codec: 'h265',
}
const FHD: NodeDecodeProfile = {
  width: 1920,
  height: 1080,
  fps: 15,
  codec: 'h264',
}

function decodeCell(
  profile: NodeDecodeProfile,
  maxStreams: number,
  hardware = true,
): NodeBenchCell {
  return {
    phase: 'decode',
    profile,
    maxStreams,
    limitedBy: 'fps',
    hardware,
    decoder: hardware ? 'vaapi' : 'software',
    motion: true,
    warmupMs: 0,
    ramp: [],
  }
}

describe('decode cells', () => {
  const ctx = { nowMs: NOW, currentPools: pools }

  it('a decode row is superseded only by a newer one for the SAME profile', () => {
    const rows = [
      row('old', decodeCell(UHD, 3), NOW - 2 * DAY),
      row('new', decodeCell(UHD, 4), NOW - DAY),
      row('fhd', decodeCell(FHD, 12), NOW - 2 * DAY),
    ]
    const standings = resultStandings(rows, ctx)
    expect(standings.get('old')?.standing).toBe('superseded')
    expect(standings.get('new')?.standing).toBe('fresh')
    expect(standings.get('fhd')?.standing).toBe('fresh')
  })

  it('a decode row goes stale by age only — it names no pool', () => {
    const r = row('a', decodeCell(UHD, 3), NOW - 31 * DAY)
    expect(resultStandings([r], ctx).get('a')).toEqual({
      standing: 'stale',
      staleWhy: 'age',
    })
  })

  it('the detector reductions do not read a decode row', () => {
    const rows = [row('d', decodeCell(UHD, 3), NOW - DAY)]
    expect(measuredCapacityFromResults(rows, ['hub'], ctx).size).toBe(0)
    expect(measuredDetectorCells(rows, 'hub', ctx)).toEqual({})
  })

  it('per node, the fresh profile that carries the FEWEST streams is the decode capacity', () => {
    const rows = [
      row('uhd', decodeCell(UHD, 4), NOW - DAY),
      row('fhd', decodeCell(FHD, 12, false), NOW - 2 * DAY),
      row('other', decodeCell(FHD, 6), NOW - DAY, 'openvino', 'agent'),
      row('stale', decodeCell(UHD, 1), NOW - 40 * DAY, 'openvino', 'agent'),
    ]
    const out = decodeCapacityFromResults(rows, ['hub', 'agent', 'none'], ctx)
    expect(out.get('hub')).toEqual({
      maxStreams: 4,
      measuredAtMs: NOW - DAY,
      profile: UHD,
      hardware: true,
      decoder: 'vaapi',
    })
    expect(out.get('agent')?.maxStreams).toBe(6)
    expect(out.has('none')).toBe(false)
  })

  it('a profile that carried no stream is a measured zero, not an absence', () => {
    const out = decodeCapacityFromResults([row('z', decodeCell(UHD, 0), NOW - DAY)], ['hub'], ctx)
    expect(out.get('hub')?.maxStreams).toBe(0)
  })

  it('the verdict of a node carries BOTH planes from its stored rows and names the smaller', () => {
    const rows = [
      row('p', pipelineCell('openvino:npu', 9), NOW - DAY),
      row('uhd', decodeCell(UHD, 4), NOW - DAY),
      row('fhd', decodeCell(FHD, 12), NOW - DAY),
      row('lonely', decodeCell(UHD, 7), NOW - DAY, 'openvino', 'agent'),
    ]
    const out = nodeCapacityVerdictsFromResults(rows, {
      ...ctx,
      runs: [{ nodeId: 'hub', deviceKey: 'openvino:npu', modelId: 'yolov9s-640' }],
    })
    expect(out.map((v) => v.nodeId)).toEqual(['agent', 'hub'])
    expect(out[1]).toMatchObject({
      capacity: 4,
      limitedBy: 'decode',
      complete: true,
      detection: { maxSessions: 9 },
      decode: { maxStreams: 4, profile: UHD },
    })
    // Decode measured, detection not: the one plane's number, flagged incomplete.
    expect(out[0]).toMatchObject({
      detection: null,
      decode: { maxStreams: 7 },
      capacity: 7,
      limitedBy: null,
      complete: false,
    })
    expect(
      nodeCapacityVerdictsFromResults(rows, {
        ...ctx,
        runs: [],
        nodeId: 'agent',
      }).map((v) => v.nodeId),
    ).toEqual(['agent'])
  })
})
