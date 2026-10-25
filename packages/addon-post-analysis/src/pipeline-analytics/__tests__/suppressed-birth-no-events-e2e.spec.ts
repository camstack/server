/**
 * A suppressed birth never emits an object event — end to end through the
 * booted addon.
 *
 * Production, device 101, 2026-10-21 14:40:48Z: the confirmation gate
 * suppressed track qe6kng8wn4's birth, so it owned no media — yet on the frame
 * the tracker LOST it, its `leaving` events (616758/616759) were persisted and
 * reached the notification center, which fired a person rule for an animal.
 *
 * The frame path dropped a rejected id's events only when the id was still in
 * `result.tracked`, and it forgot the rejection (`suppressedBirths.retain`) in
 * the same frame the tracker stopped carrying it. A `leaving` event fires for
 * an id that is ABSENT from `tracked` by definition, so it was never filtered.
 *
 * Invariant pinned here: no object event of a suppressed track is ever
 * inserted — while it is carried, on the frame it is lost, or later.
 */

import type {
  FrameHandle,
  FrameResult,
  IEventBus,
  ObjectDetection,
  PipelineInferenceResultPayload,
} from '@camstack/types'
import { createEvent, EventCategory } from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CONFIRMATION_CROP_MAX_WIDTH } from '../index.js'
import { EventStore } from '../store/event-store.js'
import { ZoneAnalyticsProvider } from '../zone-analytics-provider.js'
import { type Booted, bootAnalytics } from './boot-analytics.js'
import {
  type FakeNativeCropRequest,
  type FakeRedetectResult,
  isFullFrameRequest,
  makeFakePipelineExecutor,
  FAKE_SESSION_ROOT,
} from './test-helpers.js'

const DEVICE_ID = 101
const HANDLE: FrameHandle = {
  shmId: 'ring-101',
  slot: 0,
  seq: 2,
  width: 640,
  height: 480,
  format: 'rgb',
  pts: 1,
  byteLength: 640 * 480 * 3,
  nodeId: 'hub',
  slotCount: 8,
}
const CROP_JPEG_BASE64 = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64')

const PHANTOM: ObjectDetection = {
  id: 'a0',
  kind: 'first-level',
  macroClass: 'person',
  score: 0.9,
  labels: [],
  bbox: { x: 300, y: 300, width: 90, height: 70 },
}

/** The gate's second look finds nothing compatible: the birth is a phantom. */
const NOTHING_THERE: FakeRedetectResult = { width: 320, height: 320, detections: [] }

function buildFrame(timestamp: number, detections: readonly ObjectDetection[]): FrameResult {
  return {
    kind: 'frame',
    // The session detector the gate re-judges with (D925).
    ...FAKE_SESSION_ROOT,
    frameId: `f-${timestamp}`,
    deviceId: DEVICE_ID,
    timestamp,
    width: 640,
    height: 480,
    detections,
  }
}

function emitInference(bus: IEventBus, frame: FrameResult): void {
  const payload: PipelineInferenceResultPayload = {
    deviceId: DEVICE_ID,
    frame,
    nodeId: 'hub',
    frameHandle: HANDLE,
  }
  bus.emit(
    createEvent(
      EventCategory.PipelineInferenceResult,
      { type: 'addon', id: 'pipeline-runner' },
      payload,
    ),
  )
}

async function flush(stepMs: number): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, stepMs))
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
}

function isConfirmationCropRequest(request: FakeNativeCropRequest): boolean {
  return !isFullFrameRequest(request) && request.maxWidth === CONFIRMATION_CROP_MAX_WIDTH
}

function eventStoreOf(booted: Booted): EventStore {
  const store = Reflect.get(booted.addon, 'eventStore')
  if (!(store instanceof EventStore)) throw new Error('no event store')
  return store
}

function suppressedTrackIds(booted: Booted): readonly string[] {
  const ids: string[] = []
  for (const line of booted.logs) {
    if (line.message !== 'birth suppressed — track record retracted') continue
    const meta: unknown = Reflect.get(Object(line.extras), 'meta')
    const trackId: unknown = Reflect.get(Object(meta), 'trackId')
    if (typeof trackId === 'string') ids.push(trackId)
  }
  return ids
}

describe('a suppressed birth never emits an object event', () => {
  let booted: Booted | undefined

  afterEach(async () => {
    await flush(1)
    if (booted) await booted.addon.shutdown()
    booted = undefined
  })

  it('no event of the suppressed track is persisted — while carried, when lost, or later', async () => {
    const { executor } = makeFakePipelineExecutor(() => NOTHING_THERE)
    booted = await bootAnalytics(
      DEVICE_ID,
      async (request) => {
        if (!isConfirmationCropRequest(request)) return null
        return { jpeg: CROP_JPEG_BASE64, width: 320, height: 320, tier: 'native' as const }
      },
      { pipelineExecutor: executor },
    )
    const insertObject = vi.spyOn(eventStoreOf(booted), 'insertObject')
    // Zone OCCUPANCY is the other zone surface a rule reads: a rejected id must
    // not be counted on any frame after its rejection.
    const zoneAnalytics = Reflect.get(booted.addon, 'zoneAnalytics')
    if (!(zoneAnalytics instanceof ZoneAnalyticsProvider)) throw new Error('no zone analytics')
    const countedWhileRejected: string[] = []
    const live = booted
    const recordFrame = zoneAnalytics.recordFrame.bind(zoneAnalytics)
    vi.spyOn(zoneAnalytics, 'recordFrame').mockImplementation((input) => {
      // Ids already rejected when this frame reached occupancy.
      const rejected = new Set(suppressedTrackIds(live))
      for (const t of input.tracked) {
        if (rejected.has(t.trackId)) countedWhileRejected.push(t.trackId)
      }
      return recordFrame(input)
    })

    // The phantom is carried for a while, then the subject goes away: the
    // tracker loses the id and later frames pass with nothing in them.
    for (let i = 0; i < 30; i += 1) {
      emitInference(booted.bus.bus, buildFrame(1_000 + i * 200, [{ ...PHANTOM, id: `a${i}` }]))
      await flush(5)
    }
    for (let i = 0; i < 10; i += 1) {
      emitInference(booted.bus.bus, buildFrame(8_000 + i * 2_000, []))
      await flush(5)
    }

    const suppressed = suppressedTrackIds(booted)
    expect(suppressed, 'the gate rejected the birth').toHaveLength(1)
    const inserted = insertObject.mock.calls.map(([draft]) => draft.trackId)
    expect(inserted, 'no object event of the suppressed track was persisted').not.toContain(
      suppressed[0],
    )
    expect(countedWhileRejected, 'a rejected birth never counts toward zone occupancy').toEqual([])
    const dropped = booted.logs.filter(
      (line) => line.message === 'object event dropped — the track birth was suppressed',
    )
    expect(dropped.length, 'the dropped event is said out loud').toBeGreaterThan(0)
    expect(dropped[0]?.extras).toMatchObject({
      tags: { deviceId: DEVICE_ID },
      meta: { trackId: suppressed[0], reason: 'birth-suppressed' },
    })
  }, 30_000)
})
