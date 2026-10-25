/**
 * FilesystemStorageProvider — lazy directory creation contract.
 *
 * Directories are created lazily on first `write()` via
 * `fs.mkdir(dirname(filePath), { recursive: true })`.
 * A fresh install whose user hasn't added cameras or enabled recording
 * shouldn't end up with empty directory trees on disk.
 *
 * This spec verifies the invariant end-to-end by running the real
 * `FilesystemStorageProvider` against a temp directory and counting
 * which subdirectories exist before vs after the first actual write.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Readable } from 'node:stream'
import { FilesystemStorageProvider } from '../filesystem-storage-provider.js'

describe('FilesystemStorageProvider — lazy directory creation', () => {
  let tempDir: string
  let provider: FilesystemStorageProvider

  beforeEach(() => {
    tempDir = join(tmpdir(), `fsp-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(tempDir, { recursive: true })
    provider = new FilesystemStorageProvider(tempDir)
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('does NOT create any location subdirectories on construction', () => {
    const entries = readdirSync(tempDir)
    expect(entries).toEqual([])

    // Double-check every canonical location stays absent.
    expect(existsSync(join(tempDir, 'db'))).toBe(false)
    expect(existsSync(join(tempDir, 'media'))).toBe(false)
    expect(existsSync(join(tempDir, 'recordings'))).toBe(false)
    expect(existsSync(join(tempDir, 'recordings-high'))).toBe(false)
    expect(existsSync(join(tempDir, 'recordings-low'))).toBe(false)
    expect(existsSync(join(tempDir, 'recordings-clips'))).toBe(false)
    expect(existsSync(join(tempDir, 'event-images'))).toBe(false)
    expect(existsSync(join(tempDir, 'models'))).toBe(false)
    expect(existsSync(join(tempDir, 'addons-data'))).toBe(false)
    expect(existsSync(join(tempDir, 'logs'))).toBe(false)
  })

  it('creates the target directory lazily on the first write to a specific location', async () => {
    // Nothing yet.
    expect(existsSync(join(tempDir, 'addons-data'))).toBe(false)
    expect(existsSync(join(tempDir, 'media'))).toBe(false)

    // Write a single file under `addons-data/foo/config.json`.
    await provider.write({
      location: 'addons-data',
      relativePath: 'foo/config.json',
      data: Buffer.from('{"k":1}'),
    })

    // ONLY `addons-data` exists — `media`, `logs`, `recordings*` all still absent.
    expect(existsSync(join(tempDir, 'addons-data'))).toBe(true)
    expect(existsSync(join(tempDir, 'addons-data', 'foo'))).toBe(true)
    expect(existsSync(join(tempDir, 'addons-data', 'foo', 'config.json'))).toBe(true)

    expect(existsSync(join(tempDir, 'media'))).toBe(false)
    expect(existsSync(join(tempDir, 'recordings'))).toBe(false)
    expect(existsSync(join(tempDir, 'logs'))).toBe(false)
    expect(existsSync(join(tempDir, 'models'))).toBe(false)
  })

  it('resolves paths without creating directories', async () => {
    const resolved = await provider.resolve({
      location: 'recordings',
      relativePath: 'cam-1/2026-04-11/segment-0.mp4',
    })
    expect(resolved).toBe(join(tempDir, 'recordings', 'cam-1', '2026-04-11', 'segment-0.mp4'))
    // `resolve()` is pure — it must NOT create the directory tree.
    expect(existsSync(join(tempDir, 'recordings'))).toBe(false)
  })

  it('reports available space even when the target location directory does not exist yet', async () => {
    // The recordings dir doesn't exist — `getAvailableSpace` walks up
    // to the first existing ancestor (tempDir) and returns its statfs.
    const space = await provider.getAvailableSpace({ location: 'recordings' })
    expect(space).not.toBeNull()
    expect(typeof space).toBe('number')
    if (space !== null) expect(space).toBeGreaterThan(0)
    // Still no side effect: dir not created.
    expect(existsSync(join(tempDir, 'recordings'))).toBe(false)
  })

  it('each write to a different location creates only that location tree (others stay absent)', async () => {
    await provider.write({
      location: 'addons-data',
      relativePath: 'pipeline-orchestrator/state.json',
      data: Buffer.from('{}'),
    })
    await provider.write({
      location: 'logs',
      relativePath: 'app.log',
      data: Buffer.from('line 1\n'),
    })

    const entries = readdirSync(tempDir).toSorted()
    expect(entries).toEqual(['addons-data', 'logs'])

    expect(existsSync(join(tempDir, 'media'))).toBe(false)
    expect(existsSync(join(tempDir, 'recordings'))).toBe(false)
    expect(existsSync(join(tempDir, 'models'))).toBe(false)
    expect(existsSync(join(tempDir, 'event-images'))).toBe(false)
  })
})

/**
 * `write` replaces a file WHOLE (D654): a reader of a fixed path that is
 * overwritten in place — `lastFrame`, `lastSceneFrame` — must see the old
 * bytes or the new bytes, never a truncated prefix. Both the Buffer and the
 * stream forms go through a temp beside the target and a rename.
 */
describe('FilesystemStorageProvider — write is atomic', () => {
  let tempDir: string
  let provider: FilesystemStorageProvider

  beforeEach(() => {
    tempDir = join(tmpdir(), `fsp-atomic-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(tempDir, { recursive: true })
    provider = new FilesystemStorageProvider(tempDir)
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('a concurrent read never sees a torn file', async () => {
    const size = 4 * 1024 * 1024
    const a = Buffer.alloc(size, 0x11)
    const b = Buffer.alloc(size, 0x22)
    const at = { location: 'media' as const, relativePath: '5/events/track/t/lastFrame.jpg' }
    await provider.write({ ...at, data: a })
    let writing = true
    const writer = (async () => {
      for (let i = 0; i < 30; i += 1) await provider.write({ ...at, data: i % 2 === 0 ? b : a })
      writing = false
    })()
    const torn: number[] = []
    while (writing) {
      const got = await provider.read(at)
      if (!(got.equals(a) || got.equals(b))) torn.push(got.length)
    }
    await writer
    expect(torn).toEqual([])
  })

  it('a failing source stream rejects the write and leaves neither temp nor target', async () => {
    const at = { location: 'media' as const, relativePath: 'y/clip.bin' }
    const source = new Readable({
      read() {
        this.push(Buffer.from('partial'))
        this.destroy(new Error('source broke'))
      },
    })
    await expect(provider.write({ ...at, data: source })).rejects.toThrow('source broke')
    expect(readdirSync(join(tempDir, 'media', 'y'))).toEqual([])
  })

  it('a stream write lands whole and leaves no temp behind', async () => {
    const at = { location: 'media' as const, relativePath: 'x/clip.bin' }
    await provider.write({ ...at, data: Readable.from([Buffer.from('ab'), Buffer.from('cd')]) })
    expect((await provider.read(at)).toString()).toBe('abcd')
    expect(readdirSync(join(tempDir, 'media', 'x'))).toEqual(['clip.bin'])
  })
})
