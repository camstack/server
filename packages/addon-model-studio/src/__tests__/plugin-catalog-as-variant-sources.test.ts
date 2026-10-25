/**
 * plugin catalog manifesto → ModelVariantSource for GroupedModelSelector cards.
 */
import { describe, expect, it } from 'vitest'
import { buildModelVariantGroups } from '@camstack/types'
import type { ModelCatalogEntry } from '@camstack/types'
import type { PluginCatalogCatalogEntryView } from '../ui/api.js'
import {
  pluginCatalogEntriesAsVariantSources,
  pluginCatalogEntryForFormat,
} from '../plugin-catalog/plugin-catalog-as-variant-sources.js'

const SHA = 'a'.repeat(64)

function modelEntry(
  id: string,
  format: PluginCatalogCatalogEntryView['format'],
  sizeMB: number,
): ModelCatalogEntry {
  return {
    id,
    name: id,
    description: id,
    formats: {
      [format]: { url: `camstack-local://${id}/artifact`, sizeMB, runtimes: ['python'] },
    },
    inputSize: { width: 320, height: 320 },
    labels: [],
  }
}

function entry(
  over: Partial<PluginCatalogCatalogEntryView> &
    Pick<PluginCatalogCatalogEntryView, 'id' | 'label'>,
): PluginCatalogCatalogEntryView {
  const format = over.format ?? 'onnx'
  return {
    family: 'yolov9s',
    variant: 'relu',
    format,
    precision: 'fp32',
    inputSize: { width: 320, height: 320 },
    files: [{ relativePath: `${format}/x.bin`, size: 1_000_000, sha256: SHA }],
    model: modelEntry(over.id, format, 1),
    ...over,
  }
}

describe('pluginCatalogEntriesAsVariantSources', () => {
  it('merges onnx + openvino + coreml on one Standard chip; no Fast from fp16', () => {
    const entries = [
      entry({ id: 's-onnx', label: 'S ONNX', format: 'onnx', precision: 'fp32' }),
      entry({ id: 's-ov', label: 'S OV', format: 'openvino', precision: 'fp32' }),
      entry({ id: 's-coreml', label: 'S CoreML', format: 'coreml', precision: 'fp16' }),
      entry({
        id: 's-ov-int8',
        label: 'S OV Int8',
        format: 'openvino',
        precision: 'int8',
      }),
    ]
    const sources = pluginCatalogEntriesAsVariantSources(entries)
    expect(buildModelVariantGroups(sources).map((f) => f.family)).toEqual(['yolov9'])
    expect(sources.every((s) => s.group?.optimization === undefined)).toBe(true)

    const fp32 = sources.find((s) => s.group?.precision === 'fp32')
    expect(fp32?.id).toBe('scrypted-yolov9s-relu-320')
    expect(fp32?.id).not.toMatch(/onnx|coreml|openvino|tflite/i)
    expect(fp32?.formats).toMatchObject({ onnx: {}, openvino: {}, coreml: {} })
    expect(pluginCatalogEntryForFormat(entries, fp32!.id, 'coreml')?.id).toBe('s-coreml')

    const int8 = sources.find((s) => s.group?.precision === 'int8')
    expect(int8?.id).toBe('scrypted-yolov9s-relu-int8-320')
    expect(int8?.formats.openvino).toBeTruthy()
  })

  it('keeps relu and relu_test as separate sources when both are passed (caller filters)', () => {
    const entries = [
      entry({ id: 's-relu', label: 'S', format: 'onnx', variant: 'relu' }),
      entry({ id: 's-test', label: 'S Test', format: 'onnx', variant: 'relu_test' }),
    ]
    const sources = pluginCatalogEntriesAsVariantSources(entries)
    expect(sources).toHaveLength(2)
    const test = sources.find((s) => s.group?.optimization === 'test')
    expect(test?.id).toBe('scrypted-yolov9s-relu_test-320')
    expect(sources.find((s) => s.id === 'scrypted-yolov9s-relu-320')?.group?.optimization).toBe(
      undefined,
    )
  })

  it('merges TFLite onto the same chip as ONNX', () => {
    const entries = [
      entry({ id: 's-onnx', label: 'S ONNX', format: 'onnx', precision: 'fp32' }),
      entry({ id: 's-tflite', label: 'S TFLite', format: 'tflite', precision: 'float16' }),
    ]
    const sources = pluginCatalogEntriesAsVariantSources(entries)
    expect(sources).toHaveLength(1)
    expect(sources[0]?.formats).toMatchObject({ onnx: {}, tflite: {} })
  })
})
