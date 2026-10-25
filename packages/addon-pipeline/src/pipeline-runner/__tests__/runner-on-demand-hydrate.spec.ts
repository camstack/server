/**
 * Task 3 — eager retained hydrate is rollback-only. A detection-free success
 * must not materialize media; CAMSTACK_CONTINUOUS_RETAIN=1 restores the
 * previous post-success hydrate.
 */
import type { DecodedFrame, FrameHandle, FrameResult } from '@camstack/types'
import { makeObjectDetection } from '../../__tests__/support/object-detection.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CAMSTACK_CONTINUOUS_RETAIN } from '../on-demand-retention.js'
import { PipelineRunner } from '../runner.js'

function makeFrame(timestamp: number): DecodedFrame {
  return { data: Buffer.alloc(4), width: 4, height: 4, format: 'rgb', timestamp }
}

function makeHandle(seq: number): FrameHandle {
  return {
    shmId: `ram:hub:1`,
    slot: seq % 4,
    seq,
    width: 4,
    height: 4,
    format: 'rgb',
    pts: seq,
    byteLength: 0,
    nodeId: 'hub',
    slotCount: 8,
  }
}

function makeResult(detections: number): FrameResult {
  return {
    kind: 'frame',
    frameId: 'test-frame',
    deviceId: 1,
    timestamp: 0,
    width: 4,
    height: 4,
    detections: Array.from({ length: detections }, (_, i) =>
      makeObjectDetection({ id: `d-${i}`, macroClass: 'person', score: 0.9 }),
    ),
    debug: { totalInferenceMs: 1 },
  }
}

const delay = () => new Promise<void>((resolve) => setTimeout(resolve, 40))

describe('PipelineRunner on-demand hydrate', () => {
  const prev = process.env[CAMSTACK_CONTINUOUS_RETAIN]
  afterEach(() => {
    if (prev === undefined) delete process.env[CAMSTACK_CONTINUOUS_RETAIN]
    else process.env[CAMSTACK_CONTINUOUS_RETAIN] = prev
  })

  it('does not hydrate retained pixels after a detection-free success', async () => {
    const hydrateRetainedFrame = vi.fn().mockResolvedValue(null)
    const runner = new PipelineRunner({
      maxQueueDepth: 3,
      maxConcurrentInferences: 1,
      targetLoadPercent: 80,
      minThrottledFps: 1,
      processFrame: async () => makeResult(0),
      analyzeMotion: async () => undefined,
      hydrateRetainedFrame,
    })
    runner.registerCamera(1, { detectionMode: 'always-on', fps: 10 })
    runner.start()
    runner.enqueueDetectionFrame(1, makeFrame(1), makeHandle(1))
    await delay()
    runner.stop()
    expect(hydrateRetainedFrame).not.toHaveBeenCalled()
  })

  it('restores post-success hydrate when continuous retain rollback is on', async () => {
    process.env[CAMSTACK_CONTINUOUS_RETAIN] = '1'
    const hydrateRetainedFrame = vi.fn().mockResolvedValue(null)
    const runner = new PipelineRunner({
      maxQueueDepth: 3,
      maxConcurrentInferences: 1,
      targetLoadPercent: 80,
      minThrottledFps: 1,
      processFrame: async () => makeResult(0),
      analyzeMotion: async () => undefined,
      hydrateRetainedFrame,
    })
    runner.registerCamera(1, { detectionMode: 'always-on', fps: 10 })
    runner.start()
    runner.enqueueDetectionFrame(1, makeFrame(2), makeHandle(2))
    await delay()
    runner.stop()
    expect(hydrateRetainedFrame).toHaveBeenCalledOnce()
  })
})
