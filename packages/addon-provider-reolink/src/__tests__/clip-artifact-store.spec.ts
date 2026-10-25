/**
 * The addon-owned artifact store: thumbnails (immutable, per-device LRU
 * 2 000 files / 64 MB) and the playback scratch (10 clips / 200 MB).
 *
 * Both live in the ADDON's data dir, outside the `eventMedia` class and
 * outside the post-analysis retention sweep — a derived artifact of a catalog
 * whose retention is the camera's (D549 13).
 */
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ClipArtifactStore } from '../clips/clip-artifact-store.js'

let root = ''

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'camstack-clip-store-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const store = (opts: { maxFiles?: number; maxBytes?: number } = {}) =>
  new ClipArtifactStore({
    root,
    kind: 'clip-thumbs',
    maxFilesPerDevice: opts.maxFiles ?? 2_000,
    maxBytesPerDevice: opts.maxBytes ?? 64 * 1024 * 1024,
    extension: '.jpg',
  })

describe('ClipArtifactStore', () => {
  it('has nothing before anything was written', async () => {
    expect(await store().has(592, 'k1')).toBe(false)
    expect(await store().read(592, 'k1')).toBeNull()
  })

  it('files an artifact under <root>/<kind>/<deviceId>/<key>.jpg', async () => {
    const s = store()
    await s.put(592, 'k1', Buffer.from('jpeg-bytes'))
    await expect(stat(join(root, 'clip-thumbs', '592', 'k1.jpg'))).resolves.toBeTruthy()
    expect((await s.read(592, 'k1'))?.toString()).toBe('jpeg-bytes')
  })

  it('VOUCHES only for a file that is really there, with bytes in it', async () => {
    const s = store()
    // A zero-length file is a failed mint, not a thumbnail. Believing it would
    // paint a blank tile and call it a picture.
    await writeFile(join(await s.deviceDir(107), 'empty.jpg'), '')
    expect(await s.has(592, 'empty')).toBe(false)
  })

  it('keeps devices apart', async () => {
    const s = store()
    await s.put(592, 'k1', Buffer.from('a'))
    expect(await s.has(618, 'k1')).toBe(false)
  })

  it('refuses a key that could escape the device directory', async () => {
    const s = store()
    await expect(s.put(592, '../../etc/passwd', Buffer.from('x'))).rejects.toThrow(/key/)
    expect(await s.has(592, '../../etc/passwd')).toBe(false)
  })

  it('evicts the OLDEST artifact when the file bound is reached', async () => {
    const s = store({ maxFiles: 2 })
    await s.put(592, 'a', Buffer.from('1'))
    await new Promise((r) => setTimeout(r, 12))
    await s.put(592, 'b', Buffer.from('2'))
    await new Promise((r) => setTimeout(r, 12))
    await s.put(592, 'c', Buffer.from('3'))
    expect(await s.has(592, 'a')).toBe(false)
    expect(await s.has(592, 'b')).toBe(true)
    expect(await s.has(592, 'c')).toBe(true)
  })

  it('evicts on the BYTE bound too', async () => {
    const s = store({ maxBytes: 20 })
    await s.put(592, 'a', Buffer.alloc(15, 1))
    await new Promise((r) => setTimeout(r, 12))
    await s.put(592, 'b', Buffer.alloc(15, 2))
    expect(await s.has(592, 'a')).toBe(false)
    expect(await s.has(592, 'b')).toBe(true)
  })

  it('reports how much headroom a device has, so a PREFETCH can decline', async () => {
    // A prefetch never evicts: it stops when the device's LRU has under 10%
    // free, so it can never push out what the operator is about to open
    // (D549 16).
    const s = store({ maxFiles: 10 })
    for (const key of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']) {
      await s.put(592, key, Buffer.from('x'))
    }
    expect(await s.hasHeadroomForPrefetch(592)).toBe(false)
    const fresh = store({ maxFiles: 10 })
    await fresh.put(618, 'a', Buffer.from('x'))
    expect(await fresh.hasHeadroomForPrefetch(618)).toBe(true)
  })

  it('never rewrites an artifact that is already there — they are immutable', async () => {
    const s = store()
    await s.put(592, 'k1', Buffer.from('first'))
    await s.put(592, 'k1', Buffer.from('second'))
    expect((await readFile(join(root, 'clip-thumbs', '592', 'k1.jpg'))).toString()).toBe('first')
  })

  it('forgets a whole device when it leaves', async () => {
    const s = store()
    await s.put(107, 'k1', Buffer.from('a'))
    await s.forgetDevice(107)
    expect(await s.has(107, 'k1')).toBe(false)
  })

  it('resolves an absolute path only for an artifact that exists', async () => {
    const s = store()
    expect(await s.pathIfPresent(592, 'k1')).toBeNull()
    await s.put(592, 'k1', Buffer.from('a'))
    expect(await s.pathIfPresent(592, 'k1')).toBe(join(root, 'clip-thumbs', '592', 'k1.jpg'))
  })
})
