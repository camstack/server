/**
 * Format-neutral plugin catalog registry identity.
 */
import { describe, expect, it } from 'vitest'
import type { CustomModelDescriptor } from '@camstack/types'
import {
  migratePluginCatalogCustomModels,
  preferredPluginCatalogTfliteEntry,
  resolvePluginCatalogModelId,
  pluginCatalogCanonicalId,
  pluginCatalogCanonicalIdFromManifestId,
  pluginCatalogDisplayName,
  pluginCatalogManifestIdForFormat,
} from '../plugin-catalog/plugin-catalog-canonical.js'
import { PLUGIN_CATALOG_YOLO_MANIFEST } from '../plugin-catalog/plugin-catalog-yolo-manifest.js'

describe('pluginCatalogCanonicalId', () => {
  it('collapses per-format manifesto rows onto one id', () => {
    const onnx = PLUGIN_CATALOG_YOLO_MANIFEST.find((m) => m.id === 'scrypted-yolov9s-relu-onnx')
    const ov = PLUGIN_CATALOG_YOLO_MANIFEST.find(
      (m) => m.id === 'scrypted-yolov9s-relu-openvino-fp32',
    )
    expect(onnx).toBeTruthy()
    expect(ov).toBeTruthy()
    expect(pluginCatalogCanonicalId(onnx!)).toBe('scrypted-yolov9s-relu-320')
    expect(pluginCatalogCanonicalId(ov!)).toBe('scrypted-yolov9s-relu-320')
    expect(onnx!.model.id).toBe('scrypted-yolov9s-relu-320')
  })

  it('keeps int8 / edgetpu on a separate chip', () => {
    const int8 = PLUGIN_CATALOG_YOLO_MANIFEST.find(
      (m) => m.format === 'openvino' && m.precision === 'int8' && m.family === 'yolov9s',
    )
    expect(int8).toBeTruthy()
    expect(pluginCatalogCanonicalId(int8!)).toBe('scrypted-yolov9s-relu-int8-320')
  })

  it('stamps Test trainings in the display name', () => {
    const test = PLUGIN_CATALOG_YOLO_MANIFEST.find(
      (m) => m.variant === 'relu_test' && m.format === 'onnx',
    )
    expect(test).toBeTruthy()
    expect(pluginCatalogDisplayName(test!)).toMatch(/\(Test\)/)
    expect(test!.model.group?.optimization).toBe('test')
  })
})

describe('resolvePluginCatalogModelId', () => {
  it('aliases a legacy manifesto id to the canonical registry id', () => {
    expect(resolvePluginCatalogModelId('scrypted-yolov9m-relu-openvino-fp32')).toBe(
      'scrypted-yolov9m-relu-320',
    )
    expect(pluginCatalogCanonicalIdFromManifestId('scrypted-yolov9m-relu-320')).toBe(
      'scrypted-yolov9m-relu-320',
    )
  })
})

describe('pluginCatalogManifestIdForFormat / preferred TFLite', () => {
  it('prefers EdgeTPU TFLite when present on the chip', () => {
    const canon = 'scrypted-yolov9s-relu-320'
    const preferred = preferredPluginCatalogTfliteEntry(canon)
    if (preferred === undefined) {
      // Manifest may lack TFLite for this chip — skip preference assert.
      expect(pluginCatalogManifestIdForFormat(canon, 'onnx')).toMatch(/onnx/)
      return
    }
    expect(preferred.format).toBe('tflite')
    expect(pluginCatalogManifestIdForFormat(canon, 'tflite')).toBe(preferred.id)
  })
})

describe('migratePluginCatalogCustomModels', () => {
  it('folds per-format rows into one multi-format entry', () => {
    const a: CustomModelDescriptor = {
      stepId: 'object-detection',
      entry: {
        id: 'scrypted-yolov9s-relu-onnx',
        name: 'legacy onnx',
        description: '',
        formats: { onnx: { url: 'camstack-local://a/a.onnx', sizeMB: 1 } },
        inputSize: { width: 320, height: 320 },
        labels: [],
        provider: 'scrypted',
      },
    }
    const b: CustomModelDescriptor = {
      stepId: 'object-detection',
      entry: {
        id: 'scrypted-yolov9s-relu-openvino-fp32',
        name: 'legacy ov',
        description: '',
        formats: { openvino: { url: 'camstack-local://b/b.xml', sizeMB: 2 } },
        inputSize: { width: 320, height: 320 },
        labels: [],
        provider: 'scrypted',
      },
    }
    const { next, aliases } = migratePluginCatalogCustomModels([a, b])
    expect(next).toHaveLength(1)
    expect(next[0]?.entry.id).toBe('scrypted-yolov9s-relu-320')
    expect(next[0]?.entry.formats.onnx).toBeTruthy()
    expect(next[0]?.entry.formats.openvino).toBeTruthy()
    expect(aliases['scrypted-yolov9s-relu-onnx']).toBe('scrypted-yolov9s-relu-320')
    expect(aliases['scrypted-yolov9s-relu-openvino-fp32']).toBe('scrypted-yolov9s-relu-320')
  })
})
