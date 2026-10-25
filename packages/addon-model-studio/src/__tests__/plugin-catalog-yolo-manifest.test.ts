/**
 * Task 7B RED — local plugin catalog YOLO manifest invariants.
 *
 * A production change that would fail this test: duplicate ids, a family
 * outside t/s/m/c, an excluded package (face/seg/vgg/clip/craft/ncnn), a
 * format combination the spec does not enumerate, labels/classMap other
 * than the identity macro map, an incomplete CoreML/OpenVINO payload, a
 * traversable path, or a non-positive declared size.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { PluginCatalogManifestFileSchema } from '../model-studio-actions.js'
import { pluginCatalogBundleFingerprint } from '../plugin-catalog/plugin-catalog-import.js'
import {
  PLUGIN_CATALOG_HF_HOST,
  PLUGIN_CATALOG_HF_REPO,
  PLUGIN_CATALOG_HF_REVISION,
  PLUGIN_CATALOG_IDENTITY_CLASS_MAP,
  PLUGIN_CATALOG_YOLO_LABELS,
  PLUGIN_CATALOG_YOLO_MANIFEST,
  type PluginCatalogManifestEntry,
} from '../plugin-catalog/plugin-catalog-yolo-manifest.js'

const FIXTURE = JSON.parse(
  readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      'fixtures/plugin-catalog-plugin-models-tree.json',
    ),
    'utf8',
  ),
) as {
  readonly revision: string
  readonly files: readonly { readonly path: string; readonly size: number }[]
}

const EXCLUDED = /(?:^|\/)(?:face|seg|vgg|clip|craft|ncnn)(?:\/|_|\.|$)|_face|_seg_/i

const FAMILIES = ['yolov9t', 'yolov9s', 'yolov9m', 'yolov9c'] as const
const VARIANTS = ['relu', 'relu_test'] as const

function allPaths(entry: PluginCatalogManifestEntry): readonly string[] {
  return entry.files.map((file) => file.relativePath)
}

describe('PLUGIN_CATALOG_YOLO_MANIFEST — source pin', () => {
  it('pins the verified Hugging Face revision used to build the fixture', () => {
    expect(PLUGIN_CATALOG_HF_HOST).toBe('https://huggingface.co')
    expect(PLUGIN_CATALOG_HF_REPO).toBe('scrypted/plugin-models')
    expect(PLUGIN_CATALOG_HF_REVISION).toBe(FIXTURE.revision)
    expect(PLUGIN_CATALOG_HF_REVISION).toMatch(/^[0-9a-f]{40}$/)
  })
})

describe('PLUGIN_CATALOG_YOLO_MANIFEST — identity', () => {
  it('has unique stable ids and only families t/s/m/c', () => {
    expect(PLUGIN_CATALOG_YOLO_MANIFEST.length).toBeGreaterThanOrEqual(33)
    const ids = PLUGIN_CATALOG_YOLO_MANIFEST.map((entry) => entry.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const entry of PLUGIN_CATALOG_YOLO_MANIFEST) {
      expect(ids.filter((id) => id === entry.id)).toHaveLength(1)
      expect(FAMILIES).toContain(entry.family)
      expect(VARIANTS).toContain(entry.variant)
    }
  })

  it('contains only YOLO / YOLO test detector packages', () => {
    expect(PLUGIN_CATALOG_YOLO_MANIFEST.length).toBeGreaterThan(0)
    for (const entry of PLUGIN_CATALOG_YOLO_MANIFEST) {
      for (const relativePath of allPaths(entry)) {
        expect(relativePath.toLowerCase()).toMatch(/yolo/)
        expect(relativePath).not.toMatch(EXCLUDED)
      }
    }
  })

  it('never lists face, seg, vgg, clip, craft or /ncnn/ paths', () => {
    expect(PLUGIN_CATALOG_YOLO_MANIFEST.length).toBeGreaterThan(0)
    const joined = PLUGIN_CATALOG_YOLO_MANIFEST.flatMap((entry) => allPaths(entry)).join('\n')
    expect(joined).not.toMatch(/face/i)
    expect(joined).not.toMatch(/seg/i)
    expect(joined).not.toMatch(/vgg/i)
    expect(joined).not.toMatch(/clip/i)
    expect(joined).not.toMatch(/craft/i)
    expect(joined).not.toMatch(/\/ncnn\//i)
  })
})

describe('PLUGIN_CATALOG_YOLO_MANIFEST — spec combinations', () => {
  function ids(format: PluginCatalogManifestEntry['format'], precision?: string) {
    return PLUGIN_CATALOG_YOLO_MANIFEST.filter(
      (entry) =>
        entry.format === format && (precision === undefined || entry.precision === precision),
    )
  }

  it('covers CoreML and ONNX for every family × relu/relu_test', () => {
    for (const format of ['coreml', 'onnx'] as const) {
      for (const family of FAMILIES) {
        for (const variant of VARIANTS) {
          const match = PLUGIN_CATALOG_YOLO_MANIFEST.filter(
            (entry) =>
              entry.format === format && entry.family === family && entry.variant === variant,
          )
          expect(match, `${format} ${family} ${variant}`).toHaveLength(1)
        }
      }
    }
  })

  it('covers OpenVINO FP32 only for standard relu (no test) and INT8 for both variants', () => {
    for (const family of FAMILIES) {
      expect(
        PLUGIN_CATALOG_YOLO_MANIFEST.filter(
          (entry) =>
            entry.format === 'openvino' &&
            entry.family === family &&
            entry.variant === 'relu' &&
            entry.precision === 'fp32',
        ),
      ).toHaveLength(1)
      expect(
        PLUGIN_CATALOG_YOLO_MANIFEST.filter(
          (entry) =>
            entry.format === 'openvino' &&
            entry.family === family &&
            entry.variant === 'relu_test' &&
            entry.precision === 'fp32',
        ),
      ).toHaveLength(0)
      for (const variant of VARIANTS) {
        expect(
          PLUGIN_CATALOG_YOLO_MANIFEST.filter(
            (entry) =>
              entry.format === 'openvino' &&
              entry.family === family &&
              entry.variant === variant &&
              entry.precision === 'int8',
          ),
        ).toHaveLength(1)
      }
    }
  })

  it('covers TFLite only for yolov9s relu sep 320 with the verified precisions', () => {
    const tflite = ids('tflite')
    expect(tflite.every((entry) => entry.family === 'yolov9s')).toBe(true)
    expect(tflite.every((entry) => entry.variant === 'relu')).toBe(true)
    expect(tflite.map((entry) => entry.precision).toSorted()).toEqual(
      ['edgetpu', 'float16', 'float32', 'full_integer_quant', 'int8', 'integer_quant'].toSorted(),
    )
  })
})

describe('PLUGIN_CATALOG_YOLO_MANIFEST — verified input and preprocess', () => {
  /**
   * Evidence at pin 187402b20a3be0a7fab9bceee21d857ed6ae0064:
   * OpenVINO XML 12/12, CoreML 8/8, ONNX 8/8, TFLite 6/6 all declare
   * 320×320. Output layout [1,7,2100] + labels person/vehicle/animal +
   * cxcywh parse are verified. plugin catalog default preprocess is RGB
   * resize/stretch to square; `settings.pad` is opt-in and not equivalent
   * to CamStack letterbox — this catalog must stay on `resize`.
   */
  it('declares inputSize 320x320 on every one of the 34 entries', () => {
    expect(PLUGIN_CATALOG_YOLO_MANIFEST).toHaveLength(34)
    const byFormat = { openvino: 0, coreml: 0, onnx: 0, tflite: 0 }
    for (const entry of PLUGIN_CATALOG_YOLO_MANIFEST) {
      expect(entry.inputSize, entry.id).toEqual({ width: 320, height: 320 })
      expect(entry.model.inputSize, entry.id).toEqual({ width: 320, height: 320 })
      byFormat[entry.format] += 1
    }
    expect(byFormat).toEqual({ openvino: 12, coreml: 8, onnx: 8, tflite: 6 })
  })

  it('uses preprocessMode resize (stretch) and forbids letterbox on this catalog', () => {
    expect(PLUGIN_CATALOG_YOLO_MANIFEST).toHaveLength(34)
    for (const entry of PLUGIN_CATALOG_YOLO_MANIFEST) {
      expect(entry.model.preprocessMode, entry.id).toBe('resize')
      expect(entry.model.preprocessMode, entry.id).not.toBe('letterbox')
    }
  })

  it('stamps yolo-split-dfl only on tflite (6-tensor DFL head); other formats stay on step-default yolo', () => {
    for (const entry of PLUGIN_CATALOG_YOLO_MANIFEST) {
      if (entry.format === 'tflite') {
        expect(entry.model.postprocessor, entry.id).toBe('yolo-split-dfl')
      } else {
        expect(entry.model.postprocessor, entry.id).toBeUndefined()
      }
    }
  })
})

describe('PLUGIN_CATALOG_YOLO_MANIFEST — labels and classMap', () => {
  it('declares exactly person/vehicle/animal and the identity classMap on every entry', () => {
    expect(PLUGIN_CATALOG_YOLO_LABELS).toEqual(['person', 'vehicle', 'animal'])
    expect(PLUGIN_CATALOG_IDENTITY_CLASS_MAP).toEqual({
      mapping: { person: 'person', vehicle: 'vehicle', animal: 'animal' },
      preserveOriginal: false,
    })
    for (const entry of PLUGIN_CATALOG_YOLO_MANIFEST) {
      expect(entry.model.labels.map((label) => label.id)).toEqual(['person', 'vehicle', 'animal'])
      expect(entry.model.classMap).toEqual(PLUGIN_CATALOG_IDENTITY_CLASS_MAP)
    }
  })
})

describe('PLUGIN_CATALOG_YOLO_MANIFEST — payloads and paths', () => {
  it('declares complete CoreML and OpenVINO payloads', () => {
    expect(PLUGIN_CATALOG_YOLO_MANIFEST.some((entry) => entry.format === 'coreml')).toBe(true)
    expect(PLUGIN_CATALOG_YOLO_MANIFEST.some((entry) => entry.format === 'openvino')).toBe(true)
    for (const entry of PLUGIN_CATALOG_YOLO_MANIFEST) {
      if (entry.format === 'coreml') {
        const paths = allPaths(entry)
        expect(paths.some((p) => p.endsWith('Manifest.json'))).toBe(true)
        expect(paths.some((p) => p.endsWith('model.mlmodel'))).toBe(true)
        expect(paths.some((p) => p.endsWith('weight.bin'))).toBe(true)
        expect(entry.model.formats.coreml?.isDirectory).toBe(true)
        expect(entry.files.length).toBeGreaterThanOrEqual(3)
      }
      if (entry.format === 'openvino') {
        const paths = allPaths(entry)
        expect(paths.some((p) => p.endsWith('.xml'))).toBe(true)
        expect(paths.some((p) => p.endsWith('.bin'))).toBe(true)
        expect(entry.files.length).toBe(2)
      }
    }
  })

  it('rejects absolute paths, .., empty segments and backslashes; sizes are positive', () => {
    expect(PLUGIN_CATALOG_YOLO_MANIFEST.length).toBeGreaterThan(0)
    for (const entry of PLUGIN_CATALOG_YOLO_MANIFEST) {
      for (const file of entry.files) {
        expect(file.relativePath.startsWith('/')).toBe(false)
        expect(file.relativePath.includes('\\')).toBe(false)
        expect(file.relativePath.split('/').every((segment) => segment.length > 0)).toBe(true)
        expect(file.relativePath.split('/').includes('..')).toBe(false)
        expect(file.size).toBeGreaterThan(0)
      }
    }
  })

  it('declared file sizes match the pinned HF fixture (no invented sizes)', () => {
    expect(PLUGIN_CATALOG_YOLO_MANIFEST.length).toBeGreaterThan(0)
    const fixtureSize = new Map(FIXTURE.files.map((file) => [file.path, file.size]))
    for (const entry of PLUGIN_CATALOG_YOLO_MANIFEST) {
      for (const file of entry.files) {
        expect(fixtureSize.get(file.relativePath), file.relativePath).toBe(file.size)
      }
    }
  })

  it('requires a 64-hex sha256 on every declared file (62/62)', () => {
    const files = PLUGIN_CATALOG_YOLO_MANIFEST.flatMap((entry) => entry.files)
    expect(files).toHaveLength(62)
    for (const file of files) {
      expect(file.sha256, file.relativePath).toMatch(/^[0-9a-f]{64}$/)
    }
    expect(() =>
      PluginCatalogManifestFileSchema.parse({ relativePath: 'onnx/x.onnx', size: 1 }),
    ).toThrow(/sha256/i)
    expect(() =>
      PluginCatalogManifestFileSchema.parse({
        relativePath: 'onnx/x.onnx',
        size: 1,
        sha256: 'not-a-hash',
      }),
    ).toThrow(/sha256|hex|64/i)
  })
})

describe('pluginCatalogBundleFingerprint', () => {
  it('is a stable non-empty digest of ordered path+sha, not the primary file alone', () => {
    const coreml = PLUGIN_CATALOG_YOLO_MANIFEST.find((entry) => entry.format === 'coreml')
    if (!coreml) throw new Error('need a multi-file CoreML entry')
    expect(coreml.files.length).toBeGreaterThan(1)
    const first = pluginCatalogBundleFingerprint(coreml)
    const shuffled = {
      ...coreml,
      files: [...coreml.files].reverse(),
    }
    expect(pluginCatalogBundleFingerprint(shuffled)).toBe(first)
    expect(first).toMatch(/^[0-9a-f]{64}$/)
    expect(first).not.toBe(coreml.files[0]?.sha256)
    const mutated = {
      ...coreml,
      files: coreml.files.map((file, index) =>
        index === 0
          ? { ...file, sha256: 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff' }
          : file,
      ),
    }
    expect(pluginCatalogBundleFingerprint(mutated)).not.toBe(first)
  })
})
