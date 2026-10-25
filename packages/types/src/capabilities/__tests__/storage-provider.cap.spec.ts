import { describe, it, expect } from 'vitest'
import { storageProviderCapability } from '../storage-provider.cap.js'

describe('storageProviderCapability', () => {
  it('declares the expected name/scope/mode', () => {
    expect(storageProviderCapability.name).toBe('storage-provider')
    expect(storageProviderCapability.scope).toBe('system')
    expect(storageProviderCapability.mode).toBe('collection')
  })

  it('exposes every method required by the spec', () => {
    const expected: readonly string[] = [
      // self-description + connectivity probe
      'getProviderInfo',
      'testLocation',
      // small-file primitives
      'resolve',
      'write',
      'read',
      'exists',
      'list',
      'delete',
      'getAvailableSpace',
      // chunked upload
      'beginUpload',
      'writeChunk',
      'finalizeUpload',
      'abortUpload',
      // chunked download
      'beginDownload',
      'readChunk',
      'endDownload',
    ]
    const actual = Object.keys(storageProviderCapability.methods).toSorted()
    expect(actual).toEqual([...expected].toSorted())
  })

  it('marks mutating methods with kind: mutation', () => {
    const mutations: readonly string[] = [
      'write',
      'delete',
      'beginUpload',
      'writeChunk',
      'finalizeUpload',
      'abortUpload',
      'beginDownload',
      'endDownload',
    ]
    for (const name of mutations) {
      const m =
        storageProviderCapability.methods[name as keyof typeof storageProviderCapability.methods]
      expect(m, `method ${name} should exist`).toBeDefined()
      expect(m.kind, `method ${name} should be a mutation`).toBe('mutation')
    }
  })

  it('beginUpload accepts a valid input', () => {
    const input = {
      location: {
        id: 'backups:nas-01',
        type: 'backups',
        displayName: 'NAS 01',
        providerId: 'filesystem-storage',
        config: { root: '/mnt/nas' },
        isDefault: false,
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_000,
      },
      relativePath: 'foo/bar.tar.gz',
      sizeBytes: 1024,
    }
    const parsed = storageProviderCapability.methods.beginUpload.input.parse(input)
    expect(parsed.relativePath).toBe('foo/bar.tar.gz')
    expect(parsed.sizeBytes).toBe(1024)
  })

  it('writeChunk rejects input missing uploadId', () => {
    const result = storageProviderCapability.methods.writeChunk.input.safeParse({
      offset: 0,
      data: new Uint8Array([1, 2, 3]),
    })
    expect(result.success).toBe(false)
  })

  it('getProviderInfo input is z.void()', () => {
    expect(() =>
      storageProviderCapability.methods.getProviderInfo.input.parse(undefined),
    ).not.toThrow()
  })
})

describe('ProviderInfoSchema disk-space fields', () => {
  const out = storageProviderCapability.methods.getProviderInfo.output

  it('accepts the true-variant (shouldSaveDiskSpace:true ⇒ numeric threshold)', () => {
    expect(() =>
      out.parse({
        providerId: 'filesystem-storage',
        displayName: 'Filesystem',
        configSchema: {},
        nodeLocal: true,
        shouldSaveDiskSpace: true,
        minFreePercent: 10,
      }),
    ).not.toThrow()
  })

  it('accepts the false-variant (shouldSaveDiskSpace:false ⇒ null threshold)', () => {
    expect(() =>
      out.parse({
        providerId: 's3',
        displayName: 'S3',
        configSchema: {},
        nodeLocal: false,
        shouldSaveDiskSpace: false,
        minFreePercent: null,
      }),
    ).not.toThrow()
  })

  it('rejects the invariant violation (false with a numeric minFreePercent)', () => {
    expect(() =>
      out.parse({
        providerId: 's3',
        displayName: 'S3',
        configSchema: {},
        nodeLocal: false,
        shouldSaveDiskSpace: false,
        minFreePercent: 50,
      }),
    ).toThrow()
  })

  it('rejects the invariant violation (true with a null minFreePercent)', () => {
    expect(() =>
      out.parse({
        providerId: 'filesystem-storage',
        displayName: 'Filesystem',
        configSchema: {},
        nodeLocal: true,
        shouldSaveDiskSpace: true,
        minFreePercent: null,
      }),
    ).toThrow()
  })

  it('rejects a provider info missing shouldSaveDiskSpace', () => {
    expect(() =>
      out.parse({
        providerId: 'x',
        displayName: 'X',
        configSchema: {},
        nodeLocal: false,
        minFreePercent: null,
      }),
    ).toThrow()
  })

  it('rejects minFreePercent outside 0..100 (true-variant)', () => {
    expect(() =>
      out.parse({
        providerId: 'x',
        displayName: 'X',
        configSchema: {},
        nodeLocal: true,
        shouldSaveDiskSpace: true,
        minFreePercent: 150,
      }),
    ).toThrow()
  })
})
