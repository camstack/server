/* eslint-disable @typescript-eslint/no-explicit-any -- test file: vi.fn() mocks need narrow casts to match callback signatures */

/**
 * A POOL SHED is a dropped frame, and until 2026-08-13 nothing counted it.
 *
 * `CameraMetrics.droppedFrames` summed the two FrameQueue overflow counters
 * only. Those count frames the RUNNER could not enqueue — and this fleet does
 * not produce them: measured 2026-08-12, three nodes shed at 563 / 283 / 114
 * `worker saturated` episodes per hour while every queue-derived signal in the
 * cluster read 0. The shed happens inside the Python pool, the runner's queue
 * drains fine, and the frame is gone.
 *
 * The consequence was not cosmetic. `node-stress.ts` scores a node from
 * `queueDepth` and the `droppedFrames` RATE, and its corroboration rule zeroes
 * the fps deficit unless one of those two is non-zero — so on 2026-08-12 the
 * observe path logged ZERO transitions during exactly the saturation it exists
 * to detect. A signal that reads zero during the failure it names is not a
 * signal.
 *
 * `FrameResult.shed` has carried the truth since 2026-08-01. It is now counted.
 */
import type { DecodedFrame, FrameResult, IScopedLogger } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunnerConfig } from '../runner.js'
import { PipelineRunner } from '../runner.js'

function makeFrame(timestamp: number): DecodedFrame {
  return { data: Buffer.alloc(4), width: 640, height: 480, format: 'jpeg', timestamp }
}

function makeResult(deviceId: number, shed: boolean): FrameResult {
  return {
    kind: 'frame',
    frameId: `f-${deviceId}-${timestampCounter++}`,
    deviceId,
    timestamp: 0,
    width: 640,
    height: 480,
    detections: [],
    debug: { totalInferenceMs: 1 },
    ...(shed ? { shed: true as const, shedReason: 'worker-in-flight-cap' } : {}),
  }
}

let timestampCounter = 0

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function silentLogger(): IScopedLogger {
  const noop = (): void => {
    /* no-op */
  }
  const logger = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    withTags: () => logger,
    child: () => logger,
  }
  return logger as unknown as IScopedLogger
}

describe('PipelineRunner — a pool shed counts as a dropped frame', () => {
  let runner: PipelineRunner

  beforeEach(() => {
    timestampCounter = 0
  })

  afterEach(() => {
    runner?.stop()
  })

  function createRunner(processFrame: RunnerConfig['processFrame']): PipelineRunner {
    return new PipelineRunner({
      // Generous on purpose: this suite must observe POOL sheds, and a queue
      // that overflows would add the other kind of drop to the same counter.
      maxQueueDepth: 64,
      maxConcurrentInferences: 4,
      targetLoadPercent: 80,
      minThrottledFps: 1,
      inferenceTimeoutMs: 2_000,
      processFrame,
      analyzeMotion: vi.fn().mockResolvedValue(undefined) as any,
      logger: silentLogger(),
    })
  }

  async function feed(deviceId: number, frames: number): Promise<void> {
    for (let i = 0; i < frames; i++) {
      runner.enqueueDetectionFrame(deviceId, makeFrame(i), undefined)
      await delay(15)
    }
    await delay(120)
  }

  it('a shed result raises droppedFrames — the queue never overflowed', async () => {
    const processFrame = vi.fn(async (deviceId: number) => makeResult(deviceId, true))
    runner = createRunner(processFrame as any)
    runner.registerCamera(101, { detectionMode: 'always-on', fps: 10 })
    runner.start()

    await feed(101, 5)

    const metrics = runner.getCameraMetrics(101)
    expect(metrics).toBeDefined()
    // Every dispatch was shed by the pool; not one frame was refused entry.
    expect(metrics!.queueDepth).toBe(0)
    expect(metrics!.droppedFrames).toBeGreaterThan(0)
  })

  it('a healthy result leaves droppedFrames at zero', async () => {
    const processFrame = vi.fn(async (deviceId: number) => makeResult(deviceId, false))
    runner = createRunner(processFrame as any)
    runner.registerCamera(102, { detectionMode: 'always-on', fps: 10 })
    runner.start()

    await feed(102, 5)

    expect(runner.getCameraMetrics(102)?.droppedFrames).toBe(0)
  })

  it('sheds are attributed PER CAMERA — the pool is shared, the blame is not', async () => {
    // One pool, two cameras, only one of them shedding. Attributing the pool's
    // shed count to the node would make both look equally bad, and the question
    // this data always gets is "why is 101 worse than 102".
    const processFrame = vi.fn(async (deviceId: number) => makeResult(deviceId, deviceId === 101))
    runner = createRunner(processFrame as any)
    runner.registerCamera(101, { detectionMode: 'always-on', fps: 10 })
    runner.registerCamera(102, { detectionMode: 'always-on', fps: 10 })
    runner.start()

    for (let i = 0; i < 4; i++) {
      runner.enqueueDetectionFrame(101, makeFrame(i), undefined)
      runner.enqueueDetectionFrame(102, makeFrame(i), undefined)
      await delay(40)
    }
    await delay(200)

    expect(runner.getCameraMetrics(101)?.droppedFrames).toBeGreaterThan(0)
    expect(runner.getCameraMetrics(102)?.droppedFrames).toBe(0)
  })
})
