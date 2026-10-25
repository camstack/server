/**
 * `S3StorageProvider` cap-impl spec.
 *
 * `S3Client` is stubbed at the constructor seam — every test injects a
 * fake `send()` that responds to specific commands against an in-memory
 * key→Buffer map. We don't test the real AWS multipart upload state
 * machine (lib-storage owns that) — only the provider's contract:
 *   - getProviderInfo shape
 *   - testLocation success / failure / config validation
 *   - small-file primitives are issued as the right SDK commands
 *   - chunked download yields byte-identical output
 *
 * Chunked upload is exercised at integration level only — the multipart
 * machinery requires a live HTTP loop; mocking it without re-implementing
 * lib-storage Upload would test only our test scaffolding.
 */
import { describe, it, expect } from 'vitest'
import { Readable } from 'node:stream'
import {
  S3Client,
  HeadBucketCommand,
  HeadObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  type S3ClientConfig,
} from '@aws-sdk/client-s3'
import type { IScopedLogger, StorageLocation, LogExtras, LogTags } from '@camstack/types'
import { S3StorageProvider } from '../s3-provider.js'

const noopLogger: IScopedLogger = {
  debug: (_message: string, _extras?: LogExtras) => undefined,
  info: (_message: string, _extras?: LogExtras) => undefined,
  warn: (_message: string, _extras?: LogExtras) => undefined,
  error: (_message: string, _extras?: LogExtras) => undefined,
  child: (_scope: string) => noopLogger,
  withTags: (_tags: LogTags) => noopLogger,
}

const makeLocation = (overrides?: Partial<Record<string, unknown>>): StorageLocation => ({
  id: 'backups:test-s3',
  type: 'backups',
  displayName: 'Test S3',
  providerId: 's3-storage',
  config: {
    region: 'us-east-1',
    bucket: 'camstack-test',
    accessKeyId: 'AKIA-TEST',
    secretAccessKey: 'SECRET',
    basePath: 'backups',
    ...overrides,
  },
  isSystem: false,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
})

interface FakeBackend {
  readonly objects: Map<string, Buffer>
  /** Simulate a missing bucket — HeadBucketCommand throws. */
  bucketExists: boolean
}

function makeFakeClientCtor(
  backend: FakeBackend,
  headFails = false,
): {
  ctor: new (config: S3ClientConfig) => S3Client
  destroyCount: () => number
} {
  let destroyed = 0
  class FakeS3 {
    async send(cmd: unknown): Promise<unknown> {
      if (cmd instanceof HeadBucketCommand) {
        if (headFails || !backend.bucketExists) throw new Error('NoSuchBucket')
        return {}
      }
      if (cmd instanceof PutObjectCommand) {
        const input = cmd.input
        const body = input.Body
        const buf = Buffer.isBuffer(body) ? body : Buffer.from(body as Uint8Array)
        backend.objects.set(input.Key as string, buf)
        return {}
      }
      if (cmd instanceof HeadObjectCommand) {
        const buf = backend.objects.get(cmd.input.Key as string)
        if (!buf) throw new Error('NotFound')
        return { ContentLength: buf.length }
      }
      if (cmd instanceof GetObjectCommand) {
        const key = cmd.input.Key as string
        const buf = backend.objects.get(key)
        if (!buf) throw new Error('NoSuchKey')
        const range = cmd.input.Range
        let slice = buf
        if (typeof range === 'string') {
          const m = /^bytes=(\d+)-(\d+)?$/.exec(range)
          if (m) {
            const start = Number(m[1])
            const end = m[2] !== undefined ? Number(m[2]) + 1 : buf.length
            slice = buf.subarray(start, end)
          }
        }
        return { Body: Readable.from(slice), ContentLength: slice.length }
      }
      if (cmd instanceof DeleteObjectCommand) {
        backend.objects.delete(cmd.input.Key as string)
        return {}
      }
      if (cmd instanceof ListObjectsV2Command) {
        const prefix = cmd.input.Prefix ?? ''
        const Contents = [...backend.objects.entries()]
          .filter(([k]) => k.startsWith(prefix))
          .map(([Key, v]) => ({ Key, Size: v.length }))
        return { Contents }
      }
      throw new Error(`unhandled fake command: ${cmd?.constructor?.name ?? 'unknown'}`)
    }
    destroy(): void {
      destroyed++
    }
  }
  return {
    ctor: FakeS3 as unknown as new (config: S3ClientConfig) => S3Client,
    destroyCount: () => destroyed,
  }
}

describe('S3StorageProvider — getProviderInfo', () => {
  it('returns expected providerId / displayName / configSchema', async () => {
    const backend: FakeBackend = { objects: new Map<string, Buffer>(), bucketExists: true }
    const { ctor } = makeFakeClientCtor(backend)
    const provider = new S3StorageProvider(noopLogger, ctor)
    const info = await provider.getProviderInfo()
    expect(info.providerId).toBe('s3-storage')
    expect(info.configSchema).toBeTypeOf('object')
  })
})

describe('S3StorageProvider — testLocation', () => {
  it('returns ok:false on missing config', async () => {
    const backend: FakeBackend = { objects: new Map<string, Buffer>(), bucketExists: true }
    const { ctor } = makeFakeClientCtor(backend)
    const provider = new S3StorageProvider(noopLogger, ctor)
    expect((await provider.testLocation({ config: {} })).ok).toBe(false)
    expect(
      (
        await provider.testLocation({
          config: { region: 'x', bucket: '', accessKeyId: 'a', secretAccessKey: 's' },
        })
      ).ok,
    ).toBe(false)
  })

  it('returns ok:true when HeadBucket succeeds', async () => {
    const backend: FakeBackend = { objects: new Map<string, Buffer>(), bucketExists: true }
    const { ctor } = makeFakeClientCtor(backend)
    const provider = new S3StorageProvider(noopLogger, ctor)
    const result = await provider.testLocation({
      config: {
        region: 'us-east-1',
        bucket: 'b',
        accessKeyId: 'a',
        secretAccessKey: 's',
      },
    })
    expect(result.ok).toBe(true)
  })

  it('returns ok:false when HeadBucket fails (missing bucket / auth error)', async () => {
    const backend: FakeBackend = { objects: new Map<string, Buffer>(), bucketExists: false }
    const { ctor } = makeFakeClientCtor(backend)
    const provider = new S3StorageProvider(noopLogger, ctor)
    const result = await provider.testLocation({
      config: {
        region: 'us-east-1',
        bucket: 'missing',
        accessKeyId: 'a',
        secretAccessKey: 's',
      },
    })
    expect(result.ok).toBe(false)
    expect(result.error).toBeTruthy()
  })
})

describe('S3StorageProvider — small-file primitives', () => {
  it('round-trips a payload via write + read', async () => {
    const backend: FakeBackend = { objects: new Map<string, Buffer>(), bucketExists: true }
    const { ctor } = makeFakeClientCtor(backend)
    const provider = new S3StorageProvider(noopLogger, ctor)
    const location = makeLocation()
    const payload = new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd])

    await provider.write({ location, relativePath: 'foo.bin', data: payload })
    expect(backend.objects.get('backups/foo.bin')?.toString('hex')).toBe('aabbccdd')

    const out = await provider.read({ location, relativePath: 'foo.bin' })
    expect(Buffer.from(out)).toEqual(Buffer.from(payload))
  })

  it('exists reflects head-object outcome; delete removes the object', async () => {
    const backend: FakeBackend = { objects: new Map<string, Buffer>(), bucketExists: true }
    const { ctor } = makeFakeClientCtor(backend)
    const provider = new S3StorageProvider(noopLogger, ctor)
    const location = makeLocation()
    await provider.write({ location, relativePath: 'a.txt', data: new Uint8Array([0x61]) })
    expect(await provider.exists({ location, relativePath: 'a.txt' })).toBe(true)
    expect(await provider.exists({ location, relativePath: 'b.txt' })).toBe(false)
    await provider.delete({ location, relativePath: 'a.txt' })
    expect(await provider.exists({ location, relativePath: 'a.txt' })).toBe(false)
  })

  it('rejects path traversal', async () => {
    const backend: FakeBackend = { objects: new Map<string, Buffer>(), bucketExists: true }
    const { ctor } = makeFakeClientCtor(backend)
    const provider = new S3StorageProvider(noopLogger, ctor)
    const location = makeLocation()
    await expect(provider.read({ location, relativePath: '../escape.bin' })).rejects.toThrow(
      /traversal/i,
    )
  })
})

describe('S3StorageProvider — chunked download', () => {
  it('reassembles a multi-chunk download byte-identically', async () => {
    const backend: FakeBackend = { objects: new Map<string, Buffer>(), bucketExists: true }
    const { ctor } = makeFakeClientCtor(backend)
    const provider = new S3StorageProvider(noopLogger, ctor)
    const location = makeLocation()
    const payload = Buffer.alloc(40)
    for (let i = 0; i < 40; i++) payload[i] = (i + 1) % 256
    backend.objects.set('backups/big.bin', payload)

    const { downloadId, sizeBytes } = await provider.beginDownload({
      location,
      relativePath: 'big.bin',
    })
    expect(sizeBytes).toBe(40)

    const buffers: Uint8Array[] = []
    for (let i = 0; i < 4; i++) {
      buffers.push(await provider.readChunk({ downloadId, offset: i * 10, length: 10 }))
    }
    await provider.endDownload({ downloadId })

    const reassembled = Buffer.concat(buffers.map((b) => Buffer.from(b)))
    expect(reassembled).toEqual(payload)

    await provider.dispose()
  })
})
