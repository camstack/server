/**
 * D913 follow-up — the automatic shares size a device from the freshest result
 * for the model it runs NOW, whichever phase measured it: a `pipeline` cell
 * first, a `device` cell's `kMax` otherwise, a cell for another model never.
 *
 * Fixtures are the two live cases: the Mac (an auto-benchmark's device-phase
 * cell only) and agent-a (a failed pipeline cell for a heavier build next
 * to a device cell for the build it runs).
 */
import { describe, expect, it } from 'vitest'
import type { HardwareInfo } from '../../../interfaces/platform.js'
import type { ModelFormat } from '../../../types/models.js'
import { type AutoTuneNodeInput, recommendNode } from '../../auto-tune/recommend.js'
import { measuredCapacityFromResults } from '../../node-benchmark/results.js'
import type { NodeBenchCell, NodeBenchmarkResult } from '../../node-benchmark/schemas.js'
import {
  capacityForModel,
  computeCapacityShares,
  foreignCapacityCells,
} from '../capacity-shares.js'

const DAY = 86_400_000
const NOW = 200 * DAY

function hw(cpuModel: string, arch: HardwareInfo['arch']): HardwareInfo {
  return {
    platform: arch === 'arm64' ? 'darwin' : 'linux',
    arch,
    cpuModel,
    cpuCores: 8,
    totalRAM_MB: 16384,
    availableRAM_MB: 8192,
    gpu: null,
    npu: null,
  }
}

const FORMATS: Readonly<Record<string, readonly ModelFormat[]>> = Object.fromEntries(
  ['t', 's', 'm'].flatMap((tier) =>
    ['320', '640'].flatMap((res) => [
      [`yolov9${tier}-${res}`, ['onnx', 'openvino', 'coreml'] as const],
      [`yolov9${tier}-${res}-int8`, ['openvino'] as const],
    ]),
  ),
)

const MAC: AutoTuneNodeInput = {
  nodeId: 'mac',
  reachable: true,
  hardware: hw('Apple M2', 'arm64'),
  devices: [{ key: 'coreml:all', format: 'coreml', enabled: true, available: true }],
  formatsByModel: FORMATS,
}
const UNRAID: AutoTuneNodeInput = {
  nodeId: 'agent-a',
  reachable: true,
  hardware: hw('Intel(R) N100', 'x64'),
  devices: [{ key: 'openvino:gpu', format: 'openvino', enabled: true, available: true }],
  formatsByModel: FORMATS,
}

const recs = [recommendNode({ node: MAC }), recommendNode({ node: UNRAID })]

function chosenOf(nodeId: string): string {
  const modelId = recs.find((r) => r.nodeId === nodeId)?.devices[0]?.chosen?.modelId
  if (modelId === undefined) throw new Error(`fixture: ${nodeId} has no chosen model`)
  return modelId
}

function deviceCell(deviceKey: string, modelId: string, kMax: number): NodeBenchCell {
  return {
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
}

function pipelineCell(deviceKey: string, modelId: string, maxSessions: number): NodeBenchCell {
  return {
    phase: 'pipeline',
    deviceKey,
    modelId,
    steps: ['face-detection'],
    maxSessions,
    limitedBy: 'cpu',
    stepsFired: [],
    warmupMs: 0,
    ramp: [],
  }
}

function row(
  id: string,
  nodeId: string,
  cell: NodeBenchCell,
  ageDays: number,
): NodeBenchmarkResult {
  return {
    id,
    runId: id,
    nodeId,
    cell,
    fpsPerStream: 10,
    fingerprint: null,
    clip: null,
    contaminated: false,
    stayingCameras: [],
    partialRun: false,
    measuredAtMs: NOW - ageDays * DAY,
  }
}

function sharesOf(rows: readonly NodeBenchmarkResult[]) {
  const measured = measuredCapacityFromResults(rows, ['mac', 'agent-a'], {
    nowMs: NOW,
    currentPools: {},
  })
  return {
    measured,
    result: computeCapacityShares({
      recommendations: recs,
      source: 'benchmark',
      measured,
      headroom: 0.4,
      cameraFps: 10,
      minSessionsPerDevice: 2,
    }),
  }
}

describe('automatic shares from a device-phase result (the Mac)', () => {
  const macRun = row('nb-mac', 'mac', deviceCell('coreml:all', chosenOf('mac'), 8), 1)

  it('a device-only auto-benchmark moves the node to benchmark capacity: kMax sessions', () => {
    const { result } = sharesOf([macRun])
    const mac = result.nodes.find((n) => n.nodeId === 'mac')
    expect(mac).toMatchObject({
      capacitySource: 'benchmark',
      capacityFallback: null,
      capacitySessions: 8,
    })
    expect(mac?.devices[0]).toMatchObject({ deviceKey: 'coreml:all', measured: true })
  })

  it('a pipeline cell for the same model beats the device cell, however old', () => {
    const { result } = sharesOf([
      macRun,
      row('p', 'mac', pipelineCell('coreml:all', chosenOf('mac'), 3), 20),
    ])
    expect(result.nodes.find((n) => n.nodeId === 'mac')?.capacitySessions).toBe(3)
  })

  it('a device cell for another model is ignored: the node falls back, and the cell is named', () => {
    const other = row('nb-other', 'mac', deviceCell('coreml:all', 'yolov9t-320', 8), 1)
    const { result, measured } = sharesOf([other])
    expect(result.nodes.find((n) => n.nodeId === 'mac')).toMatchObject({
      capacitySource: 'hardware',
      capacityFallback: 'no-benchmark-results',
    })
    expect(foreignCapacityCells(recs, measured)).toEqual([
      {
        nodeId: 'mac',
        deviceKey: 'coreml:all',
        measuredModelId: 'yolov9t-320',
        runsModelId: chosenOf('mac'),
      },
    ])
  })
})

describe('automatic shares when the only pipeline cell is for another model (agent-a)', () => {
  const runs = chosenOf('agent-a')
  const failedOther = row(
    'old-pipe',
    'agent-a',
    // 2026-10-10: a heavier build failed at load 1 → 0 sessions.
    pipelineCell('openvino:gpu', 'yolov9m-320-int8', 0),
    13,
  )
  const deviceOfRunning = row('dev', 'agent-a', deviceCell('openvino:gpu', runs, 4), 1)

  it('is sized by the device cell of the model it runs, not the failed cell of another', () => {
    const { result, measured } = sharesOf([failedOther, deviceOfRunning])
    const node = result.nodes.find((n) => n.nodeId === 'agent-a')
    expect(node).toMatchObject({ capacitySource: 'benchmark', capacitySessions: 4 })
    expect(capacityForModel(measured.get('agent-a'), 'openvino:gpu', runs)).toMatchObject({
      phase: 'device',
      maxSessions: 4,
    })
  })

  it('with no cell for the model it runs, the failed other-model cell is not read as zero', () => {
    const { result } = sharesOf([failedOther])
    expect(result.nodes.find((n) => n.nodeId === 'agent-a')).toMatchObject({
      capacitySource: 'hardware',
      capacityFallback: 'no-benchmark-results',
    })
  })
})
