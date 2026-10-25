import { describe, expect, it, vi } from 'vitest'
import type { ConvertResult, ModelCatalogEntry } from '@camstack/types'
import {
  ensureFormatsThenDistribute,
  missingEngineFormats,
  summarizeConversionOutcomes,
} from '../ensure-formats.js'
import { plusCatalogPlusRegistryId } from '../model-studio-actions.js'

function entry(partial: Partial<ModelCatalogEntry> & { id: string }): ModelCatalogEntry {
  return {
    id: partial.id,
    name: partial.name ?? partial.id,
    description: partial.description ?? '',
    formats: partial.formats ?? { onnx: { url: 'camstack-local://x/x.onnx', sizeMB: 1 } },
    inputSize: partial.inputSize ?? { width: 320, height: 320 },
    labels: partial.labels ?? [],
  }
}

function convertResultFor(format: 'openvino' | 'coreml', base: ModelCatalogEntry): ConvertResult {
  return {
    entry: {
      ...base,
      formats: {
        ...base.formats,
        [format]: { url: `camstack-local://${base.id}/${base.id}.${format}`, sizeMB: 2 },
      },
    },
    artifacts: [
      {
        format,
        precision: format === 'openvino' ? 'fp16' : undefined,
        sizeMB: 2,
        validated: true,
        files: [`${base.id}.${format}`],
      },
    ],
  }
}

describe('plusCatalogPlusRegistryId', () => {
  it('is stable and format-neutral', () => {
    expect(plusCatalogPlusRegistryId('abc-123')).toBe('plus-catalog-abc-123')
  })
})

describe('missingEngineFormats', () => {
  it('lists only absent OV/CoreML when ONNX is present', () => {
    expect(
      missingEngineFormats(entry({ id: 'm', formats: { onnx: { url: 'u', sizeMB: 1 } } })),
    ).toEqual(['openvino', 'coreml'])
    expect(
      missingEngineFormats(
        entry({
          id: 'm',
          formats: {
            onnx: { url: 'u', sizeMB: 1 },
            openvino: { url: 'v', sizeMB: 2 },
          },
        }),
      ),
    ).toEqual(['coreml'])
  })
})

describe('ensureFormatsThenDistribute', () => {
  it('converts missing engines then distributes every format to every agent', async () => {
    let current = entry({
      id: 'm1',
      formats: { onnx: { url: 'camstack-local://m1/m1.onnx', sizeMB: 1 } },
    })
    const convert = vi.fn(
      async (input: { targets: readonly { format: string }[]; metadata: { id: string } }) => {
        const format = input.targets[0]!.format as 'openvino' | 'coreml'
        return convertResultFor(format, current)
      },
    )
    const distribute = vi.fn(async () => ({ sha256: 'aa', bytes: 100 }))

    const result = await ensureFormatsThenDistribute('m1', {
      recommend: async ({ targets }) => [
        {
          nodeId: targets[0]?.format === 'coreml' ? 'mac-mini' : 'hub',
          reason: 'test',
          supported: true,
        },
      ],
      convert: async (input, nodeId) => {
        void nodeId
        const res = await convert(input)
        current = res.entry
        return res
      },
      freshSourceUrl: async () => 'https://signed/onnx',
      upsertEntry: async (e) => {
        current = e
      },
      markAvailable: async () => undefined,
      getEntry: async () => current,
      listAgentNodeIds: async () => ['agent-a', 'agent-b'],
      distribute,
    })

    expect(result.conversions.every((c) => c.ok)).toBe(true)
    expect(convert).toHaveBeenCalledTimes(2)
    // 2 agents × 3 formats (onnx + ov + coreml after ensure)
    expect(distribute).toHaveBeenCalledTimes(6)
    expect(result.distributed.filter((d) => d.ok)).toHaveLength(6)
  })

  it('skips convert when engines already present and still distributes', async () => {
    const current = entry({
      id: 'm2',
      formats: {
        onnx: { url: 'u', sizeMB: 1 },
        openvino: { url: 'v', sizeMB: 1 },
        coreml: { url: 'w', sizeMB: 1 },
      },
    })
    const convert = vi.fn()
    const distribute = vi.fn(async () => ({ sha256: 'bb', bytes: 50 }))
    const result = await ensureFormatsThenDistribute('m2', {
      recommend: async () => [{ nodeId: 'hub', reason: 'x', supported: true }],
      convert,
      freshSourceUrl: async () => 'u',
      upsertEntry: async () => undefined,
      markAvailable: async () => undefined,
      getEntry: async () => current,
      listAgentNodeIds: async () => ['agent-a'],
      distribute,
    })
    expect(convert).not.toHaveBeenCalled()
    expect(result.conversions).toEqual([])
    expect(distribute).toHaveBeenCalledTimes(3)
  })
})

describe('summarizeConversionOutcomes', () => {
  it('reports successes and failures side by side', () => {
    expect(
      summarizeConversionOutcomes([
        { format: 'openvino', ok: true, nodeId: 'hub' },
        { format: 'coreml', ok: false, error: 'no darwin' },
      ]),
    ).toBe(' Engine conversions: openvino ✓ (hub); coreml ✗ — no darwin.')
  })
})
