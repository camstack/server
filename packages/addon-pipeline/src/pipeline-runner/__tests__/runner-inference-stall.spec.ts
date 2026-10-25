/* eslint-disable @typescript-eslint/no-explicit-any -- test file: vi.fn() mocks need narrow casts to match callback signatures */
/* eslint-disable @typescript-eslint/no-unsafe-assignment -- test file: same as above */

/**
 * Regression: a hung `processFrame` wedged the WHOLE runner, silently.
 *
 * Live evidence (hub runner, 2026-07-30, cameras 101 `Camera front door`
 * and its co-attached sibling): inference latency spiked repeatedly
 * (8 102 ms, 2 819 ms, 2 698 ms) and then at 13:25:34Z every camera on that
 * runner went to `frames=0` with `dropped≈150` per 10 s interval and stayed
 * there for ~30 minutes — frames arriving, none processed, not one log line.
 * Recovery required a restart.
 *
 * Mechanism: `processWithSemaphore` awaited `processFrame` with no bound, so a
 * call that never settles holds its permit forever. `tick()` opens with
 * `if (this.semaphore.available <= 0) return`, so once every permit is held by
 * a hung call the runner stops draining EVERY camera's detection queue. Motion
 * kept flowing because `drainMotionQueues()` runs before that gate.
 */

import type { DecodedFrame, FrameResult, IScopedLogger } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunnerConfig } from '../runner.js'
import { PipelineRunner } from '../runner.js'

function makeFrame(timestamp: number): DecodedFrame {
  return { data: Buffer.alloc(4), width: 640, height: 480, format: 'jpeg', timestamp }
}

function makeResult(deviceId: number): FrameResult {
  return {
    kind: 'frame',
    frameId: `f-${deviceId}`,
    deviceId,
    timestamp: 0,
    width: 640,
    height: 480,
    detections: [],
    debug: { totalInferenceMs: 1 },
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

interface CapturedLog {
  readonly message: string
  readonly deviceId?: number
  readonly meta?: Record<string, unknown>
}

function makeLogger(sink: CapturedLog[]): IScopedLogger {
  const record =
    (_level: string) =>
    (
      message: string,
      opts?: { tags?: Record<string, unknown>; meta?: Record<string, unknown> },
    ) => {
      const deviceId = opts?.tags?.['deviceId']
      sink.push({
        message,
        ...(typeof deviceId === 'number' ? { deviceId } : {}),
        ...(opts?.meta ? { meta: opts.meta } : {}),
      })
    }
  const logger = {
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    withTags: () => logger,
  }
  return logger as unknown as IScopedLogger
}

describe('PipelineRunner — a hung inference must not wedge the runner', () => {
  let runner: PipelineRunner
  let logs: CapturedLog[]

  beforeEach(() => {
    logs = []
  })

  afterEach(() => {
    runner?.stop()
  })

  function createRunner(
    processFrame: RunnerConfig['processFrame'],
    overrides: Partial<RunnerConfig> = {},
  ): PipelineRunner {
    return new PipelineRunner({
      maxQueueDepth: 3,
      maxConcurrentInferences: 2,
      targetLoadPercent: 80,
      minThrottledFps: 1,
      inferenceTimeoutMs: 120,
      processFrame,
      analyzeMotion: vi.fn().mockResolvedValue(undefined) as any,
      logger: makeLogger(logs),
      ...overrides,
    })
  }

  it('releases the permit when a frame exceeds inferenceTimeoutMs and keeps draining', async () => {
    // Every call hangs forever — the live shape. With `maxConcurrentInferences: 2`
    // the pre-fix runner consumed both permits and never called processFrame again.
    const started: number[] = []
    const processFrame = vi.fn((deviceId: number) => {
      started.push(deviceId)
      return new Promise<FrameResult | null>(() => {})
    })

    runner = createRunner(processFrame as any)
    runner.registerCamera(101, { detectionMode: 'always-on', fps: 10 })
    runner.start()

    for (let i = 0; i < 8; i++) {
      runner.enqueueDetectionFrame(101, makeFrame(i), undefined)
      await delay(20)
    }
    await delay(300)

    // Pre-fix this is exactly 2 — both permits held by hung calls, forever.
    expect(started.length).toBeGreaterThan(2)
  })

  it('logs the timeout with the deviceId tag rather than dropping work silently', async () => {
    const processFrame = vi.fn(() => new Promise<FrameResult | null>(() => {}))

    runner = createRunner(processFrame as any)
    runner.registerCamera(101, { detectionMode: 'always-on', fps: 10 })
    runner.start()

    runner.enqueueDetectionFrame(101, makeFrame(1), undefined)
    await delay(300)

    const timeoutLog = logs.find((l) => /inference timed out/i.test(l.message))
    expect(timeoutLog).toBeDefined()
    expect(timeoutLog!.deviceId).toBe(101)
  })

  it('a slow-but-finishing frame still delivers its result', async () => {
    // The timeout must not truncate legitimate slow inference below the bound.
    const processFrame = vi.fn(async (deviceId: number) => {
      await delay(30)
      return makeResult(deviceId)
    })
    const onResult = vi.fn()

    runner = createRunner(processFrame as any)
    runner.onResult(onResult as any)
    runner.registerCamera(101, { detectionMode: 'always-on', fps: 10 })
    runner.start()

    runner.enqueueDetectionFrame(101, makeFrame(1), undefined)
    await delay(200)

    expect(onResult).toHaveBeenCalled()
    expect(logs.some((l) => /inference timed out/i.test(l.message))).toBe(false)
  })

  it('a timed-out frame does not also emit its late result', async () => {
    // The orphan call may still settle. Its result is stale by definition —
    // emitting it would put a frame from minutes ago on the live bus.
    let settle: ((r: FrameResult | null) => void) | undefined
    const processFrame = vi.fn(
      () =>
        new Promise<FrameResult | null>((resolve) => {
          settle = resolve
        }),
    )
    const onResult = vi.fn()

    runner = createRunner(processFrame as any)
    runner.onResult(onResult as any)
    runner.registerCamera(101, { detectionMode: 'always-on', fps: 10 })
    runner.start()

    runner.enqueueDetectionFrame(101, makeFrame(1), undefined)
    await delay(250)
    if (settle !== undefined) settle(makeResult(101))
    await delay(50)

    expect(onResult).not.toHaveBeenCalled()
  })

  it('warns when the scheduler has been unable to acquire a permit while work is queued', async () => {
    const processFrame = vi.fn(() => new Promise<FrameResult | null>(() => {}))

    runner = createRunner(processFrame as any, {
      // Long enough that the timeout does NOT rescue us — the stall detector is
      // what has to speak up.
      inferenceTimeoutMs: 60_000,
      inferenceStallWarnMs: 150,
    })
    runner.registerCamera(101, { detectionMode: 'always-on', fps: 10 })
    runner.start()

    for (let i = 0; i < 6; i++) {
      runner.enqueueDetectionFrame(101, makeFrame(i), undefined)
      await delay(60)
    }
    await delay(200)

    const stall = logs.find((l) => /no inference permit/i.test(l.message))
    expect(stall).toBeDefined()
    expect(stall!.meta?.['queuedFrames']).toBeGreaterThan(0)
  })
})
