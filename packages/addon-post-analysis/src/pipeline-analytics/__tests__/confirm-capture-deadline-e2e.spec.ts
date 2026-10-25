/**
 * The confirmation gate's crop request must carry the gate's OWN deadline,
 * END TO END through the booted addon.
 *
 * `confirmOne` wraps the crop fetch in `withTimeout(config.timeoutMs)` and
 * DISCARDS whatever arrives later — the verdict is already `undecided/timeout`
 * and the birth already deferred. Until this fix the request it abandoned went
 * on living in the `CaptureScheduler`: no `staleAfterMs`, so `dropExpired`
 * could never reclaim it, and priority 0, so it sat at the HEAD of the lane
 * while `insertByPriority` + `shedToCap` shed every keyFrame / thumbnail /
 * face / plate arrival at the tail.
 *
 * This has to be an END-TO-END spec, not a unit test of either half. Both
 * halves are individually correct: the gate is right to stop waiting, and the
 * scheduler is right to run what it was given. The defect is that the deadline
 * one of them owns was never told to the other — a wiring fact no test of
 * either piece can see. And it must count what reaches the RUNNER, because the
 * failure mode is not "the capture was skipped", it is "the capture RAN and
 * nobody was listening": the gate's own decision log is IDENTICAL either way
 * (same attempts, same timeouts), so a fixture that asserted on decisions would
 * pass on both.
 *
 * Live measurement that motivated it, 2026-08-30: on camera 104, 844 of 1 119
 * gate attempts in 3 h ended `timeout` and only 83 ended `no-crop` — the gate
 * was not seeing misses, it was seeing its own requests never come back. Mean
 * `handleAgeMs` on that camera's native crop misses was 5 102 ms (max 32 847),
 * i.e. the round trips that did run were asking for frames released seconds
 * earlier. On camera 108, whose lane never saturates, `timeout` was 2 of 81.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type {
  FrameHandle,
  FrameResult,
  IEventBus,
  ObjectDetection,
  PipelineInferenceResultPayload,
} from '@camstack/types'
import { EventCategory, createEvent } from '@camstack/types'
import { CONFIRMATION_CROP_MAX_WIDTH } from '../index.js'
import { bootAnalytics, type Booted } from './boot-analytics.js'
import { isFullFrameRequest, type FakeNativeCropRequest } from './test-helpers.js'

/**
 * The confirmation gate's re-detect crop: a subject ROI at the gate's own width
 * cap. Recognised by the REAL constant — a copy of the number here would go on
 * matching nothing the day the cap changes, and the spec would pass by counting
 * zero of zero. Kept in this spec rather than in `test-helpers` on purpose: the
 * constant lives in the addon's entry module, and importing that into a helper
 * every spec loads doubled the suite's collect time.
 */
function isConfirmationCropRequest(request: FakeNativeCropRequest): boolean {
  return !isFullFrameRequest(request) && request.maxWidth === CONFIRMATION_CROP_MAX_WIDTH
}

const DEVICE_ID = 104
const OWNER_NODE = 'hub'

/** The gate's per-attempt budget for these specs. Deliberately NOT the shipped
 *  default: the request must carry whatever the gate is configured with, not a
 *  constant that happens to equal it. */
const GATE_TIMEOUT_MS = 120

/** How long the fake runner sits on a confirmation crop — comfortably past
 *  {@link GATE_TIMEOUT_MS}, which is the whole production condition (an RPC
 *  slower than the deadline of the caller waiting on it). */
const RUNNER_LATENCY_MS = 400

/** `CaptureScheduler`'s per-device concurrent-exec budget. Only requests that
 *  had ALREADY STARTED when the deadline passed can reach the runner; anything
 *  still queued must be reclaimed. */
const LANE_BUDGET = 3

const HANDLE: FrameHandle = {
  shmId: 'ring-104',
  slot: 0,
  seq: 2,
  width: 640,
  height: 480,
  format: 'rgb',
  pts: 1,
  byteLength: 640 * 480 * 3,
  nodeId: OWNER_NODE,
  slotCount: 8,
}

/** A person box big enough to clear the gate's `minCropPx`, laid out on a grid
 *  so N subjects are N distinct tracks rather than one merged blob. */
function detection(index: number): ObjectDetection {
  const column = index % 8
  const row = Math.floor(index / 8)
  return {
    id: `d${index}`,
    kind: 'first-level',
    macroClass: 'person',
    score: 0.9,
    labels: [],
    bbox: { x: 10 + column * 70, y: 40 + row * 110, width: 60, height: 100 },
  }
}

function buildFrame(timestamp: number, subjects: number): FrameResult {
  return {
    kind: 'frame',
    frameId: `f-${timestamp}`,
    deviceId: DEVICE_ID,
    timestamp,
    width: 640,
    height: 480,
    detections: Array.from({ length: subjects }, (_, i) => detection(i)),
  }
}

function emitInference(bus: IEventBus, timestamp: number, subjects: number): void {
  const payload: PipelineInferenceResultPayload = {
    deviceId: DEVICE_ID,
    frame: buildFrame(timestamp, subjects),
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
  for (let i = 0; i < 6; i += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, stepMs))
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
}

/**
 * Boot a camera whose runner answers every confirmation crop LATER than the
 * gate will wait, then drive four frames of births and let every abandoned
 * request have far longer than it would need to reach the runner.
 */
async function driveStarvedCamera(subjects: number): Promise<Booted> {
  const booted = await bootAnalytics(
    DEVICE_ID,
    async (request) => {
      if (isConfirmationCropRequest(request)) {
        await new Promise<void>((resolve) => setTimeout(resolve, RUNNER_LATENCY_MS))
      }
      return null
    },
    { deviceSettings: { confirmationGateTimeoutMs: GATE_TIMEOUT_MS } },
  )
  for (let frame = 0; frame < 4; frame += 1) {
    emitInference(booted.bus.bus, 1_000 + frame * 200, subjects)
    await flush(20)
  }
  // Long enough that anything still queued WOULD have run.
  await new Promise<void>((resolve) => setTimeout(resolve, RUNNER_LATENCY_MS * 4))
  await flush(20)
  return booted
}

function count(
  requests: readonly FakeNativeCropRequest[],
  predicate: (request: FakeNativeCropRequest) => boolean,
): number {
  return requests.filter(predicate).length
}

/** Every attempt the gate actually made — the denominator. A round trip count
 *  is meaningless without it: 3 of 3 and 3 of 60 are opposite findings. */
function gateAttempts(booted: Booted): number {
  return booted.logs.filter((line) => line.message.startsWith('confirmation gate: birth')).length
}

describe('the confirmation gate’s crop carries the gate’s deadline', () => {
  let booted: Booted | undefined

  afterEach(async () => {
    await flush(1)
    if (booted) await booted.addon.shutdown()
    booted = undefined
  })

  it('a confirmation the gate has ALREADY abandoned never reaches the runner', async () => {
    booted = await driveStarvedCamera(6)

    const attempts = gateAttempts(booted)
    const roundTrips = count(booted.requests, isConfirmationCropRequest)

    // The gate tried many more times than the lane can run at once (the
    // deferral re-submits each birth on the next frame) …
    expect(attempts).toBeGreaterThan(LANE_BUDGET)
    // … but only the requests that were already RUNNING when their deadline
    // passed ever cost a native round trip. Disarmed (no `staleAfterMs`), every
    // one of the `attempts` reaches the runner instead — each on a handle by
    // then hundreds of ms stale, for an answer nobody reads.
    expect(roundTrips).toBeGreaterThan(0)
    expect(roundTrips).toBeLessThanOrEqual(LANE_BUDGET)
    expect(roundTrips).toBeLessThan(attempts)
  }, 30_000)

  it('and does not shed every KEY FRAME the camera asks for while it waits', async () => {
    // Enough births at once to fill the lane's queue, which is the state the
    // live hub sits in: `queueDepth:24 inFlight:3 budget:3` on every
    // `capture queue full` line camera 104 emitted on 2026-08-30.
    booted = await driveStarvedCamera(30)

    // THE OPERATOR-VISIBLE HALF. `keyFrame` is priority 1, so it is inserted
    // BEHIND the priority-0 confirmations and `shedToCap` pops it from the tail
    // on admission. With an unexpirable head that is permanent: disarmed, this
    // camera captures ZERO key frames for as long as births keep arriving —
    // every track then closes with no preview and wears the D276 face-crop
    // stand-in, which is the "face-only track" report.
    //
    // Since D422 the key-frame WRITE reads a parked parcel by track; the read
    // is what the scheduler-routed exec does when it runs, so it is what a
    // shed exec never does.
    expect(booted.parcelReads.filter((read) => read.kind === 'keyFrame').length).toBeGreaterThan(0)
  }, 30_000)
})
