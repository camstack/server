/**
 * `FilesystemStorageProvider` (Task 7) — `storage-provider` cap-impl spec.
 *
 * Covers:
 *  - small-file round-trip (`write` → `read`)
 *  - chunked round-trip (begin/writeChunk × N/finalize → begin/readChunk × N/end)
 *  - atomic publish via `.partial` rename
 *  - abort-cleanup leaves no dangling `.partial`
 *  - path-traversal rejection
 *  - `getProviderInfo` shape
 *  - `testLocation` happy + sad paths
 */

import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { StorageLocation } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FilesystemStorageProvider } from '../filesystem-storage-provider.js'

const makeLocation = (basePath: string): StorageLocation => ({
  id: 'data:default',
  type: 'data',
  displayName: 'Test Data',
  providerId: 'filesystem-storage',
  config: { basePath },
  isSystem: false,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
})

describe('FilesystemStorageProvider — small-file primitives', () => {
  let tempDir: string
  let provider: FilesystemStorageProvider
  let location: StorageLocation

  beforeEach(() => {
    tempDir = join(tmpdir(), `fsp-cap-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(tempDir, { recursive: true })
    provider = new FilesystemStorageProvider()
    location = makeLocation(tempDir)
  })

  afterEach(async () => {
    await provider.dispose()
    rmSync(tempDir, { recursive: true, force: true })
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

  it('list returns relative-to-location filenames', async () => {
    await provider.write({ location, relativePath: 'one.txt', data: new Uint8Array([1]) })
    await provider.write({ location, relativePath: 'two.txt', data: new Uint8Array([2]) })

    const entries = [...(await provider.list({ location }))].toSorted()
    expect(entries).toEqual(['one.txt', 'two.txt'])
  })

  it('list with prefix returns prefixed filenames', async () => {
    await provider.write({ location, relativePath: 'sub/one.txt', data: new Uint8Array([1]) })
    await provider.write({ location, relativePath: 'sub/two.txt', data: new Uint8Array([2]) })

    const entries = [...(await provider.list({ location, prefix: 'sub' }))].toSorted()
    expect(entries).toEqual(['sub/one.txt', 'sub/two.txt'])
  })

  it('rejects path-traversal attempts', async () => {
    await expect(provider.read({ location, relativePath: '../../../etc/passwd' })).rejects.toThrow(
      /escapes basePath/,
    )

    await expect(
      provider.write({ location, relativePath: '../escape.bin', data: new Uint8Array([1]) }),
    ).rejects.toThrow(/escapes basePath/)
  })

  it('throws when location.config.basePath is missing', async () => {
    const bad: StorageLocation = { ...location, config: {} }
    await expect(provider.read({ location: bad, relativePath: 'x' })).rejects.toThrow(
      /missing string config\.basePath/,
    )
  })
})

describe('FilesystemStorageProvider — chunked upload + download', () => {
  let tempDir: string
  let provider: FilesystemStorageProvider
  let location: StorageLocation

  beforeEach(() => {
    tempDir = join(tmpdir(), `fsp-chunk-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(tempDir, { recursive: true })
    provider = new FilesystemStorageProvider()
    location = makeLocation(tempDir)
  })

  afterEach(async () => {
    await provider.dispose()
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('round-trips a multi-chunk payload', async () => {
    // 32 bytes split across 4 × 8-byte chunks (the test logic is the
    // same as a 32MB archive in 4 × 8MB chunks; we keep it tiny so the
    // suite stays fast).
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

    // Final file landed atomically.
    expect(existsSync(join(tempDir, 'archive.bin'))).toBe(true)
    expect(existsSync(join(tempDir, 'archive.bin.partial'))).toBe(false)

    // Download in 4 chunks, then assemble + compare.
    const { downloadId, sizeBytes } = await provider.beginDownload({
      location,
      relativePath: 'archive.bin',
    })
    expect(sizeBytes).toBe(32)

    const buffers: Uint8Array[] = []
    for (let i = 0; i < 4; i++) {
      const chunk = await provider.readChunk({
        downloadId,
        offset: i * 8,
        length: 8,
      })
      buffers.push(chunk)
    }
    await provider.endDownload({ downloadId })

    const reassembled = Buffer.concat(buffers.map((b) => Buffer.from(b)))
    expect(reassembled).toEqual(Buffer.from(fullPayload))
  })

  it('uses a .partial file during upload, atomically renames on finalize', async () => {
    const { uploadId } = await provider.beginUpload({
      location,
      relativePath: 'pending.bin',
    })

    await provider.writeChunk({ uploadId, offset: 0, data: new Uint8Array([0xaa, 0xbb]) })

    // Mid-upload: target NOT visible yet.
    expect(existsSync(join(tempDir, 'pending.bin'))).toBe(false)
    expect(existsSync(join(tempDir, 'pending.bin.partial'))).toBe(true)

    await provider.finalizeUpload({ uploadId })

    // After finalize: target visible, partial gone.
    expect(existsSync(join(tempDir, 'pending.bin'))).toBe(true)
    expect(existsSync(join(tempDir, 'pending.bin.partial'))).toBe(false)
  })

  it('rejects out-of-order chunk offsets', async () => {
    const { uploadId } = await provider.beginUpload({
      location,
      relativePath: 'oo.bin',
    })

    await provider.writeChunk({ uploadId, offset: 0, data: new Uint8Array([1, 2, 3]) })

    // bytesWritten = 3; offset 7 is wrong.
    await expect(
      provider.writeChunk({ uploadId, offset: 7, data: new Uint8Array([4]) }),
    ).rejects.toThrow(/offset mismatch.*expected 3.*got 7/)

    await provider.abortUpload({ uploadId })
  })

  it('abortUpload cleans up the .partial and leaves the target untouched', async () => {
    const { uploadId } = await provider.beginUpload({
      location,
      relativePath: 'aborted.bin',
    })
    await provider.writeChunk({ uploadId, offset: 0, data: new Uint8Array([0xff, 0xff]) })

    await provider.abortUpload({ uploadId })

    expect(existsSync(join(tempDir, 'aborted.bin'))).toBe(false)
    expect(existsSync(join(tempDir, 'aborted.bin.partial'))).toBe(false)

    // Calling abortUpload twice is idempotent (no throw).
    await expect(provider.abortUpload({ uploadId })).resolves.toBeUndefined()
  })

  it('beginDownload on a missing file throws', async () => {
    await expect(
      provider.beginDownload({ location, relativePath: 'no-such-file.bin' }),
    ).rejects.toThrow()
  })

  it('endDownload on an unknown id is a no-op', async () => {
    await expect(provider.endDownload({ downloadId: 'never-created' })).resolves.toBeUndefined()
  })
})

describe('FilesystemStorageProvider — getProviderInfo + testLocation', () => {
  let tempDir: string
  let provider: FilesystemStorageProvider

  beforeEach(() => {
    tempDir = join(tmpdir(), `fsp-meta-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(tempDir, { recursive: true })
    provider = new FilesystemStorageProvider()
  })

  afterEach(async () => {
    await provider.dispose()
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('getProviderInfo returns the expected providerId + displayName + configSchema', async () => {
    const info = await provider.getProviderInfo()
    expect(info.providerId).toBe('filesystem-storage')
    expect(info.displayName).toBe('Filesystem')
    expect(info.configSchema).toBeTypeOf('object')
  })

  it('declares shouldSaveDiskSpace=true with minFreePercent=10 default', async () => {
    const info = await provider.getProviderInfo()
    expect(info.shouldSaveDiskSpace).toBe(true)
    expect(info.minFreePercent).toBe(10)
  })

  it('testLocation returns ok for an existing writable directory', async () => {
    const result = await provider.testLocation({ config: { basePath: tempDir } })
    expect(result.ok).toBe(true)
    expect(result.error).toBeUndefined()
  })

  it('testLocation creates the directory when it does not exist', async () => {
    const newPath = join(tempDir, 'nested', 'path')
    expect(existsSync(newPath)).toBe(false)
    const result = await provider.testLocation({ config: { basePath: newPath } })
    expect(result.ok).toBe(true)
    expect(existsSync(newPath)).toBe(true)
  })

  it('testLocation returns ok:false with an error for an unwritable path', async () => {
    // `/dev/null/nope` — `/dev/null` is a char device, so mkdir under
    // it fails with ENOTDIR. Reliable across macOS + Linux.
    const result = await provider.testLocation({ config: { basePath: '/dev/null/nope' } })
    expect(result.ok).toBe(false)
    expect(result.error).toBeTruthy()
  })

  it('testLocation rejects empty / non-string basePath', async () => {
    const empty = await provider.testLocation({ config: { basePath: '' } })
    expect(empty.ok).toBe(false)

    const missing = await provider.testLocation({ config: {} })
    expect(missing.ok).toBe(false)

    const wrongType = await provider.testLocation({ config: { basePath: 42 } })
    expect(wrongType.ok).toBe(false)
  })
})
