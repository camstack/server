/**
 * The media row's write SLOT reproduces BOTH halves of the old key's
 * uniqueness rule — proved on the real engine, in both directions (D482).
 *
 * ## What this is guarding
 *
 * `media.id` used to be the row's composite key, and it was not a derived
 * cache: it WAS the uniqueness constraint. `buildKey` omitted the timestamp
 * for {@link SINGLE_INSTANCE_KINDS}, so N racing re-captures of the same
 * `(owner, kind)` all addressed one row and the last write won ("RC-1"); every
 * other kind carried its timestamp and accumulated.
 *
 * D482 made the id a surrogate, so the rule had to move somewhere. It moved
 * into `slotTsFor` + the partial-free UNIQUE index `idx_media_slot`. If that
 * does not reproduce the two rules EXACTLY, the consequences are opposite and
 * both bad:
 *
 *  - too strict → an accumulating kind stops accumulating, or a re-capture
 *    starts throwing a UNIQUE-constraint error and the media is lost;
 *  - too loose → a single-instance kind duplicates, which is the 5 598-row
 *    orphan class this repo has already paid for once.
 *
 * So both directions are asserted here, and asserted over the REAL SQLite
 * backend rather than a fake: a fake store cannot have an index, and an index
 * is the entire mechanism. (The same reason
 * `media-footprint-plan-over-real-sqlite.spec.ts` exists.)
 *
 * ## Why the count assertions are on the STORE and not on a mock
 *
 * Every check below reads the table back. A `put` that answered with an id is
 * not evidence that only one row exists — the bug shape this file exists to
 * catch is a SECOND row nobody asked about, and only counting finds it.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SettingsStoreClient } from '@camstack/types'
import { SqliteSettingsBackend } from '@camstack/system'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeFakeStorageProvider, makeSilentLogger } from '../../__tests__/test-helpers.js'
import {
  MEDIA_COLLECTION,
  MediaStore,
  SINGLE_INSTANCE_KINDS,
  SINGLE_SLOT_TS,
  slotTsFor,
} from '../media-store.js'

/** Same documented test boundary as `media-footprint-plan-over-real-sqlite.spec.ts`. */
function clientOver(backend: SqliteSettingsBackend): SettingsStoreClient {
  return {
    declareCollection: { mutate: (i: never) => backend.declareCollection(i) },
    upsert: { mutate: (i: never) => backend.upsert(i) },
    insert: { mutate: (i: never) => backend.insert(i) },
    get: { query: (i: never) => backend.get(i) },
    set: { mutate: (i: never) => backend.set(i) },
    query: { query: (i: never) => backend.query(i) },
    delete: { mutate: (i: never) => backend.delete(i) },
    count: { query: (i: never) => backend.count(i) },
  } as unknown as SettingsStoreClient
}

const DEVICE = 101
const TRACK = 'track-abc'

describe('the media write slot, over the real SQLite settings store', () => {
  let dir: string
  let backend: SqliteSettingsBackend
  let store: SettingsStoreClient
  let mediaStore: MediaStore

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'camstack-media-slot-'))
    backend = new SqliteSettingsBackend(join(dir, 'camstack.db'))
    await backend.initialize()
    store = clientOver(backend)
    await MediaStore.declare(store)
    mediaStore = new MediaStore({
      storage: makeFakeStorageProvider(),
      store,
      logger: makeSilentLogger(),
    })
  })

  afterEach(async () => {
    await backend.shutdown()
    rmSync(dir, { recursive: true, force: true })
  })

  async function rowCount(): Promise<number> {
    return backend.count({ collection: MEDIA_COLLECTION })
  }

  function put(kind: string, timestamp: number, byte: number): Promise<number> {
    return mediaStore.put({
      deviceId: DEVICE,
      ownerKind: 'track',
      ownerId: TRACK,
      // The kind union is closed; the tests only name real members of it.
      kind: kind as never,
      timestamp,
      data: Buffer.from([byte]),
    })
  }

  // ── Direction 1: a single-instance kind must COLLAPSE ────────────────

  it('a re-captured single-instance kind lands on the SAME row — one row, one id', async () => {
    const first = await put('thumbnail', 1_700_000_000_000, 1)
    const second = await put('thumbnail', 1_700_000_005_000, 2)
    const third = await put('thumbnail', 1_700_000_010_000, 3)

    expect(second).toBe(first)
    expect(third).toBe(first)
    expect(await rowCount()).toBe(1)

    // And the row holds the LATEST capture: the second write is an update, not
    // a silent no-op. A slot that collapsed but never overwrote would freeze
    // every track's thumbnail at its first frame.
    const row = await mediaStore.getById(first)
    expect(row).not.toBeNull()
    expect(row?.timestamp).toBe(1_700_000_010_000)
  })

  it('collapses for EVERY single-instance kind, not just the one sampled', async () => {
    for (const kind of SINGLE_INSTANCE_KINDS) {
      const a = await put(kind, 1_700_000_000_000, 1)
      const b = await put(kind, 1_700_000_001_000, 2)
      expect(b, `kind ${kind} did not collapse`).toBe(a)
    }
    // One row per kind, and no more.
    expect(await rowCount()).toBe(SINGLE_INSTANCE_KINDS.size)
  })

  it('N CONCURRENT captures of one slot leave ONE row (RC-1)', async () => {
    // The race the old deterministic id existed to close. `put` is one
    // statement now, so interleaving cannot produce a survivor — but it is the
    // property, not the implementation, that must hold.
    const ids = await Promise.all(
      [1, 2, 3, 4, 5, 6, 7, 8].map((n) => put('keyFrame', 1_700_000_000_000 + n * 1_000, n)),
    )
    expect(new Set(ids).size).toBe(1)
    expect(await rowCount()).toBe(1)
  })

  // ── Direction 2: an accumulating kind must ACCUMULATE ────────────────

  it('an accumulating kind inserts a NEW row per timestamp', async () => {
    const a = await put('snapshot', 1_700_000_000_000, 1)
    const b = await put('snapshot', 1_700_000_005_000, 2)
    const c = await put('snapshot', 1_700_000_010_000, 3)

    expect(new Set([a, b, c]).size).toBe(3)
    expect(await rowCount()).toBe(3)
  })

  it('an accumulating kind re-captured at the SAME instant is still one row', async () => {
    // Not an accident of the scheme — the old key had the same property (the
    // timestamp was IN the id), and the periodic-media plan relies on it: a
    // retried capture of one frame must not become two filmstrip entries.
    const a = await put('snapshot', 1_700_000_000_000, 1)
    const b = await put('snapshot', 1_700_000_000_000, 2)
    expect(b).toBe(a)
    expect(await rowCount()).toBe(1)
  })

  // ── The slot is per (owner, kind), not per owner or per kind ─────────

  it('two kinds under one owner are two rows', async () => {
    const thumb = await put('thumbnail', 1_700_000_000_000, 1)
    const keyFrame = await put('keyFrame', 1_700_000_000_000, 2)
    expect(thumb).not.toBe(keyFrame)
    expect(await rowCount()).toBe(2)
  })

  it('the SAME kind under two owners of DIFFERENT tables is two rows — the D482 collision', async () => {
    // This is the defect, reduced: motion #101314 and object #101314 are two
    // rows that spell the same number (D474), and under the composite key they
    // were one string. A track from 17:34 on camera 101 was served a motion
    // event's snapshot from 22:35 eleven days earlier.
    const write = (ownerKind: 'motion' | 'object'): Promise<number> =>
      mediaStore.put({
        deviceId: DEVICE,
        ownerKind,
        ownerId: '101314',
        kind: 'snapshot',
        timestamp: 1_700_000_000_000,
        data: Buffer.from([ownerKind === 'motion' ? 1 : 2]),
      })
    const motion = await write('motion')
    const object = await write('object')

    expect(motion).not.toBe(object)
    expect(await rowCount()).toBe(2)

    // And each address resolves to its OWN bytes. Under the old key the second
    // write overwrote the first and both readers saw one image.
    const motionRow = await mediaStore.getById(motion)
    const objectRow = await mediaStore.getById(object)
    expect(Buffer.from(motionRow?.base64 ?? '', 'base64')).toEqual(Buffer.from([1]))
    expect(Buffer.from(objectRow?.base64 ?? '', 'base64')).toEqual(Buffer.from([2]))
  })

  // ── The rule has ONE spelling ────────────────────────────────────────

  it('slotTsFor is the only rule: single-instance → the single slot, else the frame instant', () => {
    for (const kind of SINGLE_INSTANCE_KINDS) {
      expect(slotTsFor({ kind, timestamp: 1_700_000_000_000 })).toBe(SINGLE_SLOT_TS)
    }
    for (const kind of ['snapshot', 'crop', 'fullFrame', 'faceCrop', 'plateCrop'] as const) {
      expect(slotTsFor({ kind, timestamp: 1_700_000_000_000 })).toBe(1_700_000_000_000)
    }
  })

  // ── The address is a surrogate, and says nothing ─────────────────────

  it('the id is a rowid — a plain integer that names no owner and no kind', async () => {
    const id = await put('thumbnail', 1_700_000_000_000, 1)
    expect(Number.isInteger(id)).toBe(true)
    expect(id).toBeGreaterThan(0)
    // Nothing about the owner survives in the address. That is the whole
    // record: an address that cannot name a foreign id cannot name the WRONG
    // foreign id.
    expect(String(id)).not.toContain(':')
    expect(String(id)).not.toContain(TRACK)
    expect(String(id)).not.toContain('thumbnail')
  })
})
