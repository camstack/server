/**
 * The confirmation gate promotes the subject it finds BESIDE a birth — end to
 * end through the booted addon.
 *
 * Camera 101, 2026-09-06: a person walking a dog. The full-frame detector
 * emitted no `animal`; the gate, re-running the same detector on the person's
 * native crop, saw the dog at 0.74–0.91 and logged it as
 * `bestIncompatibleClass`. Nothing else happened. This spec drives that exact
 * shape — a person birth whose crop holds a confident animal — and asserts the
 * animal becomes a TRACK of its own on the next frame, with its box put back
 * where the crop was cut from.
 *
 * End to end on purpose: the gate's decision, the queue, the injection into
 * the tracker's frame and the birth of the injected subject are four pieces
 * in three files, and the defect this closes was precisely a decision nobody
 * consumed.
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

/** A token JPEG the fake runner hands back for every confirmation crop. */
const CROP_JPEG_BASE64 = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64')

const PERSON: ObjectDetection = {
  id: 'd0',
  kind: 'first-level',
  macroClass: 'person',
  score: 0.9,
  labels: [],
  bbox: { x: 200, y: 100, width: 120, height: 240 },
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

/**
 * What the re-detector sees on the PERSON's crop: the person, and the dog
 * BESIDE it — low and to the right, in the 15% padding ring, so it is not
 * mostly contained in the person's own box. That distinction is load-bearing:
 * a box that far inside a person is a body part read as a subject, not a
 * second subject — nothing in this pipeline should ever confuse the two.
 */
const PERSON_CROP: FakeRedetectResult = {
  width: 320,
  height: 320,
  detections: [
    { macroClass: 'person', score: 0.9, bbox: { x: 20, y: 10, width: 140, height: 300 } },
    { macroClass: 'animal', score: 0.85, bbox: { x: 240, y: 230, width: 80, height: 90 } },
  ],
}
/** What it sees on the DOG's own crop, once the dog is a birth of its own. */
const DOG_CROP: FakeRedetectResult = {
  width: 320,
  height: 320,
  detections: [
    { macroClass: 'animal', score: 0.9, bbox: { x: 40, y: 40, width: 240, height: 240 } },
  ],
}

describe('a subject the gate finds beside a birth becomes a track of its own', () => {
  let booted: Booted | undefined

  afterEach(async () => {
    await flush(1)
    if (booted) await booted.addon.shutdown()
    booted = undefined
  })

  it('promotes the animal out of the person crop and births it on the frames that follow, in frame space', async () => {
    let cropContent: FakeRedetectResult = PERSON_CROP
    const { executor, calls } = makeFakePipelineExecutor(() => cropContent)
    booted = await bootAnalytics(
      DEVICE_ID,
      async (request) =>
        isConfirmationCropRequest(request)
          ? { jpeg: CROP_JPEG_BASE64, width: 320, height: 320, tier: 'native' }
          : null,
      { pipelineExecutor: executor },
    )

    // The person needs `minHits` (3) frames to be born; the gate then runs on
    // its crop, which holds the dog.
    for (let i = 0; i < 3; i += 1) {
      emitInference(booted.bus.bus, buildFrame(1_000 + i * 100, [{ ...PERSON, id: `d${i}` }]))
      await flush(5)
    }
    await flush(20)

    const promoted = booted.logs.find(
      (line) => line.message === 'confirmation gate: secondary subject promoted from the crop',
    )
    expect(promoted, 'the gate promoted what it found beside the person').toBeDefined()
    const promotedExtras = promoted?.extras
    const meta = (promotedExtras as { meta: Record<string, unknown> }).meta
    expect(meta['secondaryClass']).toBe('animal')
    expect(meta['secondaryScore']).toBe(0.85)
    // The dog's box, put back where the crop was cut from: the person box
    // padded 15% on each side (x 182..338, y 64..376), then the crop-relative
    // box (240/320 .. 320/320, 230/320 .. 320/320) inside it.
    const bbox = meta['secondaryBbox'] as { x: number; y: number; w: number; h: number }
    expect(bbox.x).toBeCloseTo(182 + (240 / 320) * 156, 3)
    expect(bbox.y).toBeCloseTo(64 + (230 / 320) * 312, 3)
    expect(bbox.w).toBeCloseTo((80 / 320) * 156, 3)
    expect(bbox.h).toBeCloseTo((90 / 320) * 312, 3)
    expect(calls).toHaveLength(1)

    // The runner keeps seeing only the person. The promoted dog rides the next
    // frames, reaches `minHits` of its own, is born, and is confirmed on its
    // OWN crop.
    cropContent = DOG_CROP
    for (let i = 0; i < 3; i += 1) {
      emitInference(booted.bus.bus, buildFrame(1_300 + i * 100, [{ ...PERSON, id: `e${i}` }]))
      await flush(5)
    }
    await flush(20)

    expect(
      booted.logs.some(
        (line) => line.message === 'secondary subjects ride this frame as detections',
      ),
    ).toBe(true)
    const started = booted.logs.filter((line) => line.message === 'track started')
    const classes = started.map(
      (line) => (line.extras as { meta: { className: string } }).meta.className,
    )
    expect(classes).toContain('person')
    expect(classes).toContain('animal')
    // The dog's own confirmation ran on its own crop — a second executor call.
    expect(calls.length).toBeGreaterThanOrEqual(2)
  }, 20_000)

  it('does not promote an incompatible class that stays under the gate bar', async () => {
    const { executor } = makeFakePipelineExecutor(() => ({
      width: 320,
      height: 320,
      detections: [
        { macroClass: 'person', score: 0.9, bbox: { x: 20, y: 10, width: 140, height: 300 } },
        { macroClass: 'animal', score: 0.3, bbox: { x: 240, y: 230, width: 80, height: 90 } },
      ],
    }))
    booted = await bootAnalytics(
      DEVICE_ID,
      async (request) =>
        isConfirmationCropRequest(request)
          ? { jpeg: CROP_JPEG_BASE64, width: 320, height: 320, tier: 'native' }
          : null,
      { pipelineExecutor: executor },
    )
    for (let i = 0; i < 6; i += 1) {
      emitInference(booted.bus.bus, buildFrame(1_000 + i * 100, [{ ...PERSON, id: `d${i}` }]))
      await flush(5)
    }
    await flush(20)

    expect(
      booted.logs.some(
        (line) => line.message === 'confirmation gate: secondary subject promoted from the crop',
      ),
    ).toBe(false)
    const classes = booted.logs
      .filter((line) => line.message === 'track started')
      .map((line) => (line.extras as { meta: { className: string } }).meta.className)
    expect(classes).toEqual(['person'])
  }, 20_000)
})
