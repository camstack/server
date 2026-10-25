/**
 * Task 7 — `FrameHandle` propagates through the pipeline.
 *
 * Drives a `DecodedFrame` + `FrameHandle` pair through the runner's
 * detection seam (`enqueueDetectionFrame` → `onResult` chain →
 * `emitInferenceResult`) and asserts the emitted
 * `PipelineInferenceResultPayload` carries the same handle on its
 * `frameHandle` field. Post-analysis consumers (Task 8) resolve the
 * decoded frame back from this handle.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- test file: vi.fn() mocks need narrow casts to match callback signatures */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { PipelineRunner } from '../runner.js'
import type { DecodedFrame, FrameHandle, FrameResult, SystemEvent } from '@camstack/types'
import { EventCategory } from '@camstack/types'

function makeFrame(timestamp: number): DecodedFrame {
  return {
    data: Buffer.alloc(4),
    width: 4,
    height: 4,
    format: 'rgb',
    timestamp,
  }
}

function makeHandle(seq: number): FrameHandle {
  return {
    shmId: `csf.test.${seq}`,
    slot: seq % 4,
    seq,
    width: 4,
    height: 4,
    format: 'rgb',
    pts: seq,
    byteLength: 4 * 4 * 3,
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
    width: 4,
    height: 4,
    detections: [],
    debug: { totalInferenceMs: 1 },
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe('PipelineRunner — FrameHandle propagation (Task 7)', () => {
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

  function createRunner(): PipelineRunner {
    return new PipelineRunner({
      maxQueueDepth: 3,
      maxConcurrentInferences: 2,
      targetLoadPercent: 80,
      minThrottledFps: 1,
      processFrame: processFrame as any,
      analyzeMotion: analyzeMotion as any,
    })
  }

  it('onResult callback receives the FrameHandle paired with the detection frame', async () => {
    runner = createRunner()
    runner.registerCamera(1, { detectionMode: 'always-on', fps: 10 })

    const seen: Array<{
      deviceId: number
      frame: DecodedFrame
      result: FrameResult
      handle: FrameHandle | undefined
    }> = []
    runner.onResult((deviceId, frame, result, _streamType, handle) => {
      seen.push({ deviceId, frame, result, handle })
    })

    const frame = makeFrame(1234)
    const handle = makeHandle(42)
    runner.enqueueDetectionFrame(1, frame, handle)
    runner.start()

    await delay(150)

    expect(seen).toHaveLength(1)
    expect(seen[0]!.deviceId).toBe(1)
    expect(seen[0]!.handle).toBeDefined()
    expect(seen[0]!.handle).toEqual(handle)
  })

  // ── CB5 shm FrameHandle passthrough — queue-depth / load gate ──────

  it('hands the shm FrameHandle to processFrame when a spare inference permit is available', async () => {
    runner = createRunner() // maxConcurrentInferences: 2
    runner.registerCamera(1, { detectionMode: 'always-on', fps: 10 })

    const handle = makeHandle(11)
    runner.enqueueDetectionFrame(1, makeFrame(11), handle)
    runner.start()

    await delay(150)

    expect(processFrame).toHaveBeenCalledTimes(1)
    const call = processFrame.mock.calls[0]!
    expect(call[0]).toBe(1)
    // 3rd arg is the passthrough handle — present because a permit was free.
    expect(call[2]).toEqual(handle)
  })

  it('falls back to copying pixels (undefined handle) when the inference semaphore is saturated', async () => {
    // Latest-only detection queue ⇒ raw queue depth is 0/1; the operative
    // backpressure signal is semaphore saturation. maxConcurrentInferences: 1
    // means the sole permit is consumed at dispatch → the gate ships pixels.
    runner = new PipelineRunner({
      maxQueueDepth: 3,
      maxConcurrentInferences: 1,
      targetLoadPercent: 80,
      minThrottledFps: 1,
      processFrame: processFrame as any,
      analyzeMotion: analyzeMotion as any,
    })
    runner.registerCamera(1, { detectionMode: 'always-on', fps: 10 })

    runner.enqueueDetectionFrame(1, makeFrame(12), makeHandle(12))
    runner.start()

    await delay(150)

    expect(processFrame).toHaveBeenCalledTimes(1)
    // No spare permit ⇒ pixel fallback ⇒ no handle handed to the executor.
    expect(processFrame.mock.calls[0]![2]).toBeUndefined()
    // The pixel FrameInput is always supplied so the fallback path works.
    expect(processFrame.mock.calls[0]![1]).toBeDefined()
  })

  it('carries the shm FrameHandle onto the motion queue → analyzeMotion', async () => {
    runner = createRunner()
    runner.registerCamera(1, { detectionMode: 'on-motion', fps: 10 })

    const handle = makeHandle(13)
    runner.enqueueMotionFrame(1, makeFrame(13), handle)
    runner.start()

    await delay(150)

    expect(analyzeMotion).toHaveBeenCalledTimes(1)
    const call = analyzeMotion.mock.calls[0]!
    expect(call[0]).toBe(1)
    // Motion drains on the scheduler tick — the handle is carried unchanged.
    expect(call[2]).toEqual(handle)
  })

  it('enqueues a motion frame with an undefined handle (foreign / remote-fallback source)', async () => {
    runner = createRunner()
    runner.registerCamera(1, { detectionMode: 'on-motion', fps: 10 })

    runner.enqueueMotionFrame(1, makeFrame(14), undefined)
    runner.start()

    await delay(150)

    expect(analyzeMotion).toHaveBeenCalledTimes(1)
    expect(analyzeMotion.mock.calls[0]![2]).toBeUndefined()
  })
})

// ── Addon-level emission ───────────────────────────────────────────
//
// Drive the runner's `onResult` chain inside the `PipelineRunnerAddon`
// and assert that `emitInferenceResult` puts `frameHandle` on the
// emitted `PipelineInferenceResultPayload`.

describe('PipelineRunnerAddon — emitInferenceResult carries frameHandle', () => {
  it('emits PipelineInferenceResult with frameHandle equal to the input handle', async () => {
    const { default: PipelineRunnerAddon } = await import('../index.js')

    const emitted: SystemEvent[] = []
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      child: vi.fn(function (this: unknown) {
        return this
      }),
      withTags: vi.fn(function (this: unknown) {
        return this
      }),
    }
    const ctx = {
      id: 'pipeline-runner',
      logger,
      kernel: { localNodeId: 'hub' },
      eventBus: {
        emit: (e: SystemEvent) => {
          emitted.push(e)
        },
        subscribe: () => () => {},
        getRecent: () => [],
      },
      api: {
        pipelineExecutor: {
          runFrame: { mutate: vi.fn() },
          runPipeline: { mutate: vi.fn().mockResolvedValue(makePipelineResult()) },
        },
        streamBroker: {},
      },
      settings: {
        readAddonStore: vi.fn(async () => ({})),
        writeAddonStore: vi.fn(async () => undefined),
        readDeviceStore: vi.fn(async () => ({})),
        writeDeviceStore: vi.fn(async () => undefined),
        getSection: vi.fn(async () => ({})),
        setSection: vi.fn(async () => undefined),
      },
    }

    const addon = new PipelineRunnerAddon()
    Object.defineProperty(addon, 'ctx', { value: ctx, configurable: true })

    interface AddonInternals {
      onInitialize(): Promise<unknown>
      emitInferenceResult(
        deviceId: number,
        frame: DecodedFrame,
        result: FrameResult,
        handle: FrameHandle | undefined,
      ): void
    }
    const internals = addon as unknown as AddonInternals
    await internals.onInitialize()

    const handle = makeHandle(7)
    const frame = makeFrame(5000)
    const result = makePipelineResult()

    internals.emitInferenceResult(1, frame, result, handle)

    const inferenceEvents = emitted.filter(
      (e) => e.category === EventCategory.PipelineInferenceResult,
    )
    expect(inferenceEvents).toHaveLength(1)
    const data = inferenceEvents[0]!.data as {
      deviceId: number
      frame: FrameResult
      nodeId: string
      frameHandle?: FrameHandle
    }
    expect(data.deviceId).toBe(1)
    expect(data.frame).toEqual(result)
    expect(data.nodeId).toBe('hub')
    expect(data.frameHandle).toEqual(handle)

    await addon.shutdown().catch(() => {
      /* ignore */
    })
  })
})
