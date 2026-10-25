import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createHash } from 'node:crypto'
import { ModelUploadStore, sanitizeModelFilename } from '../upload/model-upload-store.js'

describe('sanitizeModelFilename', () => {
  it('accepts a plain .onnx / .tflite basename', () => {
    expect(sanitizeModelFilename('frigate-yolonas-s.onnx')).toBe('frigate-yolonas-s.onnx')
    expect(sanitizeModelFilename('mobiledet.tflite')).toBe('mobiledet.tflite')
  })
  it('rejects path traversal', () => {
    expect(() => sanitizeModelFilename('../../etc/passwd.onnx')).toThrow()
    expect(() => sanitizeModelFilename('a/b.onnx')).toThrow()
  })
  it('rejects disallowed extensions', () => {
    expect(() => sanitizeModelFilename('model.exe')).toThrow(/extension/i)
    expect(() => sanitizeModelFilename('model.onnx.sh')).toThrow(/extension/i)
  })
})

describe('ModelUploadStore', () => {
  let stagingDir: string
  let modelsDir: string
  let store: ModelUploadStore

  beforeEach(() => {
    stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-staging-'))
    modelsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-models-'))
    store = new ModelUploadStore({ stagingDir, modelsDir })
  })
  afterEach(() => {
    fs.rmSync(stagingDir, { recursive: true, force: true })
    fs.rmSync(modelsDir, { recursive: true, force: true })
  })

  it('assembles chunks and lands the file in modelsDir with a matching sha256', async () => {
    const payload = Buffer.from('not-a-real-onnx-but-bytes-are-bytes'.repeat(1000))
    const { uploadId } = store.begin({ filename: 'test-model.onnx', totalBytes: payload.length })

    const chunkSize = 4096
    for (let offset = 0; offset < payload.length; offset += chunkSize) {
      const chunk = payload.subarray(offset, offset + chunkSize)
      const { received } = store.append({ uploadId, chunkBase64: chunk.toString('base64') })
      expect(received).toBe(Math.min(offset + chunkSize, payload.length))
    }

    const result = store.commit({ uploadId })
    expect(result.filename).toBe('test-model.onnx')
    expect(result.bytes).toBe(payload.length)
    const landed = fs.readFileSync(path.join(modelsDir, 'test-model.onnx'))
    expect(Buffer.compare(landed, payload)).toBe(0)
    const expectedSha = createHash('sha256').update(payload).digest('hex')
    expect(result.sha256).toBe(expectedSha)
  })

  it('refuses to exceed the declared totalBytes', () => {
    const { uploadId } = store.begin({ filename: 'small.onnx', totalBytes: 10 })
    expect(() =>
      store.append({ uploadId, chunkBase64: Buffer.alloc(50).toString('base64') }),
    ).toThrow(/exceeds/i)
  })

  it('refuses commit when bytes are missing', () => {
    const { uploadId } = store.begin({ filename: 'short.onnx', totalBytes: 100 })
    store.append({ uploadId, chunkBase64: Buffer.alloc(10).toString('base64') })
    expect(() => store.commit({ uploadId })).toThrow(/incomplete/i)
  })

  it('rejects an unknown uploadId', () => {
    expect(() => store.append({ uploadId: 'nope', chunkBase64: 'AA==' })).toThrow(/unknown/i)
  })

  it('abort removes the staged file', () => {
    const { uploadId } = store.begin({ filename: 'gone.onnx', totalBytes: 4 })
    store.append({ uploadId, chunkBase64: Buffer.alloc(4).toString('base64') })
    store.abort({ uploadId })
    expect(fs.readdirSync(stagingDir)).toEqual([])
    expect(() => store.commit({ uploadId })).toThrow(/unknown/i)
  })

  it('enforces the global size cap at begin', () => {
    expect(() =>
      store.begin({ filename: 'huge.onnx', totalBytes: 10 * 1024 * 1024 * 1024 }),
    ).toThrow(/too large/i)
  })
})
