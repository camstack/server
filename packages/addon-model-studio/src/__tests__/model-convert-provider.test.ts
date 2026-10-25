import { it, expect, vi } from 'vitest'
import { buildModelConvertProvider } from '../model-convert-provider.js'

const metadata = {
  id: 'custom-yolo',
  name: 'Custom YOLO',
  labels: [{ id: '0', name: 'person' }],
  inputSize: { width: 640, height: 640 },
  outputFormat: 'yolo' as const,
}

it('downloads onnx, runs convert, builds an entry with validated artifacts', async () => {
  const downloadOnnx = vi.fn(async () => '/data/models/src.onnx')
  const runConvert = vi.fn(async () => ({
    artifacts: [
      {
        format: 'openvino' as const,
        precision: 'fp16' as const,
        sizeMB: 9,
        validated: true,
        files: ['camstack-custom-yolo.xml', 'camstack-custom-yolo.bin'],
      },
    ],
  }))
  const provider = buildModelConvertProvider({
    modelsDir: async () => '/data/models',
    pythonPath: async () => '/py/bin/python',
    ensureRequirements: async () => {},
    runConvert,
    downloadOnnx,
    writeJob: async () => '/tmp/job.json',
  })
  const result = await provider.convert({
    sourceUrl: 'https://x/m.onnx',
    metadata,
    targets: [{ format: 'openvino', precisions: ['fp16'] }],
  })
  expect(downloadOnnx).toHaveBeenCalled()
  expect(runConvert).toHaveBeenCalled()
  expect(result.entry.formats.openvino?.url).toContain('camstack-custom-yolo.xml')
  expect(result.entry.formats.openvino?.files).toEqual(['camstack-custom-yolo.bin'])
  expect(result.artifacts[0]?.validated).toBe(true)
})

it('preserves metadata.classMap on the converted catalog entry', async () => {
  const classMap = {
    mapping: { person: 'person', vehicle: 'vehicle', animal: 'animal' },
    preserveOriginal: false,
  } as const
  const provider = buildModelConvertProvider({
    modelsDir: async () => '/data/models',
    pythonPath: async () => '/py/bin/python',
    ensureRequirements: async () => {},
    runConvert: async () => ({
      artifacts: [
        {
          format: 'openvino' as const,
          precision: 'fp16' as const,
          sizeMB: 9,
          validated: true,
          files: ['camstack-custom-yolo.xml', 'camstack-custom-yolo.bin'],
        },
      ],
    }),
    downloadOnnx: async () => '/data/models/src.onnx',
    writeJob: async () => '/tmp/job.json',
  })
  const result = await provider.convert({
    sourceUrl: 'https://x/m.onnx',
    metadata: { ...metadata, classMap },
    targets: [{ format: 'openvino', precisions: ['fp16'] }],
  })
  expect(result.entry.classMap).toEqual(classMap)
})

it('omits a format whose artifacts came back empty (validation dropped it)', async () => {
  const provider = buildModelConvertProvider({
    modelsDir: async () => '/data/models',
    pythonPath: async () => '/py',
    ensureRequirements: async () => {},
    runConvert: async () => ({ artifacts: [] }),
    downloadOnnx: async () => '/data/models/src.onnx',
    writeJob: async () => '/tmp/job.json',
  })
  const result = await provider.convert({
    sourceUrl: 'https://x/m.onnx',
    metadata,
    targets: [{ format: 'coreml' }],
  })
  expect(result.entry.formats.coreml).toBeUndefined()
  expect(result.artifacts).toHaveLength(0)
})
