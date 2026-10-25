/**
 * A suppressed birth leaves no resident behind — end to end through the booted
 * addon (the second resident leak, follow-up to the `closedIds` tombstone).
 *
 * The gate rejects a birth → `residents.close(id, 'prune')` writes a tombstone.
 * The tracker keeps carrying the id for as long as the phantom persists, and
 * later per-frame work (best frame, confirmation, last-frame stamp) used to
 * re-create the resident: `observeBestFrame` called `open()`, which erased the
 * tombstone. The id was never in the TrackStore, so no sweep ever closed it.
 * ~250 leaked residents a day on one hub runner.
 *
 * Invariant pinned here: every track ended and every window passed ⇒ zero
 * residents.
 */

import type {
  FrameHandle,
  FrameResult,
  IEventBus,
  ObjectDetection,
  PipelineInferenceResultPayload,
} from '@camstack/types'
import { createEvent, EventCategory } from '@camstack/types'
import { afterEach, describe, expect, it } from 'vitest'
import { CONFIRMATION_CROP_MAX_WIDTH } from '../index.js'
import { TrackResidentState } from '../pipeline/track-resident-state.js'
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
/** The frame (0-based) on which the tracker first offers the phantom for birth. */
const BIRTH_FRAME = 2
const CROP_JPEG_BASE64 = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64')

const PHANTOM: ObjectDetection = {
  id: 'a0',
  kind: 'first-level',
  macroClass: 'animal',
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

function residentsOf(booted: Booted): TrackResidentState {
  const residents = Reflect.get(booted.addon, 'residents')
  if (!(residents instanceof TrackResidentState)) throw new Error('no residents')
  return residents
}

describe('a suppressed birth leaves no resident behind', () => {
  let booted: Booted | undefined

  afterEach(async () => {
    await flush(1)
    if (booted) await booted.addon.shutdown()
    booted = undefined
  })

  it('residents are zero once the tracker drops a phantom it carried for N frames', async () => {
    const { executor } = makeFakePipelineExecutor(() => NOTHING_THERE)
    booted = await bootAnalytics(
      DEVICE_ID,
      async (request) => {
        if (!isConfirmationCropRequest(request)) return null
        return { jpeg: CROP_JPEG_BASE64, width: 320, height: 320, tier: 'native' as const }
      },
      { pipelineExecutor: executor },
    )

    // The phantom is detected frame after frame; the tracker keeps its id.
    for (let i = 0; i < 12; i += 1) {
      emitInference(booted.bus.bus, buildFrame(1_000 + i * 100, [{ ...PHANTOM, id: `a${i}` }]))
      await flush(5)
    }
    const messages = booted.logs.map((line) => line.message)
    expect(messages, 'the gate rejected the birth').toContain(
      'birth suppressed — track record retracted',
    )
    expect(messages, 'no track ever started').not.toContain('track started')
    // While the tracker still carries the id, nothing may re-create it.
    expect(residentsOf(booted).size()).toBe(0)

    // The subject goes away; the tracker lets the id go and windows pass.
    for (let i = 0; i < 6; i += 1) {
      emitInference(booted.bus.bus, buildFrame(60_000 + i * 5_000, []))
      await flush(5)
    }
    expect(residentsOf(booted).size()).toBe(0)
    expect(booted.addon.orphanResidents(Date.now() + 10 * 60_000)).toEqual([])
  }, 30_000)
})

describe('the first birth verdict wins, in both directions', () => {
  let booted: Booted | undefined

  afterEach(async () => {
    await flush(1)
    if (booted) await booted.addon.shutdown()
    booted = undefined
  })

  it('a confirming verdict that lands after a suppression is ignored — no orphan resident', async () => {
    // The same id is offered to the gate by two frames that are both in flight
    // (`lastActiveTrackIds` is written only at the END of a frame). The first
    // verdict is "nothing there", the second "confirmed".
    let redetections = 0
    let cropRequests = 0
    const { executor } = makeFakePipelineExecutor(() => {
      redetections += 1
      return redetections === 1
        ? NOTHING_THERE
        : {
            width: 320,
            height: 320,
            detections: [
              {
                macroClass: 'animal',
                score: 0.95,
                bbox: { x: 20, y: 20, width: 280, height: 280 },
              },
            ],
          }
    })
    booted = await bootAnalytics(
      DEVICE_ID,
      async (request) => {
        if (!isConfirmationCropRequest(request)) return null
        // The first look misses (the birth is DEFERRED); every later one is
        // slow enough that a second frame reaches the gate while the first waits.
        cropRequests += 1
        if (cropRequests === 1) return null
        await new Promise<void>((resolve) => setTimeout(resolve, 30))
        return { jpeg: CROP_JPEG_BASE64, width: 320, height: 320, tier: 'native' as const }
      },
      { pipelineExecutor: executor },
    )

    // The tracker needs a few hits before it offers a birth to the gate; the
    // first look at it misses, so the birth is deferred.
    for (let i = 0; i <= BIRTH_FRAME; i += 1) {
      emitInference(booted.bus.bus, buildFrame(1_000 + i * 100, [{ ...PHANTOM, id: `a${i}` }]))
      await flush(5)
    }
    // Two frames that each RE-OFFER the deferred id are NOT awaited between:
    // both are in flight at the gate together.
    for (let i = BIRTH_FRAME + 1; i <= BIRTH_FRAME + 2; i += 1) {
      emitInference(booted.bus.bus, buildFrame(1_000 + i * 100, [{ ...PHANTOM, id: `a${i}` }]))
    }
    await flush(15)
    // The phantom is then carried for a few more frames.
    for (let i = BIRTH_FRAME + 3; i < BIRTH_FRAME + 9; i += 1) {
      emitInference(booted.bus.bus, buildFrame(1_000 + i * 100, [{ ...PHANTOM, id: `a${i}` }]))
      await flush(5)
    }

    const lines = booted.logs
    const messages = lines.map((line) => line.message)
    expect(redetections, 'two verdicts were requested, so the frames overlapped').toBe(2)
    expect(messages).toContain('birth suppressed — track record retracted')
    expect(messages, 'a suppressed birth never starts').not.toContain('track started')
    const ignored = lines.filter(
      (line) => line.message === 'late birth verdict ignored — the birth was already suppressed',
    )
    expect(ignored).toHaveLength(1)
    expect(ignored[0]?.extras).toMatchObject({ meta: { verdict: 'confirmed' } })
    expect(residentsOf(booted).size()).toBe(0)

    for (let i = 0; i < 6; i += 1) {
      emitInference(booted.bus.bus, buildFrame(60_000 + i * 5_000, []))
      await flush(5)
    }
    expect(residentsOf(booted).size()).toBe(0)
    expect(booted.addon.orphanResidents(Date.now() + 10 * 60_000)).toEqual([])
  }, 30_000)
})

describe('orphan residents', () => {
  it('counts a resident neither active nor carried by the tracker once it is idle', async () => {
    const booted = await bootAnalytics(DEVICE_ID, async () => null)
    try {
      const residents = residentsOf(booted)
      residents.open(DEVICE_ID, 'ghost')
      residents.setLastFrameAt(DEVICE_ID, 'ghost', 1_000)
      expect(booted.addon.orphanResidents(1_000 + 60_000)).toEqual([])
      expect(booted.addon.orphanResidents(1_000 + 3 * 60_000)).toEqual([
        { trackId: 'ghost', deviceId: DEVICE_ID, lastFrameAt: 1_000 },
      ])
    } finally {
      await booted.addon.shutdown()
    }
  })
})
