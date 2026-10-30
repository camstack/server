/**
 * Installed inventory — one row per model × format on a node (operator
 * decision 2026-10-07), with the devices that use that file as chips.
 *
 * The shapes below are the LIVE hub of 2026-10-07: CPU and Coral DISABLED
 * (CPU's format default is yolo26n, Coral's the SSD), NPU and iGPU enabled
 * and both running yolov9m-320-int8 from ONE OpenVINO IR, each in its own
 * pool. The old card claimed "running on CPU" for yolo26n and hid its Remove.
 */
import { describe, expect, it } from 'vitest'
import type { NodeInferenceDevice } from '@camstack/types'
import {
  buildClusterPlacement,
  buildInstalledInventory,
  deviceFilterOptions,
  filterInventoryRows,
  type InstalledFileRow,
  type ResidentEngineView,
} from '../ui/installed-inventory.js'
import type { CatalogSeed, StepCatalogSlice } from '../ui/model-studio-ui.js'

function device(
  partial: Partial<NodeInferenceDevice> & Pick<NodeInferenceDevice, 'key'>,
): NodeInferenceDevice {
  return {
    backend: 'openvino',
    device: 'gpu',
    format: 'openvino',
    available: true,
    enabled: true,
    weight: 1,
    maxSessions: null,
    defaultModelId: 'yolov9m-320-int8',
    exclusion: null,
    ...partial,
  }
}

const HUB_DEVICES: readonly NodeInferenceDevice[] = [
  device({
    key: 'cpu',
    backend: 'cpu',
    device: 'cpu',
    format: 'onnx',
    enabled: false,
    defaultModelId: 'yolo26n',
    exclusion: 'disabled',
  }),
  device({
    key: 'edgetpu:usb',
    backend: 'edgetpu',
    device: 'usb',
    format: 'tflite',
    enabled: false,
    defaultModelId: 'ssd-mobilenet-v2-coco-edgetpu',
    exclusion: 'disabled',
  }),
  device({ key: 'openvino:gpu', device: 'gpu' }),
  device({ key: 'openvino:npu', device: 'npu' }),
]

const HUB_ENGINES: readonly ResidentEngineView[] = [
  {
    engineKey: 'python/openvino/npu',
    engine: { backend: 'openvino', format: 'openvino', device: 'npu' },
    kind: 'runtime',
    modelsLoaded: ['object-detection/yolov9m-320-int8', 'face-embedding/auraface-r100'],
  },
  {
    engineKey: 'python/openvino/gpu [openvino:gpu]',
    engine: { backend: 'openvino', format: 'openvino', device: 'gpu' },
    kind: 'device-pool',
    modelsLoaded: ['object-detection/yolov9m-320-int8', 'face-embedding/auraface-r100'],
  },
]

const OD_CATALOG: StepCatalogSlice = {
  id: 'object-detection',
  slot: 'detector',
  defaultModelId: 'yolo26n',
  defaultModelIdByFormat: { tflite: 'ssd-mobilenet-v2-coco-edgetpu' },
  models: [
    { id: 'yolo26n', formats: { onnx: { sizeMB: 10 }, openvino: { sizeMB: 9 } } },
    { id: 'yolov9m-320-int8', formats: { openvino: { sizeMB: 20 } } },
    { id: 'ssd-mobilenet-v2-coco-edgetpu', formats: { tflite: { sizeMB: 6 } } },
  ],
}

const FACE_CATALOG: StepCatalogSlice = {
  id: 'face-embedding',
  slot: 'classifier',
  defaultModelId: 'auraface-r100',
  models: [{ id: 'auraface-r100', formats: { onnx: { sizeMB: 261 }, openvino: { sizeMB: 131 } } }],
}

const AUDIO_CATALOG: StepCatalogSlice = {
  id: 'audio-classifier',
  slot: 'audio-classifier',
  defaultModelId: 'yamnet-onnx',
  models: [{ id: 'yamnet-onnx', formats: { onnx: { sizeMB: 16.1 } } }],
}

const STEP_CATALOGS = {
  'object-detection': OD_CATALOG,
  'face-embedding': FACE_CATALOG,
  'audio-classifier': AUDIO_CATALOG,
}

const HUB_SEEDS: readonly CatalogSeed[] = [
  {
    provider: 'camstack',
    stepId: 'object-detection',
    stepName: 'Object detection',
    modelId: 'yolo26n',
    name: 'YOLO26 Nano',
    formats: [
      { format: 'onnx', sizeMB: 10, downloaded: true, onDisk: 'current' },
      { format: 'openvino', sizeMB: 9, downloaded: true, onDisk: 'current' },
    ],
  },
  {
    provider: 'camstack',
    stepId: 'object-detection',
    stepName: 'Object detection',
    modelId: 'yolov9m-320-int8',
    name: 'YOLOv9m 320 INT8',
    formats: [
      { format: 'openvino', sizeMB: 20, downloaded: true, onDisk: 'current', precision: 'int8' },
    ],
  },
  {
    provider: 'camstack',
    stepId: 'object-detection',
    stepName: 'Object detection',
    modelId: 'ssd-mobilenet-v2-coco-edgetpu',
    name: 'SSD MobileNet v2 (EdgeTPU)',
    formats: [
      { format: 'tflite', sizeMB: 6, downloaded: false, onDisk: 'stale', precision: 'int8' },
    ],
  },
  {
    provider: 'camstack',
    stepId: 'face-embedding',
    stepName: 'Face embedding',
    modelId: 'auraface-r100',
    name: 'AuraFace R100',
    formats: [
      { format: 'onnx', sizeMB: 261, downloaded: true, onDisk: 'current' },
      { format: 'openvino', sizeMB: 131, downloaded: true, onDisk: 'current' },
    ],
  },
  {
    provider: 'camstack',
    stepId: 'audio-classifier',
    stepName: 'Audio classifier',
    modelId: 'yamnet-onnx',
    name: 'YAMNet',
    formats: [{ format: 'onnx', sizeMB: 16.1, downloaded: true, onDisk: 'current' }],
  },
]

function hubInventory(engines: readonly ResidentEngineView[] | null = HUB_ENGINES) {
  return buildInstalledInventory({
    nodeId: 'hub',
    seeds: HUB_SEEDS,
    stepCatalogs: STEP_CATALOGS,
    devices: HUB_DEVICES,
    engines,
    clusterModels: { 'face-embedding': 'auraface-r100' },
    registry: [],
    availability: {},
  })
}

function row(rows: readonly InstalledFileRow[], modelId: string, format: string): InstalledFileRow {
  const found = rows.find((r) => r.modelId === modelId && r.format === format)
  if (found === undefined) throw new Error(`no row ${modelId} · ${format}`)
  return found
}

describe('buildInstalledInventory — one row per model × format', () => {
  it('a model held in two formats is two rows, each with its own size and precision', () => {
    const rows = hubInventory()
    expect(row(rows, 'yolo26n', 'onnx').sizeMB).toBe(10)
    expect(row(rows, 'yolo26n', 'openvino').sizeMB).toBe(9)
    expect(row(rows, 'yolov9m-320-int8', 'openvino').precision).toBe('int8')
    expect(row(rows, 'yolo26n', 'onnx').precision).toBeUndefined()
  })

  it('NPU and iGPU sharing one OpenVINO IR are two chips on ONE row, both loaded', () => {
    const r = row(hubInventory(), 'yolov9m-320-int8', 'openvino')
    expect(r.chips.map((c) => [c.label, c.loaded, c.configured])).toEqual([
      ['iGPU', true, true],
      ['NPU', true, true],
    ])
    expect(r.usage).toBe('in-use')
    expect(r.removable).toBe(false)
  })

  it('a DISABLED device is never shown as running its format default (the false CPU pill)', () => {
    const r = row(hubInventory(), 'yolo26n', 'onnx')
    expect(r.chips).toEqual([
      { deviceKey: 'cpu', label: 'CPU', enabled: false, loaded: false, configured: false },
    ])
    expect(r.usage).toBe('unused')
    expect(r.removable).toBe(true)
  })

  it('a file an enabled device could run but nothing loads is idle and removable', () => {
    const r = row(hubInventory(), 'yolo26n', 'openvino')
    expect(r.usage).toBe('idle')
    expect(r.chips.every((c) => !c.configured && c.loaded === false)).toBe(true)
    expect(r.removable).toBe(true)
  })

  it('a stale copy is listed as stale, never as configured', () => {
    const r = row(hubInventory(), 'ssd-mobilenet-v2-coco-edgetpu', 'tflite')
    expect(r.onDisk).toBe('stale')
    expect(r.chips[0]?.configured).toBe(false)
    expect(r.usage).toBe('unused')
  })

  it('a cluster-scoped model carries real per-device load state, not a cluster pill', () => {
    const rows = hubInventory()
    const ov = row(rows, 'auraface-r100', 'openvino')
    expect(ov.clusterScoped).toBe(true)
    expect(ov.usage).toBe('in-use')
    expect(ov.chips.map((c) => c.label)).toEqual(['iGPU', 'NPU'])
    const onnx = row(rows, 'auraface-r100', 'onnx')
    expect(onnx.usage).toBe('unused')
    expect(onnx.removable).toBe(true)
  })

  it('the audio analyzer model is served outside the device pools and is not offered for removal', () => {
    const r = row(hubInventory(), 'yamnet-onnx', 'onnx')
    expect(r.usage).toBe('outside-pools')
    expect(r.removable).toBe(false)
  })

  it('a cluster-scoped model is listed on the hub only, never under another node', () => {
    const onAgent = buildInstalledInventory({
      nodeId: 'little-unraid',
      seeds: HUB_SEEDS,
      stepCatalogs: STEP_CATALOGS,
      devices: HUB_DEVICES,
      engines: HUB_ENGINES,
      clusterModels: { 'face-embedding': 'auraface-r100' },
      registry: [],
      availability: {},
    })
    expect(onAgent.some((r) => r.stepId === 'face-embedding')).toBe(false)
    expect(onAgent.some((r) => r.modelId === 'yolo26n')).toBe(true)
    expect(hubInventory().some((r) => r.stepId === 'face-embedding')).toBe(true)
  })

  it('the audio analyzer model shows the device it runs on (CPU), with or without node devices', () => {
    for (const devices of [HUB_DEVICES, [] as readonly NodeInferenceDevice[]]) {
      const r = row(
        buildInstalledInventory({
          nodeId: 'hub',
          seeds: HUB_SEEDS,
          stepCatalogs: STEP_CATALOGS,
          devices,
          engines: HUB_ENGINES,
          clusterModels: null,
          registry: [],
          availability: {},
        }),
        'yamnet-onnx',
        'onnx',
      )
      expect(r.chips.map((c) => [c.label, c.fixed])).toEqual([['CPU', true]])
    }
  })

  it('when the loaded-engine read fails, nothing an enabled device could run is called idle', () => {
    const rows = hubInventory(null)
    const ov = row(rows, 'yolo26n', 'openvino')
    expect(ov.usage).toBe('unknown')
    expect(ov.removable).toBe(false)
    expect(ov.chips.every((c) => c.loaded === null)).toBe(true)
    // configured is still known: it does not depend on the engine read
    expect(row(rows, 'yolov9m-320-int8', 'openvino').usage).toBe('configured')
    // a format no enabled device runs stays unused either way
    expect(row(rows, 'yolo26n', 'onnx').usage).toBe('unused')
  })

  it('an imported model is a registry row and its on-node availability adds formats the schema omits', () => {
    const rows = buildInstalledInventory({
      nodeId: 'hub',
      seeds: [],
      stepCatalogs: STEP_CATALOGS,
      devices: HUB_DEVICES,
      engines: HUB_ENGINES,
      clusterModels: null,
      registry: [
        {
          stepId: 'object-detection',
          entry: {
            id: 'plus-catalog-x',
            name: 'plus catalog ssd',
            description: 'imported',
            provider: 'frigate',
            formats: { tflite: { url: 'camstack-local://plus-catalog-x/x.tflite', sizeMB: 4.8 } },
            inputSize: { width: 320, height: 320 },
            labels: [],
          },
        },
      ],
      availability: {
        'plus-catalog-x': {
          hub: { formats: { tflite: { sha256: 'aa', bytes: 4_846_496, at: 1 } } },
        },
      },
    })
    const r = row(rows, 'plus-catalog-x', 'tflite')
    expect(r.origin).toBe('registry')
    expect(r.provider).toBe('frigate')
    expect(r.renameable).toBe(true)
    expect(r.sizeMB).toBeCloseTo(4.85, 1)
    expect(r.usage).toBe('unused')
  })
})

describe('device filter', () => {
  it('lists every device of the node, disabled ones marked off', () => {
    expect(deviceFilterOptions(HUB_DEVICES)).toEqual([
      { value: 'cpu', label: 'CPU', enabled: false },
      { value: 'edgetpu:usb', label: 'Coral', enabled: false },
      { value: 'openvino:gpu', label: 'iGPU', enabled: true },
      { value: 'openvino:npu', label: 'NPU', enabled: true },
    ])
  })

  it('filtering by a device keeps the rows whose format that device runs', () => {
    const rows = hubInventory()
    const npu = filterInventoryRows(rows, HUB_DEVICES, {
      provider: 'all',
      step: 'all',
      device: 'openvino:npu',
    })
    expect(new Set(npu.map((r) => r.format))).toEqual(new Set(['openvino']))
    const cpu = filterInventoryRows(rows, HUB_DEVICES, {
      provider: 'all',
      step: 'all',
      device: 'cpu',
    })
    expect(cpu.map((r) => `${r.modelId}·${r.format}`).toSorted()).toEqual([
      'auraface-r100·onnx',
      'yamnet-onnx·onnx',
      'yolo26n·onnx',
    ])
  })
})

describe('buildClusterPlacement — where a cluster model runs, per node', () => {
  it('names node · runtime · devices · loaded, and refuses a format with no build', () => {
    const placement = buildClusterPlacement('face-embedding', 'auraface-r100', [
      {
        nodeId: 'hub',
        seeds: HUB_SEEDS,
        stepCatalogs: STEP_CATALOGS,
        devices: HUB_DEVICES,
        engines: HUB_ENGINES,
      },
      {
        nodeId: 'mac',
        seeds: [],
        stepCatalogs: {
          'face-embedding': {
            ...FACE_CATALOG,
            models: [{ id: 'auraface-r100', formats: { coreml: { sizeMB: 131 } } }],
          },
        },
        devices: [
          device({ key: 'coreml:all', backend: 'coreml', device: 'all', format: 'coreml' }),
        ],
        engines: [
          {
            engineKey: 'python/coreml/all',
            engine: { backend: 'coreml', format: 'coreml', device: 'all' },
            kind: 'runtime',
            modelsLoaded: [],
          },
        ],
      },
      {
        nodeId: 'coral-box',
        seeds: [],
        stepCatalogs: { 'face-embedding': FACE_CATALOG },
        devices: [
          device({ key: 'edgetpu:usb', backend: 'edgetpu', device: 'usb', format: 'tflite' }),
        ],
        engines: [],
      },
    ])
    expect(placement.nodes.map((n) => [n.nodeId, n.entries])).toEqual([
      [
        'hub',
        [
          {
            format: 'openvino',
            devices: [
              { deviceKey: 'openvino:gpu', label: 'iGPU', loaded: true },
              { deviceKey: 'openvino:npu', label: 'NPU', loaded: true },
            ],
            state: 'loaded',
            onDisk: 'current',
          },
        ],
      ],
      [
        'mac',
        [
          {
            format: 'coreml',
            devices: [{ deviceKey: 'coreml:all', label: 'ANE', loaded: false }],
            state: 'not-loaded',
            onDisk: 'missing',
          },
        ],
      ],
      [
        'coral-box',
        [
          {
            format: 'tflite',
            devices: [{ deviceKey: 'edgetpu:usb', label: 'Coral', loaded: false }],
            state: 'refused',
            onDisk: 'missing',
          },
        ],
      ],
    ])
  })

  it('a node whose reads failed says so instead of listing nothing', () => {
    const placement = buildClusterPlacement('face-embedding', 'auraface-r100', [
      { nodeId: 'gone', error: 'unreachable' },
    ])
    expect(placement.nodes).toEqual([{ nodeId: 'gone', entries: [], error: 'unreachable' }])
  })
})
