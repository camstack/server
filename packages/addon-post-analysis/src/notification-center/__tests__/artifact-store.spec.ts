import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  NcArtifactStore,
  NC_ARTIFACT_SUBTREE,
  UNATTRIBUTED_DEVICE_BUCKET,
} from '../artifact-store.js'
import { makeSilentLogger } from '../../pipeline-analytics/__tests__/test-helpers.js'

/**
 * The store lives in the shared `artifacts` class (singleton, two tenants —
 * "le cartelle addons non devono trasportare nulla" [the addons folders must not carry anything], 2026-09-04, D341):
 * `rootDir` is that location's resolved root, and every artifact lands under
 * `<deviceId>/nc-artifacts/…` — per-camera buckets so occupancy counts device
 * dirs and a camera's artifacts die with the camera. An artifact no caller
 * can attribute to a camera goes to the `0` bucket, the repo's existing
 * "not a camera" id (PHOTO_ENROLL_DEVICE_ID).
 */
let rootDir: string
let clock = 1_000_000

beforeEach(async () => {
  rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nc-artifact-'))
  clock = 1_000_000
})
afterEach(async () => {
  await fs.rm(rootDir, { recursive: true, force: true })
})

function makeStore(
  overrides: { maxAgeMs?: number; maxEntries?: number; keptMaxAgeMs?: number | null } = {},
): NcArtifactStore {
  return new NcArtifactStore({
    rootDir,
    logger: makeSilentLogger(),
    now: () => clock,
    ...overrides,
  })
}

/** The scratch shelf of one camera bucket. */
const scratchDir = (deviceId: number): string =>
  path.join(rootDir, String(deviceId), NC_ARTIFACT_SUBTREE)
/** The retained shelf of one camera bucket. */
const keptDir = (deviceId: number): string => path.join(scratchDir(deviceId), 'kept')

const jpeg = (n: number): Uint8Array => new Uint8Array(Array.from({ length: n }, (_, i) => i % 251))

describe('NcArtifactStore — eventMedia-class layout', () => {
  it('files a device-attributed artifact under <deviceId>/nc-artifacts', async () => {
    const store = makeStore()
    await store.start()
    const art = await store.put(jpeg(16), 'image/jpeg', { deviceId: 7 })
    expect(await fs.readdir(scratchDir(7))).toEqual([`${art.id}.jpg`])
  })

  it('files an unattributable artifact in the 0 bucket, never a guessed camera', async () => {
    const store = makeStore()
    await store.start()
    const anon = await store.put(jpeg(8), 'image/jpeg')
    const nullDev = await store.put(jpeg(8), 'image/gif', { deviceId: null })
    const names = await fs.readdir(scratchDir(UNATTRIBUTED_DEVICE_BUCKET))
    expect(names.toSorted()).toEqual([`${anon.id}.jpg`, `${nullDev.id}.gif`].toSorted())
  })

  it('round-trips bytes and mime across device buckets', async () => {
    const store = makeStore()
    await store.start()
    const a = await store.put(jpeg(64), 'image/jpeg', { deviceId: 7 })
    const b = await store.put(jpeg(32), 'video/mp4', {
      deviceId: 9,
      retain: true,
    })
    const readA = await store.read(a.id)
    expect(readA?.mime).toBe('image/jpeg')
    expect(readA?.bytes.byteLength).toBe(64)
    const readB = await store.read(b.id)
    expect(readB?.mime).toBe('video/mp4')
    expect(readB?.bytes.byteLength).toBe(32)
  })

  it('returns null for an unknown id', async () => {
    const store = makeStore()
    await store.start()
    expect(await store.read('1700000000000-3f2504e0-4f89-11d3-9a0c-0305e82c3301')).toBeNull()
  })

  // The route is PUBLIC: the id is attacker-supplied, so anything that is not
  // the exact minted shape must be refused before any filesystem lookup.
  it('refuses a traversal-shaped id without touching the filesystem', async () => {
    const store = makeStore()
    await store.start()
    expect(await store.read('../../etc/passwd')).toBeNull()
    expect(await store.read('not-an-id')).toBeNull()
  })

  it('sweeps artifacts older than maxAge in every bucket', async () => {
    const store = makeStore({ maxAgeMs: 1_000 })
    await store.start()
    const old = await store.put(jpeg(16), 'image/jpeg', { deviceId: 5 })
    const target = path.join(scratchDir(5), `${old.id}.jpg`)
    const past = new Date(clock - 10_000)
    await fs.utimes(target, past, past)
    await store.sweep()
    expect(await store.read(old.id)).toBeNull()
  })

  // The entry bound is GLOBAL — the shelf protects the disk, and a disk does
  // not care which camera the bytes belong to.
  it('drops the OLDEST beyond maxEntries across buckets', async () => {
    const store = makeStore({ maxEntries: 2 })
    await store.start()
    const a = await store.put(jpeg(8), 'image/jpeg', { deviceId: 1 })
    await fs.utimes(
      path.join(scratchDir(1), `${a.id}.jpg`),
      new Date(clock - 300),
      new Date(clock - 300),
    )
    const b = await store.put(jpeg(8), 'image/jpeg', { deviceId: 2 })
    await fs.utimes(
      path.join(scratchDir(2), `${b.id}.jpg`),
      new Date(clock - 200),
      new Date(clock - 200),
    )
    const c = await store.put(jpeg(8), 'image/jpeg', { deviceId: 3 })
    await fs.utimes(
      path.join(scratchDir(3), `${c.id}.jpg`),
      new Date(clock - 100),
      new Date(clock - 100),
    )
    await store.sweep()
    expect(await store.read(a.id)).toBeNull()
    expect(await store.read(b.id)).not.toBeNull()
    expect(await store.read(c.id)).not.toBeNull()
  })

  it('start() sweeps what a crash left behind', async () => {
    const dir = scratchDir(4)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'leftover.jpg'), Buffer.from([1, 2, 3]))
    const past = new Date(clock - 10 * 3600_000)
    await fs.utimes(path.join(dir, 'leftover.jpg'), past, past)
    const store = makeStore()
    await store.start()
    expect(await fs.readdir(dir)).toEqual([])
  })

  // The class root is SHARED with the recorder's exports tenant, which is a
  // SIBLING inside the same camera bucket (`<root>/<deviceId>/exports/…`).
  // Sharing a location must never become sharing a sweep: this store
  // ADDRESSES `<deviceId>/nc-artifacts/` — it never enumerates whatever a
  // bucket holds — so neither the bounds sweep nor clear() may touch the
  // other tenant's files (D341).
  it('sweep() and clear() never touch the exports tenant of the shared root', async () => {
    const store = makeStore({ maxAgeMs: 1, maxEntries: 0, keptMaxAgeMs: 1 })
    await store.start()
    await store.put(jpeg(4), 'image/jpeg', { deviceId: 102 }) // the bucket IS visible to the walk
    const exportFile = path.join(rootDir, '102', 'exports', 'abc.mp4')
    // The THIRD tenant: the enrolled gallery lives top-level at
    // `<root>/gallery/…` — retention-exempt, no sweep may ever reach it.
    const galleryFile = path.join(rootDir, 'gallery', '102', 'events', 'identity', 'id1', 'c.jpg')
    await fs.mkdir(path.dirname(galleryFile), { recursive: true })
    await fs.writeFile(galleryFile, Buffer.from([9]))
    await fs.utimes(galleryFile, new Date(clock - 10_000), new Date(clock - 10_000))
    await fs.mkdir(path.dirname(exportFile), { recursive: true })
    await fs.writeFile(exportFile, Buffer.from([7]))
    const past = new Date(clock - 10_000)
    await fs.utimes(exportFile, past, past)
    await store.sweep()
    await store.clear()
    expect(await fs.readFile(exportFile)).toEqual(Buffer.from([7]))
    expect(await fs.readFile(galleryFile)).toEqual(Buffer.from([9]))
  })

  // The root is a SHARED class root: co-rooted foreign content lives beside
  // the artifact subtrees. clear() must only ever remove nc-artifacts dirs.
  it('clear() removes only the artifact subtrees, never sibling event media', async () => {
    const store = makeStore()
    await store.start()
    await store.put(jpeg(8), 'video/mp4', { deviceId: 6 })
    await store.put(jpeg(8), 'image/jpeg', { deviceId: 6, retain: true })
    const sibling = path.join(rootDir, '6', 'events', 'track', 't1') // co-rooted foreign class content
    await fs.mkdir(sibling, { recursive: true })
    await fs.writeFile(path.join(sibling, 'thumb.jpg'), Buffer.from([9]))
    await store.clear()
    await expect(fs.readdir(scratchDir(6))).rejects.toThrow()
    expect(await fs.readFile(path.join(sibling, 'thumb.jpg'))).toEqual(Buffer.from([9]))
  })

  it('names the file by mime so a fetched link has a usable extension', async () => {
    const store = makeStore()
    await store.start()
    await store.put(jpeg(8), 'video/mp4', { deviceId: 3 })
    const [name] = await fs.readdir(scratchDir(3))
    expect(name?.endsWith('.mp4')).toBe(true)
  })
})

/**
 * The RETAINED shelf (task #36) — same contract as before, per camera bucket:
 * its own three bounds, out of the scratch's way, readable by the same id.
 */
describe('NcArtifactStore — retained shelf', () => {
  it('keeps a retained artifact on its own shelf, readable by the same id', async () => {
    const store = makeStore()
    await store.start()
    const art = await store.put(jpeg(32), 'video/mp4', {
      retain: true,
      deviceId: 7,
    })
    expect(await fs.readdir(keptDir(7))).toEqual([`${art.id}.mp4`])
    const read = await store.read(art.id)
    expect(read?.mime).toBe('video/mp4')
    expect(read?.bytes.byteLength).toBe(32)
  })

  // The whole point of the shelf: the scratch bounds must not reach it.
  it('survives a scratch sweep that would have swept it', async () => {
    const store = makeStore({ maxAgeMs: 1_000, maxEntries: 1 })
    await store.start()
    const kept = await store.put(jpeg(16), 'image/jpeg', {
      retain: true,
      deviceId: 7,
    })
    const past = new Date(clock - 10_000)
    await fs.utimes(path.join(keptDir(7), `${kept.id}.jpg`), past, past)
    await store.sweep()
    expect(await store.read(kept.id)).not.toBeNull()
  })

  it('sweeps the retained shelf past its own age bound', async () => {
    const store = makeStore({ keptMaxAgeMs: 1_000 })
    await store.start()
    const kept = await store.put(jpeg(16), 'image/jpeg', {
      retain: true,
      deviceId: 7,
    })
    const past = new Date(clock - 10_000)
    await fs.utimes(path.join(keptDir(7), `${kept.id}.jpg`), past, past)
    await store.sweep()
    expect(await store.read(kept.id)).toBeNull()
  })

  // The retained shelf carried two more bounds until D485 — 2 000 rows and
  // 2 GiB, whichever bit first — and the tests that pinned them lived here. The
  // operator asked for a shelf whose number means what it says, so they are
  // GONE, and this is the assertion that they stay gone: a count bound removed
  // but still half-wired reads as working retention while bounding nothing.
  //
  // The cost is real and belongs next to the test: `artifacts` is not a class
  // the storage evictor sweeps, so age is now the only thing between this shelf
  // and the disk.
  it('does not bound the retained shelf by count or by bytes', async () => {
    const store = makeStore({ keptMaxAgeMs: 10_000 })
    await store.start()
    const ids: string[] = []
    for (let i = 0; i < 12; i += 1) {
      const art = await store.put(jpeg(1_000), 'image/jpeg', { retain: true, deviceId: 7 })
      ids.push(art.id)
    }

    await store.sweep()

    const survivors = await Promise.all(ids.map(async (id) => (await store.read(id)) !== null))
    expect(survivors.every(Boolean), 'nothing inside the window may be swept').toBe(true)
  })

  it('keeps the retained shelf forever when the window is null', async () => {
    // `null` is the operator's 0 ("keep forever"). It must not be folded into
    // the 14-day default, which is what `?? DEFAULT` used to do.
    const store = makeStore({ keptMaxAgeMs: null })
    await store.start()
    const art = await store.put(jpeg(8), 'image/jpeg', { retain: true, deviceId: 3 })
    const ancient = new Date(clock - 400 * 24 * 3600_000)
    await fs.utimes(path.join(keptDir(3), `${art.id}.jpg`), ancient, ancient)

    await store.sweep()

    expect(await store.read(art.id)).not.toBeNull()
  })

  it('reports which ids are still on the retained shelf, across buckets', async () => {
    const store = makeStore()
    await store.start()
    const a = await store.put(jpeg(8), 'image/jpeg', {
      retain: true,
      deviceId: 1,
    })
    const b = await store.put(jpeg(8), 'image/jpeg', {
      retain: true,
      deviceId: 2,
    })
    await store.put(jpeg(8), 'image/jpeg', { deviceId: 1 })
    expect((await store.keptIds()).toSorted()).toEqual([a.id, b.id].toSorted())
  })

  it('start() sweeps a retained leftover past its bound', async () => {
    await fs.mkdir(keptDir(9), { recursive: true })
    await fs.writeFile(path.join(keptDir(9), 'leftover.jpg'), Buffer.from([1, 2, 3]))
    const past = new Date(clock - 30 * 24 * 3600_000)
    await fs.utimes(path.join(keptDir(9), 'leftover.jpg'), past, past)
    const store = makeStore()
    await store.start()
    expect(await fs.readdir(keptDir(9))).toEqual([])
  })
})
