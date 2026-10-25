import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { createHash } from 'node:crypto'
import type { ModelCatalogEntry } from '@camstack/types'
import { ModelDownloadService } from '../src/download/model-download-service'

/**
 * `ModelDownloadService` (the CLIP encoder's downloader) answers the same
 * revision contract as `ensureModel` (D743): a copy with no record, or a
 * different one, is stale unless its weight file hashes to the revision; a
 * stale copy is fetched again and the old one serves until the new one is
 * complete.
 */
const FIXTURE = 'https://huggingface.co/camstack-test/fixture-models/resolve/main'
const sha256 = (body: string): string => createHash('sha256').update(body).digest('hex')

const textEntry = (revision: string): ModelCatalogEntry => ({
  id: 'clip-text',
  name: 'CLIP text',
  description: '',
  inputSize: { width: 1, height: 1 },
  labels: [],
  formats: {
    onnx: {
      url: `${FIXTURE}/clip/onnx/camstack-clip-text.onnx`,
      sizeMB: 1,
      files: ['camstack-clip-text-tokenizer.json'],
      revision,
    },
  },
})

const listedBundle: ModelCatalogEntry = {
  id: 'clip-vision',
  name: 'CLIP vision',
  description: '',
  inputSize: { width: 1, height: 1 },
  labels: [],
  formats: {
    coreml: {
      url: `${FIXTURE}/clip/coreml/camstack-clip-vision.mlpackage`,
      sizeMB: 1,
      isDirectory: true,
    },
  },
}

describe('ModelDownloadService honours the format revision', () => {
  let tmpDir: string
  const main = () => path.join(tmpDir, 'camstack-clip-text.onnx')
  const tokenizer = () => path.join(tmpDir, 'camstack-clip-text-tokenizer.json')

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
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'camstack-mds-'))
    fs.writeFileSync(main(), 'OLD')
    fs.writeFileSync(tokenizer(), '{"old":true}')
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('isDownloaded is false for a copy the revision does not describe', () => {
    const svc = new ModelDownloadService(tmpDir, [textEntry(sha256('NEW'))])
    expect(svc.isDownloaded('clip-text', 'onnx')).toBe(false)
  })

  it('ensure fetches a stale copy again, with its siblings, and records the revision', async () => {
    const asked = serve((url) => (url.endsWith('.json') ? '{"new":true}' : 'NEW'))
    const svc = new ModelDownloadService(tmpDir, [textEntry(sha256('NEW'))])
    expect(await svc.ensure('clip-text', 'onnx')).toBe(main())
    expect(asked).toHaveLength(2)
    expect(fs.readFileSync(main(), 'utf8')).toBe('NEW')
    expect(fs.readFileSync(tokenizer(), 'utf8')).toBe('{"new":true}')
    expect(svc.isDownloaded('clip-text', 'onnx')).toBe(true)
  })

  it('a failed re-fetch keeps the old copy', async () => {
    serve(() => null)
    const svc = new ModelDownloadService(tmpDir, [textEntry(sha256('NEW'))])
    await expect(svc.ensure('clip-text', 'onnx')).rejects.toThrow()
    expect(fs.readFileSync(main(), 'utf8')).toBe('OLD')
  })

  it('a copy that hashes to the revision is adopted without a request', async () => {
    const asked = serve(() => 'unexpected')
    const svc = new ModelDownloadService(tmpDir, [textEntry(sha256('OLD'))])
    await svc.ensure('clip-text', 'onnx')
    expect(asked).toEqual([])
    expect(svc.isDownloaded('clip-text', 'onnx')).toBe(true)
  })

  it('reports progress per model id', async () => {
    serve((url) => (url.endsWith('.json') ? '{}' : 'NEW'))
    const seen: string[] = []
    const svc = new ModelDownloadService(tmpDir, [textEntry(sha256('NEW'))], (id) => seen.push(id))
    await svc.ensure('clip-text', 'onnx')
    expect(seen.length).toBeGreaterThan(0)
    expect(new Set(seen)).toEqual(new Set(['clip-text']))
  })

  it('a bundle that declares no files is listed through the Hugging Face tree API', async () => {
    const tree = JSON.stringify([
      { type: 'file', path: 'clip/coreml/camstack-clip-vision.mlpackage/Manifest.json', size: 2 },
      { type: 'directory', path: 'clip/coreml/camstack-clip-vision.mlpackage/Data' },
    ])
    const sub = JSON.stringify([
      {
        type: 'file',
        path: 'clip/coreml/camstack-clip-vision.mlpackage/Data/weight.bin',
        size: 1,
      },
    ])
    const asked = serve((url) => {
      if (url.includes('/api/models/')) return url.endsWith('/Data') ? sub : tree
      return url.endsWith('weight.bin') ? 'W' : '{}'
    })
    const svc = new ModelDownloadService(tmpDir, [listedBundle])
    const p = await svc.ensure('clip-vision', 'coreml')
    expect(asked.filter((u) => u.includes('/resolve/main/'))).toHaveLength(2)
    expect(fs.readFileSync(path.join(p, 'Data/weight.bin'), 'utf8')).toBe('W')
    expect(svc.isDownloaded('clip-vision', 'coreml')).toBe(true)
  })
})
