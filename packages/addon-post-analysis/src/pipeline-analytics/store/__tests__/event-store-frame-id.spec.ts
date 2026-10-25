/**
 * `ObjectEvent.frameId` — the SCENE key, and whether it survives a write.
 *
 * The cap has documented `frameId` since the collection existed ("lets a
 * consumer group co-occurring detections (e.g. 2 people + 1 dog) under one full
 * frame"), `frame-processor` stamps it on every event of a frame, and
 * `slimObject` reads it back. There was no COLUMN for it, and the sqlite
 * backend drops an undeclared key WITHOUT ERROR — `if (decl.columns.has(k))`.
 * So every read was `undefined` and the whole scene relation was, in practice,
 * write-only. A leftover that describes the right design reads as verification
 * of it; this file is the verification.
 *
 * `enforceDeclaredColumns` is the neutralisation and the reason these tests are
 * worth having: the default fake is a permissive bag that would return a value
 * production wrote into the void — which is exactly how this survived. Delete
 * the column from `OBJECT_COLUMNS` and every test below fails.
 */

import {
  eventStoreLedgers,
  type FakeRecords,
  makeAnalyticsRecords,
} from '../../__tests__/fake-records.js'
import { beforeEach, describe, expect, it } from 'vitest'
import type { ObjectEvent } from '@camstack/types'
import {
  type FakeSettingsStore,
  makeFakeSettingsStore,
  makeSilentLogger,
} from '../../__tests__/test-helpers.js'
import { EventStore, OBJECT_COLUMNS } from '../event-store.js'

const DEVICE_ID = 101

let objectEventIdSeq = 90_000
function nextObjectEventId(): number {
  objectEventIdSeq += 1
  return objectEventIdSeq
}

function objectEvent(over: Partial<ObjectEvent> = {}): ObjectEvent {
  return {
    id: nextObjectEventId(),
    kind: 'object',
    deviceId: DEVICE_ID,
    timestamp: 1_700_000_000_000,
    trackId: 'track-a',
    className: 'person',
    confidence: 0.91,
    bbox: { x: 1, y: 2, w: 3, h: 4 },
    zones: [],
    state: 'moving',
    frameId: 'frame-XYZ',
    ...over,
  }
}

describe('ObjectEvent.frameId is a declared column', () => {
  let fake: FakeSettingsStore
  let world: FakeRecords
  let events: EventStore

  beforeEach(async () => {
    fake = makeFakeSettingsStore({ enforceDeclaredColumns: true })
    world = await makeAnalyticsRecords()
    events = new EventStore({
      store: fake.client,
      logger: makeSilentLogger(),
      ...eventStoreLedgers(world.records),
    })
    await EventStore.declareObjectCollection(fake.client)
  })

  it('declares frameId on the object-events collection', () => {
    expect(OBJECT_COLUMNS.map((c) => c.name)).toContain('frameId')
  })

  it('round-trips frameId through a backend that drops undeclared keys', async () => {
    await events.insertObject(objectEvent())
    const rows = await events.queryObject({ deviceId: DEVICE_ID })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.frameId).toBe('frame-XYZ')
  })

  it('answers "which detections shared a frame" — the relation the key exists for', async () => {
    await events.insertObject(objectEvent({ trackId: 't-a', frameId: 'frame-1' }))
    await events.insertObject(objectEvent({ trackId: 't-b', frameId: 'frame-1' }))
    await events.insertObject(objectEvent({ trackId: 't-c', frameId: 'frame-2' }))

    const rows = await events.queryObject({ deviceId: DEVICE_ID, projection: 'slim' })
    const byFrame = new Map<string, string[]>()
    for (const r of rows) {
      const key = r.frameId ?? '∅'
      byFrame.set(key, [...(byFrame.get(key) ?? []), r.trackId ?? '∅'])
    }
    // Two tracks under ONE scene, and a third under its own.
    expect(byFrame.get('frame-1')?.toSorted()).toEqual(['t-a', 't-b'])
    expect(byFrame.get('frame-2')).toEqual(['t-c'])
  })

  it('leaves frameId absent when the producer stamped none', async () => {
    const { frameId: _dropped, ...noFrame } = objectEvent()
    await events.insertObject(noFrame)
    const rows = await events.queryObject({ deviceId: DEVICE_ID })
    expect(rows[0]?.frameId).toBeUndefined()
  })
})
