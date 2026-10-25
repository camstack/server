/**
 * The audio level bar is read from device-history (D431 follow-up): the bucket
 * level is the PEAK, level-only buckets are emitted, and a failed history read
 * falls back to the audio events and says so once per camera.
 */
import { describe, it, expect, vi } from 'vitest'
import { eventStoreLedgers, makeAnalyticsRecords } from '../../__tests__/fake-records.js'
import {
  makeFakeSettingsStore,
  makeSilentLogger,
  seedTracklessEvents,
} from '../../__tests__/test-helpers.js'
import {
  EventStore,
  AUDIO_EVENTS_COLLECTION,
  type AudioLevelHistoryReader,
} from '../event-store.js'
import { AnalyticsQueryFacade } from '../../analytics-query-facade.js'
import { ANALYTICS_AUDIO_LEVEL_KEY } from '../analytics-history-keys.js'

const DEVICE = 7
const NOW = 10_000_000_000
const SINCE = NOW - 3_600_000
const BUCKET = 60_000
const UNTIL = SINCE + 3 * BUCKET

function reader(points: ReadonlyArray<{ t: number; max: number }>) {
  return vi.fn<AudioLevelHistoryReader>(async () => ({ series: [{ scope: '', points }] }))
}

async function build(history: AudioLevelHistoryReader) {
  const fake = makeFakeSettingsStore()
  const world = await makeAnalyticsRecords()
  const warn = vi.fn()
  const logger = { ...makeSilentLogger(), warn, child: () => logger }
  const store = new EventStore({
    store: fake.client,
    logger,
    audioLevelHistory: history,
    now: () => NOW,
    ...eventStoreLedgers(world.records),
  })
  await EventStore.declareObjectCollection(fake.client)
  return { store, world, warn }
}

const q = { deviceId: DEVICE, since: SINCE, until: UNTIL, bucketMs: BUCKET }

describe('densityByKind audio level from device-history', () => {
  it('emits level-only buckets with the bucket PEAK (counts 0)', async () => {
    const h = reader([
      { t: SINCE + 1_000, max: -50 },
      { t: SINCE + 12_000, max: -20 },
      { t: SINCE + BUCKET + 5_000, max: -40 },
    ])
    const { store } = await build(h)
    const out = await store.densityByKind(q)
    expect(out).toEqual([
      { bucketStart: SINCE, motion: 0, object: 0, audio: 0, audioDbfs: -20 },
      { bucketStart: SINCE + BUCKET, motion: 0, object: 0, audio: 0, audioDbfs: -40 },
    ])
    expect(h).toHaveBeenCalledTimes(1)
    expect(h.mock.calls[0]?.[0]).toMatchObject({
      deviceId: DEVICE,
      key: ANALYTICS_AUDIO_LEVEL_KEY,
      resolution: 'raw',
    })
  })

  it('omits audioDbfs for a bucket with no history point', async () => {
    const { store, world } = await build(reader([{ t: SINCE + 1_000, max: -30 }]))
    seedTracklessEvents(world, AUDIO_EVENTS_COLLECTION, [])
    const out = await store.densityByKind(q)
    expect(out.map((b) => b.bucketStart)).toEqual([SINCE])
  })

  it('uses the 5m tier for big buckets and 1h beyond rollup retention', async () => {
    const h = reader([])
    const { store } = await build(h)
    await store.densityByKind({ ...q, bucketMs: 900_000, until: SINCE + 1_800_000 })
    expect(h.mock.calls[0]?.[0]).toMatchObject({ resolution: '5m' })
    await store.densityByKind({
      deviceId: DEVICE,
      since: NOW - 30 * 86_400_000,
      until: NOW,
      bucketMs: 3_600_000,
    })
    expect(h.mock.calls[1]?.[0]).toMatchObject({ resolution: '1h' })
  })

  it('falls back to the events and logs once per camera when the read fails', async () => {
    const h = vi.fn<AudioLevelHistoryReader>(async () => {
      throw new Error('boom')
    })
    const { store, world, warn } = await build(h)
    seedTracklessEvents(world, AUDIO_EVENTS_COLLECTION, [
      { id: 'a1', data: { deviceId: DEVICE, timestamp: SINCE + 1_000, rms: 0.1, dbfs: -25 } },
    ])
    const out = await store.densityByKind(q)
    expect(out).toHaveLength(1)
    expect(out[0]?.audioDbfs).toBeCloseTo(-25, 5)
    await store.densityByKind(q)
    const tagged = warn.mock.calls.filter((c) => c[1]?.tags?.deviceId === DEVICE)
    expect(tagged).toHaveLength(1)
  })

  it('a batch issues ONE history query per device, not one per bucket', async () => {
    const h = reader([{ t: SINCE + 1_000, max: -30 }])
    const { store } = await build(h)
    const logger = makeSilentLogger()
    const facade = new AnalyticsQueryFacade({
      trackStore: () => null,
      eventStore: () => store,
      mediaStore: () => null,
      sensorEventStore: () => null,
      opsLog: () => null,
      eventMediaBaseUrl: () => null,
      eventMediaPathPrefix: () => '/x',
      logger: () => logger,
    })
    const rows = await facade.getEventDensityBatch({
      deviceIds: [1, 2],
      since: SINCE,
      until: UNTIL,
      bucketMs: 10_000,
    })
    expect(rows.every((r) => r.read === 'read' && r.buckets.length > 0)).toBe(true)
    expect(h).toHaveBeenCalledTimes(2)
    expect(h.mock.calls.map((c) => c[0].deviceId).sort()).toEqual([1, 2])
  })
})
