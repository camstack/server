/**
 * The PRE-ROLL lane and the one rule that makes it safe: live always wins.
 *
 * A catch-up burst is a one-shot at session open. It rides a queue of its own
 * because the live detection queue is LATEST-ONLY by design
 * (`frame-queue.ts`) — pushing tens of history frames through it would leave
 * exactly one, which is the second of the three gates that kills the pre-roll
 * today. And it is drained only when the camera has no live frame waiting, so
 * a pre-roll frame can never delay a live one.
 */
import type { DecodedFrame, FrameResult } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunnerConfig } from '../runner.js'
import { PipelineRunner } from '../runner.js'

function makeFrame(timestamp: number, capturedAt?: number): DecodedFrame {
  return {
    data: Buffer.alloc(4),
    width: 640,
    height: 480,
    format: 'jpeg',
    timestamp,
    ...(capturedAt !== undefined ? { capturedAt } : {}),
  }
}

function makeResult(): FrameResult {
  return {
    kind: 'frame',
    frameId: 'test-frame',
    deviceId: 102,
    timestamp: 0,
    width: 640,
    height: 480,
    detections: [],
    debug: { totalInferenceMs: 10 },
  }
}

describe('PipelineRunner — pre-roll catch-up lane', () => {
  let runner: PipelineRunner
  let processFrame: ReturnType<typeof vi.fn>

  beforeEach(() => {
    processFrame = vi.fn().mockResolvedValue(makeResult())
  })

  afterEach(() => {
    runner?.stop()
  })

  function createRunner(overrides: Partial<RunnerConfig> = {}): PipelineRunner {
    return new PipelineRunner({
      maxQueueDepth: 3,
      maxConcurrentInferences: 4,
      targetLoadPercent: 100,
      minThrottledFps: 30,
      processFrame: processFrame as unknown as RunnerConfig['processFrame'],
      analyzeMotion: vi.fn() as unknown as RunnerConfig['analyzeMotion'],
      ...overrides,
    })
  }

  async function settle(): Promise<void> {
    for (let i = 0; i < 40; i++) await new Promise<void>((r) => setTimeout(r, 5))
  }

  it('KEEPS a burst of pre-roll frames instead of collapsing it to the newest', async () => {
    // This is the whole point. The live queue is latest-only: ten frames in one
    // turn leave one. The pre-roll lane is a bounded FIFO, so all ten survive
    // to inference.
    runner = createRunner()
    runner.registerCamera(102, { detectionMode: 'always-on', fps: 10 })
    for (let i = 0; i < 10; i++) {
      expect(runner.enqueuePreRollFrame(102, makeFrame(i), undefined)).toBe(true)
    }
    expect(runner.preRollQueueDepth(102)).toBe(10)
    runner.start()
    await settle()
    expect(processFrame).toHaveBeenCalledTimes(10)
  })

  it('is BOUNDED — a FIFO that is full refuses rather than growing', () => {
    runner = createRunner({ maxPreRollQueueDepth: 3 })
    runner.registerCamera(102, { detectionMode: 'always-on', fps: 10 })
    expect(runner.enqueuePreRollFrame(102, makeFrame(1), undefined)).toBe(true)
    expect(runner.enqueuePreRollFrame(102, makeFrame(2), undefined)).toBe(true)
    expect(runner.enqueuePreRollFrame(102, makeFrame(3), undefined)).toBe(true)
    expect(runner.enqueuePreRollFrame(102, makeFrame(4), undefined)).toBe(false)
    expect(runner.preRollQueueDepth(102)).toBe(3)
  })

  it('serves the LIVE frame first — a pre-roll frame never delays one', async () => {
    // One permit, so the scheduler makes exactly one choice per tick and the
    // order it picks is observable. A live frame is waiting alongside a full
    // pre-roll lane: the live frame must go first.
    runner = createRunner({ maxConcurrentInferences: 1 })
    runner.registerCamera(102, { detectionMode: 'always-on', fps: 10 })
    for (let i = 0; i < 5; i++) runner.enqueuePreRollFrame(102, makeFrame(100 + i), undefined)
    runner.enqueueDetectionFrame(102, makeFrame(999), undefined)
    runner.start()
    await settle()
    const firstTimestamp = processFrame.mock.calls[0]?.[1]?.timestamp
    expect(firstTimestamp).toBe(999)
  })

  it('leaves an inference permit for live — a burst cannot take the last one', () => {
    // Several cameras opening on the same motion event must not be able to
    // occupy every permit with history. The lane refuses to dispatch unless a
    // permit would still be spare afterwards.
    runner = createRunner({ maxConcurrentInferences: 1 })
    runner.registerCamera(102, { detectionMode: 'always-on', fps: 10 })
    runner.enqueuePreRollFrame(102, makeFrame(1), undefined)
    expect(runner.preRollDispatchable()).toBe(false)

    runner = createRunner({ maxConcurrentInferences: 2 })
    runner.registerCamera(102, { detectionMode: 'always-on', fps: 10 })
    expect(runner.preRollDispatchable()).toBe(true)
  })

  it('a pre-roll frame carries its OWN capture moment through to the result', async () => {
    runner = createRunner()
    runner.registerCamera(102, { detectionMode: 'always-on', fps: 10 })
    const seen: Array<number | undefined> = []
    runner.onResult((_deviceId, frame) => {
      seen.push(frame.capturedAt)
    })
    // 1.68 s before now — the frame on which the cyclist scored 0.5669.
    runner.enqueuePreRollFrame(102, makeFrame(1, 1_788_900_482_710), undefined)
    runner.start()
    await settle()
    expect(seen).toEqual([1_788_900_482_710])
  })

  it('forgets the lane when the camera detaches', () => {
    runner = createRunner()
    runner.registerCamera(102, { detectionMode: 'always-on', fps: 10 })
    runner.enqueuePreRollFrame(102, makeFrame(1), undefined)
    runner.unregisterCamera(102)
    expect(runner.preRollQueueDepth(102)).toBe(0)
    expect(runner.enqueuePreRollFrame(102, makeFrame(2), undefined)).toBe(false)
  })
})
