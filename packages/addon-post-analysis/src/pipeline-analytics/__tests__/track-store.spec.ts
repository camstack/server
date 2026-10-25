/**
 * TrackStore unit tests — P9.
 *
 * Covers:
 *  - upsert: new vs. existing track, position history growth, distance
 *    accumulation, zone deduplication, maxPositionHistory downsampling
 *  - addSnapshot: attaches + updates lastSnapshotAt
 *  - getActive / getActiveByTrack filters by deviceId + active flag
 *  - expireStale: promotes stale tracks to declared collection, returns
 *    them, keeps fresh tracks in RAM
 *  - clearDevice / clearAll: RAM-only drops, no persistence
 *  - queryHistorical: reads the declared collection with filters
 *  - declare: idempotent, uses the declareCollection cap method
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { TRACKS_COLLECTION, type TrackPosition, TrackStore } from '../store/track-store.js'
import {
  type FakeSettingsStore,
  makeFakeSettingsStore,
  makeLogRecorder,
  makeSilentLogger,
} from './test-helpers.js'

function pos(x: number, y: number, timestamp: number): TrackPosition {
  return { x, y, timestamp, bbox: { x, y, w: 10, h: 10 } }
}

describe('TrackStore', () => {
  let fake: FakeSettingsStore
  let store: TrackStore

  beforeEach(() => {
    fake = makeFakeSettingsStore()
    store = new TrackStore({ store: fake.client, logger: makeSilentLogger() })
  })

  describe('declare', () => {
    it('registers the tracks collection via declareCollection.mutate', async () => {
      await TrackStore.declare(fake.client)
      expect(fake.declared.has(TRACKS_COLLECTION)).toBe(true)
      expect(fake.declaredDatabase.get(TRACKS_COLLECTION)).toBe('events')
    })
  })

  describe('upsert', () => {
    it('creates a fresh track on first sighting', () => {
      const t = store.upsert({
        trackId: 't1',
        deviceId: 4,
        className: 'person',
        timestamp: 1000,
        position: pos(10, 20, 1000),
        zones: ['entrance'],
        state: 'new',
      })
      expect(t.trackId).toBe('t1')
      expect(t.firstSeen).toBe(1000)
      expect(t.lastSeen).toBe(1000)
      expect(t.positions).toHaveLength(1)
      expect(t.zonesVisited).toEqual(['entrance'])
      expect(t.totalDistance).toBe(0)
      expect(t.active).toBe(true)

      const fetched = store.getActiveByTrack('t1')
      expect(fetched?.trackId).toBe('t1')
    })

    it('accumulates distance + positions on subsequent sightings', () => {
      store.upsert({
        trackId: 't1',
        deviceId: 4,
        className: 'person',
        timestamp: 1000,
        position: pos(0, 0, 1000),
        zones: [],
        state: 'new',
      })
      store.upsert({
        trackId: 't1',
        deviceId: 4,
        className: 'person',
        timestamp: 1100,
        position: pos(3, 4, 1100),
        zones: [],
        state: 'moving',
      })
      const t = store.getActiveByTrack('t1')!
      expect(t.positions).toHaveLength(2)
      expect(t.lastSeen).toBe(1100)
      expect(t.totalDistance).toBeCloseTo(5, 5) // 3-4-5 triangle
      expect(t.state).toBe('moving')
    })

    it('deduplicates zones across upserts', () => {
      store.upsert({
        trackId: 't1',
        deviceId: 4,
        className: 'person',
        timestamp: 1000,
        position: pos(0, 0, 1000),
        zones: ['a'],
        state: 'new',
      })
      store.upsert({
        trackId: 't1',
        deviceId: 4,
        className: 'person',
        timestamp: 1100,
        position: pos(1, 1, 1100),
        zones: ['a', 'b'],
        state: 'moving',
      })
      expect(store.getActiveByTrack('t1')!.zonesVisited).toEqual(['a', 'b'])
    })

    it('downsamples first half when positions exceed maxPositionHistory', () => {
      const max = 10
      const local = new TrackStore({
        store: fake.client,
        logger: makeSilentLogger(),
        config: { maxPositionHistory: max },
      })
      for (let i = 0; i < max; i++) {
        local.upsert({
          trackId: 't1',
          deviceId: 4,
          className: 'person',
          timestamp: 1000 + i,
          position: pos(i, 0, 1000 + i),
          zones: [],
          state: 'moving',
        })
      }
      // Push the (max+1)th — should trigger downsample.
      local.upsert({
        trackId: 't1',
        deviceId: 4,
        className: 'person',
        timestamp: 2000,
        position: pos(99, 0, 2000),
        zones: [],
        state: 'moving',
      })
      const t = local.getActiveByTrack('t1')!
      // After downsample: half = 5 — keep indexes 5..9 entirely + every-other
      // from 0..4 → indexes 0,2,4 → 3 kept + 5 kept + new = 9
      expect(t.positions.length).toBeLessThanOrEqual(max)
      expect(t.positions.at(-1)?.x).toBe(99)
    })

    it('seeds the observed-class set with the first sighting className', () => {
      const t = store.upsert({
        trackId: 't1',
        deviceId: 4,
        className: 'person',
        timestamp: 1000,
        position: pos(0, 0, 1000),
        zones: [],
        state: 'new',
      })
      expect(t.classes).toEqual(['person'])
    })

    it('accumulates + deduplicates observed classes across upserts', () => {
      store.upsert({
        trackId: 't1',
        deviceId: 4,
        className: 'person',
        timestamp: 1000,
        position: pos(0, 0, 1000),
        zones: [],
        state: 'new',
      })
      store.upsert({
        trackId: 't1',
        deviceId: 4,
        className: 'person', // duplicate — no growth
        timestamp: 1100,
        position: pos(1, 1, 1100),
        zones: [],
        state: 'moving',
      })
      store.upsert({
        trackId: 't1',
        deviceId: 4,
        className: 'vehicle', // reclassified — appended
        timestamp: 1200,
        position: pos(2, 2, 1200),
        zones: [],
        state: 'moving',
      })
      expect(store.getActiveByTrack('t1')!.classes).toEqual(['person', 'vehicle'])
    })

    it('carries the class set into the persisted (cloned) track', async () => {
      await TrackStore.declare(fake.client)
      store.upsert({
        trackId: 't1',
        deviceId: 4,
        className: 'person',
        timestamp: 1000,
        position: pos(0, 0, 1000),
        zones: [],
        state: 'new',
      })
      store.upsert({
        trackId: 't1',
        deviceId: 4,
        className: 'vehicle',
        timestamp: 1100,
        position: pos(1, 1, 1100),
        zones: [],
        state: 'moving',
      })
      const [expired] = await store.expireStale(100_000)
      expect(expired?.classes).toEqual(['person', 'vehicle'])
      const persisted = await store.getPersistedByTrackId('t1')
      expect(persisted?.classes).toEqual(['person', 'vehicle'])
    })

    it('keeps the tier patch only when provided', () => {
      const t1 = store.upsert({
        trackId: 't1',
        deviceId: 4,
        className: 'person',
        timestamp: 1000,
        position: pos(0, 0, 1000),
        zones: [],
        state: 'new',
      })
      expect(t1.label).toBeUndefined()
      const t2 = store.upsert({
        trackId: 't2',
        deviceId: 4,
        className: 'person',
        labelPatch: { subLabel: 'alice', subLabelScore: 0.9 },
        timestamp: 1000,
        position: pos(0, 0, 1000),
        zones: [],
        state: 'new',
      })
      expect(t2.subLabel).toBe('alice')
    })

    describe('upsert of a CLOSED id (review M3)', () => {
      /**
       * Disarm (restored): drop the `this.closedRows.has(params.trackId)`
       * guard at the top of `upsert` — "refuses, warns, and never
       * resurrects" fails on both assertions (the row IS in `getActive`,
       * and no warning was logged).
       */
      it('refuses, warns, and never resurrects a row this store already closed', async () => {
        const recorder = makeLogRecorder()
        const local = new TrackStore({ store: fake.client, logger: recorder.logger })
        local.upsert({
          trackId: 'closed-1',
          deviceId: 9,
          className: 'person',
          timestamp: 1000,
          position: pos(0, 0, 1000),
          zones: [],
          state: 'new',
        })
        await local.expireStale(1000 + 60_000)
        expect(local.rowClosedAt('closed-1')).toBeDefined()

        // A frame queued behind pipeline latency, arriving after the close
        // (review M2's own residual edge — `canClose` makes this
        // unreachable in every MEASURED scene, not structurally).
        const late = local.upsert({
          trackId: 'closed-1',
          deviceId: 9,
          className: 'person',
          timestamp: 70_000,
          position: pos(5, 5, 70_000),
          zones: [],
          state: 'new',
        })
        // The caller still gets a normal-shaped row back — nothing
        // downstream throws on the return value...
        expect(late.trackId).toBe('closed-1')
        // ...but it was never resurrected into the live map, so the
        // persisted row (and whatever it holds) can never be overwritten.
        expect(local.getActiveByTrack('closed-1')).toBeNull()
        expect(local.getActive(9)).toEqual([])
        const warned = recorder.entries.find(
          (e) => e.level === 'warn' && e.message.includes('upsert refused'),
        )
        expect(warned?.extras).toMatchObject({
          tags: { deviceId: 9 },
          meta: { trackId: 'closed-1' },
        })
      })
    })
  })

  describe('addSnapshot', () => {
    it('attaches snapshot + updates lastSnapshotAt', () => {
      store.upsert({
        trackId: 't1',
        deviceId: 4,
        className: 'person',
        timestamp: 1000,
        position: pos(0, 0, 1000),
        zones: [],
        state: 'new',
      })
      store.addSnapshot('t1', {
        timestamp: 1500,
        position: pos(0, 0, 1500),
        mediaId: 7001,
      })
      expect(store.lastSnapshotAt('t1')).toBe(1500)
      expect(store.getActiveByTrack('t1')!.snapshots).toHaveLength(1)
    })

    it('ignores snapshots for unknown tracks', () => {
      store.addSnapshot('ghost', {
        timestamp: 1,
        position: pos(0, 0, 1),
        mediaId: 7003,
      })
      expect(store.lastSnapshotAt('ghost')).toBe(0)
    })
  })

  describe('markSnapshotPending (BUG 1 — snapshot gate clock race)', () => {
    it('synchronously advances lastSnapshotAt + bbox WITHOUT appending a snapshot', () => {
      store.upsert({
        trackId: 't1',
        deviceId: 4,
        className: 'person',
        timestamp: 1000,
        position: pos(0, 0, 1000),
        zones: [],
        state: 'new',
      })
      store.markSnapshotPending('t1', 1500, { x: 5, y: 6, w: 20, h: 40 })
      expect(store.lastSnapshotAt('t1')).toBe(1500)
      expect(store.lastSnapshotBbox('t1')).toEqual({ x: 5, y: 6, w: 20, h: 40 })
      // The real snapshots array is untouched — it fills only when the async
      // encode lands via addSnapshot.
      expect(store.getActiveByTrack('t1')!.snapshots).toHaveLength(0)
    })

    it('makes the periodic gate re-close on the NEXT frame before the async write lands', () => {
      // The race: two consecutive frames pass the gate because lastSnapshotAt
      // only advanced when the async dispatcher returned. Marking pending at
      // decision time closes the interval window immediately.
      store.upsert({
        trackId: 't1',
        deviceId: 4,
        className: 'person',
        timestamp: 10_000,
        position: pos(0, 0, 10_000),
        zones: [],
        state: 'new',
      })
      store.seedSnapshotClock('t1', 0) // unseeded → gate would open once interval passes
      store.markSnapshotPending('t1', 10_000, { x: 0, y: 0, w: 10, h: 10 })
      // A frame 40ms later (well within any interval) must now see the advanced
      // clock, so the caller's evaluatePeriodicSnapshot returns interval-not-elapsed.
      expect(store.lastSnapshotAt('t1')).toBe(10_000)
    })

    it('ignores unknown tracks (no throw, no leak)', () => {
      store.markSnapshotPending('ghost', 1, { x: 0, y: 0, w: 1, h: 1 })
      expect(store.lastSnapshotAt('ghost')).toBe(0)
    })

    it('is consistent with a later addSnapshot re-stamp of the same slot', () => {
      store.upsert({
        trackId: 't1',
        deviceId: 4,
        className: 'person',
        timestamp: 2000,
        position: pos(0, 0, 2000),
        zones: [],
        state: 'new',
      })
      store.markSnapshotPending('t1', 2500, { x: 1, y: 1, w: 10, h: 10 })
      // async encode lands → addSnapshot re-stamps the same clock/bbox + appends.
      store.addSnapshot('t1', {
        timestamp: 2500,
        position: pos(1, 1, 2500),
        mediaId: 7001,
      })
      expect(store.lastSnapshotAt('t1')).toBe(2500)
      expect(store.getActiveByTrack('t1')!.snapshots).toHaveLength(1)
    })
  })

  describe('seedSnapshotClock (§5 cadence)', () => {
    it('seeds lastSnapshotAt once at track start without appending a snapshot', () => {
      store.upsert({
        trackId: 't1',
        deviceId: 4,
        className: 'person',
        timestamp: 1000,
        position: pos(0, 0, 1000),
        zones: [],
        state: 'new',
      })
      expect(store.lastSnapshotAt('t1')).toBe(0) // unset on fresh track
      store.seedSnapshotClock('t1', 1000)
      expect(store.lastSnapshotAt('t1')).toBe(1000)
      expect(store.getActiveByTrack('t1')!.snapshots).toHaveLength(0) // no snapshot added
    })

    it('does not overwrite an already-set snapshot clock', () => {
      store.upsert({
        trackId: 't1',
        deviceId: 4,
        className: 'person',
        timestamp: 1000,
        position: pos(0, 0, 1000),
        zones: [],
        state: 'new',
      })
      store.addSnapshot('t1', { timestamp: 2000, position: pos(0, 0, 2000), mediaId: 7004 })
      store.seedSnapshotClock('t1', 9999) // must be a no-op now
      expect(store.lastSnapshotAt('t1')).toBe(2000)
    })
  })

  describe('getActive', () => {
    it('only returns tracks for the requested device', () => {
      store.upsert({
        trackId: 't1',
        deviceId: 4,
        className: 'person',
        timestamp: 1000,
        position: pos(0, 0, 1000),
        zones: [],
        state: 'new',
      })
      store.upsert({
        trackId: 't2',
        deviceId: 5,
        className: 'vehicle',
        timestamp: 1000,
        position: pos(0, 0, 1000),
        zones: [],
        state: 'new',
      })
      expect(store.getActive(4)).toHaveLength(1)
      expect(store.getActive(5)).toHaveLength(1)
      expect(store.getActive(999)).toHaveLength(0)
    })
  })

  describe('expireStale', () => {
    it('promotes stale tracks to the declared collection and returns them', async () => {
      await TrackStore.declare(fake.client)
      store.upsert({
        trackId: 't-old',
        deviceId: 4,
        className: 'person',
        timestamp: 1000,
        position: pos(0, 0, 1000),
        zones: [],
        state: 'new',
      })
      store.upsert({
        trackId: 't-fresh',
        deviceId: 4,
        className: 'person',
        timestamp: 80_000,
        position: pos(0, 0, 80_000),
        zones: [],
        state: 'new',
      })

      // Now = 100_000, default ttl = 30_000 → t-old (lastSeen=1000) is stale
      // (99s gap) but t-fresh (lastSeen=80_000, 20s gap) is not.
      const expired = await store.expireStale(100_000)
      expect(expired.map((t) => t.trackId)).toEqual(['t-old'])
      expect(store.getActiveByTrack('t-old')).toBeNull()
      expect(store.getActiveByTrack('t-fresh')?.trackId).toBe('t-fresh')

      // Persisted row lives in the declared collection.
      expect(fake.size(TRACKS_COLLECTION)).toBe(1)
    })

    it('returns empty array when nothing is stale', async () => {
      await TrackStore.declare(fake.client)
      store.upsert({
        trackId: 't1',
        deviceId: 4,
        className: 'person',
        timestamp: 1000,
        position: pos(0, 0, 1000),
        zones: [],
        state: 'new',
      })
      const expired = await store.expireStale(2000) // 1s younger than ttl
      expect(expired).toHaveLength(0)
      expect(fake.size(TRACKS_COLLECTION)).toBe(0)
    })
  })

  describe('clearDevice / clearAll', () => {
    it('clearDevice drops only that device', () => {
      store.upsert({
        trackId: 't1',
        deviceId: 4,
        className: 'person',
        timestamp: 1000,
        position: pos(0, 0, 1000),
        zones: [],
        state: 'new',
      })
      store.upsert({
        trackId: 't2',
        deviceId: 5,
        className: 'person',
        timestamp: 1000,
        position: pos(0, 0, 1000),
        zones: [],
        state: 'new',
      })
      store.clearDevice(4)
      expect(store.getActive(4)).toHaveLength(0)
      expect(store.getActive(5)).toHaveLength(1)
    })

    it('clearAll drops every device', () => {
      store.upsert({
        trackId: 't1',
        deviceId: 4,
        className: 'person',
        timestamp: 1000,
        position: pos(0, 0, 1000),
        zones: [],
        state: 'new',
      })
      store.upsert({
        trackId: 't2',
        deviceId: 5,
        className: 'person',
        timestamp: 1000,
        position: pos(0, 0, 1000),
        zones: [],
        state: 'new',
      })
      store.clearAll()
      expect(store.getActive(4)).toHaveLength(0)
      expect(store.getActive(5)).toHaveLength(0)
    })

    it('clearDevice does NOT persist the tracks (RAM-only drop)', async () => {
      await TrackStore.declare(fake.client)
      store.upsert({
        trackId: 't1',
        deviceId: 4,
        className: 'person',
        timestamp: 1000,
        position: pos(0, 0, 1000),
        zones: [],
        state: 'new',
      })
      store.clearDevice(4)
      expect(fake.size(TRACKS_COLLECTION)).toBe(0)
    })
  })

  describe('deletePersisted', () => {
    it('deletes the persisted track row', async () => {
      await TrackStore.declare(fake.client)
      store.upsert({
        trackId: 't-1',
        deviceId: 4,
        className: 'person',
        timestamp: 1000,
        position: pos(1, 1, 1000),
        zones: [],
        state: 'new',
      })
      // Expire so the completed track is persisted to the collection.
      await store.expireStale(100_000)
      expect(await store.getPersistedByTrackId('t-1')).not.toBeNull()

      await store.deletePersisted('t-1')
      expect(await store.getPersistedByTrackId('t-1')).toBeNull()
      expect(fake.size(TRACKS_COLLECTION)).toBe(0)
    })

    it('drops the in-RAM active entry when present', async () => {
      await TrackStore.declare(fake.client)
      store.upsert({
        trackId: 't-ram',
        deviceId: 4,
        className: 'person',
        timestamp: 1000,
        position: pos(0, 0, 1000),
        zones: [],
        state: 'new',
      })
      expect(store.getActiveByTrack('t-ram')?.trackId).toBe('t-ram')

      await store.deletePersisted('t-ram')
      expect(store.getActiveByTrack('t-ram')).toBeNull()
    })
  })

  // ── Task 5 / 4g: the tiered write ──────────────────────────────────
  describe('applyLabelCandidate', () => {
    const identity = {
      text: 'Alice',
      tier: 2 as const,
      score: 0.9,
      stepId: 'face-recognizer',
      decidedAt: 1,
    }

    it('sets the tier-2 label on an active track and persists it', async () => {
      await TrackStore.declare(fake.client)
      store.upsert({
        trackId: 'tA',
        deviceId: 4,
        className: 'person',
        timestamp: 1000,
        position: pos(1, 1, 1000),
        zones: [],
        state: 'new',
      })
      // Expire the track so it is persisted, then offer the candidate. The
      // rule reads the PERSISTED row when the track is no longer active — an
      // enrichment answer routinely lands after expiry.
      await store.expireStale(100_000)
      await store.applyLabelCandidate('tA', identity)
      const rows = await store.queryHistorical({ deviceId: 4 })
      const tA = rows.find((t) => t.trackId === 'tA')
      expect(tA?.subLabel).toBe('Alice')
      expect(tA?.subLabelScore).toBe(0.9)
      expect(tA?.subLabelMeta?.stepId).toBe('face-recognizer')
    })

    it('sets the label on an active (not yet persisted) track', async () => {
      await TrackStore.declare(fake.client)
      store.upsert({
        trackId: 'tB',
        deviceId: 4,
        className: 'person',
        timestamp: 1000,
        position: pos(0, 0, 1000),
        zones: [],
        state: 'new',
      })
      await store.applyLabelCandidate('tB', { ...identity, text: 'Bob' })
      // The in-memory track should carry the tier-2 value.
      const active = store.getActiveByTrack('tB')
      expect(active?.subLabel).toBe('Bob')
    })
  })

  describe('queryHistorical', () => {
    it('reads from the declared collection filtered by deviceId + time range', async () => {
      await TrackStore.declare(fake.client)
      fake.seed(TRACKS_COLLECTION, [
        {
          id: 't-old',
          data: {
            deviceId: 4,
            className: 'person',
            firstSeen: 1000,
            lastSeen: 1500,
            positions: [],
            snapshots: [],
            zonesVisited: [],
            totalDistance: 0,
            state: 'idle',
          },
        },
        {
          id: 't-other-dev',
          data: {
            deviceId: 99,
            className: 'person',
            firstSeen: 1200,
            lastSeen: 1300,
            positions: [],
            snapshots: [],
            zonesVisited: [],
            totalDistance: 0,
            state: 'idle',
          },
        },
        {
          id: 't-newer',
          data: {
            deviceId: 4,
            className: 'vehicle',
            firstSeen: 3000,
            lastSeen: 3500,
            positions: [],
            snapshots: [],
            zonesVisited: [],
            totalDistance: 0,
            state: 'idle',
          },
        },
      ])
      const all = await store.queryHistorical({ deviceId: 4 })
      expect(all.map((t) => t.trackId).toSorted()).toEqual(['t-newer', 't-old'])
      // Default ordering: firstSeen desc.
      expect(all[0]!.trackId).toBe('t-newer')
    })

    it('getPersistedByTrackId returns a single record or null', async () => {
      await TrackStore.declare(fake.client)
      fake.seed(TRACKS_COLLECTION, [
        {
          id: 't1',
          data: {
            deviceId: 4,
            className: 'person',
            firstSeen: 1000,
            lastSeen: 1500,
            positions: [],
            snapshots: [],
            zonesVisited: [],
            totalDistance: 0,
            state: 'idle',
          },
        },
      ])
      expect((await store.getPersistedByTrackId('t1'))?.trackId).toBe('t1')
      expect(await store.getPersistedByTrackId('missing')).toBeNull()
    })
  })

  describe('addAudioLabelEpisode (track-level audio context)', () => {
    const seed = (trackId: string, deviceId: number): void => {
      store.upsert({
        trackId,
        deviceId,
        className: 'person',
        timestamp: 1000,
        position: pos(10, 20, 1000),
        zones: [],
        state: 'new',
      })
    }

    it('aggregates episodes per label with peak score, count and time bounds', () => {
      seed('t1', 4)
      store.addAudioLabelEpisode(4, 'speech', 0.6, 2000)
      store.addAudioLabelEpisode(4, 'speech', 0.9, 3000)
      store.addAudioLabelEpisode(4, 'dog_bark', 0.7, 3500)

      const t = store.getActiveByTrack('t1')
      expect(t?.audioLabels).toEqual([
        { label: 'speech', peakScore: 0.9, count: 2, firstAt: 2000, lastAt: 3000 },
        { label: 'dog_bark', peakScore: 0.7, count: 1, firstAt: 3500, lastAt: 3500 },
      ])
    })

    it('stamps every active track on the device, never other devices', () => {
      seed('t1', 4)
      seed('t2', 4)
      seed('other-cam', 9)
      store.addAudioLabelEpisode(4, 'speech', 0.8, 2000)

      expect(store.getActiveByTrack('t1')?.audioLabels).toHaveLength(1)
      expect(store.getActiveByTrack('t2')?.audioLabels).toHaveLength(1)
      expect(store.getActiveByTrack('other-cam')?.audioLabels).toBeUndefined()
    })

    it('omits audioLabels entirely when no episode was heard', () => {
      seed('t1', 4)
      expect(store.getActiveByTrack('t1')?.audioLabels).toBeUndefined()
    })

    it('carries audioLabels into the persisted record and reads them back', async () => {
      await TrackStore.declare(fake.client)
      seed('t1', 4)
      store.addAudioLabelEpisode(4, 'speech', 0.8, 2000)

      const expired = await store.expireStale(1000 + 30_000 + 1)
      expect(expired[0]?.audioLabels).toEqual([
        { label: 'speech', peakScore: 0.8, count: 1, firstAt: 2000, lastAt: 2000 },
      ])

      const persisted = await store.getPersistedByTrackId('t1')
      expect(persisted?.audioLabels).toEqual([
        { label: 'speech', peakScore: 0.8, count: 1, firstAt: 2000, lastAt: 2000 },
      ])
    })
  })
})
