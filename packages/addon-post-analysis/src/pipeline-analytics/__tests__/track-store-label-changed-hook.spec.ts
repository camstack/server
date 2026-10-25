/**
 * D692: the TrackStore tells the notification centre — synchronously, on an ACTIVE
 * track — that a label changed: an accepted tier write or a D665 retraction. A grouped
 * window learns the name in the same tick the track does; a closed track never fires
 * the hook (its close carries the label).
 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { SettingsStoreClient } from '@camstack/types'
import { TrackStore, type TrackLabelChanged, type TrackPosition } from '../store/track-store.js'
import { type FakeSettingsStore, makeFakeSettingsStore, makeSilentLogger } from './test-helpers.js'

const IDENTITY = {
  text: 'Person A',
  tier: 2 as const,
  score: 0.9,
  stepId: 'face-recognizer',
  decidedAt: 1,
  identityId: 'id-a',
}

function pos(x: number, y: number, timestamp: number): TrackPosition {
  return { x, y, timestamp, bbox: { x, y, w: 10, h: 20 } }
}

describe('TrackStore label-changed hook (D692)', () => {
  let fake: FakeSettingsStore
  let calls: TrackLabelChanged[]
  let store: TrackStore
  let throwing: boolean

  beforeEach(async () => {
    fake = makeFakeSettingsStore()
    calls = []
    throwing = false
    store = new TrackStore({
      store: fake.client,
      logger: makeSilentLogger(),
      onLabelChanged: (c) => {
        if (throwing) throw new Error('hook down')
        calls.push(c)
      },
    })
    await TrackStore.declare(fake.client)
    store.upsert({
      trackId: 'tA',
      deviceId: 101,
      className: 'person',
      timestamp: 1000,
      position: pos(1, 1, 1000),
      zones: [],
      state: 'new',
    })
  })

  it('an accepted write on an ACTIVE track is reported once, with the tiers after the write', async () => {
    const decision = await store.applyLabelCandidate('tA', IDENTITY)
    expect(decision?.kind).toBe('write')
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ deviceId: 101, trackId: 'tA', change: 'accepted' })
    expect(calls[0]?.tiers.subLabel).toBe('Person A')
    expect(calls[0]?.tiers.subLabelMeta?.identityId).toBe('id-a')
  })

  it('a REFUSED candidate (weaker, same tier) does not report', async () => {
    await store.applyLabelCandidate('tA', IDENTITY)
    calls.length = 0
    const weaker = await store.applyLabelCandidate('tA', {
      ...IDENTITY,
      text: 'Person B',
      score: 0.1,
      identityId: 'id-b',
    })
    expect(weaker?.kind).not.toBe('write')
    expect(calls).toHaveLength(0)
  })

  it('a write on a persisted-only (closed) track does not report', async () => {
    await store.expireStale(100_000)
    const decision = await store.applyLabelCandidate('tA', IDENTITY)
    expect(decision?.kind).toBe('write')
    expect(calls).toHaveLength(0)
  })

  it('a hook that throws never fails the write', async () => {
    throwing = true
    const decision = await store.applyLabelCandidate('tA', IDENTITY)
    expect(decision?.kind).toBe('write')
    expect(store.getActiveByTrack('tA')?.subLabel).toBe('Person A')
  })

  it('a retraction (clearLabel, D665) on an ACTIVE track reports the cleared tiers', async () => {
    await store.applyLabelCandidate('tA', IDENTITY)
    calls.length = 0
    await store.clearLabel('tA', 2)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ trackId: 'tA', change: 'cleared' })
    expect(calls[0]?.tiers.subLabel).toBeUndefined()
    expect(calls[0]?.tiers.subLabelMeta).toBeUndefined()
  })

  it('the hook fires in the SAME tick as the RAM write — before the durable patch settles', async () => {
    // A store whose patch never resolves: the hook must already have fired.
    const hung: SettingsStoreClient = {
      ...fake.client,
      update: { mutate: () => new Promise<never>(() => {}) },
    }
    const seen: TrackLabelChanged[] = []
    const slow = new TrackStore({
      store: hung,
      logger: makeSilentLogger(),
      onLabelChanged: (c) => seen.push(c),
    })
    slow.upsert({
      trackId: 'tS',
      deviceId: 101,
      className: 'person',
      timestamp: 1000,
      position: pos(1, 1, 1000),
      zones: [],
      state: 'new',
    })
    let settled = false
    void slow.applyLabelCandidate('tS', IDENTITY).then(() => {
      settled = true
    })
    await new Promise<void>((r) => setImmediate(r))
    expect(settled).toBe(false)
    expect(seen.map((c) => c.change)).toEqual(['accepted'])
    void slow.clearLabel('tS', 2)
    await new Promise<void>((r) => setImmediate(r))
    expect(seen.map((c) => c.change)).toEqual(['accepted', 'cleared'])
  })
})
