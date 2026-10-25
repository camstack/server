/**
 * R4 (D779): pipeline tracks in, `ObjectDetection` events out — one per track
 * and class, person/package only, never twice for one object inside 30 s, and
 * only for the classes the camera reports (declared ∩ chosen in the app).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SmartVisionClass } from '../endpoints/builder.js'
import {
  CAMERA_EVENT_MIN_INTERVAL_MS,
  OBJECT_EVENT_MIN_INTERVAL_MS,
  ObjectDetectionFeed,
  type VisionDetection,
} from '../vision/object-detection-feed.js'
import { eventIdentifierFor, isUuid, objectIdentifierFor } from '../vision/vision-ids.js'
import { quietLogger } from './helpers/fake-device-api.js'

const NS = '6f1c2a54-1d0e-4c8b-9a52-0c3f7d2e9b11'

function harness(classes: readonly SmartVisionClass[] = ['person', 'package']) {
  const posted: Array<{ deviceId: number; detection: VisionDetection }> = []
  const remembered: string[] = []
  let now = 1_700_000_000_000
  const feed = new ObjectDetectionFeed({
    eventBus: { subscribe: () => () => {} } as never,
    reportableClasses: async () => classes,
    namespace: () => NS,
    post: async (deviceId, detection) => {
      posted.push({ deviceId, detection })
    },
    remember: async (_d, entry) => {
      remembered.push(entry.e)
    },
    logger: quietLogger,
    now: () => now,
  })
  return {
    feed,
    posted,
    remembered,
    advance: (ms: number) => {
      now += ms
    },
    track: async (
      trackId: string,
      phase: 'start' | 'update' | 'end',
      bestClassName: string,
      deviceId = 7,
    ) => {
      await feed.onTrackLifecycle({ deviceId, trackId, phase, bestClassName })
    },
  }
}

beforeEach(() => vi.useRealTimers())
afterEach(() => vi.useRealTimers())

describe('ObjectDetectionFeed', () => {
  it('a person track posts ONE event with track-derived ids', async () => {
    const h = harness()
    await h.track('t1', 'start', 'person')
    await h.track('t1', 'update', 'person')
    await h.track('t1', 'update', 'person')
    expect(h.posted).toHaveLength(1)
    const d = h.posted[0]!.detection
    expect(d.imageNetClass).toBe('person')
    expect(d.objectIdentifier).toBe(objectIdentifierFor(NS, 7, 't1'))
    expect(d.eventIdentifier).toBe(eventIdentifierFor(NS, 7, 't1', 'person'))
    expect(isUuid(d.eventIdentifier)).toBe(true)
    // version-4 nibble
    expect(d.eventIdentifier[14]).toBe('4')
    expect(d.objectIdentifier[14]).toBe('4')
    expect(h.remembered).toEqual([d.eventIdentifier])
  })

  it('vehicles and animals are not Amazon classes — nothing is posted', async () => {
    const h = harness()
    await h.track('car', 'start', 'car')
    await h.track('dog', 'start', 'dog')
    expect(h.posted).toEqual([])
  })

  it('a package track posts a package event', async () => {
    const h = harness()
    await h.track('p', 'start', 'package')
    expect(h.posted.map((p) => p.detection.imageNetClass)).toEqual(['package'])
  })

  it('a class the camera does not report is not posted', async () => {
    const h = harness(['person'])
    await h.track('p', 'start', 'package')
    expect(h.posted).toEqual([])
  })

  it('switched off (no reportable class) posts nothing', async () => {
    const h = harness([])
    await h.track('t1', 'start', 'person')
    expect(h.posted).toEqual([])
  })

  it('the same object is never reported twice inside 30 s', async () => {
    const h = harness()
    await h.track('t1', 'start', 'person')
    // the track is re-classified: same object, new class
    await h.track('t1', 'update', 'package')
    expect(h.posted).toHaveLength(1)
    h.advance(OBJECT_EVENT_MIN_INTERVAL_MS)
    await h.track('t1', 'update', 'package')
    expect(h.posted.map((p) => p.detection.imageNetClass)).toEqual(['person', 'package'])
  })

  it('two different tracks are two objects', async () => {
    const h = harness()
    await h.track('a', 'start', 'person')
    h.advance(CAMERA_EVENT_MIN_INTERVAL_MS)
    await h.track('b', 'start', 'person')
    expect(new Set(h.posted.map((p) => p.detection.objectIdentifier)).size).toBe(2)
  })

  it('a track that ends and never re-appears frees its bookkeeping', async () => {
    const h = harness()
    await h.track('t1', 'start', 'person')
    await h.track('t1', 'end', 'person')
    expect(h.feed.trackedCount()).toBe(0)
  })
})
