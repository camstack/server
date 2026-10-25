import { describe, expect, it } from 'vitest'
import type { CustomModelDescriptor, ModelCatalogEntry } from '@camstack/types'
import {
  buildConvertTargets,
  catalogGroupedSeeds,
  catalogProviderSections,
  catalogSeedsForStep,
  catalogSeedsFromSchema,
  catalogStepOptions,
  catalogUngroupedSeeds,
  EMPTY_TARGET_SELECTION,
  entryFormats,
  entrySizeMB,
  formatBytes,
  formatMB,
  hasAnyTarget,
  formatPresentOnNode,
  formatsByNode,
  nodePresence,
  toModelRows,
  type AvailabilityMap,
  type CatalogSchemaLike,
} from '../ui/model-studio-ui.js'

function entry(over: Partial<ModelCatalogEntry> = {}): ModelCatalogEntry {
  return {
    id: 'm1',
    name: 'Model One',
    description: 'desc',
    formats: { onnx: { url: 'http://x/m.onnx', sizeMB: 10 } },
    inputSize: { width: 640, height: 640 },
    labels: [],
    ...over,
  }
}

function descriptor(over: Partial<CustomModelDescriptor> = {}): CustomModelDescriptor {
  return { stepId: 'object-detection', entry: entry(), ...over }
}

describe('entryFormats', () => {
  it('returns declared formats in stable order', () => {
    const e = entry({
      formats: {
        openvino: { url: 'a', sizeMB: 1 },
        onnx: { url: 'b', sizeMB: 2 },
      },
    })
    expect(entryFormats(e)).toEqual(['onnx', 'openvino'])
  })

  it('returns empty when no formats declared', () => {
    expect(entryFormats(entry({ formats: {} }))).toEqual([])
  })
})

describe('entrySizeMB', () => {
  it('sums sizes across formats', () => {
    const e = entry({
      formats: {
        onnx: { url: 'a', sizeMB: 10 },
        openvino: { url: 'b', sizeMB: 5.5 },
      },
    })
    expect(entrySizeMB(e)).toBe(15.5)
  })
})

describe('nodePresence', () => {
  const availability: AvailabilityMap = {
    m1: {
      'agent-2': { formats: { openvino: { sha256: '', bytes: 2_000_000, at: 1 } } },
      hub: {
        formats: {
          onnx: { sha256: '', bytes: 1_000_000, at: 1 },
          openvino: { sha256: '', bytes: 500_000, at: 2 },
        },
      },
    },
  }

  it('lists per-node × format presence sorted by nodeId then format', () => {
    const pres = nodePresence(availability, 'm1')
    expect(pres.map((p) => `${p.nodeId}:${p.format}`)).toEqual([
      'agent-2:openvino',
      'hub:onnx',
      'hub:openvino',
    ])
    expect(pres[0]).toMatchObject({ nodeId: 'agent-2', format: 'openvino', bytes: 2_000_000 })
  })

  it('returns empty for unknown model', () => {
    expect(nodePresence(availability, 'missing')).toEqual([])
  })

  it('formatsByNode groups formats under each node', () => {
    const groups = formatsByNode(nodePresence(availability, 'm1'))
    expect(groups).toEqual([
      { nodeId: 'agent-2', formats: ['openvino'] },
      { nodeId: 'hub', formats: ['onnx', 'openvino'] },
    ])
  })

  it('formatPresentOnNode checks a single cell of the matrix', () => {
    const pres = nodePresence(availability, 'm1')
    expect(formatPresentOnNode(pres, 'hub', 'onnx')).toBe(true)
    expect(formatPresentOnNode(pres, 'hub', 'coreml')).toBe(false)
    expect(formatPresentOnNode(pres, 'agent-2', 'openvino')).toBe(true)
  })
})

describe('toModelRows', () => {
  it('joins registry + availability and sorts by name', () => {
    const models = [
      descriptor({ entry: entry({ id: 'b', name: 'Beta' }) }),
      descriptor({ entry: entry({ id: 'a', name: 'Alpha' }) }),
    ]
    const availability: AvailabilityMap = {
      a: { hub: { formats: { onnx: { sha256: '', bytes: 1, at: 1 } } } },
    }
    const rows = toModelRows(models, availability)
    expect(rows.map((r) => r.name)).toEqual(['Alpha', 'Beta'])
    expect(rows[0]?.nodes).toHaveLength(1)
    expect(rows[1]?.nodes).toHaveLength(0)
  })
})

describe('buildConvertTargets', () => {
  it('returns empty for empty selection', () => {
    expect(buildConvertTargets(EMPTY_TARGET_SELECTION)).toEqual([])
  })

  it('groups openvino precisions into a single target', () => {
    const t = buildConvertTargets({ openvinoFp16: true, openvinoInt8: true, coreml: false })
    expect(t).toEqual([{ format: 'openvino', precisions: ['fp16', 'int8'] }])
  })

  it('emits coreml as its own target', () => {
    const t = buildConvertTargets({ openvinoFp16: false, openvinoInt8: false, coreml: true })
    expect(t).toEqual([{ format: 'coreml' }])
  })

  it('combines openvino and coreml', () => {
    const t = buildConvertTargets({ openvinoFp16: true, openvinoInt8: false, coreml: true })
    expect(t).toEqual([{ format: 'openvino', precisions: ['fp16'] }, { format: 'coreml' }])
  })
})

describe('hasAnyTarget', () => {
  it('is false for empty selection', () => {
    expect(hasAnyTarget(EMPTY_TARGET_SELECTION)).toBe(false)
  })
  it('is true when any flag set', () => {
    expect(hasAnyTarget({ ...EMPTY_TARGET_SELECTION, coreml: true })).toBe(true)
  })
})

describe('formatBytes', () => {
  it('formats byte magnitudes', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2.0 KB')
    expect(formatBytes(5_000_000)).toBe('4.8 MB')
  })
})

describe('formatMB', () => {
  it('formats megabytes and gigabytes', () => {
    expect(formatMB(0)).toBe('—')
    expect(formatMB(12.34)).toBe('12.3 MB')
    expect(formatMB(2500)).toBe('2.50 GB')
  })
})

describe('catalogSeedsFromSchema — CamStack provider from pipeline getSchema', () => {
  const schema: CatalogSchemaLike = {
    slots: [
      {
        addons: [
          {
            id: 'object-detection',
            name: 'Object detection',
            models: [
              {
                id: 'yolo26n',
                name: 'YOLO26 Nano',
                legacy: false,
                provider: 'camstack',
                group: { family: 'yolo26', tier: 'n', resolution: 640 },
                formats: {
                  onnx: { downloaded: true, sizeMB: 6 },
                  openvino: { downloaded: false, sizeMB: 4 },
                },
              },
              {
                id: 'yolov9c-640',
                name: 'YOLOv9 Compact @640',
                provider: 'camstack',
                group: { family: 'yolov9', tier: 'c', resolution: 640 },
                formats: { onnx: { downloaded: false, sizeMB: 50 } },
              },
              {
                id: 'ssd-mobilenet-v2-coco-edgetpu',
                name: 'SSD MobileNet V2 (EdgeTPU)',
                formats: { tflite: { downloaded: false, sizeMB: 7 } },
              },
              {
                id: 'yolov8n-legacy',
                name: 'YOLOv8-N (legacy)',
                legacy: true,
                formats: { onnx: { downloaded: false, sizeMB: 6 } },
              },
            ],
          },
          {
            id: 'face-detection',
            name: 'Face detection',
            models: [
              {
                id: 'scrfd-10g',
                name: 'SCRFD 10G',
                formats: { onnx: { downloaded: false, sizeMB: 16 } },
              },
            ],
          },
        ],
      },
    ],
  }

  it('flattens live seeds, hides legacy, and propagates group + provider', () => {
    const seeds = catalogSeedsFromSchema(schema)
    expect(seeds.map((s) => s.modelId)).toEqual([
      'yolo26n',
      'yolov9c-640',
      'ssd-mobilenet-v2-coco-edgetpu',
      'scrfd-10g',
    ])
    expect(seeds[0]).toMatchObject({
      provider: 'camstack',
      stepId: 'object-detection',
      stepName: 'Object detection',
      modelId: 'yolo26n',
      name: 'YOLO26 Nano',
      group: { family: 'yolo26', tier: 'n', resolution: 640 },
    })
    expect(seeds[0]?.formats).toEqual([
      { format: 'onnx', downloaded: true, sizeMB: 6, onDisk: 'current' },
      { format: 'openvino', downloaded: false, sizeMB: 4, onDisk: 'missing' },
    ])
    expect(seeds[2]?.group).toBeUndefined()
    expect(seeds[2]?.provider).toBe('camstack')
  })

  it('carries what is on disk and the precision a node reports (D746), stale included', () => {
    const seeds = catalogSeedsFromSchema({
      slots: [
        {
          addons: [
            {
              id: 'object-detection',
              name: 'Object detection',
              models: [
                {
                  id: 'yolov9m-320-int8',
                  name: 'YOLOv9m 320 INT8',
                  formats: {
                    openvino: { downloaded: false, sizeMB: 20, onDisk: 'stale', precision: 'int8' },
                  },
                },
              ],
            },
          ],
        },
      ],
    })
    expect(seeds[0]?.formats).toEqual([
      { format: 'openvino', downloaded: false, sizeMB: 20, onDisk: 'stale', precision: 'int8' },
    ])
  })

  it('keeps plus catalog / plugin catalog in Catalog but namespaces their family so chips do not merge', () => {
    const mixed: CatalogSchemaLike = {
      slots: [
        {
          addons: [
            {
              id: 'object-detection',
              name: 'Object detection',
              models: [
                {
                  id: 'yolo26n',
                  name: 'YOLO26 Nano',
                  provider: 'camstack',
                  group: { family: 'yolo26', tier: 'n', resolution: 640 },
                  formats: { onnx: { downloaded: false, sizeMB: 6 } },
                },
                {
                  id: 'yolov9c-640',
                  name: 'YOLOv9 Compact @640',
                  provider: 'camstack',
                  group: { family: 'yolov9', tier: 'c', resolution: 640 },
                  formats: { onnx: { downloaded: false, sizeMB: 50 } },
                },
                {
                  id: 'scrypted-yolov9t-relu-onnx',
                  name: 'plugin catalog YOLOv9T ReLU ONNX',
                  provider: 'scrypted',
                  group: { family: 'yolov9', tier: 't', resolution: 320 },
                  formats: { onnx: { downloaded: true, sizeMB: 8 } },
                },
                {
                  id: 'frigate-mobiledet-edgetpu',
                  name: 'plus catalog default — SSDLite MobileDet',
                  provider: 'frigate',
                  group: { family: 'ssdlite-mobiledet', tier: 'default', resolution: 320 },
                  formats: { tflite: { downloaded: true, sizeMB: 5 } },
                },
              ],
            },
          ],
        },
      ],
    }
    const seeds = catalogSeedsFromSchema(mixed)
    expect(seeds.map((s) => s.modelId)).toEqual([
      'yolo26n',
      'yolov9c-640',
      'scrypted-yolov9t-relu-onnx',
      'frigate-mobiledet-edgetpu',
    ])
    expect(seeds.find((s) => s.modelId === 'scrypted-yolov9t-relu-onnx')?.group?.family).toBe(
      'scrypted:yolov9',
    )
    expect(seeds.find((s) => s.modelId === 'yolov9c-640')?.group?.family).toBe('yolov9')
    expect(seeds.find((s) => s.modelId === 'frigate-mobiledet-edgetpu')?.group?.family).toBe(
      'frigate:ssdlite-mobiledet',
    )
    const sections = catalogProviderSections(seeds)
    expect(sections.map((s) => s.provider)).toEqual(['camstack', 'scrypted', 'frigate'])
  })

  it('lists unique steps in schema order and filters seeds by step', () => {
    const seeds = catalogSeedsFromSchema(schema)
    expect(catalogStepOptions(seeds)).toEqual([
      { id: 'object-detection', name: 'Object detection' },
      { id: 'face-detection', name: 'Face detection' },
    ])
    expect(catalogSeedsForStep(seeds, 'face-detection').map((s) => s.modelId)).toEqual([
      'scrfd-10g',
    ])
  })

  it('partitions grouped vs ungrouped seeds for Catalog UI', () => {
    const od = catalogSeedsForStep(catalogSeedsFromSchema(schema), 'object-detection')
    expect(catalogGroupedSeeds(od).map((s) => s.modelId)).toEqual(['yolo26n', 'yolov9c-640'])
    expect(catalogUngroupedSeeds(od).map((s) => s.modelId)).toEqual([
      'ssd-mobilenet-v2-coco-edgetpu',
    ])
  })
})
