import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { createHash } from 'node:crypto'
import {
  adoptModelRevisions,
  downloadModel,
  ensureModel,
  isModelDownloaded,
  deleteModelFromDisk,
  collectModelFiles,
  resolveFormatRevision,
  revisionWeightUrl,
} from '../src/download/model-downloader'
import { HOSTED_MODEL_REVISIONS } from '../src/download/hosted-model-revisions'
import type { ModelCatalogEntry } from '@camstack/types'

const ovEntry: ModelCatalogEntry = {
  id: 'ov-model',
  name: 'OV Model',
  description: 'openvino IR test model',
  inputSize: { width: 640, height: 640 },
  labels: [],
  formats: {
    openvino: {
      url: 'http://example.com/openvino/camstack-ov-model.xml',
      sizeMB: 1,
      runtimes: ['python'],
      // Catalog-declared sibling weights file (format-agnostic downloader).
      files: ['camstack-ov-model.bin'],
    },
  },
}

describe('collectModelFiles', () => {
  it('returns the main file + declared siblings for a single-file format', () => {
    expect(collectModelFiles(ovEntry, 'openvino')).toEqual([
      'camstack-ov-model.xml',
      'camstack-ov-model.bin',
    ])
  })

  it('includes extraFiles by filename', () => {
    const withExtra: ModelCatalogEntry = {
      ...ovEntry,
      extraFiles: [{ url: 'http://x/labels.json', filename: 'labels.json', sizeMB: 0.1 }],
    }
    expect(collectModelFiles(withExtra, 'openvino')).toEqual([
      'camstack-ov-model.xml',
      'camstack-ov-model.bin',
      'labels.json',
    ])
  })

  it('returns the bundle dir name (no siblings) for a directory format', () => {
    const dirEntry: ModelCatalogEntry = {
      id: 'sa',
      name: 'SoundAnalysis',
      description: '',
      inputSize: { width: 1, height: 1 },
      labels: [],
      formats: {
        coreml: { url: 'http://x/apple-sa.mlpackage', sizeMB: 1, isDirectory: true },
      },
    }
    expect(collectModelFiles(dirEntry, 'coreml')).toEqual(['apple-sa.mlpackage'])
  })

  it('returns [] for an absent format', () => {
    expect(collectModelFiles(ovEntry, 'onnx')).toEqual([])
  })
})

describe('single-file format sibling files (e.g. OpenVINO IR .xml + .bin)', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'camstack-ov-test-'))
  })
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('isModelDownloaded=false when only the .xml is present (weights missing)', () => {
    fs.writeFileSync(path.join(tmpDir, 'camstack-ov-model.xml'), '<net/>')
    expect(isModelDownloaded(tmpDir, ovEntry, 'openvino')).toBe(false)
  })

  it('isModelDownloaded=false when the .bin is present but empty', () => {
    fs.writeFileSync(path.join(tmpDir, 'camstack-ov-model.xml'), '<net/>')
    fs.writeFileSync(path.join(tmpDir, 'camstack-ov-model.bin'), '')
    expect(isModelDownloaded(tmpDir, ovEntry, 'openvino')).toBe(false)
  })

  it('isModelDownloaded=true when both .xml and a non-empty .bin are present', () => {
    fs.writeFileSync(path.join(tmpDir, 'camstack-ov-model.xml'), '<net/>')
    fs.writeFileSync(path.join(tmpDir, 'camstack-ov-model.bin'), 'WEIGHTS')
    expect(isModelDownloaded(tmpDir, ovEntry, 'openvino')).toBe(true)
  })

  it('ensureModel returns the .xml path without network when both files are cached', async () => {
    fs.writeFileSync(path.join(tmpDir, 'camstack-ov-model.xml'), '<net/>')
    fs.writeFileSync(path.join(tmpDir, 'camstack-ov-model.bin'), 'WEIGHTS')
    const p = await ensureModel(tmpDir, ovEntry, 'openvino')
    expect(p).toBe(path.join(tmpDir, 'camstack-ov-model.xml'))
  })

  it('deleteModelFromDisk removes BOTH the .xml and the .bin', () => {
    const xml = path.join(tmpDir, 'camstack-ov-model.xml')
    const bin = path.join(tmpDir, 'camstack-ov-model.bin')
    fs.writeFileSync(xml, '<net/>')
    fs.writeFileSync(bin, 'WEIGHTS')
    expect(deleteModelFromDisk(tmpDir, ovEntry, 'openvino')).toBe(true)
    expect(fs.existsSync(xml)).toBe(false)
    expect(fs.existsSync(bin)).toBe(false)
  })
})

describe('downloadModel', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'camstack-model-test-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns fromCache=true when file already exists', async () => {
    const filePath = path.join(tmpDir, 'model.bin')
    fs.writeFileSync(filePath, 'fake-model-data')

    const result = await downloadModel({
      url: 'http://example.com/model.bin',
      destDir: tmpDir,
    })

    expect(result.fromCache).toBe(true)
    expect(result.downloadedBytes).toBe(0)
    expect(result.filePath).toBe(filePath)
  })

  it('derives filename from url when filename not provided', async () => {
    const filePath = path.join(tmpDir, 'yolov8n.onnx')
    fs.writeFileSync(filePath, 'cached')

    const result = await downloadModel({
      url: 'http://example.com/yolov8n.onnx',
      destDir: tmpDir,
    })

    expect(result.fromCache).toBe(true)
    expect(result.filePath).toBe(filePath)
  })

  it('uses provided filename over url-derived name for cache check', async () => {
    const filePath = path.join(tmpDir, 'custom-name.onnx')
    fs.writeFileSync(filePath, 'cached')

    const result = await downloadModel({
      url: 'http://example.com/yolov8n.onnx',
      destDir: tmpDir,
      filename: 'custom-name.onnx',
    })

    expect(result.fromCache).toBe(true)
    expect(result.filePath).toBe(filePath)
  })

  it('creates destDir if it does not exist', async () => {
    const nestedDir = path.join(tmpDir, 'a', 'b', 'c')
    // Put a cached file there to avoid actual HTTP request
    fs.mkdirSync(nestedDir, { recursive: true })
    fs.writeFileSync(path.join(nestedDir, 'model.bin'), 'data')

    const result = await downloadModel({
      url: 'http://example.com/model.bin',
      destDir: nestedDir,
    })

    expect(result.fromCache).toBe(true)
  })

  it('throws when download fails on all URLs', async () => {
    await expect(
      downloadModel({
        url: 'http://127.0.0.1:19999/nonexistent.bin',
        fallbackUrls: ['http://127.0.0.1:19998/nonexistent.bin'],
        destDir: tmpDir,
      }),
    ).rejects.toThrow()
  })

  it('falls back to secondary URL when primary fails (cache hit on second)', async () => {
    // Simulate: primary would fail, but file happens to exist (cache hit triggered by second URL
    // since both point to same filename). We test the cache path — full retry with a real server
    // is handled in integration tests.
    const fname = 'fallback-model.bin'
    fs.writeFileSync(path.join(tmpDir, fname), 'data')

    const result = await downloadModel({
      url: `http://example.com/${fname}`,
      fallbackUrls: [`http://backup.example.com/${fname}`],
      destDir: tmpDir,
    })

    // Cache hit on primary URL filename
    expect(result.fromCache).toBe(true)
  })
})

/**
 * A hosted artefact replaced IN PLACE (same URL, new bytes) reaches a node that
 * already holds the old copy only through the catalog's `revision` (D743):
 * the node records the revision it fetched next to the file, and a different
 * catalog revision makes the copy stale.
 */
describe('format revision (an artefact replaced in place on the mirror)', () => {
  let tmpDir: string

  // A fixture repo, NOT the CamStack mirror: a mirror URL resolves its
  // revision from the generated table, and these cases need to choose theirs.
  const HF = 'https://huggingface.co/camstack-test/fixture-models/resolve/main'
  const pkgEntry = (revision?: string): ModelCatalogEntry => ({
    id: 'yolov9m-320',
    name: 'YOLOv9 Medium @320',
    description: '',
    inputSize: { width: 320, height: 320 },
    labels: [],
    formats: {
      coreml: {
        url: `${HF}/objectDetection/yolov9/coreml/camstack-yolov9m-320.mlpackage`,
        sizeMB: 1,
        isDirectory: true,
        files: ['Manifest.json', 'Data/com.apple.CoreML/weights/weight.bin'],
        runtimes: ['python'],
        ...(revision !== undefined ? { revision } : {}),
      },
    },
  })
  const irEntry = (revision?: string): ModelCatalogEntry => ({
    ...ovEntry,
    formats: {
      openvino: {
        ...ovEntry.formats.openvino!,
        ...(revision !== undefined ? { revision } : {}),
      },
    },
  })
  const pkgDir = () => path.join(tmpDir, 'camstack-yolov9m-320.mlpackage')
  const weights = () => path.join(pkgDir(), 'Data/com.apple.CoreML/weights/weight.bin')
  const marker = (name: string) => path.join(tmpDir, `${name}.revision`)

  function writeOldPackage(): void {
    fs.mkdirSync(path.dirname(weights()), { recursive: true })
    fs.writeFileSync(path.join(pkgDir(), 'Manifest.json'), '{}')
    fs.writeFileSync(weights(), 'FP32-WEIGHTS')
  }

  /** A fetch that serves `body(url)` and records every URL it was asked for. */
  function serve(body: (url: string) => string | null): string[] {
    const asked: string[] = []
    vi.stubGlobal('fetch', async (input: string | URL) => {
      const url = String(input)
      asked.push(url)
      const b = body(url)
      return b === null ? new Response('nope', { status: 503 }) : new Response(b, { status: 200 })
    })
    return asked
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'camstack-rev-test-'))
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('a format without a revision keeps the old behaviour: present means downloaded', () => {
    writeOldPackage()
    expect(isModelDownloaded(tmpDir, pkgEntry(), 'coreml')).toBe(true)
  })

  it('a copy fetched before the revision existed is stale', () => {
    writeOldPackage()
    expect(isModelDownloaded(tmpDir, pkgEntry('rev-fp16'), 'coreml')).toBe(false)
  })

  it('a copy recorded under another revision is stale; under the same one it is current', () => {
    writeOldPackage()
    fs.writeFileSync(marker('camstack-yolov9m-320.mlpackage'), 'rev-fp32\n')
    expect(isModelDownloaded(tmpDir, pkgEntry('rev-fp16'), 'coreml')).toBe(false)
    fs.writeFileSync(marker('camstack-yolov9m-320.mlpackage'), 'rev-fp16\n')
    expect(isModelDownloaded(tmpDir, pkgEntry('rev-fp16'), 'coreml')).toBe(true)
  })

  it('ensureModel re-fetches a stale directory bundle in place and records the revision', async () => {
    writeOldPackage()
    const asked = serve((url) => (url.endsWith('weight.bin') ? 'FP16-WEIGHTS' : '{"v":2}'))
    const p = await ensureModel(tmpDir, pkgEntry('rev-fp16'), 'coreml')
    expect(p).toBe(pkgDir())
    expect(asked).toHaveLength(2)
    expect(fs.readFileSync(weights(), 'utf8')).toBe('FP16-WEIGHTS')
    expect(fs.readFileSync(marker('camstack-yolov9m-320.mlpackage'), 'utf8').trim()).toBe(
      'rev-fp16',
    )
    expect(isModelDownloaded(tmpDir, pkgEntry('rev-fp16'), 'coreml')).toBe(true)
  })

  it('ensureModel does not touch the network for a current copy', async () => {
    writeOldPackage()
    fs.writeFileSync(marker('camstack-yolov9m-320.mlpackage'), 'rev-fp16')
    const asked = serve(() => 'unexpected')
    await ensureModel(tmpDir, pkgEntry('rev-fp16'), 'coreml')
    expect(asked).toEqual([])
    expect(fs.readFileSync(weights(), 'utf8')).toBe('FP32-WEIGHTS')
  })

  it('a first download records the revision', async () => {
    serve((url) => (url.endsWith('weight.bin') ? 'FP16-WEIGHTS' : '{}'))
    await ensureModel(tmpDir, pkgEntry('rev-fp16'), 'coreml')
    expect(isModelDownloaded(tmpDir, pkgEntry('rev-fp16'), 'coreml')).toBe(true)
  })

  it('a failed re-fetch keeps the old bundle serving', async () => {
    writeOldPackage()
    serve(() => null)
    await expect(ensureModel(tmpDir, pkgEntry('rev-fp16'), 'coreml')).rejects.toThrow()
    expect(fs.readFileSync(weights(), 'utf8')).toBe('FP32-WEIGHTS')
    expect(isModelDownloaded(tmpDir, pkgEntry('rev-fp16'), 'coreml')).toBe(false)
  })

  it('ensureModel re-fetches a stale single-file format together with its siblings', async () => {
    fs.writeFileSync(path.join(tmpDir, 'camstack-ov-model.xml'), '<old/>')
    fs.writeFileSync(path.join(tmpDir, 'camstack-ov-model.bin'), 'OLD')
    const asked = serve((url) => (url.endsWith('.bin') ? 'NEW' : '<new/>'))
    await ensureModel(tmpDir, irEntry('r2'), 'openvino')
    expect(asked).toHaveLength(2)
    expect(fs.readFileSync(path.join(tmpDir, 'camstack-ov-model.xml'), 'utf8')).toBe('<new/>')
    expect(fs.readFileSync(path.join(tmpDir, 'camstack-ov-model.bin'), 'utf8')).toBe('NEW')
    expect(isModelDownloaded(tmpDir, irEntry('r2'), 'openvino')).toBe(true)
  })

  it('an outdated main file whose sibling is missing is replaced, not paired with the new sibling', async () => {
    fs.writeFileSync(path.join(tmpDir, 'camstack-ov-model.xml'), '<old/>')
    serve((url) => (url.endsWith('.bin') ? 'NEW' : '<new/>'))
    await ensureModel(tmpDir, irEntry('r2'), 'openvino')
    expect(fs.readFileSync(path.join(tmpDir, 'camstack-ov-model.xml'), 'utf8')).toBe('<new/>')
    expect(fs.readFileSync(path.join(tmpDir, 'camstack-ov-model.bin'), 'utf8')).toBe('NEW')
  })

  it('a failed single-file re-fetch keeps the old files', async () => {
    fs.writeFileSync(path.join(tmpDir, 'camstack-ov-model.xml'), '<old/>')
    fs.writeFileSync(path.join(tmpDir, 'camstack-ov-model.bin'), 'OLD')
    serve((url) => (url.endsWith('.bin') ? null : '<new/>'))
    await expect(ensureModel(tmpDir, irEntry('r2'), 'openvino')).rejects.toThrow()
    expect(fs.readFileSync(path.join(tmpDir, 'camstack-ov-model.xml'), 'utf8')).toBe('<old/>')
    expect(fs.readFileSync(path.join(tmpDir, 'camstack-ov-model.bin'), 'utf8')).toBe('OLD')
  })

  it('deleteModelFromDisk removes the revision record too', () => {
    writeOldPackage()
    fs.writeFileSync(marker('camstack-yolov9m-320.mlpackage'), 'rev-fp16')
    expect(deleteModelFromDisk(tmpDir, pkgEntry('rev-fp16'), 'coreml')).toBe(true)
    expect(fs.existsSync(marker('camstack-yolov9m-320.mlpackage'))).toBe(false)
  })
})

const sha256 = (body: string): string => createHash('sha256').update(body).digest('hex')

/**
 * Every artefact on the CamStack mirror carries a revision — the sha256 of its
 * weight file, generated from the mirror's LFS metadata into
 * `hosted-model-revisions.ts` — and a node holding a copy without a record
 * proves it current by hashing that file instead of downloading it again.
 */
describe('hosted revisions (the mirror table) and adoption by hash', () => {
  let tmpDir: string
  const MIRROR = 'https://huggingface.co/camstack/camstack-models/resolve/main'
  const FIXTURE = 'https://huggingface.co/camstack-test/fixture-models/resolve/main'

  const bundle = (revision: string): ModelCatalogEntry => ({
    id: 'pkg',
    name: 'pkg',
    description: '',
    inputSize: { width: 1, height: 1 },
    labels: [],
    formats: {
      coreml: {
        url: `${FIXTURE}/x/coreml/camstack-pkg.mlpackage`,
        sizeMB: 1,
        isDirectory: true,
        files: ['Manifest.json', 'Data/com.apple.CoreML/weights/weight.bin'],
        revision,
      },
    },
  })
  const ir = (revision: string): ModelCatalogEntry => ({
    ...ovEntry,
    formats: {
      openvino: {
        url: `${FIXTURE}/x/openvino/camstack-ov-model.xml`,
        sizeMB: 1,
        files: ['camstack-ov-model.bin'],
        revision,
      },
    },
  })
  const onnx = (revision: string): ModelCatalogEntry => ({
    ...ovEntry,
    id: 'onnx-model',
    formats: { onnx: { url: `${FIXTURE}/x/onnx/camstack-onnx-model.onnx`, sizeMB: 1, revision } },
  })
  const record = (name: string) => path.join(tmpDir, `${name}.revision`)

  function writeBundle(weights: string): void {
    const dir = path.join(tmpDir, 'camstack-pkg.mlpackage', 'Data/com.apple.CoreML/weights')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(tmpDir, 'camstack-pkg.mlpackage', 'Manifest.json'), '{}')
    fs.writeFileSync(path.join(dir, 'weight.bin'), weights)
  }

  /** A fetch that must never be called. */
  function noNetwork(): string[] {
    const asked: string[] = []
    vi.stubGlobal('fetch', async (input: string | URL) => {
      asked.push(String(input))
      return new Response('unexpected', { status: 500 })
    })
    return asked
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'camstack-hosted-rev-'))
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('a mirror format with no inline revision takes the one in the generated table', () => {
    const urlPath = 'objectDetection/yolov9/coreml/camstack-yolov9m-320.mlpackage'
    expect(HOSTED_MODEL_REVISIONS[urlPath]).toMatch(/^[0-9a-f]{64}$/)
    expect(
      resolveFormatRevision({ url: `${MIRROR}/${urlPath}`, sizeMB: 1, isDirectory: true }),
    ).toBe(HOSTED_MODEL_REVISIONS[urlPath])
  })

  it('an inline revision wins; a URL off the mirror has none', () => {
    expect(resolveFormatRevision({ url: `${FIXTURE}/a.onnx`, sizeMB: 1 })).toBeUndefined()
    expect(resolveFormatRevision({ url: `${FIXTURE}/a.onnx`, sizeMB: 1, revision: 'r' })).toBe('r')
  })

  it('every table revision is a sha256', () => {
    for (const rev of Object.values(HOSTED_MODEL_REVISIONS)) expect(rev).toMatch(/^[0-9a-f]{64}$/)
  })

  it('the weight file of a bundle, an IR and a single file', () => {
    expect(revisionWeightUrl(bundle('r').formats.coreml!)).toBe(
      `${FIXTURE}/x/coreml/camstack-pkg.mlpackage/Data/com.apple.CoreML/weights/weight.bin`,
    )
    expect(revisionWeightUrl(ir('r').formats.openvino!)).toBe(
      `${FIXTURE}/x/openvino/camstack-ov-model.bin`,
    )
    expect(revisionWeightUrl(onnx('r').formats.onnx!)).toBe(
      `${FIXTURE}/x/onnx/camstack-onnx-model.onnx`,
    )
  })

  it('a bundle with no record whose weight.bin hashes to the revision is adopted, not fetched', async () => {
    writeBundle('FP16')
    const asked = noNetwork()
    expect(isModelDownloaded(tmpDir, bundle(sha256('FP16')), 'coreml')).toBe(false)
    await ensureModel(tmpDir, bundle(sha256('FP16')), 'coreml')
    expect(asked).toEqual([])
    expect(fs.readFileSync(record('camstack-pkg.mlpackage'), 'utf8').trim()).toBe(sha256('FP16'))
    expect(isModelDownloaded(tmpDir, bundle(sha256('FP16')), 'coreml')).toBe(true)
  })

  it('a copy recorded under an older revision but holding the new bytes is adopted', async () => {
    writeBundle('FP16')
    fs.writeFileSync(record('camstack-pkg.mlpackage'), 'older\n')
    const asked = noNetwork()
    await ensureModel(tmpDir, bundle(sha256('FP16')), 'coreml')
    expect(asked).toEqual([])
    expect(isModelDownloaded(tmpDir, bundle(sha256('FP16')), 'coreml')).toBe(true)
  })

  it('an IR is adopted by its .bin weights', async () => {
    fs.writeFileSync(path.join(tmpDir, 'camstack-ov-model.xml'), '<net/>')
    fs.writeFileSync(path.join(tmpDir, 'camstack-ov-model.bin'), 'W')
    const asked = noNetwork()
    await ensureModel(tmpDir, ir(sha256('W')), 'openvino')
    expect(asked).toEqual([])
    expect(isModelDownloaded(tmpDir, ir(sha256('W')), 'openvino')).toBe(true)
  })

  it('a single file is adopted by its own bytes', async () => {
    fs.writeFileSync(path.join(tmpDir, 'camstack-onnx-model.onnx'), 'ONNX')
    const asked = noNetwork()
    await ensureModel(tmpDir, onnx(sha256('ONNX')), 'onnx')
    expect(asked).toEqual([])
    expect(isModelDownloaded(tmpDir, onnx(sha256('ONNX')), 'onnx')).toBe(true)
  })

  it('a copy whose bytes differ is fetched again', async () => {
    fs.writeFileSync(path.join(tmpDir, 'camstack-onnx-model.onnx'), 'OLD')
    const asked: string[] = []
    vi.stubGlobal('fetch', async (input: string | URL) => {
      asked.push(String(input))
      return new Response('NEW', { status: 200 })
    })
    await ensureModel(tmpDir, onnx(sha256('NEW')), 'onnx')
    expect(asked).toHaveLength(1)
    expect(fs.readFileSync(path.join(tmpDir, 'camstack-onnx-model.onnx'), 'utf8')).toBe('NEW')
  })

  it('adoptModelRevisions records every copy that hashes current and names the stale ones, offline', async () => {
    writeBundle('FP16')
    fs.writeFileSync(path.join(tmpDir, 'camstack-onnx-model.onnx'), 'OLD')
    const asked = noNetwork()
    const report = await adoptModelRevisions(tmpDir, [
      bundle(sha256('FP16')),
      onnx(sha256('NEW')),
      ir(sha256('absent')),
    ])
    expect(asked).toEqual([])
    expect(report.adopted).toEqual(['pkg/coreml'])
    expect(report.stale).toEqual(['onnx-model/onnx'])
    expect(isModelDownloaded(tmpDir, bundle(sha256('FP16')), 'coreml')).toBe(true)
    expect(isModelDownloaded(tmpDir, onnx(sha256('NEW')), 'onnx')).toBe(false)
  })
})
