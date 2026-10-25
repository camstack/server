/**
 * D791 — measured on this node beats the table. A fresh node benchmark
 * result for (device, model) replaces the hardware-class latency cell; the
 * choice names its source; a node of unknown hardware is recommended from its
 * measurements alone; without measurements nothing changes.
 */
import { describe, expect, it } from 'vitest'
import type { HardwareInfo } from '../../../interfaces/platform.js'
import type { ModelFormat } from '../../../types/models.js'
import { type AutoTuneNodeInput, recommendNode } from '../recommend.js'

function hw(cpuModel: string): HardwareInfo {
  return {
    platform: 'linux',
    arch: 'x64',
    cpuModel,
    cpuCores: 4,
    totalRAM_MB: 16384,
    availableRAM_MB: 8192,
    gpu: null,
    npu: null,
  }
}

const FORMATS: Readonly<Record<string, readonly ModelFormat[]>> = Object.fromEntries(
  ['t', 's', 'm'].flatMap((tier) =>
    ['320', '640'].flatMap((res) => [
      [`yolov9${tier}-${res}`, ['onnx', 'openvino'] as readonly ModelFormat[]],
      [`yolov9${tier}-${res}-int8`, ['openvino'] as readonly ModelFormat[]],
    ]),
  ),
)

const N100: AutoTuneNodeInput = {
  nodeId: 'agent-a',
  reachable: true,
  hardware: hw('Intel(R) N100'),
  devices: [{ key: 'openvino:gpu', format: 'openvino', enabled: true, available: true }],
  formatsByModel: FORMATS,
}

function chosen(rec: ReturnType<typeof recommendNode>) {
  return rec.devices.find((d) => d.deviceKey === 'openvino:gpu')?.chosen ?? null
}

describe('recommendNode — measured on the node beats the table', () => {
  it('without measurements the table decides, and the choice says so', () => {
    const c = chosen(recommendNode({ node: N100 }))
    expect(c?.modelId).toBe('yolov9s-320-int8')
    expect(c?.source).toEqual({ kind: 'table' })
  })

  it('a measured cell replaces the table: a faster-than-table m-320-int8 now fits two sessions', () => {
    const rec = recommendNode({
      node: N100,
      measured: {
        'openvino:gpu': {
          'yolov9m-320-int8': { p50Ms: 9, fps: 40, resultId: 'r1', measuredAtMs: 123 },
        },
      },
    })
    const c = chosen(rec)
    expect(c?.modelId).toBe('yolov9m-320-int8')
    expect(c?.fps).toBe(40)
    expect(c?.measured).toBe(true)
    expect(c?.source).toEqual({ kind: 'node-benchmark', resultId: 'r1', measuredAtMs: 123 })
  })

  it('a measured cell slower than the table steps the model down', () => {
    const rec = recommendNode({
      node: N100,
      measured: {
        'openvino:gpu': {
          'yolov9s-320-int8': { p50Ms: 60, fps: 15, resultId: 'r2', measuredAtMs: 1 },
        },
      },
    })
    expect(chosen(rec)?.modelId).not.toBe('yolov9s-320-int8')
  })

  it('an unknown hardware class is recommended from its measurements alone', () => {
    const node: AutoTuneNodeInput = { ...N100, hardware: hw('AMD Ryzen 5 7640HS') }
    expect(recommendNode({ node }).skipped).toBe(true)
    const rec = recommendNode({
      node,
      measured: {
        'openvino:gpu': {
          'yolov9s-640': { p50Ms: 12, fps: 60, resultId: 'r3', measuredAtMs: 1 },
        },
      },
    })
    expect(rec.skipped).toBe(false)
    expect(chosen(rec)?.modelId).toBe('yolov9s-640')
    expect(chosen(rec)?.source?.kind).toBe('node-benchmark')
  })
})
