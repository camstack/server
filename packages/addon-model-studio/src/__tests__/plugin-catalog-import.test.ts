/**
 * Task 7B RED — plugin catalog catalog import (server-owned id only).
 *
 * A production change that would fail this test: accepting a client URL,
 * importing an unknown or drifted id, keeping an LFS pointer, skipping
 * size/checksum bounds, leaving staging files after failure, registering
 * an incomplete CoreML/OpenVINO payload, or a non-idempotent re-import.
 */
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { modelStudioActions } from '../model-studio-actions.js'
import {
  hashFileSha256,
  importPluginCatalogCatalogModel,
  resolvePluginCatalogImportedFormat,
  type PluginCatalogImportDeps,
  verifyPluginCatalogStagedFile,
} from '../plugin-catalog/plugin-catalog-import.js'
import type { PluginCatalogCatalogDrift } from '../plugin-catalog/plugin-catalog-tree-drift.js'
import {
  PLUGIN_CATALOG_HF_HOST,
  PLUGIN_CATALOG_HF_REPO,
  PLUGIN_CATALOG_IDENTITY_CLASS_MAP,
  PLUGIN_CATALOG_YOLO_MANIFEST,
  type PluginCatalogManifestEntry,
} from '../plugin-catalog/plugin-catalog-yolo-manifest.js'

const LFS_POINTER = [
  'version https://git-lfs.github.com/spec/v1',
  'oid sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  'size 101631962',
  '',
].join('\n')

function entryBy(format: PluginCatalogManifestEntry['format']): PluginCatalogManifestEntry {
  const entry = PLUGIN_CATALOG_YOLO_MANIFEST.find((candidate) => candidate.format === format)
  if (!entry) throw new Error(`no ${format} entry`)
  return entry
}

function bytesFor(
  file: PluginCatalogManifestEntry['files'][number],
  kind: 'ok' | 'lfs' | 'wrong-size',
): Buffer {
  if (kind === 'lfs') return Buffer.from(LFS_POINTER)
  if (kind === 'wrong-size') return Buffer.alloc(32, 7)
  const payload = Buffer.alloc(file.size, 1)
  if (file.sha256) {
    // Content is synthetic; sha is checked against the written bytes when
    // the test asks for a mismatch via deps, not here.
  }
  return payload
}

interface Harness {
  readonly stagingDir: string
  readonly modelsDir: string
  readonly downloads: string[]
  readonly deps: PluginCatalogImportDeps
  payloads: Map<string, Buffer>
}

function makeHarness(opts?: {
  readonly drift?: readonly PluginCatalogCatalogDrift[]
  readonly maxFileBytes?: number
}): Harness {
  const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-catalog-stage-'))
  const modelsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-catalog-models-'))
  const downloads: string[] = []
  const payloads = new Map<string, Buffer>()
  const deps: PluginCatalogImportDeps = {
    stagingDir,
    modelsDir,
    maxFileBytes: opts?.maxFileBytes,
    driftFor: async (manifestId) =>
      opts?.drift?.find((row) => row.manifestId === manifestId) ?? { manifestId, status: 'ok' },
    downloadFile: async (url, destPath) => {
      downloads.push(url)
      fs.mkdirSync(path.dirname(destPath), { recursive: true })
      const body = payloads.get(url) ?? Buffer.from('missing-payload')
      fs.writeFileSync(destPath, body)
      return destPath
    },
  }
  return { stagingDir, modelsDir, downloads, deps, payloads }
}

function seedOkPayloads(harness: Harness, entry: PluginCatalogManifestEntry): void {
  for (const file of entry.files) {
    harness.payloads.set(file.relativePath, bytesFor(file, 'ok'))
  }
  harness.deps.fileSha256 = async (filePath) => {
    const rel = entry.files.find((file) =>
      filePath.endsWith(file.relativePath.split('/').pop() ?? ''),
    )
    return rel?.sha256 ?? createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
  }
  harness.deps.downloadFile = async (url, destPath) => {
    const file = entry.files.find(
      (candidate) =>
        url.endsWith(candidate.relativePath.split('/').map(encodeURIComponent).join('/')) ||
        url.includes(candidate.relativePath),
    )
    const body = file ? bytesFor(file, 'ok') : Buffer.from('missing-payload')
    harness.downloads.push(url)
    fs.mkdirSync(path.dirname(destPath), { recursive: true })
    fs.writeFileSync(destPath, body)
    return destPath
  }
}

describe('importPluginCatalogCatalogModel action schema', () => {
  it('accepts only { manifestId } — client URL/path/labels/checksum are dropped', () => {
    const parsed = modelStudioActions.importPluginCatalogCatalogModel.input.parse({
      manifestId: 'scrypted-yolov9t-relu-onnx',
      url: 'https://evil.example/model.onnx',
      path: '/etc/passwd',
      labels: ['person'],
      classMap: { mapping: { person: 'person' }, preserveOriginal: true },
      sha256: 'abc',
    })
    expect(parsed).toEqual({ manifestId: 'scrypted-yolov9t-relu-onnx' })
    expect(parsed).not.toHaveProperty('url')
  })
})

describe('importPluginCatalogCatalogModel', () => {
  let harness: Harness

  beforeEach(() => {
    harness = makeHarness()
  })
  afterEach(() => {
    fs.rmSync(harness.stagingDir, { recursive: true, force: true })
    fs.rmSync(harness.modelsDir, { recursive: true, force: true })
  })

  it('rejects an unknown manifest id', async () => {
    await expect(
      importPluginCatalogCatalogModel({ manifestId: 'no-such-model' }, harness.deps),
    ).rejects.toThrow(/unknown/i)
    expect(fs.readdirSync(harness.stagingDir)).toEqual([])
  })

  it('rejects an unknown drift status as unavailable and does not treat it as ok', async () => {
    const entry = entryBy('onnx')
    const unknown = makeHarness({
      drift: [
        { manifestId: entry.id, status: 'totally-new' as PluginCatalogCatalogDrift['status'] },
      ],
    })
    try {
      await expect(
        importPluginCatalogCatalogModel({ manifestId: entry.id }, unknown.deps),
      ).rejects.toThrow(/drift|unavailable|unknown/i)
      expect(fs.readdirSync(unknown.stagingDir)).toEqual([])
    } finally {
      fs.rmSync(unknown.stagingDir, { recursive: true, force: true })
      fs.rmSync(unknown.modelsDir, { recursive: true, force: true })
    }
  })

  it('rejects a drifted entry and cleans staging', async () => {
    const entry = entryBy('onnx')
    const drifted = makeHarness({
      drift: [{ manifestId: entry.id, status: 'size-changed', details: 'size mismatch' }],
    })
    try {
      await expect(
        importPluginCatalogCatalogModel({ manifestId: entry.id }, drifted.deps),
      ).rejects.toThrow(/drift|size-changed/i)
      expect(fs.readdirSync(drifted.stagingDir)).toEqual([])
    } finally {
      fs.rmSync(drifted.stagingDir, { recursive: true, force: true })
      fs.rmSync(drifted.modelsDir, { recursive: true, force: true })
    }
  })

  it('rejects an LFS pointer and cleans staging', async () => {
    const entry = entryBy('onnx')
    const file = entry.files[0]
    if (!file) throw new Error('onnx file missing')
    harness.deps.downloadFile = async (_url, destPath) => {
      harness.downloads.push(_url)
      fs.mkdirSync(path.dirname(destPath), { recursive: true })
      fs.writeFileSync(destPath, LFS_POINTER)
      return destPath
    }
    await expect(
      importPluginCatalogCatalogModel({ manifestId: entry.id }, harness.deps),
    ).rejects.toThrow(/lfs/i)
    expect(fs.readdirSync(harness.stagingDir)).toEqual([])
  })

  it('rejects a file over the size limit or outside tolerance and cleans staging', async () => {
    const entry = entryBy('onnx')
    const limited = makeHarness({ maxFileBytes: 16 })
    limited.deps.downloadFile = async (_url, destPath) => {
      fs.mkdirSync(path.dirname(destPath), { recursive: true })
      fs.writeFileSync(destPath, Buffer.alloc(64, 2))
      return destPath
    }
    try {
      await expect(
        importPluginCatalogCatalogModel({ manifestId: entry.id }, limited.deps),
      ).rejects.toThrow(/size|limit|tolerance/i)
      expect(fs.readdirSync(limited.stagingDir)).toEqual([])
    } finally {
      fs.rmSync(limited.stagingDir, { recursive: true, force: true })
      fs.rmSync(limited.modelsDir, { recursive: true, force: true })
    }
  })

  it('requires a complete CoreML payload before finalize', async () => {
    const base = entryBy('coreml')
    const files = base.files.filter((file) => !file.relativePath.endsWith('weight.bin'))
    expect(files.length).toBeGreaterThanOrEqual(2)
    expect(files.every((file) => /^[0-9a-f]{64}$/.test(file.sha256))).toBe(true)
    const entry = { ...base, files }
    harness.deps.resolveEntry = () => entry
    seedOkPayloads(harness, entry)
    await expect(
      importPluginCatalogCatalogModel({ manifestId: entry.id }, harness.deps),
    ).rejects.toThrow(
      'CoreML payload is incomplete — Manifest.json, model and weights are required',
    )
    expect(fs.readdirSync(harness.stagingDir)).toEqual([])
  })

  it('requires a complete OpenVINO xml+bin payload before finalize', async () => {
    const base = entryBy('openvino')
    const files = base.files.filter((file) => !file.relativePath.endsWith('.bin'))
    expect(files).toHaveLength(1)
    expect(files[0]?.relativePath.endsWith('.xml')).toBe(true)
    expect(files.every((file) => /^[0-9a-f]{64}$/.test(file.sha256))).toBe(true)
    const entry = { ...base, files }
    harness.deps.resolveEntry = () => entry
    seedOkPayloads(harness, entry)
    await expect(
      importPluginCatalogCatalogModel({ manifestId: entry.id }, harness.deps),
    ).rejects.toThrow('OpenVINO payload is incomplete — xml and bin siblings are required')
    expect(fs.readdirSync(harness.stagingDir)).toEqual([])
  })

  it('registers a descriptor with labels, identity classMap and hub-local artifact', async () => {
    const entry = entryBy('onnx')
    seedOkPayloads(harness, entry)
    const descriptor = await importPluginCatalogCatalogModel({ manifestId: entry.id }, harness.deps)
    expect(descriptor.stepId).toBe('object-detection')
    expect(descriptor.entry.id).toBe(entry.model.id)
    expect(descriptor.entry.id).not.toMatch(/-(onnx|openvino|coreml|tflite)/)
    expect(descriptor.entry.labels.map((label) => label.id)).toEqual([
      'person',
      'vehicle',
      'animal',
    ])
    expect(descriptor.entry.classMap).toEqual(PLUGIN_CATALOG_IDENTITY_CLASS_MAP)
    expect(descriptor.entry.labels).toEqual(entry.model.labels)
    expect(descriptor.entry.formats.onnx?.url).toMatch(/^camstack-local:\/\//)
    expect(descriptor.entry.formats.onnx?.url).not.toContain('evil')
    expect(resolvePluginCatalogImportedFormat(entry.id, descriptor)).toBe('onnx')
    for (const url of harness.downloads) {
      expect(url.startsWith(`${PLUGIN_CATALOG_HF_HOST}/${PLUGIN_CATALOG_HF_REPO}/resolve/`)).toBe(
        true,
      )
      expect(url).not.toContain('..')
    }
    expect(fs.readdirSync(harness.stagingDir)).toEqual([])
  })

  it('rejects a checksum mismatch and cleans staging', async () => {
    const entry = entryBy('onnx')
    const file = entry.files[0]
    if (!file?.sha256) throw new Error('expected a sha256 on the onnx file')
    harness.deps.downloadFile = async (_url, destPath) => {
      fs.mkdirSync(path.dirname(destPath), { recursive: true })
      fs.writeFileSync(destPath, Buffer.alloc(file.size, 9))
      return destPath
    }
    await expect(
      importPluginCatalogCatalogModel({ manifestId: entry.id }, harness.deps),
    ).rejects.toThrow(/checksum|sha256/i)
    expect(fs.readdirSync(harness.stagingDir)).toEqual([])
  })

  it('is idempotent on repeat import', async () => {
    const entry = entryBy('onnx')
    seedOkPayloads(harness, entry)
    const first = await importPluginCatalogCatalogModel({ manifestId: entry.id }, harness.deps)
    const second = await importPluginCatalogCatalogModel({ manifestId: entry.id }, harness.deps)
    expect(second.entry.id).toBe(first.entry.id)
    expect(second.entry.formats.onnx?.url).toBe(first.entry.formats.onnx?.url)
    expect(first.entry.provider).toBe('scrypted')
  })

  it('builds download URLs with encoded segments and never follows client paths', async () => {
    const entry = entryBy('onnx')
    seedOkPayloads(harness, entry)
    await importPluginCatalogCatalogModel({ manifestId: entry.id }, harness.deps)
    for (const url of harness.downloads) {
      const rest = url.slice(`${PLUGIN_CATALOG_HF_HOST}/${PLUGIN_CATALOG_HF_REPO}/resolve/`.length)
      const segments = rest.split('/')
      expect(segments[0]).toMatch(/^[0-9a-f]{40}$/)
      expect(decodeURIComponent(rest)).not.toMatch(/^\/|\\|\.\./)
    }
  })
})

describe('resolvePluginCatalogImportedFormat', () => {
  it('uses the manifesto format, not Object.keys(formats)[0]', () => {
    const coreml = entryBy('coreml')
    const descriptor = {
      stepId: 'object-detection' as const,
      entry: {
        ...coreml.model,
        formats: {
          onnx: { url: 'camstack-local://decoy/decoy.onnx', sizeMB: 1 },
          [coreml.format]: coreml.model.formats.coreml,
        },
      },
    }
    expect(Object.keys(descriptor.entry.formats)[0]).toBe('onnx')
    expect(resolvePluginCatalogImportedFormat(coreml.id, descriptor)).toBe('coreml')
  })
})

describe('real fileSha256 integrity', () => {
  it('accepts matching temp bytes and rejects a one-byte flip, cleaning staging', async () => {
    const entry = PLUGIN_CATALOG_YOLO_MANIFEST.find((candidate) =>
      candidate.files.some((file) => file.relativePath.endsWith('Manifest.json') && file.sha256),
    )
    const manifestFile = entry?.files.find((file) => file.relativePath.endsWith('Manifest.json'))
    if (!entry || !manifestFile?.sha256) throw new Error('need a CoreML Manifest.json with sha256')

    const fixturePath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      'fixtures/plugin-catalog-coreml-manifest.json',
    )
    const good = fs.readFileSync(fixturePath)
    expect(createHash('sha256').update(good).digest('hex')).toBe(manifestFile.sha256)
    expect(good.length).toBe(manifestFile.size)

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-catalog-integrity-'))
    const goodPath = path.join(tmp, 'good.json')
    const badPath = path.join(tmp, 'bad.json')
    fs.writeFileSync(goodPath, good)
    expect(await hashFileSha256(goodPath)).toBe(manifestFile.sha256)
    await expect(verifyPluginCatalogStagedFile(goodPath, manifestFile, {})).resolves.toBeUndefined()

    const flipped = Buffer.from(good)
    flipped[0] = flipped[0] === 0x7b ? 0x20 : (flipped[0] ?? 0) ^ 0xff
    fs.writeFileSync(badPath, flipped)
    expect(await hashFileSha256(badPath)).not.toBe(manifestFile.sha256)
    await expect(verifyPluginCatalogStagedFile(badPath, manifestFile, {})).rejects.toThrow(
      /checksum|sha256/i,
    )
    fs.rmSync(tmp, { recursive: true, force: true })

    const integrity = makeHarness()
    try {
      integrity.deps.downloadFile = async (url, destPath) => {
        integrity.downloads.push(url)
        fs.mkdirSync(path.dirname(destPath), { recursive: true })
        const file = entry.files.find(
          (candidate) =>
            url.endsWith(candidate.relativePath.split('/').map(encodeURIComponent).join('/')) ||
            url.includes(candidate.relativePath),
        )
        if (file?.relativePath.endsWith('Manifest.json')) {
          fs.writeFileSync(destPath, flipped)
        } else if (file) {
          fs.writeFileSync(destPath, Buffer.alloc(file.size, 1))
        } else {
          fs.writeFileSync(destPath, Buffer.from('missing-payload'))
        }
        return destPath
      }
      await expect(
        importPluginCatalogCatalogModel({ manifestId: entry.id }, integrity.deps),
      ).rejects.toThrow(/checksum|sha256/i)
      expect(fs.readdirSync(integrity.stagingDir)).toEqual([])
    } finally {
      fs.rmSync(integrity.stagingDir, { recursive: true, force: true })
      fs.rmSync(integrity.modelsDir, { recursive: true, force: true })
    }
  })
})

describe('checksum helper used by import tests', () => {
  it('documents the sha256 of the LFS pointer so a false green is obvious', () => {
    expect(createHash('sha256').update(LFS_POINTER).digest('hex')).toHaveLength(64)
  })
})
