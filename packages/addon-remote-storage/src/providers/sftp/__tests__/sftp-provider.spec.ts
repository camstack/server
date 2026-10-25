/**
 * `SftpStorageProvider` cap-impl spec.
 *
 * The real `ssh2.Client` opens a TCP connection — fine for an integration
 * test against a live server, but we want a fast unit suite. We inject
 * a constructor stub that returns a fake `Client` whose `sftp()` callback
 * yields an in-memory `SFTPWrapper` over a shared file map. Provider
 * behaviour (chunked round-trip, .partial rename, path-traversal guard,
 * etc.) is therefore exercised end-to-end against a deterministic backend.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import type { Client, ConnectConfig, SFTPWrapper, FileEntry } from 'ssh2'
import type { IScopedLogger, StorageLocation, LogExtras, LogTags } from '@camstack/types'
import { SftpStorageProvider } from '../sftp-provider.js'

const noopLogger: IScopedLogger = {
  debug: (_message: string, _extras?: LogExtras) => undefined,
  info: (_message: string, _extras?: LogExtras) => undefined,
  warn: (_message: string, _extras?: LogExtras) => undefined,
  error: (_message: string, _extras?: LogExtras) => undefined,
  child: (_scope: string) => noopLogger,
  withTags: (_tags: LogTags) => noopLogger,
}

const makeLocation = (overrides?: Partial<StorageLocation['config']>): StorageLocation => ({
  id: 'backups:test-sftp',
  type: 'backups',
  displayName: 'Test SFTP',
  providerId: 'sftp-storage',
  config: {
    host: 'sftp.example.com',
    port: 22,
    username: 'tester',
    authMethod: 'password',
    password: 'secret',
    basePath: '/srv/backups',
    ...overrides,
  },
  isSystem: false,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
})

// In-memory backend. Files keyed by absolute-style path string.
// Intentionally NOT typed as `Partial<SFTPWrapper>` — the ssh2 typings
// declare overloaded signatures (numeric mode, attribute objects, …)
// that would force every method here to handle 4+ branches without
// adding any test value. The fake is duck-typed to the actual subset
// the provider invokes.
class FakeSftp extends EventEmitter {
  private readonly files: Map<string, Buffer>
  private readonly handles: Map<string, { path: string; flags: string; offset: number }>
  private nextHandleId = 1

  constructor(files: Map<string, Buffer>) {
    super()
    this.files = files
    this.handles = new Map<string, { path: string; flags: string; offset: number }>()
  }

  private allocHandle(target: string, flags: string): Buffer {
    const id = String(this.nextHandleId++)
    this.handles.set(id, { path: target, flags, offset: 0 })
    return Buffer.from(id)
  }

  private resolveHandle(handle: Buffer): { path: string; flags: string; offset: number } {
    const id = handle.toString('utf-8')
    const h = this.handles.get(id)
    if (!h) throw new Error(`fake-sftp: unknown handle "${id}"`)
    return h
  }

  open(target: string, flags: string, cb: (err: Error | null, handle: Buffer) => void): void {
    if (flags === 'r' && !this.files.has(target)) {
      cb(new Error(`ENOENT: ${target}`), Buffer.alloc(0))
      return
    }
    if (flags === 'w') {
      this.files.set(target, Buffer.alloc(0))
    }
    cb(null, this.allocHandle(target, flags))
  }

  write(
    handle: Buffer,
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
    cb: (err: Error | null, bytesWritten: number) => void,
  ): void {
    const h = this.resolveHandle(handle)
    const existing = this.files.get(h.path) ?? Buffer.alloc(0)
    const minSize = position + length
    const grown =
      existing.length < minSize
        ? Buffer.concat([existing, Buffer.alloc(minSize - existing.length)])
        : Buffer.from(existing)
    buffer.copy(grown, position, offset, offset + length)
    this.files.set(h.path, grown)
    cb(null, length)
  }

  read(
    handle: Buffer,
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
    cb: (err: Error | null, bytesRead: number, buffer: Buffer) => void,
  ): void {
    const h = this.resolveHandle(handle)
    const file = this.files.get(h.path)
    if (!file) {
      cb(new Error(`ENOENT: ${h.path}`), 0, buffer)
      return
    }
    const slice = file.subarray(position, position + length)
    slice.copy(buffer, offset)
    cb(null, slice.length, buffer)
  }

  close(handle: Buffer, cb: (err: Error | null) => void): void {
    this.handles.delete(handle.toString('utf-8'))
    cb(null)
  }

  unlink(target: string, cb: (err: Error | null) => void): void {
    this.files.delete(target)
    cb(null)
  }

  rename(from: string, to: string, cb: (err: Error | null) => void): void {
    const buf = this.files.get(from)
    if (!buf) {
      cb(new Error(`ENOENT: ${from}`))
      return
    }
    this.files.set(to, buf)
    this.files.delete(from)
    cb(null)
  }

  mkdir(_target: string, cb: (err: Error | null) => void): void {
    // The fake doesn't track directories — every mkdir is a no-op.
    cb(null)
  }

  stat(
    target: string,
    cb: (
      err: Error | null,
      attrs: { size: number; isDirectory(): boolean; isFile(): boolean } | null,
    ) => void,
  ): void {
    const file = this.files.get(target)
    if (!file) {
      cb(new Error(`ENOENT: ${target}`), null)
      return
    }
    cb(null, {
      size: file.length,
      isDirectory: () => false,
      isFile: () => true,
    })
  }

  readdir(dir: string, cb: (err: Error | null, entries: FileEntry[]) => void): void {
    const prefix = dir.endsWith('/') ? dir : `${dir}/`
    const entries: FileEntry[] = []
    for (const k of this.files.keys()) {
      if (k.startsWith(prefix)) {
        const rest = k.slice(prefix.length)
        if (!rest.includes('/')) {
          entries.push({
            filename: rest,
            longname: rest,
            attrs: {
              size: this.files.get(k)!.length,
              uid: 0,
              gid: 0,
              mode: 0o644,
              atime: 0,
              mtime: 0,
              isDirectory: () => false,
              isFile: () => true,
              isBlockDevice: () => false,
              isCharacterDevice: () => false,
              isSymbolicLink: () => false,
              isFIFO: () => false,
              isSocket: () => false,
            },
          } as unknown as FileEntry)
        }
      }
    }
    cb(null, entries)
  }

  end(): void {
    // no-op
  }
}

class FakeClient extends EventEmitter {
  private readonly files: Map<string, Buffer>

  constructor(files: Map<string, Buffer>) {
    super()
    this.files = files
  }

  connect(_cfg: ConnectConfig): void {
    setImmediate(() => this.emit('ready'))
  }

  sftp(cb: (err: Error | null, sftp: SFTPWrapper) => void): void {
    setImmediate(() => cb(null, new FakeSftp(this.files) as unknown as SFTPWrapper))
  }

  end(): void {
    this.emit('end')
  }
}

class FailingClient extends EventEmitter {
  connect(_cfg: ConnectConfig): void {
    setImmediate(() => this.emit('error', new Error('connect ECONNREFUSED')))
  }

  sftp(_cb: (err: Error | null, sftp: SFTPWrapper) => void): void {
    /* not reached */
  }

  end(): void {
    /* no-op */
  }
}

function makeProviderWithFakeBackend(): {
  provider: SftpStorageProvider
  files: Map<string, Buffer>
} {
  const files = new Map<string, Buffer>()
  const ctor = function FakeCtor(this: unknown): Client {
    return new FakeClient(files) as unknown as Client
  } as unknown as new () => Client
  const provider = new SftpStorageProvider(noopLogger, ctor)
  return { provider, files }
}

describe('SftpStorageProvider — getProviderInfo', () => {
  it('returns expected providerId, displayName, and a non-empty config schema', async () => {
    const { provider } = makeProviderWithFakeBackend()
    const info = await provider.getProviderInfo()
    expect(info.providerId).toBe('sftp-storage')
    expect(info.displayName).toBe('SFTP')
    expect(info.configSchema).toBeTypeOf('object')
  })
})

describe('SftpStorageProvider — testLocation', () => {
  it('returns ok:false on empty / invalid config without attempting a connection', async () => {
    const { provider } = makeProviderWithFakeBackend()
    const result = await provider.testLocation({ config: {} })
    expect(result.ok).toBe(false)
    expect(result.error).toBeTruthy()
  })

  it('returns ok:false when the underlying client errors out', async () => {
    const ctor = function FailCtor(): Client {
      return new FailingClient() as unknown as Client
    } as unknown as new () => Client
    const provider = new SftpStorageProvider(noopLogger, ctor)
    const result = await provider.testLocation({
      config: { host: 'unreachable', username: 'x', password: 'y', basePath: '/tmp' },
    })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/ECONNREFUSED|connect/i)
  })

  it('returns ok:true against a healthy backend', async () => {
    const { provider } = makeProviderWithFakeBackend()
    const result = await provider.testLocation({
      config: {
        host: 'sftp.example.com',
        port: 22,
        username: 'tester',
        authMethod: 'password',
        password: 'secret',
        basePath: '/srv/backups',
      },
    })
    expect(result.ok).toBe(true)
  })
})

describe('SftpStorageProvider — small-file primitives', () => {
  let provider: SftpStorageProvider
  let location: StorageLocation

  beforeEach(() => {
    ;({ provider } = makeProviderWithFakeBackend())
    location = makeLocation()
  })

  it('round-trips a small payload via write + read', async () => {
    const payload = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0xff])
    await provider.write({ location, relativePath: 'foo/bar.bin', data: payload })
    const out = await provider.read({ location, relativePath: 'foo/bar.bin' })
    expect(Buffer.from(out)).toEqual(Buffer.from(payload))
  })

  it('exists + delete behave correctly', async () => {
    await provider.write({ location, relativePath: 'a.txt', data: new Uint8Array([0x61]) })
    expect(await provider.exists({ location, relativePath: 'a.txt' })).toBe(true)
    expect(await provider.exists({ location, relativePath: 'missing.txt' })).toBe(false)
    await provider.delete({ location, relativePath: 'a.txt' })
    expect(await provider.exists({ location, relativePath: 'a.txt' })).toBe(false)
  })

  it('rejects path traversal attempts', async () => {
    await expect(provider.read({ location, relativePath: '../../../etc/passwd' })).rejects.toThrow(
      /escapes basePath/,
    )
  })
})

describe('SftpStorageProvider — chunked upload + download', () => {
  it('round-trips a multi-chunk payload + atomic rename of .partial', async () => {
    const { provider, files } = makeProviderWithFakeBackend()
    const location = makeLocation()
    const fullPayload = new Uint8Array(32)
    for (let i = 0; i < 32; i++) fullPayload[i] = i + 1

    const { uploadId } = await provider.beginUpload({
      location,
      relativePath: 'archive.bin',
      sizeBytes: 32,
    })
    for (let i = 0; i < 4; i++) {
      await provider.writeChunk({
        uploadId,
        offset: i * 8,
        data: fullPayload.subarray(i * 8, (i + 1) * 8),
      })
    }
    await provider.finalizeUpload({ uploadId })

    expect(files.has('/srv/backups/archive.bin')).toBe(true)
    expect(files.has('/srv/backups/archive.bin.partial')).toBe(false)

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
    expect(Buffer.concat(buffers.map((b) => Buffer.from(b)))).toEqual(Buffer.from(fullPayload))

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

  it('abortUpload removes the .partial without committing the target', async () => {
    const { provider, files } = makeProviderWithFakeBackend()
    const location = makeLocation()
    const { uploadId } = await provider.beginUpload({ location, relativePath: 'aborted.bin' })
    await provider.writeChunk({ uploadId, offset: 0, data: new Uint8Array([0xff, 0xff]) })
    await provider.abortUpload({ uploadId })

    expect(files.has('/srv/backups/aborted.bin')).toBe(false)
    expect(files.has('/srv/backups/aborted.bin.partial')).toBe(false)

    // Idempotent.
    await expect(provider.abortUpload({ uploadId })).resolves.toBeUndefined()
    await provider.dispose()
  })
})
