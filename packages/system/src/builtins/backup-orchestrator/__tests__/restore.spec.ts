/**
 * Unit tests for chunked-download restore (Task 12 of the storage-
 * unification refactor).
 *
 * Exercises `downloadArchiveToCache` with a fake `AddonApi['storage']`
 * slice backed by an in-memory `Map<key, Uint8Array>`. The test
 * writes bytes to a real OS tmp dir to verify the cache file lands
 * on disk with byte-exact contents (mirrors the production restore
 * marker handoff to the boot-time apply hook).
 *
 * Round-trip coverage: upload bytes via fake storage → download via
 * `downloadArchiveToCache` → verify the cache file matches the
 * source byte for byte.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import type { IScopedLogger } from '@camstack/types'
import { downloadArchiveToCache } from '../download-helpers.js'
import type { ChunkedDownloadApi } from '../manifest-store.js'

interface FakeDownloadApi {
  readonly beginDownload: {
    mutate: (input: {
      location: string
      relativePath: string
    }) => Promise<{ downloadId: string; sizeBytes: number }>
  }
  readonly readChunk: {
    query: (input: { downloadId: string; offset: number; length: number }) => Promise<Uint8Array>
  }
  readonly endDownload: { mutate: (input: { downloadId: string }) => Promise<void> }
}

function makeFakeStorage(seed: Map<string, Uint8Array>): {
  api: ChunkedDownloadApi
  ended: string[]
} {
  const sessions = new Map<string, { location: string; relativePath: string }>()
  const ended: string[] = []
  let counter = 0
  const fake: FakeDownloadApi = {
    beginDownload: {
      mutate: async ({ location, relativePath }) => {
        const data = seed.get(`${location}|${relativePath}`)
        if (!data) throw new Error(`fake storage: ${location}/${relativePath} missing`)
        const downloadId = `dl-${++counter}`
        sessions.set(downloadId, { location, relativePath })
        return { downloadId, sizeBytes: data.byteLength }
      },
    },
    readChunk: {
      query: async ({ downloadId, offset, length }) => {
        const session = sessions.get(downloadId)
        if (!session) throw new Error(`fake storage: unknown downloadId ${downloadId}`)
        const data = seed.get(`${session.location}|${session.relativePath}`)
        if (!data) throw new Error(`fake storage: source vanished mid-read`)
        return data.slice(offset, offset + length)
      },
    },
    endDownload: {
      mutate: async ({ downloadId }) => {
        ended.push(downloadId)
        sessions.delete(downloadId)
      },
    },
  }
  return { api: fake as unknown as ChunkedDownloadApi, ended }
}

function makeLogger(): IScopedLogger {
  return {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
    withTags: vi.fn().mockReturnThis(),
  } as unknown as IScopedLogger
}

describe('downloadArchiveToCache (Task 12)', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'camstack-backup-restore-test-'))
  })

  afterEach(async () => {
    try {
      await fsp.rm(tmpDir, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  })

  it('downloads bytes byte-for-byte into the cache path', async () => {
    const sourceBytes = new Uint8Array(1024)
    for (let i = 0; i < sourceBytes.length; i++) sourceBytes[i] = i % 256
    const seed = new Map<string, Uint8Array>([['backups:default|abc.tar.gz', sourceBytes]])
    const { api, ended } = makeFakeStorage(seed)
    const cachePath = path.join(tmpDir, 'restore-abc.tar.gz')

    await downloadArchiveToCache({
      api,
      locationId: 'backups:default',
      filename: 'abc.tar.gz',
      cachePath,
      chunkBytes: 256, // Force multiple reads.
      logger: makeLogger(),
    })

    const onDisk = await fsp.readFile(cachePath)
    expect(onDisk.byteLength).toBe(sourceBytes.byteLength)
    expect(new Uint8Array(onDisk.buffer, onDisk.byteOffset, onDisk.byteLength)).toEqual(sourceBytes)
    expect(ended).toHaveLength(1)
  })

  it('handles small archives that fit in a single chunk', async () => {
    const sourceBytes = new Uint8Array([1, 2, 3, 4, 5])
    const seed = new Map<string, Uint8Array>([['backups:default|tiny.tar.gz', sourceBytes]])
    const { api } = makeFakeStorage(seed)
    const cachePath = path.join(tmpDir, 'restore-tiny.tar.gz')

    await downloadArchiveToCache({
      api,
      locationId: 'backups:default',
      filename: 'tiny.tar.gz',
      cachePath,
      chunkBytes: 8 * 1024 * 1024,
      logger: makeLogger(),
    })

    const onDisk = await fsp.readFile(cachePath)
    expect(Array.from(onDisk)).toEqual([1, 2, 3, 4, 5])
  })

  it('cleans up the partial cache file on mid-stream failure', async () => {
    const sourceBytes = new Uint8Array(2048)
    const seed = new Map<string, Uint8Array>([['backups:default|abc.tar.gz', sourceBytes]])
    const { api } = makeFakeStorage(seed)
    // Wrap readChunk to throw on the second call.
    let calls = 0
    const wrappedRead: ChunkedDownloadApi['readChunk'] = {
      query: async (input) => {
        calls++
        if (calls === 2) throw new Error('simulated transport failure')
        return api.readChunk.query(input)
      },
    }
    const wrappedApi: ChunkedDownloadApi = {
      ...api,
      readChunk: wrappedRead,
    }
    const cachePath = path.join(tmpDir, 'restore-abc.tar.gz')

    await expect(
      downloadArchiveToCache({
        api: wrappedApi,
        locationId: 'backups:default',
        filename: 'abc.tar.gz',
        cachePath,
        chunkBytes: 256,
        logger: makeLogger(),
      }),
    ).rejects.toThrow('simulated transport failure')

    expect(fs.existsSync(cachePath)).toBe(false)
  })

  it('throws when the source reports sizeBytes but yields an empty chunk', async () => {
    let counter = 0
    const empty: FakeDownloadApi = {
      beginDownload: {
        mutate: async () => {
          const downloadId = `dl-${++counter}`
          // Claim 100 bytes but always return empty chunks.
          return { downloadId, sizeBytes: 100 }
        },
      },
      readChunk: {
        query: async () => new Uint8Array(0),
      },
      endDownload: {
        mutate: async () => {
          /* noop */
        },
      },
    }
    const emptyApi = empty as unknown as ChunkedDownloadApi

    const cachePath = path.join(tmpDir, 'restore-empty.tar.gz')
    await expect(
      downloadArchiveToCache({
        api: emptyApi,
        locationId: 'backups:default',
        filename: 'whatever.tar.gz',
        cachePath,
        chunkBytes: 256,
        logger: makeLogger(),
      }),
    ).rejects.toThrow(/empty chunk/)
  })

  it('round-trips a structured archive payload', async () => {
    // Simulate a "real" tarball: a 4 KB payload with structured bytes.
    const sourceBytes = new Uint8Array(4096)
    for (let i = 0; i < sourceBytes.length; i++) sourceBytes[i] = (i * 7) & 0xff
    const seed = new Map<string, Uint8Array>([['backups:nas|round-trip.tar.gz', sourceBytes]])
    const { api } = makeFakeStorage(seed)
    const cachePath = path.join(tmpDir, 'restore-rt.tar.gz')

    await downloadArchiveToCache({
      api,
      locationId: 'backups:nas',
      filename: 'round-trip.tar.gz',
      cachePath,
      chunkBytes: 1000, // Off-multiple → exercises tail-handling.
      logger: makeLogger(),
    })

    const onDisk = await fsp.readFile(cachePath)
    expect(onDisk.byteLength).toBe(4096)
    expect(new Uint8Array(onDisk.buffer, onDisk.byteOffset, onDisk.byteLength)).toEqual(sourceBytes)
  })
})
