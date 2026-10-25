/**
 * `WebDavStorageProvider` cap-impl spec.
 *
 * The real `webdav` package's `createClient` returns a `WebDAVClient`
 * that talks fetch+HTTP — fine for an integration test against a real
 * Nextcloud, but for the unit suite we inject a constructor-like
 * factory that yields an in-memory `FakeWebDavClient`. Provider
 * behaviour (chunked round-trip, .partial rename, path-traversal guard)
 * is exercised end-to-end against a deterministic backend.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { Readable } from 'node:stream'
import type {
  WebDAVClient,
  WebDAVClientOptions,
  FileStat,
  ResponseDataDetailed,
  BufferLike,
} from 'webdav'
import type { IScopedLogger, StorageLocation, LogExtras, LogTags } from '@camstack/types'
import { WebDavStorageProvider } from '../webdav-provider.js'

const noopLogger: IScopedLogger = {
  debug: (_message: string, _extras?: LogExtras) => undefined,
  info: (_message: string, _extras?: LogExtras) => undefined,
  warn: (_message: string, _extras?: LogExtras) => undefined,
  error: (_message: string, _extras?: LogExtras) => undefined,
  child: (_scope: string) => noopLogger,
  withTags: (_tags: LogTags) => undefined as unknown as IScopedLogger,
}

const makeLocation = (overrides?: Partial<Record<string, unknown>>): StorageLocation => ({
  id: 'backups:test-webdav',
  type: 'backups',
  displayName: 'Test WebDAV',
  providerId: 'webdav-storage',
  config: {
    url: 'https://nextcloud.example.com/remote.php/dav/files/me/',
    authMethod: 'basic',
    username: 'me',
    password: 'secret',
    basePath: '/Camstack',
    ...overrides,
  },
  isSystem: false,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
})

class FakeWebDavClient {
  readonly files = new Map<string, Buffer>()

  async exists(path: string): Promise<boolean> {
    return this.files.has(path)
  }

  async createDirectory(_path: string): Promise<void> {
    // No-op — we don't track directories.
  }

  async putFileContents(
    path: string,
    data: string | BufferLike | Readable,
    _options?: unknown,
  ): Promise<boolean> {
    if (Buffer.isBuffer(data)) {
      this.files.set(path, Buffer.from(data))
      return true
    }
    if (data instanceof Uint8Array) {
      this.files.set(path, Buffer.from(data))
      return true
    }
    if (data instanceof ArrayBuffer) {
      this.files.set(path, Buffer.from(data))
      return true
    }
    if (typeof data === 'string') {
      this.files.set(path, Buffer.from(data))
      return true
    }
    // Stream — drain it.
    const chunks: Buffer[] = []
    return new Promise<boolean>((resolve, reject) => {
      const r = data as Readable
      r.on('data', (c: Buffer | string) => {
        chunks.push(typeof c === 'string' ? Buffer.from(c) : c)
      })
      r.on('end', () => {
        this.files.set(path, Buffer.concat(chunks))
        resolve(true)
      })
      r.on('error', reject)
    })
  }

  async getFileContents(
    path: string,
    _options?: unknown,
  ): Promise<BufferLike | string | ResponseDataDetailed<BufferLike | string>> {
    const buf = this.files.get(path)
    if (!buf) throw new Error(`ENOENT: ${path}`)
    return buf
  }

  async deleteFile(path: string): Promise<void> {
    this.files.delete(path)
  }

  async moveFile(from: string, to: string): Promise<void> {
    const buf = this.files.get(from)
    if (!buf) throw new Error(`ENOENT: ${from}`)
    this.files.set(to, buf)
    this.files.delete(from)
  }

  async stat(path: string): Promise<FileStat> {
    const buf = this.files.get(path)
    if (!buf) throw new Error(`ENOENT: ${path}`)
    return {
      filename: path,
      basename: path.split('/').pop() ?? path,
      lastmod: new Date().toUTCString(),
      size: buf.length,
      type: 'file',
      etag: null,
    }
  }

  createReadStream(path: string, options?: { range?: { start: number; end?: number } }): Readable {
    const buf = this.files.get(path)
    if (!buf) {
      const r = new Readable({
        read() {
          /* no-op */
        },
      })
      setImmediate(() => r.destroy(new Error(`ENOENT: ${path}`)))
      return r
    }
    const start = options?.range?.start ?? 0
    const end = options?.range?.end !== undefined ? options.range.end + 1 : buf.length
    return Readable.from(buf.subarray(start, end))
  }

  async getDirectoryContents(path: string): Promise<FileStat[]> {
    const prefix = path.endsWith('/') ? path : `${path}/`
    const out: FileStat[] = []
    for (const k of this.files.keys()) {
      if (k.startsWith(prefix)) {
        const rest = k.slice(prefix.length)
        if (!rest.includes('/')) {
          out.push({
            filename: k,
            basename: rest,
            lastmod: new Date().toUTCString(),
            size: this.files.get(k)!.length,
            type: 'file',
            etag: null,
          })
        }
      }
    }
    return out
  }

  async getQuota(): Promise<{ used: number; available: number } | null> {
    return { used: 0, available: 1024 * 1024 * 1024 }
  }
}

function makeProviderWithFakeBackend(): {
  provider: WebDavStorageProvider
  backend: FakeWebDavClient
} {
  const backend = new FakeWebDavClient()
  const factory = (_url: string, _opts?: WebDAVClientOptions): WebDAVClient =>
    backend as unknown as WebDAVClient
  const provider = new WebDavStorageProvider(noopLogger, factory)
  return { provider, backend }
}

describe('WebDavStorageProvider — getProviderInfo', () => {
  it('returns expected providerId / displayName / configSchema', async () => {
    const { provider } = makeProviderWithFakeBackend()
    const info = await provider.getProviderInfo()
    expect(info.providerId).toBe('webdav-storage')
    expect(info.displayName).toBe('WebDAV')
    expect(info.configSchema).toBeTypeOf('object')
  })
})

describe('WebDavStorageProvider — testLocation', () => {
  it('returns ok:false on missing config', async () => {
    const { provider } = makeProviderWithFakeBackend()
    expect((await provider.testLocation({ config: {} })).ok).toBe(false)
    expect(
      (
        await provider.testLocation({
          config: { url: 'http://x', basePath: '' },
        })
      ).ok,
    ).toBe(false)
  })

  it('returns ok:true when the server responds', async () => {
    const { provider } = makeProviderWithFakeBackend()
    const result = await provider.testLocation({
      config: {
        url: 'http://x',
        authMethod: 'basic',
        username: 'me',
        password: 'pw',
        basePath: '/Camstack',
      },
    })
    expect(result.ok).toBe(true)
  })

  it('returns ok:false when the underlying client throws', async () => {
    const factory = (): WebDAVClient => {
      throw new Error('fetch failed')
    }
    const provider = new WebDavStorageProvider(noopLogger, factory)
    const result = await provider.testLocation({
      config: {
        url: 'http://x',
        authMethod: 'basic',
        username: 'me',
        password: 'pw',
        basePath: '/Camstack',
      },
    })
    expect(result.ok).toBe(false)
  })
})

describe('WebDavStorageProvider — small-file primitives', () => {
  let provider: WebDavStorageProvider
  let backend: FakeWebDavClient
  let location: StorageLocation

  beforeEach(() => {
    ;({ provider, backend } = makeProviderWithFakeBackend())
    location = makeLocation()
  })

  it('round-trips a payload via write + read', async () => {
    const payload = new Uint8Array([0xde, 0xad, 0xbe, 0xef])
    await provider.write({ location, relativePath: 'foo.bin', data: payload })
    expect(backend.files.has('/Camstack/foo.bin')).toBe(true)
    const out = await provider.read({ location, relativePath: 'foo.bin' })
    expect(Buffer.from(out)).toEqual(Buffer.from(payload))
  })

  it('exists + delete behave correctly', async () => {
    await provider.write({ location, relativePath: 'a.txt', data: new Uint8Array([0x61]) })
    expect(await provider.exists({ location, relativePath: 'a.txt' })).toBe(true)
    expect(await provider.exists({ location, relativePath: 'missing.txt' })).toBe(false)
    await provider.delete({ location, relativePath: 'a.txt' })
    expect(await provider.exists({ location, relativePath: 'a.txt' })).toBe(false)
  })

  it('rejects path traversal', async () => {
    await expect(provider.read({ location, relativePath: '../../escape.bin' })).rejects.toThrow(
      /escapes basePath/,
    )
  })

  it('getAvailableSpace surfaces the server quota when available', async () => {
    const space = await provider.getAvailableSpace({ location })
    expect(space).toBe(1024 * 1024 * 1024)
  })
})

describe('WebDavStorageProvider — chunked upload + download', () => {
  it('round-trips a multi-chunk payload + atomic rename of .partial', async () => {
    const { provider, backend } = makeProviderWithFakeBackend()
    const location = makeLocation()
    const payload = new Uint8Array(32)
    for (let i = 0; i < 32; i++) payload[i] = i + 1

    const { uploadId } = await provider.beginUpload({
      location,
      relativePath: 'archive.bin',
      sizeBytes: 32,
    })
    for (let i = 0; i < 4; i++) {
      await provider.writeChunk({
        uploadId,
        offset: i * 8,
        data: payload.subarray(i * 8, (i + 1) * 8),
      })
    }
    await provider.finalizeUpload({ uploadId })

    expect(backend.files.has('/Camstack/archive.bin')).toBe(true)
    expect(backend.files.has('/Camstack/archive.bin.partial')).toBe(false)

    const { downloadId, sizeBytes } = await provider.beginDownload({
      location,
      relativePath: 'archive.bin',
    })
    expect(sizeBytes).toBe(32)
    const buffers: Uint8Array[] = []
    for (let i = 0; i < 4; i++) {
      buffers.push(await provider.readChunk({ downloadId, offset: i * 8, length: 8 }))
    }
    await provider.endDownload({ downloadId })

    expect(Buffer.concat(buffers.map((b) => Buffer.from(b)))).toEqual(Buffer.from(payload))

    await provider.dispose()
  })

  it('rejects out-of-order chunk offsets', async () => {
    const { provider } = makeProviderWithFakeBackend()
    const location = makeLocation()
    const { uploadId } = await provider.beginUpload({ location, relativePath: 'oo.bin' })
    await provider.writeChunk({ uploadId, offset: 0, data: new Uint8Array([1, 2, 3]) })
    await expect(
      provider.writeChunk({ uploadId, offset: 7, data: new Uint8Array([4]) }),
    ).rejects.toThrow(/offset mismatch.*expected 3.*got 7/)
    await provider.abortUpload({ uploadId })
    await provider.dispose()
  })
})
