/**
 * D214 addendum — a plus catalog ONNX import feeds the SAME conversion pipeline
 * as the Convert tab, producing the variants for every engine the cluster
 * runs (openvino, coreml) — with per-format isolation (D54): a failed or
 * unsupported format is reported explicitly and never invalidates the
 * others; and the converted formats MERGE into the registered entry —
 * never replace it (the stock convert entry carries no postprocessor, and
 * replacing would re-create the exact D208 silent-decode bug).
 */
import { describe, expect, it } from 'vitest'
import type { ModelCatalogEntry } from '@camstack/types'
import { mergeConvertedFormats, runPlusConversions } from '../plus-catalog/plus-conversion.js'

const baseEntry: ModelCatalogEntry = {
  id: 'my-plus',
  name: 'My Plus',
  description: 'plus catalog personal model (yolonas) — imported via Model Studio',
  formats: {
    onnx: { url: 'camstack-local://my-plus/my-plus.onnx', sizeMB: 49, runtimes: ['python'] },
  },
  inputSize: { width: 320, height: 320 },
  labels: [{ id: 'person', name: 'person' }],
  preprocessMode: 'letterbox',
  postprocessor: 'yolonas',
}

const convertedEntry: ModelCatalogEntry = {
  id: 'my-plus',
  name: 'My Plus',
  description: 'Converted via Model Studio P3',
  formats: {
    openvino: {
      url: 'camstack-local://my-plus/camstack-my-plus.xml',
      sizeMB: 25,
      runtimes: ['python'],
      files: ['camstack-my-plus.bin'],
    },
  },
  inputSize: { width: 320, height: 320 },
  labels: [{ id: 'person', name: 'person' }],
}

const identityClassMap = {
  mapping: { person: 'person', vehicle: 'vehicle', animal: 'animal' },
  preserveOriginal: false,
} as const

describe('mergeConvertedFormats', () => {
  it('adds the converted formats and KEEPS the base entry identity (onnx + postprocessor + labels)', () => {
    const merged = mergeConvertedFormats(baseEntry, convertedEntry)
    expect(merged.formats.onnx).toEqual(baseEntry.formats.onnx)
    expect(merged.formats.openvino).toEqual(convertedEntry.formats.openvino)
    expect(merged.postprocessor).toBe('yolonas')
    expect(merged.description).toBe(baseEntry.description)
    expect(merged.labels).toEqual(baseEntry.labels)
  })

  it('preserves the base entry classMap when converted formats are merged', () => {
    const merged = mergeConvertedFormats(
      { ...baseEntry, classMap: identityClassMap },
      convertedEntry,
    )
    expect(merged.classMap).toEqual(identityClassMap)
    expect(merged.formats.openvino).toEqual(convertedEntry.formats.openvino)
  })
})

describe('runPlusConversions — per-format isolation (D54)', () => {
  const okResult = {
    entry: convertedEntry,
    artifacts: [
      {
        format: 'openvino' as const,
        precision: 'fp16' as const,
        sizeMB: 25,
        validated: true,
        files: ['camstack-my-plus.xml', 'camstack-my-plus.bin'],
      },
    ],
  }

  it('converts each supported format independently and reports per-format outcomes', async () => {
    const upserts: ModelCatalogEntry[] = []
    const marked: { nodeId: string; format: string }[] = []
    const outcomes = await runPlusConversions(
      {
        recommend: async ({ targets }) =>
          targets.some((t) => t.format === 'coreml')
            ? [{ nodeId: 'mac', reason: 'darwin/ANE', supported: true }]
            : [{ nodeId: 'hub', reason: 'openvino node', supported: true }],
        convert: async (input) => {
          if (input.targets.some((t) => t.format === 'coreml')) {
            throw new Error('coremltools blew up')
          }
          return okResult
        },
        freshSourceUrl: async () => 'https://cdn/x.onnx',
        upsertEntry: async (entry) => {
          upserts.push(entry)
        },
        markAvailable: async (nodeId, _modelId, artifacts) => {
          for (const a of artifacts) marked.push({ nodeId, format: a.format })
        },
      },
      { entry: baseEntry, targetFormats: ['openvino', 'coreml'] },
    )

    // openvino succeeded, coreml failed — BOTH reported, neither hides the other.
    expect(outcomes).toEqual([
      { format: 'openvino', ok: true, nodeId: 'hub' },
      { format: 'coreml', ok: false, error: 'coremltools blew up' },
    ])
    // The upserted entry is the MERGE: onnx + postprocessor survive.
    expect(upserts).toHaveLength(1)
    expect(upserts[0]!.formats.onnx).toBeDefined()
    expect(upserts[0]!.formats.openvino).toBeDefined()
    expect(upserts[0]!.postprocessor).toBe('yolonas')
    expect(marked).toEqual([{ nodeId: 'hub', format: 'openvino' }])
  })

  it('an UNSUPPORTED format (no capable node) is an explicit outcome, not an exception', async () => {
    const outcomes = await runPlusConversions(
      {
        recommend: async ({ targets }) =>
          targets.some((t) => t.format === 'coreml')
            ? [{ nodeId: 'hub', reason: 'coreml needs a darwin node', supported: false }]
            : [{ nodeId: 'hub', reason: 'openvino node', supported: true }],
        convert: async () => okResult,
        freshSourceUrl: async () => 'https://cdn/x.onnx',
        upsertEntry: async () => {},
        markAvailable: async () => {},
      },
      { entry: baseEntry, targetFormats: ['openvino', 'coreml'] },
    )
    expect(outcomes[0]).toEqual({ format: 'openvino', ok: true, nodeId: 'hub' })
    expect(outcomes[1]!.ok).toBe(false)
    expect(outcomes[1]!.error).toMatch(/darwin|no node/i)
  })
})
