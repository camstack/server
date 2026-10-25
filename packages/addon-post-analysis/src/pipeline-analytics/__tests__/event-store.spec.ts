/**
 * EventStore unit tests — P9 / B4.
 *
 * Covers:
 *  - declare: only object-events is a legacy table; motion and audio are
 *    records kinds and are never declared as tables
 *  - insertMotion / insertObject / insertAudio: round-trip through the
 *    fake settings store (object) and the records world (motion, audio); returned query rows carry `kind` literal
 *  - queryMotion / queryObject / queryAudio: device + time-range
 *    filtering, ordering, limit
 *  - queryObject classFilter: narrows rows when provided
 *  - evictBefore: deletes rows per-kind with independent cutoffs
 *  - slim projection: heavy fields omitted, label fields kept (B4)
 */

import type {
  AudioEventDraft,
  MotionEventDraft,
  ObjectEvent,
  ObjectEventDraft,
} from '@camstack/types'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  AUDIO_EVENTS_COLLECTION,
  EventStore,
  MOTION_EVENTS_COLLECTION,
  OBJECT_EVENTS_COLLECTION,
} from '../store/event-store.js'
import {
  type EventStoreLedgers,
  eventStoreLedgers,
  instrumentRecords,
  makeAnalyticsRecords,
} from './fake-records.js'
import { type FakeSettingsStore, makeFakeSettingsStore, makeSilentLogger } from './test-helpers.js'

function motion(deviceId: number, timestamp: number): MotionEventDraft {
  return {
    kind: 'motion',
    deviceId,
    timestamp,
    regionCount: 1,
    regions: [{ bbox: { x: 0, y: 0, w: 10, h: 10 }, pixelCount: 100, intensity: 0.5 }],
    frameWidth: 640,
    frameHeight: 480,
  }
}

function object(
  deviceId: number,
  timestamp: number,
  overrides: Partial<ObjectEvent> = {},
): ObjectEventDraft {
  return {
    kind: 'object',
    deviceId,
    timestamp,
    trackId: 't1',
    className: 'person',
    confidence: 0.9,
    bbox: { x: 0, y: 0, w: 10, h: 10 },
    zones: [],
    state: 'new',
    ...overrides,
  }
}

function audio(deviceId: number, timestamp: number): AudioEventDraft {
  return { kind: 'audio', deviceId, timestamp, rms: 0.1, dbfs: -20 }
}

describe('EventStore', () => {
  let fake: FakeSettingsStore
  let ledgers: EventStoreLedgers
  let records: Awaited<ReturnType<typeof makeAnalyticsRecords>>['records']
  let store: EventStore
  /**
   * The id the database gave each row, under the readable name this file knows
   * it by.
   *
   * Those names USED to be the ids (`'m1'`), which is no longer expressible:
   * an event key is a rowid the store assigns (D474). The names stay, because
   * they are what each assertion is about; this map is the one place they meet
   * the real key, so no assertion pins a literal that only encoded the old
   * representation.
   */
  let ids: Map<string, number>

  beforeEach(async () => {
    fake = makeFakeSettingsStore()
    records = (await makeAnalyticsRecords()).records
    ledgers = eventStoreLedgers(records)
    store = new EventStore({ store: fake.client, logger: makeSilentLogger(), ...ledgers })
    ids = new Map()
  })

  /** Insert and remember the assigned id under `name`. */
  const put = async (name: string, insert: () => Promise<number | null>): Promise<number> => {
    const id = await insert()
    expect(id, `insert for ${name} returned no id`).not.toBeNull()
    ids.set(name, id!)
    return id!
  }
  const putMotion = (name: string, s: EventStore, ev: MotionEventDraft): Promise<number> =>
    put(name, () => s.insertMotion(ev))
  const putObject = (name: string, s: EventStore, ev: ObjectEventDraft): Promise<number> =>
    put(name, () => s.insertObject(ev))
  const putAudio = (name: string, s: EventStore, ev: AudioEventDraft): Promise<number> =>
    put(name, () => s.insertAudio(ev))

  /** The assigned id for a name. Throws rather than asserting on `undefined`. */
  const id = (name: string): number => {
    const value = ids.get(name)
    if (value === undefined) throw new Error(`no row was inserted under the name ${name}`)
    return value
  }
  /** The same id as the store's own string-keyed surfaces report it. */
  const key = (name: string): string => String(id(name))

  describe('declare', () => {
    it('registers object-events only — motion and audio are records kinds, never tables', async () => {
      await EventStore.declareObjectCollection(fake.client)
      expect(fake.declared.has(OBJECT_EVENTS_COLLECTION)).toBe(true)
      expect(fake.declared.has(MOTION_EVENTS_COLLECTION)).toBe(false)
      expect(fake.declared.has(AUDIO_EVENTS_COLLECTION)).toBe(false)
    })
  })

  describe('insert + query round-trip', () => {
    beforeEach(async () => {
      await EventStore.declareObjectCollection(fake.client)
    })

    it('persists + queries motion events for a device', async () => {
      await putMotion('m1', store, motion(4, 1000))
      await putMotion('m2', store, motion(4, 2000))
      await putMotion('m-other', store, motion(99, 1000))

      const rows = await store.queryMotion({ deviceId: 4 })
      expect(rows.map((r) => r.id).toSorted()).toEqual([id('m1'), id('m2')].toSorted())
      // Ordered by timestamp desc.
      expect(rows[0]!.id).toBe(id('m2'))
      // Every row carries the literal `kind`.
      expect(rows.every((r) => r.kind === 'motion')).toBe(true)
    })

    it('an episode row opens with durationMs: null and no edges key, then updateMotion closes it (D475)', async () => {
      const mid = await putMotion('episode', store, { ...motion(4, 1000), durationMs: null })

      const openRows = await store.queryMotion({ deviceId: 4 })
      const openRow = openRows.find((r) => r.id === mid)
      expect(openRow?.durationMs).toBeNull()
      expect(openRow?.edges).toBeUndefined()

      const landed = await store.updateMotion(mid, 4, { durationMs: 8_000, edges: [0, 4_500] })
      expect(landed).toBe(true)

      const closedRows = await store.queryMotion({ deviceId: 4 })
      const closedRow = closedRows.find((r) => r.id === mid)
      expect(closedRow?.durationMs).toBe(8_000)
      expect(closedRow?.edges).toEqual([0, 4_500])
    })

    it('a row written before D475 has neither durationMs nor edges — never read as an open episode', async () => {
      const mid = await putMotion('legacy', store, motion(4, 1000))
      const rows = await store.queryMotion({ deviceId: 4 })
      const row = rows.find((r) => r.id === mid)
      expect(row?.durationMs).toBeUndefined()
      expect(row?.edges).toBeUndefined()
    })

    it('persists + queries object events with class filter', async () => {
      await putObject('o1', store, object(4, 1000, { className: 'person' }))
      await putObject('o2', store, object(4, 2000, { className: 'vehicle' }))
      await putObject('o3', store, object(4, 3000, { className: 'person' }))

      const all = await store.queryObject({ deviceId: 4 })
      expect(all).toHaveLength(3)

      const persons = await store.queryObject({ deviceId: 4, classFilter: 'person' })
      expect(persons.map((r) => r.id).toSorted()).toEqual([id('o1'), id('o3')].toSorted())
      expect(persons.every((r) => r.className === 'person')).toBe(true)
    })

    it('slim projection keeps frameId + trackId (scene/track grouping keys) but drops heavy bbox/zones', async () => {
      await putObject('o1', store, object(4, 1000, { frameId: 'f-1000', trackId: 'track-7' }))
      const [slim] = await store.queryObject({ deviceId: 4, projection: 'slim' })
      expect(slim!.frameId).toBe('f-1000')
      expect(slim!.trackId).toBe('track-7')
      expect(slim!.bbox).toBeUndefined()
      expect(slim!.zones).toBeUndefined()
      // full projection still carries everything
      const [full] = await store.queryObject({ deviceId: 4, projection: 'full' })
      expect(full!.frameId).toBe('f-1000')
      expect(full!.bbox).toEqual({ x: 0, y: 0, w: 10, h: 10 })
    })

    it('persists + queries audio events', async () => {
      await putAudio('a1', store, audio(4, 1000))
      const rows = await store.queryAudio({ deviceId: 4 })
      expect(rows).toHaveLength(1)
      expect(rows[0]!.kind).toBe('audio')
      expect(rows[0]!.rms).toBe(0.1)
    })

    it('filters by since + until timestamps', async () => {
      await putMotion('m1', store, motion(4, 1000))
      await putMotion('m2', store, motion(4, 2000))
      await putMotion('m3', store, motion(4, 3000))

      const inRange = await store.queryMotion({ deviceId: 4, since: 1500, until: 2500 })
      expect(inRange.map((r) => r.id)).toEqual([id('m2')])
    })

    it('honours limit in queries', async () => {
      for (let i = 0; i < 10; i++) {
        await putMotion(`m${i}`, store, motion(4, 1000 + i))
      }
      const limited = await store.queryMotion({ deviceId: 4, limit: 3 })
      expect(limited).toHaveLength(3)
    })
  })

  describe('evictTracklessBefore', () => {
    beforeEach(async () => {
      await EventStore.declareObjectCollection(fake.client)
    })

    it('drops motion + audio rows older than the cutoff', async () => {
      await putMotion('m-old', store, motion(4, 1000))
      await putMotion('m-new', store, motion(4, 10_000))
      await putAudio('a-old', store, audio(4, 1000))
      await putAudio('a-new', store, audio(4, 10_000))

      const deleted = await store.evictTracklessBefore({ cutoffMs: 5000 })
      // The evicted-id lists are the MEDIA owner ids — text, because that is
      // what `deleteForEvents` addresses a blob by (D474).
      expect(deleted).toEqual({ motion: [key('m-old')], audio: [key('a-old')] })

      expect((await store.queryMotion({ deviceId: 4 })).map((r) => r.id)).toEqual([id('m-new')])
      expect((await store.queryAudio({ deviceId: 4 })).map((r) => r.id)).toEqual([id('a-new')])
    })

    it('NEVER age-evicts an object event, however old — it belongs to a track', async () => {
      // The load-bearing assertion of D61. An object event carries a trackId and
      // owns crops; it leaves with its track through `deleteByTracks` and by no
      // other route. Before this, object events were swept on their own
      // `retentionObjectDays` window (measured 19.8 days of them against 7.0
      // days of tracks) and everything they owned was orphaned behind them.
      await putObject('o-ancient', store, object(4, 1))
      await store.evictTracklessBefore({ cutoffMs: Number.MAX_SAFE_INTEGER })
      expect((await store.queryObject({ deviceId: 4 })).map((r) => r.id)).toEqual([id('o-ancient')])
    })

    it('ONE cutoff governs both kinds — motion and audio cannot diverge', async () => {
      // They used to take a window each (`retentionMotionDays` /
      // `retentionAudioDays`), which is two clocks over two entities always
      // swept in the same pass, for the same device, by the same caller. There
      // is now one parameter, so the divergence is not expressible (D62).
      await putMotion('m1', store, motion(4, 1000))
      await putAudio('a1', store, audio(4, 1000))
      await putMotion('m2', store, motion(4, 3000))
      await putAudio('a2', store, audio(4, 3000))

      const deleted = await store.evictTracklessBefore({ cutoffMs: 2000 })
      expect(deleted).toEqual({ motion: [key('m1')], audio: [key('a1')] })
    })

    it('drains ALL stale rows even when the total exceeds one query page', async () => {
      // The engine caps rows per query page. The age sweep must keep
      // querying+deleting until the pages run out, or a high-volume camera
      // grows the table unbounded (only one page evicted per 5-min sweep).
      // Cap the page at 3 and seed 10 stale rows per kind.
      const PAGE_LIMIT = 3
      const STALE = 10
      for (let i = 0; i < STALE; i++) {
        await putMotion(`m-old-${i}`, store, motion(4, 1000 + i))
        await putAudio(`a-old-${i}`, store, audio(4, 1000 + i))
      }
      await putMotion('m-keep', store, motion(4, 10_000))

      const capped = instrumentRecords(records, { capQueryLimit: PAGE_LIMIT })
      const cappedStore = new EventStore({
        store: fake.client,
        logger: makeSilentLogger(),
        ...eventStoreLedgers(capped.records),
      })

      const deleted = await cappedStore.evictTracklessBefore({ cutoffMs: 5000 })

      expect(deleted.motion).toHaveLength(STALE)
      expect(deleted.audio).toHaveLength(STALE)
      // Only the single fresh motion row survives.
      expect((await store.queryMotion({ deviceId: 4 })).map((r) => r.id)).toEqual([id('m-keep')])
      expect(await store.queryAudio({ deviceId: 4 })).toHaveLength(0)
    })

    it('deletes event-owned media of evicted motion rows in lockstep', async () => {
      const deleted: string[][] = []
      const withMedia = new EventStore({
        store: fake.client,
        logger: makeSilentLogger(),
        ...ledgers,
        media: {
          deleteForEvents: async (ids) => {
            const flat = [...(ids.motion ?? []), ...(ids.object ?? []), ...(ids.audio ?? [])]
            deleted.push(flat)
            return flat.length
          },
        },
      })
      await putMotion('m-old', withMedia, motion(4, 1000))
      await putMotion('m-new', withMedia, motion(4, 10_000))
      await putAudio('a-old', withMedia, audio(4, 1000))

      const evicted = await withMedia.evictTracklessBefore({ cutoffMs: 5000 })
      expect(evicted).toEqual({ motion: [key('m-old')], audio: [key('a-old')] })
      expect(deleted).toEqual([[key('m-old'), key('a-old')]])
    })
  })

  describe('existingEventIdsIn', () => {
    beforeEach(async () => {
      await EventStore.declareObjectCollection(fake.client)
    })

    it('returns only the ids that still exist in THAT table — the orphan audit liveness probe', async () => {
      await putObject('o-live', store, object(4, 1000))
      const live = await store.existingEventIdsIn('object', [key('o-live'), 'o-gone'])
      expect([...live]).toEqual([key('o-live')])
    })

    it('answers per TABLE: a motion row of the same id does not make an object row live', async () => {
      // D474 made an event id a per-table rowid alias, so this is the normal
      // case and not a contrived one: on the live hub every object id and
      // every audio id is also a motion id. The union this replaced answered
      // "live" for all of them (D480).
      await putMotion('m-live', store, motion(4, 1000))
      const motionId = key('m-live')
      expect([...(await store.existingEventIdsIn('motion', [motionId]))]).toEqual([motionId])
      expect([...(await store.existingEventIdsIn('object', [motionId]))]).toEqual([])
      expect([...(await store.existingEventIdsIn('audio', [motionId]))]).toEqual([])
    })

    it('has no id-only door left — a probe that can skip the table will', () => {
      expect('existingEventIds' in store).toBe(false)
    })
  })

  // ── Task 5 / 4g: the tiered back-patch ──────────────────────────────
  describe('projectTrackLabel (the track decides, the rows copy)', () => {
    beforeEach(async () => {
      await EventStore.declareObjectCollection(fake.client)
    })

    it('updates the label on every object event of a track, leaving others', async () => {
      // o1 and o2 belong to track 'tA', o3 belongs to 'tB'
      await putObject('o1', store, object(4, 1000, { trackId: 'tA' }))
      await putObject('o2', store, object(4, 2000, { trackId: 'tA' }))
      await putObject('o3', store, object(4, 3000, { trackId: 'tB' }))

      const updated = await store.projectTrackLabel('tA', {
        subLabel: 'Alice',
        subLabelScore: 0.9,
        subLabelMeta: { stepId: 'face-recognizer', decidedAt: 1, identityId: 'id-alice' },
      })
      expect(updated).toBe(2)

      const rows = await store.queryObject({ deviceId: 4 })
      const byId = new Map(rows.map((r) => [r.id, r.subLabel]))
      expect(byId.get(id('o1'))).toBe('Alice')
      expect(byId.get(id('o2'))).toBe('Alice')
      expect(byId.get(id('o3'))).not.toBe('Alice')
    })

    // THE REGRESSION: 407 of 437 tracks had event rows disagreeing with the
    // track, because the row re-ran the write rule and its own stronger
    // incumbent won. The track's answer is now the only one.
    it('overwrites a row whose own incumbent OUTSCORES the track decision', async () => {
      await putObject(
        'o1',
        store,
        object(4, 1000, {
          trackId: 'tA',
          subLabel: 'AB123CD',
          subLabelScore: 0.99,
          subLabelMeta: { stepId: 'plate-ocr', decidedAt: 1 },
        }),
      )

      await store.projectTrackLabel('tA', {
        subLabel: 'Alice',
        subLabelScore: 0.4,
        subLabelMeta: { stepId: 'face-recognizer', decidedAt: 2, identityId: 'id-alice' },
      })

      const rows = await store.queryObject({ deviceId: 4 })
      expect(rows.find((r) => r.id === id('o1'))?.subLabel).toBe('Alice')
    })
  })

  // ── B4: slim projection ────────────────────────────────────────────
  describe('slim projection', () => {
    beforeEach(async () => {
      await EventStore.declareObjectCollection(fake.client)
    })

    it('queryMotion slim: omits heavy fields (regions/frameWidth/frameHeight), keeps regionCount', async () => {
      await putMotion('m1', store, motion(4, 1000))

      const slim = await store.queryMotion({ deviceId: 4, projection: 'slim' })
      expect(slim).toHaveLength(1)
      const ev = slim[0]!
      // Base fields present
      expect(ev.id).toBe(id('m1'))
      expect(ev.kind).toBe('motion')
      expect(ev.deviceId).toBe(4)
      expect(ev.timestamp).toBe(1000)
      // Label field present
      expect(ev.regionCount).toBe(1)
      // Heavy fields absent
      expect(ev.regions).toBeUndefined()
      expect(ev.frameWidth).toBeUndefined()
      expect(ev.frameHeight).toBeUndefined()
      // mediaUrl not set yet (B5)
      expect(ev.mediaUrl).toBeUndefined()
    })

    it('queryObject slim: omits heavy fields (trackId/confidence/bbox/zones/state), keeps className', async () => {
      await putObject('o1', store, object(4, 1000, { label: 'human' }))

      const slim = await store.queryObject({ deviceId: 4, projection: 'slim' })
      expect(slim).toHaveLength(1)
      const ev = slim[0]!
      // Base fields present
      expect(ev.id).toBe(id('o1'))
      expect(ev.kind).toBe('object')
      expect(ev.deviceId).toBe(4)
      expect(ev.timestamp).toBe(1000)
      // Label fields present
      expect(ev.className).toBe('person')
      expect(ev.label).toBe('human')
      // trackId is now KEPT in slim (light string, track grouping key).
      expect(ev.trackId).toBe('t1')
      // Heavy fields absent
      expect(ev.confidence).toBeUndefined()
      expect(ev.bbox).toBeUndefined()
      expect(ev.zones).toBeUndefined()
      expect(ev.state).toBeUndefined()
      // mediaUrl not set yet (B5)
      expect(ev.mediaUrl).toBeUndefined()
    })

    it('queryObject slim: omits label when not set', async () => {
      await putObject('o2', store, object(4, 2000))

      const slim = await store.queryObject({ deviceId: 4, projection: 'slim' })
      expect(slim).toHaveLength(1)
      const ev = slim[0]!
      expect(ev.className).toBe('person')
      expect(ev.label).toBeUndefined()
    })

    it('queryMotion full (default): still returns heavy fields', async () => {
      await putMotion('m1', store, motion(4, 1000))

      const full = await store.queryMotion({ deviceId: 4, projection: 'full' })
      expect(full).toHaveLength(1)
      const ev = full[0]!
      expect(ev.regions).toBeDefined()
      expect(ev.frameWidth).toBe(640)
      expect(ev.frameHeight).toBe(480)
    })

    it('queryObject full (default): still returns heavy fields', async () => {
      await putObject('o1', store, object(4, 1000))

      const full = await store.queryObject({ deviceId: 4, projection: 'full' })
      expect(full).toHaveLength(1)
      const ev = full[0]!
      expect(ev.trackId).toBe('t1')
      expect(ev.confidence).toBe(0.9)
      expect(ev.bbox).toBeDefined()
      expect(ev.zones).toBeDefined()
      expect(ev.state).toBe('new')
    })

    it('queryAudio slim: equivalent to full (no heavy fields to drop), returns rms/dbfs', async () => {
      await putAudio('a1', store, audio(4, 1000))

      const slim = await store.queryAudio({ deviceId: 4, projection: 'slim' })
      expect(slim).toHaveLength(1)
      const ev = slim[0]!
      expect(ev.id).toBe(id('a1'))
      expect(ev.kind).toBe('audio')
      expect(ev.rms).toBe(0.1)
      expect(ev.dbfs).toBe(-20)
      expect(ev.mediaUrl).toBeUndefined()
    })
  })

  describe('countForDevice', () => {
    beforeEach(async () => {
      await EventStore.declareObjectCollection(fake.client)
    })

    it('sums motion + object + audio rows for the device', async () => {
      await putMotion('m1', store, motion(4, 1000))
      await putMotion('m2', store, motion(4, 2000))
      await putObject('o1', store, object(4, 1500))
      await putAudio('a1', store, audio(4, 1700))
      // Another device — must not be counted.
      await putMotion('m3', store, motion(9, 1000))

      expect(await store.countForDevice(4)).toBe(4)
      expect(await store.countForDevice(9)).toBe(1)
      expect(await store.countForDevice(123)).toBe(0)
    })
  })
})
