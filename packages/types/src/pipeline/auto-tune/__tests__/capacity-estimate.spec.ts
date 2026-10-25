/**
 * D930 — an unmeasured accelerator is scaled from the nearest measured
 * column of the same kind. A node benchmark beats the estimate. Null compute
 * is not zero. Below 10 fps an intel-igpu gets the measured overlap.
 */
import { describe, expect, it } from 'vitest'
import type { HardwareInfo } from '../../../interfaces/platform.js'
import type { ModelFormat } from '../../../types/models.js'
import {
  type AcceleratorCompute,
  ESTIMATE_COMPUTE_RATIO_MAX,
  ESTIMATE_COMPUTE_RATIO_MIN,
  N100_IGPU_CLOCK_MHZ,
  N100_IGPU_EU,
  type ReferenceCompute,
  parseAcceleratorFactsJson,
  resolveLatencyColumn,
} from '../accelerator-compute.js'
import { DETECTOR_PERF } from '../detector-performance.js'
import {
  type AutoTuneNodeInput,
  aggregateThroughputFactor,
  capacitySessionsOf,
  recommendNode,
} from '../recommend.js'

function report(
  patch: Partial<AcceleratorCompute> & Pick<AcceleratorCompute, 'deviceKey'>,
): AcceleratorCompute {
  return {
    fullDeviceName: null,
    executionUnits: null,
    clockMHz: null,
    gops: null,
    architecture: null,
    npuName: null,
    tops: null,
    vendor: null,
    webgpuArchitecture: null,
    webgpuDevice: null,
    computeUnits: null,
    ...patch,
  }
}

function hw(cpuModel: string, accelerators?: readonly AcceleratorCompute[]): HardwareInfo {
  return {
    platform: 'linux',
    arch: 'x64',
    cpuModel,
    cpuCores: 8,
    totalRAM_MB: 16384,
    availableRAM_MB: 8192,
    gpu: null,
    npu: null,
    ...(accelerators !== undefined ? { accelerators } : {}),
  }
}

const FORMATS: Readonly<Record<string, readonly ModelFormat[]>> = Object.fromEntries(
  ['t', 's', 'm'].flatMap((tier) =>
    ['320', '640'].flatMap((res) => [
      [`yolov9${tier}-${res}`, ['onnx', 'openvino', 'coreml'] as readonly ModelFormat[]],
      [`yolov9${tier}-${res}-int8`, ['openvino'] as readonly ModelFormat[]],
    ]),
  ),
)

function node(
  cpuModel: string,
  deviceKey: string,
  format: ModelFormat,
  accelerators?: readonly AcceleratorCompute[],
): AutoTuneNodeInput {
  return {
    nodeId: 'n',
    reachable: true,
    hardware: hw(cpuModel, accelerators),
    devices: [{ key: deviceKey, format, enabled: true, available: true }],
    formatsByModel: FORMATS,
  }
}

function tableFps(hardwareClass: 'intel-n-series' | 'intel-core-ultra', modelId: string): number {
  const fps = DETECTOR_PERF[hardwareClass]?.['intel-igpu']?.[modelId]?.fps
  if (fps === undefined) throw new Error(`no cell ${hardwareClass} ${modelId}`)
  return fps
}

const S320 = 'yolov9s-320-int8'

describe('resolveLatencyColumn — scale from reported compute', () => {
  it('an N305 is faster than the N100 column it is scaled from', () => {
    const n100 = tableFps('intel-n-series', S320)
    const resolved = resolveLatencyColumn({
      hardwareClass: 'intel-n-series',
      accelerator: 'intel-igpu',
      report: report({
        deviceKey: 'openvino:gpu',
        executionUnits: 32,
        clockMHz: 1250,
        gops: null,
      }),
    })
    const cell = resolved?.column[S320]
    expect(cell?.measured).toBe(false)
    expect(cell?.estimatedFrom).toBe('intel-n-series')
    expect(resolved?.estimatedFrom).toBe('intel-n-series')
    expect(cell?.fps).toBeGreaterThan(n100)
  })

  it('an N100 reporting its own EU×clock stays the measured column', () => {
    const resolved = resolveLatencyColumn({
      hardwareClass: 'intel-n-series',
      accelerator: 'intel-igpu',
      report: report({
        deviceKey: 'openvino:gpu',
        executionUnits: N100_IGPU_EU,
        clockMHz: N100_IGPU_CLOCK_MHZ,
      }),
    })
    expect(resolved?.estimatedFrom).toBeNull()
    expect(resolved?.column[S320]?.measured).toBe(true)
    expect(resolved?.column[S320]?.fps).toBe(tableFps('intel-n-series', S320))
  })

  it('UHD 770 and Iris Xe are estimated from an intel-igpu column, and the 96 EU part is faster', () => {
    const uhd = resolveLatencyColumn({
      hardwareClass: 'unknown',
      accelerator: 'intel-igpu',
      report: report({ deviceKey: 'openvino:gpu', executionUnits: 32, clockMHz: 1450 }),
    })
    const iris = resolveLatencyColumn({
      hardwareClass: 'unknown',
      accelerator: 'intel-igpu',
      report: report({ deviceKey: 'openvino:gpu', executionUnits: 96, clockMHz: 1400 }),
    })
    expect(
      uhd?.estimatedFrom === 'intel-n-series' || uhd?.estimatedFrom === 'intel-core-ultra',
    ).toBe(true)
    expect(
      iris?.estimatedFrom === 'intel-n-series' || iris?.estimatedFrom === 'intel-core-ultra',
    ).toBe(true)
    expect(uhd?.column[S320]?.measured).toBe(false)
    expect(iris?.column[S320]?.measured).toBe(false)
    const uhdFps = uhd?.column[S320]?.fps ?? 0
    const irisFps = iris?.column[S320]?.fps ?? 0
    expect(irisFps).toBeGreaterThan(uhdFps)
  })

  it('a Core Ultra stays the measured column even when its reported compute differs', () => {
    const resolved = resolveLatencyColumn({
      hardwareClass: 'intel-core-ultra',
      accelerator: 'intel-igpu',
      report: report({ deviceKey: 'openvino:gpu', executionUnits: 8, clockMHz: 300 }),
    })
    expect(resolved?.estimatedFrom).toBeNull()
    expect(resolved?.column[S320]?.measured).toBe(true)
    expect(resolved?.column[S320]?.fps).toBe(tableFps('intel-core-ultra', S320))
  })

  it('an AMD APU without a Phoenix name is estimated from the amd-igpu column', () => {
    const resolved = resolveLatencyColumn({
      hardwareClass: 'unknown',
      accelerator: 'amd-igpu',
      report: report({ deviceKey: 'onnx:webgpu', computeUnits: 7, gops: null }),
    })
    expect(resolved?.estimatedFrom).toBe('amd-phoenix')
    expect(resolved?.column['yolov9t-320']?.measured).toBe(false)
    const phoenix = DETECTOR_PERF['amd-phoenix']?.['amd-igpu']?.['yolov9t-320']?.fps ?? 0
    expect(resolved?.column['yolov9t-320']?.fps).toBeLessThan(phoenix)
  })

  it('null GOPS and no fallback compute does not invent a column', () => {
    const resolved = resolveLatencyColumn({
      hardwareClass: 'unknown',
      accelerator: 'intel-igpu',
      report: report({ deviceKey: 'openvino:gpu', gops: null }),
    })
    expect(resolved).toBeNull()
  })

  it('a GOPS of 0 is not a measurement of zero compute', () => {
    const resolved = resolveLatencyColumn({
      hardwareClass: 'unknown',
      accelerator: 'intel-igpu',
      report: report({ deviceKey: 'openvino:gpu', gops: { int8: 0, fp16: 0 } }),
    })
    expect(resolved).toBeNull()
  })

  it('clamps the scale at the named ratio band', () => {
    const n100 = tableFps('intel-n-series', S320)
    const faster = resolveLatencyColumn({
      hardwareClass: 'unknown',
      accelerator: 'intel-igpu',
      // 60 × 750 = 45000 EU·MHz: still nearer the N100 than Core Ultra, and 2.5× it.
      report: report({
        deviceKey: 'openvino:gpu',
        executionUnits: 60,
        clockMHz: N100_IGPU_CLOCK_MHZ,
      }),
    })
    const slower = resolveLatencyColumn({
      hardwareClass: 'unknown',
      accelerator: 'intel-igpu',
      report: report({
        deviceKey: 'openvino:gpu',
        executionUnits: N100_IGPU_EU,
        clockMHz: N100_IGPU_CLOCK_MHZ / 10,
      }),
    })
    expect(faster?.column[S320]?.fps).toBe(Math.round(n100 * ESTIMATE_COMPUTE_RATIO_MAX))
    expect(slower?.column[S320]?.fps).toBe(Math.round(n100 * ESTIMATE_COMPUTE_RATIO_MIN))
  })

  it('prefers int8 GOPS over EU×clock when the reference carries GOPS', () => {
    const references: readonly ReferenceCompute[] = [
      {
        hardwareClass: 'intel-n-series',
        accelerator: 'intel-igpu',
        score: { metric: 'gops-int8', value: 1000 },
      },
      {
        hardwareClass: 'intel-n-series',
        accelerator: 'intel-igpu',
        score: { metric: 'eu-mhz', value: N100_IGPU_EU * N100_IGPU_CLOCK_MHZ },
      },
    ]
    const n100 = tableFps('intel-n-series', S320)
    const resolved = resolveLatencyColumn({
      hardwareClass: 'unknown',
      accelerator: 'intel-igpu',
      report: report({
        deviceKey: 'openvino:gpu',
        gops: { int8: 1500, fp16: null },
        executionUnits: N100_IGPU_EU * 10,
        clockMHz: N100_IGPU_CLOCK_MHZ,
      }),
      references,
    })
    expect(resolved?.column[S320]?.fps).toBe(Math.round(n100 * 1.5))
  })
})

describe('recommendNode — estimate, then a node benchmark, then nothing', () => {
  it('recommends an i5 from the estimate and says so', () => {
    const rec = recommendNode({
      node: node('Intel(R) Core(TM) i5-12500', 'openvino:gpu', 'openvino', [
        report({ deviceKey: 'openvino:gpu', executionUnits: 32, clockMHz: 1450 }),
      ]),
    })
    expect(rec.skipped).toBe(false)
    expect(rec.hardwareClass).toBe('unknown')
    const chosen = rec.devices[0]?.chosen
    expect(chosen?.measured).toBe(false)
    expect(chosen?.source?.kind).toBe('estimated')
    expect(chosen?.estimatedFrom).toBe(
      chosen?.source?.kind === 'estimated' ? chosen.source.estimatedFrom : undefined,
    )
  })

  it('a node benchmark beats the estimate', () => {
    const measuredModels = Object.fromEntries(
      Object.keys(DETECTOR_PERF['intel-n-series']?.['intel-igpu'] ?? {}).map((modelId) => [
        modelId,
        { p50Ms: 5, fps: 200, resultId: 'bench', measuredAtMs: 1 },
      ]),
    )
    const rec = recommendNode({
      node: node('Intel(R) Core(TM) i5-12500', 'openvino:gpu', 'openvino', [
        report({ deviceKey: 'openvino:gpu', executionUnits: 32, clockMHz: 1450 }),
      ]),
      measured: { 'openvino:gpu': measuredModels },
    })
    const chosen = rec.devices[0]?.chosen
    expect(chosen?.measured).toBe(true)
    expect(chosen?.fps).toBe(200)
    expect(chosen?.source).toEqual({ kind: 'node-benchmark', resultId: 'bench', measuredAtMs: 1 })
    expect(chosen?.estimatedFrom).toBeUndefined()
  })

  it('null GOPS and an unknown CPU recommends nothing', () => {
    const rec = recommendNode({
      node: node('Intel(R) Core(TM) i5-12500', 'openvino:gpu', 'openvino', [
        report({ deviceKey: 'openvino:gpu', gops: null }),
      ]),
    })
    expect(rec.skipped).toBe(true)
    expect(rec.hardwareClass).toBe('unknown')
    expect(rec.reasons).toEqual([{ kind: 'no-measured-data', hardwareClass: 'unknown' }])
  })

  it('a Core Ultra plan is unchanged by a compute report', () => {
    const plain = recommendNode({
      node: node('Intel(R) Core(TM) Ultra 7 265K', 'openvino:gpu', 'openvino'),
    })
    const reported = recommendNode({
      node: node('Intel(R) Core(TM) Ultra 7 265K', 'openvino:gpu', 'openvino', [
        report({ deviceKey: 'openvino:gpu', executionUnits: 8, clockMHz: 300 }),
      ]),
    })
    expect(reported.devices[0]?.chosen).toEqual(plain.devices[0]?.chosen)
    expect(reported.devices[0]?.chosen?.measured).toBe(true)
    expect(reported.devices[0]?.chosen?.source).toEqual({ kind: 'table' })
  })

  it('an AMD APU that is not Phoenix is recommended from the estimate', () => {
    const rec = recommendNode({
      node: node('AMD Ryzen 5 5600G', 'onnx:webgpu', 'onnx', [
        report({ deviceKey: 'onnx:webgpu', computeUnits: 7, vendor: 'amd' }),
      ]),
    })
    expect(rec.skipped).toBe(false)
    expect(rec.devices[0]?.chosen?.measured).toBe(false)
    expect(rec.devices[0]?.chosen?.estimatedFrom).toBe('amd-phoenix')
  })
})

describe('capacity at 5 fps uses the intel-igpu overlap', () => {
  it('5 fps intel-igpu sessions exceed the serial count; 10 fps and other kinds do not', () => {
    const serial = capacitySessionsOf(34, 0.4, 5)
    const lifted = capacitySessionsOf(34, 0.4, 5, aggregateThroughputFactor('intel-igpu', 5))
    expect(aggregateThroughputFactor('intel-igpu', 5)).toBe(1.4)
    expect(lifted).toBeGreaterThan(serial)
    expect(aggregateThroughputFactor('intel-igpu', 10)).toBe(1)
    expect(aggregateThroughputFactor('amd-igpu', 5)).toBe(1)
    expect(capacitySessionsOf(34, 0.4, 10, aggregateThroughputFactor('intel-igpu', 10))).toBe(
      capacitySessionsOf(34, 0.4, 10),
    )
  })

  it('the plan at 5 fps counts the uplift for an intel iGPU and not for Apple', () => {
    const n100 = recommendNode({
      node: node('Intel(R) N100', 'openvino:gpu', 'openvino'),
      cameraFps: 5,
    })
    const chosen = n100.devices[0]?.chosen
    expect(chosen).not.toBeNull()
    if (chosen === null || chosen === undefined) return
    const factor = aggregateThroughputFactor('intel-igpu', 5)
    expect(chosen.capacitySessions).toBe(capacitySessionsOf(chosen.fps, 0.4, 5, factor))
    expect(chosen.capacitySessions).toBeGreaterThan(capacitySessionsOf(chosen.fps, 0.4, 5))

    const mac = recommendNode({
      node: {
        ...node('Apple M2', 'coreml:all', 'coreml'),
        hardware: { ...hw('Apple M2'), platform: 'darwin', arch: 'arm64' },
      },
      cameraFps: 5,
    })
    const ane = mac.devices[0]?.chosen
    expect(ane).not.toBeNull()
    if (ane === null || ane === undefined) return
    expect(ane.capacitySessions).toBe(capacitySessionsOf(ane.fps, 0.4, 5))
  })
})

describe('parseAcceleratorFactsJson', () => {
  it('turns a non-positive number into null and a failed payload into null', () => {
    const parsed = parseAcceleratorFactsJson({
      accelerators: [
        {
          deviceKey: 'openvino:gpu',
          fullDeviceName: 'Intel',
          executionUnits: 0,
          clockMHz: 750,
          gops: { int8: 100, fp16: null },
          architecture: '',
          npuName: null,
          tops: null,
          vendor: null,
          webgpuArchitecture: null,
          webgpuDevice: null,
          computeUnits: null,
        },
      ],
    })
    expect(parsed?.[0]?.executionUnits).toBeNull()
    expect(parsed?.[0]?.clockMHz).toBe(750)
    expect(parsed?.[0]?.gops).toEqual({ int8: 100, fp16: null })
    expect(parsed?.[0]?.architecture).toBeNull()
    expect(parseAcceleratorFactsJson({ accelerators: null })).toBeNull()
    expect(parseAcceleratorFactsJson({ nope: true })).toBeNull()
  })
})
