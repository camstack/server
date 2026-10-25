/**
 * A camera never has more frames in inference than its decode worker can
 * hold. The worker keeps `holdFrames` (8) native frames for the runner's lazy
 * refs and evicts the OLDEST when a newer marked frame lands; the runner's
 * semaphore allows 16 inferences at once. Both numbers were right on their own
 * and wrong together: a cold engine at session start let sixteen frames of ONE
 * camera into inference, frames 9–16 evicted 1–8 from the hold, and every one
 * of the first eight reads failed with "toBuffer for unknown or stale frameId"
 * (measured 2026-09-06: exactly eight errors, ids 1–8, in the same second the
 * engine warmed up — on every fresh session, every node).
 */
import type { DecodedFrame, FrameHandle, FrameResult } from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
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
    shmId: `csf.inflight-test.${seq}`,
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

function makeResult(): FrameResult {
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

async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 60 && !predicate(); i += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 5))
  }
}

describe('PipelineRunner — per-camera in-flight cap', () => {
  let runner: PipelineRunner
  /** One parked executor call per dispatched frame; settle them by hand. */
  const settle: Array<(result: FrameResult) => void> = []
  const processFrame = vi.fn(() => new Promise<FrameResult>((resolve) => settle.push(resolve)))

  afterEach(() => {
    runner?.stop()
    settle.length = 0
    processFrame.mockClear()
  })

  function createRunner(overrides: Partial<RunnerConfig> = {}): PipelineRunner {
    return new PipelineRunner({
      maxQueueDepth: 3,
      maxConcurrentInferences: 8,
      targetLoadPercent: 100,
      minThrottledFps: 1,
      processFrame: processFrame as unknown as RunnerConfig['processFrame'],
      analyzeMotion: vi.fn().mockResolvedValue(undefined),
      maxInflightPerCamera: 2,
      ...overrides,
    })
  }

  async function dispatchOne(timestamp: number): Promise<void> {
    const before = processFrame.mock.calls.length
    runner.enqueueDetectionFrame(1, makeFrame(timestamp), makeHandle(timestamp))
    await until(() => processFrame.mock.calls.length > before)
  }

  it('holds the third frame in the queue while two are in inference, and reports backpressure', async () => {
    runner = createRunner()
    runner.registerCamera(1, { detectionMode: 'always-on', fps: 10 })
    runner.start()
    await dispatchOne(1)
    await dispatchOne(2)
    expect(processFrame).toHaveBeenCalledTimes(2)
    expect(runner.detectionBackpressure(1)).toBe(true)

    runner.enqueueDetectionFrame(1, makeFrame(3), makeHandle(3))
    await new Promise<void>((resolve) => setTimeout(resolve, 60))
    // Eight permits are free; the CAMERA is what is full.
    expect(processFrame).toHaveBeenCalledTimes(2)

    settle[0]!(makeResult())
    await until(() => processFrame.mock.calls.length === 3)
    expect(processFrame).toHaveBeenCalledTimes(3)
  })

  it('follows the hold when it is resized — a raised cap releases the queued frame', async () => {
    runner = createRunner()
    runner.registerCamera(1, { detectionMode: 'always-on', fps: 10 })
    runner.start()
    await dispatchOne(1)
    await dispatchOne(2)
    runner.enqueueDetectionFrame(1, makeFrame(3), makeHandle(3))
    await new Promise<void>((resolve) => setTimeout(resolve, 60))
    expect(processFrame).toHaveBeenCalledTimes(2)

    runner.setMaxInflightPerCamera(3)
    await until(() => processFrame.mock.calls.length === 3)
    expect(processFrame).toHaveBeenCalledTimes(3)
    expect(runner.detectionBackpressure(1)).toBe(true)
  })
})
