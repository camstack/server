/**
 * The retrain dataset does not live on the footage volume.
 *
 * On 2026-08-17 the operator wiped the recordings volume and "the whole
 * retrain frame dataset" went with it (D197): the copies sat under
 * `eventMedia`, whose declaration says `defaultsTo: 'recordings'`. A dataset
 * version that the cloud-training plan freezes for a job must point at frames
 * no footage wipe, eviction or drain can reach.
 *
 * So the copies are the FOURTH tenant of the `artifacts` class (D341's rule:
 * curation media shares the one durable class, never a class per producer):
 * rows carry the PERMANENT ref `retrainMedia`, which the media-storage wiring
 * maps onto the artifacts root, and the blobs live in its top-level
 * `retrain/` subtree.
 *
 * Discriminating: with the old `eventMedia` write location every assertion
 * after `wipeTheFootageVolume()` fails, and the migration test fails because
 * nothing moves the legacy rows.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  makeFakeSettingsStore,
  makeFakeStorageProvider,
  makeSilentLogger,
  type FakeSettingsStore,
  type FakeStorageProvider,
} from '../../__tests__/test-helpers.js'
import {
  type FakeRecords,
  kindRow,
  makeAnalyticsRecords,
  seedLedgerRows,
} from '../../__tests__/fake-records.js'
import type { EventLedgerCollection } from '../../store/event-ledger-collection.js'
import { MediaRelocateEngine } from '../../media-relocate-engine.js'
import {
  LEGACY_RETRAIN_MEDIA_LOCATION,
  RETRAIN_MEDIA_LOCATION,
  RetrainFrameStore,
} from '../retrain-frame-store.js'
import { wireRetrainFrameLedger } from '../../store/event-ledger-wiring.js'

/** A baseline JPEG header — enough for `readJpegSize`, no encoder needed. */
function jpegOf(width: number, height: number): Buffer {
  const sof = Buffer.from([
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    (height >> 8) & 0xff,
    height & 0xff,
    (width >> 8) & 0xff,
    width & 0xff,
    0x03,
    0x01,
    0x11,
    0x00,
    0x02,
    0x11,
    0x01,
    0x03,
    0x11,
    0x01,
  ])
  return Buffer.concat([Buffer.from([0xff, 0xd8]), sof, Buffer.from([0xff, 0xd9])])
}

const SELECTION = {
  deviceId: 101,
  trackId: 'track-a',
  sourceMediaId: 501,
  sourceKind: 'keyFrame',
} as const

describe('retrain copies live on the durable artifacts tenant', () => {
  let fake: FakeSettingsStore
  let world: FakeRecords
  let frameLedger: EventLedgerCollection
  /** The stored `retrain-frames` body of `id`. */
  const frameRow = (id: string): Record<string, unknown> | undefined =>
    kindRow(world, 'retrain-frames', id)
  let storage: FakeStorageProvider
  let store: RetrainFrameStore
  const sources = new Map<number, Buffer>()

  /** Everything every event-media location held, gone — the 2026-08-17 wipe. */
  const wipeTheFootageVolume = (): void => {
    for (const key of [...storage.files.keys()]) {
      if (key.startsWith(`${LEGACY_RETRAIN_MEDIA_LOCATION}`)) storage.files.delete(key)
    }
  }

  beforeEach(async () => {
    fake = makeFakeSettingsStore()
    world = await makeAnalyticsRecords()
    frameLedger = wireRetrainFrameLedger({ records: world.records })
    storage = makeFakeStorageProvider()
    sources.clear()
    store = new RetrainFrameStore({
      frameLedger,
      storage,
      logger: makeSilentLogger(),
      now: () => 1_700_000_000_000,
      readSource: async (mediaId) => sources.get(mediaId) ?? null,
    })
  })

  it('is a location of its own, never the footage class', () => {
    expect(RETRAIN_MEDIA_LOCATION).toBe('retrainMedia')
    expect(RETRAIN_MEDIA_LOCATION).not.toBe(LEGACY_RETRAIN_MEDIA_LOCATION)
  })

  it('writes a new copy to the retrain location and stamps the row with it', async () => {
    sources.set(SELECTION.sourceMediaId, jpegOf(1920, 1080))

    const result = await store.copyFrame(SELECTION)

    expect(result.kind).toBe('copied')
    if (result.kind !== 'copied') return
    expect(result.frame.locationId).toBe(RETRAIN_MEDIA_LOCATION)
    const row = frameRow(result.frame.frameId)
    expect(row?.['locationId']).toBe(RETRAIN_MEDIA_LOCATION)
    const keys = [...storage.files.keys()]
    expect(keys).toHaveLength(1)
    expect(keys[0]?.startsWith(`${RETRAIN_MEDIA_LOCATION}:retrain/101/track-a/`)).toBe(true)
  })

  it('a selected frame survives a wipe of the footage volume', async () => {
    sources.set(SELECTION.sourceMediaId, jpegOf(1920, 1080))
    const result = await store.copyFrame(SELECTION)
    if (result.kind !== 'copied') throw new Error('copy refused')

    wipeTheFootageVolume()

    const frame = await store.get(result.frame.frameId)
    expect(frame).not.toBeNull()
    if (!frame) return
    expect((await store.readFrame(frame))?.length).toBeGreaterThan(0)
  })

  describe('migrating copies taken while the dataset lived on eventMedia', () => {
    const legacyRow = (id: string, locationId: string | null) => ({
      id,
      data: {
        deviceId: 101,
        trackId: 'track-a',
        sourceMediaId: 7,
        sourceKind: 'keyFrame',
        path: `retrain/101/track-a/${id}.jpg`,
        sizeBytes: 3,
        width: 1,
        height: 1,
        copiedAt: 1,
        locationId,
      },
    })

    it('moves NULL and concrete eventMedia rows, restamps them, and deletes the source', async () => {
      await seedLedgerRows(frameLedger, [
        legacyRow('retrain:track-a:aaaa', null),
        legacyRow('retrain:track-a:bbbb', 'eventMedia:hdd'),
      ])
      await storage.write({
        location: LEGACY_RETRAIN_MEDIA_LOCATION,
        relativePath: 'retrain/101/track-a/aaaa.jpg',
        data: Buffer.from('one'),
      })
      await storage.write({
        location: 'eventMedia:hdd',
        relativePath: 'retrain/101/track-a/bbbb.jpg',
        data: Buffer.from('two'),
      })

      const result = await store.relocateLegacyCopies()

      expect(result).toEqual({ relocated: 2, missing: 0, failed: 0 })
      for (const id of ['retrain:track-a:aaaa', 'retrain:track-a:bbbb']) {
        expect(frameRow(id)?.['locationId']).toBe(RETRAIN_MEDIA_LOCATION)
      }
      expect(storage.files.has('eventMedia:retrain/101/track-a/aaaa.jpg')).toBe(false)
      expect(storage.files.has('eventMedia:hdd:retrain/101/track-a/bbbb.jpg')).toBe(false)

      wipeTheFootageVolume()
      const frame = await store.get('retrain:track-a:bbbb')
      if (!frame) throw new Error('row vanished')
      expect((await store.readFrame(frame))?.toString()).toBe('two')
    })

    it('reports a copy whose bytes are already gone, and keeps its row', async () => {
      await seedLedgerRows(frameLedger, [legacyRow('retrain:track-a:cccc', null)])

      const result = await store.relocateLegacyCopies()

      expect(result).toEqual({ relocated: 0, missing: 1, failed: 0 })
      // A missing blob is reported, never silently deleted: the annotations
      // that point at the row are the operator's work, and only the operator
      // decides to drop them.
      expect(frameRow('retrain:track-a:cccc')).toBeDefined()
    })

    it('is converged after one pass', async () => {
      await seedLedgerRows(frameLedger, [legacyRow('retrain:track-a:dddd', null)])
      await storage.write({
        location: LEGACY_RETRAIN_MEDIA_LOCATION,
        relativePath: 'retrain/101/track-a/dddd.jpg',
        data: Buffer.from('x'),
      })
      await store.relocateLegacyCopies()

      expect(await store.relocateLegacyCopies()).toEqual({ relocated: 0, missing: 0, failed: 0 })
    })
  })

  it('an eventMedia move pass never drags a durable copy back onto the footage class', async () => {
    sources.set(SELECTION.sourceMediaId, jpegOf(640, 480))
    const copied = await store.copyFrame(SELECTION)
    if (copied.kind !== 'copied') throw new Error('copy refused')
    const engine = new MediaRelocateEngine({
      store: fake.client,
      retrainFrameLedger: frameLedger,
      storage,
      logger: makeSilentLogger(),
      now: () => 1,
      newId: () => 'move-1',
      resolveTargetRoot: async () => '/target',
      sleep: async () => {},
    })

    const jobId = engine.start({ toLocationId: 'eventMedia:new' })
    for (let i = 0; i < 100; i++) {
      if (engine.list().find((j) => j.jobId === jobId)?.state !== 'running') break
      await new Promise((resolve) => setTimeout(resolve, 0))
    }

    const row = frameRow(copied.frame.frameId)
    expect(row?.['locationId']).toBe(RETRAIN_MEDIA_LOCATION)
  })
})
