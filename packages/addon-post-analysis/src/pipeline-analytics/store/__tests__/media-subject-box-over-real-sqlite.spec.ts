/**
 * The subject's box travels WITH the media row, through the real store (D510).
 *
 * Over real SQLite rather than a fake for the same reason
 * `media-slot-idempotence-over-real-sqlite.spec.ts` is: the thing being added
 * is a COLUMN, and a fake store has none — a fake would happily hand back an
 * object the declared table could never have held. The write also has to
 * survive the slot upsert, which is the statement a missing column would break
 * at runtime, on the first capture after a deploy.
 *
 * What is pinned here:
 *  - a box written is a box read back, identical;
 *  - a row written WITHOUT one is absent from the answer — not a box at the
 *    origin, which is what a zero-defaulting column would produce;
 *  - a re-capture of the same slot carries the NEW box, because a frozen box
 *    on a refreshed frame is precisely the mispairing this replaces;
 *  - every row written before this column existed reads as "cannot say".
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SettingsStoreClient } from '@camstack/types'
import { SqliteSettingsBackend } from '@camstack/system'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeFakeStorageProvider, makeSilentLogger } from '../../__tests__/test-helpers.js'
import { MediaStore, parseMediaSubjectBox, type MediaSubjectBox } from '../media-store.js'

/** Same documented test boundary as the slot spec next door. */
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

const DEVICE = 102
const TRACK = 'track-with-a-box'
const BOX: MediaSubjectBox = { x: 12, y: 34, w: 56, h: 78, frameWidth: 640, frameHeight: 360 }

describe('the media row carries its subject box, over the real SQLite settings store', () => {
  let dir: string
  let backend: SqliteSettingsBackend
  let mediaStore: MediaStore

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'camstack-media-subject-box-'))
    backend = new SqliteSettingsBackend(join(dir, 'camstack.db'))
    await backend.initialize()
    const store = clientOver(backend)
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

  it('a keyFrame written with a box reads back with the SAME box', async () => {
    const mediaId = await mediaStore.putReplacing({
      deviceId: DEVICE,
      ownerKind: 'track',
      ownerId: TRACK,
      kind: 'keyFrame',
      timestamp: 1_700_000_000_000,
      data: Buffer.from([1]),
      subjectBox: BOX,
    })
    const rows = await mediaStore.listSubjectBoxesByOwner('track', TRACK, DEVICE)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.mediaId).toBe(mediaId)
    expect(rows[0]?.kind).toBe('keyFrame')
    expect(rows[0]?.subjectBox).toEqual(BOX)
  })

  it('a row written WITHOUT a box is absent — never a box at the origin', async () => {
    await mediaStore.put({
      deviceId: DEVICE,
      ownerKind: 'track',
      ownerId: TRACK,
      kind: 'snapshot',
      timestamp: 1_700_000_000_000,
      data: Buffer.from([1]),
    })
    expect(await mediaStore.listSubjectBoxesByOwner('track', TRACK, DEVICE)).toEqual([])
  })

  it('a re-capture of the same slot carries the NEW box', async () => {
    const write = (x: number, ts: number): Promise<number> =>
      mediaStore.putReplacing({
        deviceId: DEVICE,
        ownerKind: 'track',
        ownerId: TRACK,
        kind: 'keyFrame',
        timestamp: ts,
        data: Buffer.from([1]),
        subjectBox: { ...BOX, x },
      })
    const first = await write(10, 1_700_000_000_000)
    const second = await write(400, 1_700_000_004_000)
    // Same slot, one row (RC-1) — and the box moved with the frame.
    expect(second).toBe(first)
    const rows = await mediaStore.listSubjectBoxesByOwner('track', TRACK, DEVICE)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.subjectBox.x).toBe(400)
  })

  it('the deviceId filter is the authorization boundary here too', async () => {
    await mediaStore.putReplacing({
      deviceId: DEVICE,
      ownerKind: 'track',
      ownerId: TRACK,
      kind: 'keyFrame',
      timestamp: 1_700_000_000_000,
      data: Buffer.from([1]),
      subjectBox: BOX,
    })
    expect(await mediaStore.listSubjectBoxesByOwner('track', TRACK, 1)).toEqual([])
  })
})

describe('parseMediaSubjectBox', () => {
  it('reads a stored JSON box', () => {
    expect(parseMediaSubjectBox(JSON.stringify(BOX))).toEqual(BOX)
  })

  it('answers undefined for a row that predates the column', () => {
    expect(parseMediaSubjectBox(null)).toBeUndefined()
    expect(parseMediaSubjectBox(undefined)).toBeUndefined()
  })

  it('refuses anything that is not a whole rectangle on a real frame', () => {
    expect(parseMediaSubjectBox('not json')).toBeUndefined()
    expect(parseMediaSubjectBox(JSON.stringify({ ...BOX, w: 0 }))).toBeUndefined()
    expect(parseMediaSubjectBox(JSON.stringify({ ...BOX, frameWidth: 0 }))).toBeUndefined()
    expect(parseMediaSubjectBox(JSON.stringify({ x: 1, y: 2, w: 3, h: 4 }))).toBeUndefined()
    expect(parseMediaSubjectBox(JSON.stringify({ ...BOX, x: 'left' }))).toBeUndefined()
  })
})
