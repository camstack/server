/**
 * Zod-parse hardening for `ui/api.ts` — every `addons.custom` response used to
 * cross the wire via `value as unknown as View`, asserting a shape nobody
 * checked. This suite proves the replacement parse behaviour end to end:
 *
 *  - a valid response of each shape parses into the expected view;
 *  - a malformed row inside a LIST is dropped, and its siblings survive
 *    (never a wholesale failure, never a silent one — see console.warn spy);
 *  - an absent OPTIONAL field never fails a parse;
 *  - a malformed SINGLE object throws a readable error naming the field.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  convertModel,
  plusCatalogPlusListModels,
  importPluginCatalogCatalogModel,
  listAvailability,
  listCustomModels,
  listPlusCatalogCatalog,
  listPluginCatalogCatalog,
} from '../ui/api.js'

function trpcReturning(payload: unknown) {
  return {
    addons: { custom: { mutate: async () => payload } },
  } as never
}

const VALID_ENTRY = {
  id: 'yolo26n',
  name: 'YOLO26 Nano',
  description: 'baseline detector',
  formats: {},
  inputSize: { width: 320, height: 320 },
  labels: [],
}

describe('listCustomModels', () => {
  let warn: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })
  afterEach(() => warn.mockRestore())

  it('parses a valid descriptor', async () => {
    const result = await listCustomModels(
      trpcReturning([{ stepId: 'object-detection', entry: VALID_ENTRY }]),
    )
    expect(result).toEqual([{ stepId: 'object-detection', entry: VALID_ENTRY }])
  })

  it('drops a malformed row and keeps the valid ones, logging the drop', async () => {
    const result = await listCustomModels(
      trpcReturning([
        { stepId: 'object-detection', entry: VALID_ENTRY },
        { stepId: 'object-detection' /* missing entry */ },
        { stepId: 'face', entry: { ...VALID_ENTRY, id: 'face1' } },
      ]),
    )
    expect(result).toHaveLength(2)
    expect(result.map((r) => r.entry.id)).toEqual(['yolo26n', 'face1'])
    expect(warn).toHaveBeenCalled()
  })
})

describe('listAvailability', () => {
  let warn: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })
  afterEach(() => warn.mockRestore())

  it('parses a valid nested availability map (legacy single-format folded)', async () => {
    const result = await listAvailability(
      trpcReturning({
        yolo26n: {
          hub: { format: 'onnx', sha256: 'a'.repeat(64), bytes: 1024, at: 1700000000 },
        },
      }),
    )
    expect(result.yolo26n?.hub).toEqual({
      formats: {
        onnx: { sha256: 'a'.repeat(64), bytes: 1024, at: 1700000000 },
      },
    })
  })

  it('parses multi-format presence and drops a malformed sibling node', async () => {
    const result = await listAvailability(
      trpcReturning({
        yolo26n: {
          hub: {
            formats: {
              onnx: { sha256: 'a'.repeat(64), bytes: 1024, at: 1 },
              openvino: { sha256: 'c'.repeat(64), bytes: 900, at: 2 },
            },
          },
          agent1: { formats: { onnx: { sha256: 1 /* bad */ } } },
        },
        other: {
          hub: { format: 'coreml', sha256: 'b'.repeat(64), bytes: 2048, at: 2 },
        },
      }),
    )
    expect(Object.keys(result.yolo26n ?? {})).toEqual(['hub'])
    expect(Object.keys(result.yolo26n!.hub!.formats).toSorted()).toEqual(['onnx', 'openvino'])
    expect(result.other?.hub?.formats.coreml?.bytes).toBe(2048)
    expect(warn).toHaveBeenCalled()
  })
})

describe('convertModel', () => {
  it('parses a valid response, entry and artifacts included', async () => {
    const result = await convertModel(
      trpcReturning({
        entry: VALID_ENTRY,
        nodeId: 'hub',
        artifacts: [{ format: 'onnx', sizeMB: 10, validated: true, files: ['a.onnx'] }],
      }),
      {
        sourceUrl: 'https://example.com/m.onnx',
        metadata: {
          id: 'm1',
          name: 'm1',
          labels: [],
          inputSize: { width: 320, height: 320 },
          outputFormat: 'yolo',
        },
        targets: [{ format: 'coreml' }],
      },
    )
    expect(result.entry.id).toBe('yolo26n')
    expect(result.artifacts).toHaveLength(1)
  })

  it('drops a malformed artifact row but keeps the entry and valid artifacts', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const result = await convertModel(
      trpcReturning({
        entry: VALID_ENTRY,
        nodeId: 'hub',
        artifacts: [
          { format: 'onnx', sizeMB: 10, validated: true, files: ['a.onnx'] },
          { format: 'onnx' /* missing sizeMB/validated/files */ },
        ],
      }),
      {
        sourceUrl: 'https://example.com/m.onnx',
        metadata: {
          id: 'm1',
          name: 'm1',
          labels: [],
          inputSize: { width: 320, height: 320 },
          outputFormat: 'yolo',
        },
        targets: [{ format: 'coreml' }],
      },
    )
    expect(result.artifacts).toHaveLength(1)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('throws a readable, field-naming error when entry fails to parse', async () => {
    await expect(
      convertModel(
        trpcReturning({
          entry: { id: 'bad' /* missing name/description/formats/inputSize/labels */ },
          nodeId: 'hub',
          artifacts: [],
        }),
        {
          sourceUrl: 'https://example.com/m.onnx',
          metadata: {
            id: 'm1',
            name: 'm1',
            labels: [],
            inputSize: { width: 320, height: 320 },
            outputFormat: 'yolo',
          },
          targets: [{ format: 'coreml' }],
        },
      ),
    ).rejects.toThrow(/convertModel\.entry/)
  })
})

describe('listPlusCatalogCatalog', () => {
  it('parses a valid catalog row', async () => {
    const result = await listPlusCatalogCatalog(
      trpcReturning([
        {
          id: 'mobiledet',
          label: 'MobileDet',
          format: 'tflite',
          sizeMB: 4.2,
          inputSize: 320,
          notes: 'coral',
        },
      ]),
    )
    expect(result).toEqual([
      {
        id: 'mobiledet',
        label: 'MobileDet',
        format: 'tflite',
        sizeMB: 4.2,
        inputSize: 320,
        notes: 'coral',
      },
    ])
  })

  it('drops a malformed row, keeping the others', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const result = await listPlusCatalogCatalog(
      trpcReturning([
        {
          id: 'mobiledet',
          label: 'MobileDet',
          format: 'tflite',
          sizeMB: 4.2,
          inputSize: 320,
          notes: '',
        },
        { id: 'broken', label: 'Broken' /* missing format/sizeMB/inputSize/notes */ },
      ]),
    )
    expect(result).toHaveLength(1)
    expect(result[0]?.id).toBe('mobiledet')
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('plusCatalogPlusListModels', () => {
  const REQUIRED_FIELDS = {
    id: 'p1',
    name: 'Personal model',
    type: 'detect',
    isBaseModel: false,
    baseModel: 'yolov9',
    supportedDetectors: ['cpu'],
    trainDate: '2026-01-01',
    verifiedImages: 500,
  }

  it('parses a row with every optional field present', async () => {
    const result = await plusCatalogPlusListModels(
      trpcReturning([{ ...REQUIRED_FIELDS, hailoDevice: 'hailo8', width: 320, height: 320 }]),
    )
    expect(result).toEqual([{ ...REQUIRED_FIELDS, hailoDevice: 'hailo8', width: 320, height: 320 }])
  })

  it('parses a row with every optional field ABSENT — absence never fails the parse', async () => {
    const result = await plusCatalogPlusListModels(trpcReturning([REQUIRED_FIELDS]))
    expect(result).toEqual([REQUIRED_FIELDS])
  })

  it('drops a malformed row, keeping the well-formed one', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const result = await plusCatalogPlusListModels(
      trpcReturning([REQUIRED_FIELDS, { id: 'broken' /* missing everything else */ }]),
    )
    expect(result).toHaveLength(1)
    expect(result[0]?.id).toBe('p1')
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('listPluginCatalogCatalog entries', () => {
  const VALID_PLUGIN_CATALOG_ENTRY = {
    id: 'yolov9t-relu-coreml',
    label: 'YOLOv9t (ReLU, CoreML)',
    family: 'yolov9t',
    variant: 'relu',
    format: 'coreml',
    precision: 'fp16',
    inputSize: { width: 320, height: 320 },
    files: [{ relativePath: 'model.mlpackage/Data', size: 100, sha256: 'a'.repeat(64) }],
    model: VALID_ENTRY,
  }

  it('parses a valid entry', async () => {
    const result = await listPluginCatalogCatalog(
      trpcReturning({ entries: [VALID_PLUGIN_CATALOG_ENTRY], drift: [] }),
    )
    expect(result.entries).toEqual([VALID_PLUGIN_CATALOG_ENTRY])
  })

  it('drops a malformed entry, keeping the others', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const result = await listPluginCatalogCatalog(
      trpcReturning({
        entries: [VALID_PLUGIN_CATALOG_ENTRY, { id: 'broken' /* missing everything else */ }],
        drift: [],
      }),
    )
    expect(result.entries).toHaveLength(1)
    expect(result.entries[0]?.id).toBe('yolov9t-relu-coreml')
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('importPluginCatalogCatalogModel', () => {
  it('parses a valid response', async () => {
    const result = await importPluginCatalogCatalogModel(
      trpcReturning({ stepId: 'object-detection', entry: VALID_ENTRY }),
      { manifestId: 'yolov9t-relu-coreml' },
    )
    expect(result).toEqual({ stepId: 'object-detection', entry: VALID_ENTRY })
  })

  it('throws a readable, field-naming error on a malformed response', async () => {
    await expect(
      importPluginCatalogCatalogModel(trpcReturning({ entry: VALID_ENTRY /* missing stepId */ }), {
        manifestId: 'yolov9t-relu-coreml',
      }),
    ).rejects.toThrow(/stepId/)
  })
})
