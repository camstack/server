import type { DecodedFrame, FrameHandle, FrameResult } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunnerConfig } from '../runner.js'
import { PipelineRunner } from '../runner.js'

function makeFrame(timestamp: number): DecodedFrame {
  return {
    data: Buffer.alloc(4),
    width: 640,
    height: 480,
    format: 'jpeg',
    timestamp,
  }
}

function makeHandle(seq: number): FrameHandle {
  return {
    shmId: `csf.governor-test.${seq}`,
    slot: 0,
    seq,
    width: 640,
    height: 480,
    format: 'jpeg',
    pts: seq,
    byteLength: 4,
    nodeId: 'hub',
    slotCount: 8,
  }
}

function makePipelineResult(): FrameResult {
  return {
    kind: 'frame',
    frameId: 'test-frame',
    deviceId: 1,
    timestamp: 0,
    width: 640,
    height: 480,
    detections: [],
    debug: { totalInferenceMs: 10 },
  }
}

describe('PipelineRunner — governed inference admission', () => {
  let runner: PipelineRunner
  let processFrame: ReturnType<typeof vi.fn>
  let analyzeMotion: ReturnType<typeof vi.fn>

  beforeEach(() => {
    processFrame = vi.fn().mockResolvedValue(makePipelineResult())
    analyzeMotion = vi.fn().mockResolvedValue(undefined)
  })

  afterEach(() => {
    runner?.stop()
  })

  function createRunner(overrides: Partial<RunnerConfig> = {}): PipelineRunner {
    return new PipelineRunner({
      maxQueueDepth: 3,
      maxConcurrentInferences: 2,
      // Tight budget + a huge avgInferenceMs (seeded below) forces
      // minIntervalMs(deviceId) well above "back-to-back" admission spacing.
      targetLoadPercent: 50,
      minThrottledFps: 1,
      processFrame: processFrame as unknown as RunnerConfig['processFrame'],
      analyzeMotion: analyzeMotion as unknown as RunnerConfig['analyzeMotion'],
      ...overrides,
    })
  }

  it('reports backpressure when a frame enqueued now would wait for the executor', async () => {
    // The ref transport asks this per frame: `true` means copy the pixels
    // while the frame is still reserved, instead of a lazy ref the worker's
    // 8-slot hold may have recycled by the time the executor reads it.
    runner = createRunner({ maxConcurrentInferences: 1 })
    expect(runner.detectionBackpressure(1)).toBe(true) // unknown camera: never a gamble
    runner.registerCamera(1, { detectionMode: 'always-on', fps: 10 })
    expect(runner.detectionBackpressure(1)).toBe(false)
    // The executor is parked: once the tick dispatches the first frame it
    // holds the only inference slot, and every frame after it waits — a lazy
    // ref's pixels would be read only after that wait.
    processFrame.mockImplementation(() => new Promise(() => {}))
    runner.start()
    runner.enqueueDetectionFrame(1, makeFrame(1), makeHandle(1))
    for (let i = 0; i < 40 && processFrame.mock.calls.length === 0; i += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5))
    }
    expect(processFrame).toHaveBeenCalledTimes(1)
    expect(runner.detectionBackpressure(1)).toBe(true)
  })

  it('gates a second back-to-back detection frame once the governor has throttled the camera', () => {
    runner = createRunner()
    // always-on: phase is 'active' immediately, no reportMotion needed.
    runner.registerCamera(1, { detectionMode: 'always-on', fps: 10 })

    // Seed the sampler with a huge inference time so the governor computes a
    // real interval for device 1, then prime the governor synchronously —
    // no need to wait for the periodic tick.
    runner.timingSampler.addSample(1, {
      queueWait: 0,
      semaphoreWait: 0,
      inference: 5_000,
      resultToEmit: 0,
      endToEnd: 5_000,
      frameAge: -1,
      detections: 0,
    })
    runner.recomputeGovernor()

    // Two back-to-back admissions for the SAME camera. The queue is
    // latest-wins (capacity 1): FrameQueue.enqueue() increments
    // `droppedFrames` iff it overwrites an existing item. If BOTH frames
    // were admitted, droppedFrames would be 1 (frame2 overwrote frame1). If
    // the governor gated the second call before it ever reached the queue,
    // droppedFrames stays 0 — frame1 is still the sole occupant.
    runner.enqueueDetectionFrame(1, makeFrame(1), makeHandle(1))
    runner.enqueueDetectionFrame(1, makeFrame(2), makeHandle(2))

    expect(runner.getCameraMetrics(1)!.droppedFrames).toBe(0)
    expect(runner.getCameraMetrics(1)!.queueDepth).toBe(1)
    expect(runner.getMetrics().throttledCameras).toBe(1)
  })

  // The lease-admission signal rides this return value: the caller marks the
  // decode worker's native lease worth keeping only when the frame was ADMITTED
  // (`markInferred`). A method that always reported `true` would keep the
  // shipped 25 fps retention while every counter claimed the filter was on —
  // the metrics would say it worked and nothing would have changed.
  it('reports admission so the caller can mark only the frames that reach inference', () => {
    runner = createRunner()
    runner.registerCamera(1, { detectionMode: 'always-on', fps: 10 })
    runner.timingSampler.addSample(1, {
      queueWait: 0,
      semaphoreWait: 0,
      inference: 5_000,
      resultToEmit: 0,
      endToEnd: 5_000,
      frameAge: -1,
      detections: 0,
    })
    runner.recomputeGovernor()

    expect(runner.enqueueDetectionFrame(1, makeFrame(1), makeHandle(1))).toBe(true)
    expect(runner.enqueueDetectionFrame(1, makeFrame(2), makeHandle(2))).toBe(false)
  })

  it('can reserve admission before pixel materialization without counting the frame twice', () => {
    runner = createRunner()
    runner.registerCamera(1, { detectionMode: 'always-on', fps: 10 })
    runner.timingSampler.addSample(1, {
      queueWait: 0,
      semaphoreWait: 0,
      inference: 5_000,
      resultToEmit: 0,
      endToEnd: 5_000,
      frameAge: -1,
      detections: 0,
    })
    runner.recomputeGovernor()

    expect(runner.reserveDetectionFrame(1, 1_000)).toBe(true)
    expect(runner.enqueueReservedDetectionFrame(1, makeFrame(1), makeHandle(1))).toBe(true)
    expect(runner.reserveDetectionFrame(1, 1_001)).toBe(false)
    expect(runner.getCameraMetrics(1)?.queueDepth).toBe(1)
  })

  it('hot-reloads governor tuning and immediately changes live admission', () => {
    runner = createRunner({ targetLoadPercent: 100 })
    runner.registerCamera(1, { detectionMode: 'always-on', fps: 10 })
    runner.timingSampler.addSample(1, {
      queueWait: 0,
      semaphoreWait: 0,
      inference: 80,
      resultToEmit: 0,
      endToEnd: 80,
      frameAge: -1,
      detections: 0,
    })
    runner.recomputeGovernor()
    expect(runner.getMetrics().throttledCameras).toBe(0)

    runner.updateLimits({ targetLoadPercent: 1 })

    expect(runner.getMetrics().throttledCameras).toBe(1)
    expect(runner.enqueueDetectionFrame(1, makeFrame(1), makeHandle(1))).toBe(true)
    expect(runner.enqueueDetectionFrame(1, makeFrame(2), makeHandle(2))).toBe(false)
  })

  it('reports FALSE for a camera that is not active and for one it does not know', () => {
    runner = createRunner()
    // on-motion with no motion reported → phase 'watching': the frame is
    // delivered by the decode worker but never reaches inference.
    runner.registerCamera(2, { detectionMode: 'on-motion', fps: 10 })
    expect(runner.enqueueDetectionFrame(2, makeFrame(1), makeHandle(1))).toBe(false)
    expect(runner.enqueueDetectionFrame(99, makeFrame(1), makeHandle(1))).toBe(false)
  })

  it('splits the node budget only across ACTIVE cameras — a watching camera does not dilute the active one', () => {
    runner = createRunner()
    // Camera 1: always-on → phase 'active' immediately.
    runner.registerCamera(1, { detectionMode: 'always-on', fps: 10 })
    // Camera 2: on-motion with no motion reported → phase stays 'watching'.
    runner.registerCamera(2, { detectionMode: 'on-motion', fps: 10 })

    // Node budget = targetLoadPercent(50) × maxConcurrentInferences(2) × 1000
    //             = 1000 ms/s. With 80 ms/inference:
    //   • full budget (active camera alone) → 1000/80 = 12.5 fps ≥ 10 → NOT throttled.
    //   • half budget (diluted by the watching camera) → 500/80 = 6.25 fps < 10 → throttled.
    // So the throttled count discriminates the fix: 0 (only camera 1 sampled)
    // vs 1 (watching camera 2 halved the share).
    runner.timingSampler.addSample(1, {
      queueWait: 0,
      semaphoreWait: 0,
      inference: 80,
      resultToEmit: 0,
      endToEnd: 80,
      frameAge: -1,
      detections: 0,
    })
    runner.recomputeGovernor()

    expect(runner.getMetrics().throttledCameras).toBe(0)
  })

  it('does not gate admission before the governor has run its first recompute', () => {
    runner = createRunner()
    runner.registerCamera(1, { detectionMode: 'always-on', fps: 10 })

    // recomputeGovernor() never called — FrameGovernor starts with an empty
    // intervals map, so minIntervalMs(1) is 0 (no gate) regardless of the
    // camera's configured fps.
    runner.enqueueDetectionFrame(1, makeFrame(1), makeHandle(1))
    runner.enqueueDetectionFrame(1, makeFrame(2), makeHandle(2))

    // Both admitted — latest-wins queue overwrote frame1 with frame2.
    expect(runner.getCameraMetrics(1)!.droppedFrames).toBe(1)
    expect(runner.getMetrics().throttledCameras).toBe(0)
  })
})
