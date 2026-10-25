/**
 * Task 7B RED — read-only plugin catalog tree drift parser.
 *
 * A production change that would fail this test: auto-importing a remote
 * entry, mutating the local manifest, treating excluded packages as catalog
 * rows, or swallowing a network error as a silent ok.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  comparePluginCatalogManifestDrift,
  fetchPluginCatalogRemoteTree,
  isExcludedPluginCatalogPath,
  normalizePluginCatalogDrift,
  type PluginCatalogHfTreeFile,
} from '../plugin-catalog/plugin-catalog-tree-drift.js'
import {
  PLUGIN_CATALOG_HF_REVISION,
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
  readonly files: readonly PluginCatalogHfTreeFile[]
}

function sampleEntry(): PluginCatalogManifestEntry {
  const entry = PLUGIN_CATALOG_YOLO_MANIFEST[0]
  if (!entry) throw new Error('manifest empty')
  return entry
}

describe('isExcludedPluginCatalogPath', () => {
  it('ignores face, seg, vgg, clip, craft and ncnn packages', () => {
    expect(isExcludedPluginCatalogPath('coreml/scrypted_yolov9t_relu_face/x.onnx')).toBe(true)
    expect(isExcludedPluginCatalogPath('onnx/scrypted_yolov9t_seg_relu/x.onnx')).toBe(true)
    expect(isExcludedPluginCatalogPath('onnx/vgg_english_g2/vgg_english_g2.onnx')).toBe(true)
    expect(isExcludedPluginCatalogPath('onnx/clip/vision.onnx')).toBe(true)
    expect(isExcludedPluginCatalogPath('onnx/craft/craft.onnx')).toBe(true)
    expect(isExcludedPluginCatalogPath('ncnn/scrypted_yolov9c_relu/best_converted.ncnn.bin')).toBe(
      true,
    )
    expect(
      isExcludedPluginCatalogPath('onnx/scrypted_yolov9c_relu/scrypted_yolov9c_relu.onnx'),
    ).toBe(false)
  })
})

describe('comparePluginCatalogManifestDrift', () => {
  it('reports ok when every declared file is present at the declared size', () => {
    const entry = sampleEntry()
    const drift = comparePluginCatalogManifestDrift([entry], FIXTURE.files)
    expect(drift).toEqual([{ manifestId: entry.id, status: 'ok' }])
  })

  it('reports missing when a declared file is absent from the remote tree', () => {
    const entry = sampleEntry()
    const drift = comparePluginCatalogManifestDrift([entry], [])
    expect(drift[0]?.status).toBe('missing')
    expect(drift[0]?.manifestId).toBe(entry.id)
    expect(drift[0]?.details).toMatch(/missing/i)
  })

  it('reports size-changed when a declared file size diverges', () => {
    const entry = sampleEntry()
    const mutated = FIXTURE.files.map((file) =>
      file.path === entry.files[0]?.relativePath
        ? {
            ...file,
            size: file.size + 99,
            lfs: file.lfs ? { ...file.lfs, size: file.size + 99 } : undefined,
          }
        : file,
    )
    const drift = comparePluginCatalogManifestDrift([entry], mutated)
    expect(drift[0]?.status).toBe('size-changed')
    expect(drift[0]?.details).toMatch(/size/i)
  })

  it('never auto-adds a remote-only YOLO file as a manifest entry', () => {
    const before = PLUGIN_CATALOG_YOLO_MANIFEST.map((entry) => entry.id)
    const remoteOnly: PluginCatalogHfTreeFile = {
      path: 'onnx/scrypted_yolov9x_relu/scrypted_yolov9x_relu.onnx',
      size: 12,
    }
    const drift = comparePluginCatalogManifestDrift(PLUGIN_CATALOG_YOLO_MANIFEST, [
      ...FIXTURE.files,
      remoteOnly,
    ])
    expect(drift.every((row) => before.includes(row.manifestId))).toBe(true)
    expect(drift.some((row) => row.manifestId.includes('yolov9x'))).toBe(false)
    expect(PLUGIN_CATALOG_YOLO_MANIFEST.map((entry) => entry.id)).toEqual(before)
  })

  it('does not emit drift rows for excluded remote packages', () => {
    const excluded = FIXTURE.files.filter((file) => isExcludedPluginCatalogPath(file.path))
    expect(excluded.length).toBeGreaterThan(0)
    const drift = comparePluginCatalogManifestDrift(PLUGIN_CATALOG_YOLO_MANIFEST, FIXTURE.files)
    expect(
      drift.every((row) =>
        PLUGIN_CATALOG_YOLO_MANIFEST.some((entry) => entry.id === row.manifestId),
      ),
    ).toBe(true)
  })
})

describe('normalizePluginCatalogDrift', () => {
  it('maps unknown statuses fail-closed to unavailable, never ok', () => {
    expect(normalizePluginCatalogDrift({ manifestId: 'x', status: 'ok' }).status).toBe('ok')
    expect(normalizePluginCatalogDrift({ manifestId: 'x', status: 'missing' }).status).toBe(
      'missing',
    )
    expect(normalizePluginCatalogDrift({ manifestId: 'x', status: 'size-changed' }).status).toBe(
      'size-changed',
    )
    expect(normalizePluginCatalogDrift({ manifestId: 'x', status: 'unavailable' }).status).toBe(
      'unavailable',
    )
    const unknown = normalizePluginCatalogDrift({ manifestId: 'x', status: 'totally-new' })
    expect(unknown.status).toBe('unavailable')
    expect(unknown.status).not.toBe('ok')
    expect(unknown.details).toMatch(/unknown|unavailable|totally-new/i)
  })
})

describe('fetchPluginCatalogRemoteTree', () => {
  it('returns an explicit unavailable error without mutating the manifest', async () => {
    const before = structuredClone(PLUGIN_CATALOG_YOLO_MANIFEST)
    await expect(
      fetchPluginCatalogRemoteTree({
        fetchImpl: async () => {
          throw new Error('ECONNRESET huggingface.co')
        },
        retryDelayMs: 0,
        maxRetries: 2,
      }),
    ).rejects.toThrow(/unavailable|ECONNRESET|huggingface/i)
    expect(PLUGIN_CATALOG_YOLO_MANIFEST).toEqual(before)
    expect(PLUGIN_CATALOG_HF_REVISION).toBe(FIXTURE.revision)
  })
})
