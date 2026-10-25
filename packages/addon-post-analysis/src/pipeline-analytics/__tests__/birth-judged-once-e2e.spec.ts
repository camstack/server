/**
 * A birth is judged ONCE (D377) — end to end through the booted addon.
 *
 * Camera 101, 2026-09-07 04:59:38.335Z: `confirmation gate: birth confirmed
 * {trackId=f585b2ee… className=animal bestScore=0.7068}` followed by `track
 * started`. 486 ms later, same id: `birth suppressed (false positive)` — with
 * no `bestScore` at all, i.e. the second crop held no compatible detection —
 * and `birth suppressed — track record retracted`. The dog had a track and
 * lost it.
 *
 * The mechanism is structural, not a race in the gate: `processFrame` reads
 * `lastActiveTrackIds` at the TOP and writes it at the BOTTOM, and between the
 * two it AWAITS the gate (a crop fetch to the frame's node plus a
 * re-detection — 130-490 ms on this camera). Two frames 100 ms apart therefore
 * both see the same fresh id as an unjudged birth and both submit it. The same
 * shape produced two `track started` lines for one vehicle id at 07:03:48.
 *
 * These tests drive exactly that overlap: two frames processed concurrently
 * whose gate verdicts DISAGREE.
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

const DOG: ObjectDetection = {
  id: 'a0',
  kind: 'first-level',
  macroClass: 'animal',
  score: 0.9,
  labels: [],
  bbox: { x: 300, y: 300, width: 90, height: 70 },
}

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

const DOG_SEEN: FakeRedetectResult = {
  width: 320,
  height: 320,
  detections: [
    { macroClass: 'animal', score: 0.71, bbox: { x: 40, y: 40, width: 240, height: 240 } },
  ],
}
/** The very next crop of the same subject holds nothing compatible — the
 *  measured 06:59:38 outcome, and the whole reason a second verdict is
 *  dangerous. */
const DOG_LOST: FakeRedetectResult = { width: 320, height: 320, detections: [] }

function messages(booted: Booted): readonly string[] {
  return booted.logs.map((line) => line.message)
}

function trackIdsFor(booted: Booted, message: string): readonly string[] {
  return booted.logs
    .filter((line) => line.message === message)
    .map((line) => (line.extras as { meta: { trackId: string } }).meta.trackId)
}

describe('a birth already started is not retracted by a later verdict', () => {
  let booted: Booted | undefined

  afterEach(async () => {
    await flush(1)
    if (booted) await booted.addon.shutdown()
    booted = undefined
  })

  it('keeps the track when two overlapping frames judge the same birth and disagree', async () => {
    let confirmCalls = 0
    const { executor } = makeFakePipelineExecutor(() => {
      confirmCalls += 1
      return confirmCalls === 1 ? DOG_SEEN : DOG_LOST
    })
    booted = await bootAnalytics(
      DEVICE_ID,
      async (request) => {
        if (!isConfirmationCropRequest(request)) return null
        // The gate's crop is a round trip to the frame's node: 130-490 ms on
        // camera 101. A synchronous fake would let `processFrame` finish
        // before the next frame arrives and the overlap this test is about
        // would not exist.
        await new Promise<void>((resolve) => setTimeout(resolve, 25))
        return { jpeg: CROP_JPEG_BASE64, width: 320, height: 320, tier: 'native' as const }
      },
      { pipelineExecutor: executor },
    )

    // Two hits, settled — still below `minHits` (3), so no birth yet.
    for (let i = 0; i < 2; i += 1) {
      emitInference(booted.bus.bus, buildFrame(1_000 + i * 100, [{ ...DOG, id: `a${i}` }]))
      await flush(5)
    }
    // The third frame births the dog. The fourth goes out BACK TO BACK, with
    // no flush between, and carries NO detection — which is the whole premise
    // of this camera: the full-frame pass cannot see the dog, and the runner's
    // recovery pass is rate-limited to one frame in five, so the track coasts.
    //
    // That combination is what re-opens a settled birth:
    //   • the fourth `processFrame` reads `lastActiveTrackIds` before the third
    //     has written it, so the id looks fresh, AND
    //   • a COASTED upsert appends no position, so `positionsCount` is still 1
    //     and `classifyTrackAppearance` says `birth` rather than `resurrection`.
    // Neither alone is enough; together they hand the gate a second, decisive
    // vote — taken on a stale, coasted box.
    emitInference(booted.bus.bus, buildFrame(1_200, [{ ...DOG, id: 'a2' }]))
    emitInference(booted.bus.bus, buildFrame(1_300, []))
    await flush(20)

    const started = trackIdsFor(booted, 'track started')
    expect(started.length, 'the dog was born').toBeGreaterThan(0)
    // Both verdicts were taken (the gate ran twice) …
    expect(confirmCalls).toBeGreaterThanOrEqual(2)
    // … and the second, negative one did NOT undo the first.
    expect(messages(booted)).not.toContain('birth suppressed — track record retracted')
    // One id, one birth ritual.
    expect(new Set(started).size).toBe(started.length)
  }, 20_000)
})
