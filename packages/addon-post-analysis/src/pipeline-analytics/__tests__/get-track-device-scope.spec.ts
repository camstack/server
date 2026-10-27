/**
 * `getTrack` is answered for the device the CALLER named.
 *
 * The events share link gates `pipelineAnalytics.getTrack` on `input.deviceId`
 * being inside the link's scope. That is only a gate if the provider honours
 * the id: a lookup by `trackId` alone would let a link for camera A read
 * camera B's track by passing A's id.
 */
import { describe, expect, it } from 'vitest'
import { AnalyticsQueryFacade } from '../analytics-query-facade.js'
import { TrackStore, type TrackPosition } from '../store/track-store.js'
import { makeFakeSettingsStore, makeSilentLogger } from './test-helpers.js'

function pos(timestamp: number): TrackPosition {
  return { x: 0, y: 0, timestamp, bbox: { x: 0, y: 0, w: 10, h: 10 } }
}

async function seeded(): Promise<AnalyticsQueryFacade> {
  const fake = makeFakeSettingsStore()
  const trackStore = new TrackStore({ store: fake.client, logger: makeSilentLogger() })
  await TrackStore.declare(fake.client)
  for (const [trackId, deviceId] of [
    ['persisted-b', 7],
    ['persisted-a', 5],
  ] as const) {
    trackStore.upsert({
      trackId,
      deviceId,
      className: 'person',
      timestamp: 1000,
      position: pos(1000),
      zones: [],
      state: 'new',
    })
  }
  await trackStore.expireStale(100_000)
  trackStore.upsert({
    trackId: 'active-b',
    deviceId: 7,
    className: 'person',
    timestamp: 200_000,
    position: pos(200_000),
    zones: [],
    state: 'new',
  })
  const logger = makeSilentLogger()
  return new AnalyticsQueryFacade({
    trackStore: () => trackStore,
    eventStore: () => null,
    mediaStore: () => null,
    sensorEventStore: () => null,
    opsLog: () => null,
    eventMediaBaseUrl: () => null,
    eventMediaPathPrefix: () => '/addon/pipeline-analytics/event-media',
    logger: () => logger,
  })
}

describe('AnalyticsQueryFacade.getTrack — device scope', () => {
  it('returns a persisted track for its own device', async () => {
    const facade = await seeded()
    expect((await facade.getTrack({ deviceId: 5, trackId: 'persisted-a' }))?.deviceId).toBe(5)
  })

  it('returns null for a persisted track of ANOTHER device', async () => {
    const facade = await seeded()
    expect(await facade.getTrack({ deviceId: 5, trackId: 'persisted-b' })).toBeNull()
  })

  it('returns null for an ACTIVE track of another device', async () => {
    const facade = await seeded()
    expect(await facade.getTrack({ deviceId: 5, trackId: 'active-b' })).toBeNull()
  })

  it('returns an active track for its own device', async () => {
    const facade = await seeded()
    expect((await facade.getTrack({ deviceId: 7, trackId: 'active-b' }))?.deviceId).toBe(7)
  })
})
