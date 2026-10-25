/**
 * The CAMERA as this camera's root step.
 *
 * The properties that make it a root step rather than a side channel:
 *  1. it takes NO inference permit — the accelerator is the thing this mode
 *     gives back;
 *  2. its boxes reach the SAME result callback, with the real decoded frame and
 *     the real handle, so everything downstream (subject tiles, birth evidence,
 *     the `detailSteps` announce, the overlay) applies unchanged;
 *  3. a silent camera produces NO result — not an empty one, which would tell
 *     the tracker every quiet frame is evidence of absence.
 */
import type { DecodedFrame, DetectionSource, FrameHandle, FrameResult } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { PipelineRunner } from '../runner.js'

function makeFrame(timestamp: number): DecodedFrame {
  return { data: Buffer.alloc(4), width: 640, height: 360, format: 'rgb', timestamp }
}

function makeHandle(seq: number): FrameHandle {
  return {
    shmId: 'ram:hub:1',
    slot: seq % 4,
    seq,
    width: 640,
    height: 360,
    format: 'rgb',
    pts: seq,
    byteLength: 0,
    nodeId: 'hub',
    slotCount: 8,
  }
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 40))

interface Captured {
  readonly result: FrameResult
  readonly handle: FrameHandle | undefined
  readonly source: DetectionSource
}

function bootRunner(detectionSources: readonly ('pipeline' | 'onboard')[] | undefined): {
  runner: PipelineRunner
  processFrame: ReturnType<typeof vi.fn>
  captured: Captured[]
} {
  const processFrame = vi.fn(
    async (): Promise<FrameResult> => ({
      kind: 'frame',
      frameId: 'ml',
      deviceId: 1,
      timestamp: 0,
      width: 640,
      height: 360,
      detections: [],
    }),
  )
  const captured: Captured[] = []
  const runner = new PipelineRunner({
    maxQueueDepth: 3,
    maxConcurrentInferences: 1,
    targetLoadPercent: 80,
    minThrottledFps: 1,
    processFrame,
    analyzeMotion: async () => undefined,
  })
  runner.onResult((_deviceId, _frame, result, _streamType, handle, source) => {
    captured.push({ result, handle, source })
  })
  runner.registerCamera(1, {
    detectionMode: 'always-on',
    fps: 10,
    ...(detectionSources !== undefined ? { detectionSources: [...detectionSources] } : {}),
  })
  runner.start()
  return { runner, processFrame, captured }
}

describe('the camera as root step', () => {
  it('never asks the accelerator, and delivers the camera boxes on the ordinary callback', async () => {
    const { runner, processFrame, captured } = bootRunner(['onboard'])
    runner.reportNativeDetection(1, [
      { class: 'person', timestamp: Date.now(), bbox: [0.25, 0.5, 0.1, 0.2] },
    ])
    runner.enqueueDetectionFrame(1, makeFrame(1), makeHandle(1))
    await settle()
    runner.stop()

    expect(processFrame).not.toHaveBeenCalled()
    expect(captured).toHaveLength(1)
    expect(captured[0]!.source).toBe('onboard')
    // The REAL handle: without it the detail subtree has no pixels to cut.
    expect(captured[0]!.handle?.seq).toBe(1)
    // Scaled to the DECODED frame, not a nominal size.
    expect(captured[0]!.result.detections?.[0]?.bbox).toEqual({
      x: 160,
      y: 180,
      width: 64,
      height: 72,
    })
  })

  it('a silent camera emits nothing — an empty result is a claim this path cannot make', async () => {
    const { runner, captured } = bootRunner(['onboard'])
    runner.enqueueDetectionFrame(1, makeFrame(1), makeHandle(1))
    await settle()
    runner.stop()
    expect(captured).toEqual([])
  })

  it('one push is pinned to ONE frame — a second frame does not re-use it', async () => {
    const { runner, captured } = bootRunner(['onboard'])
    runner.reportNativeDetection(1, [
      { class: 'person', timestamp: Date.now(), bbox: [0.25, 0.5, 0.1, 0.2] },
    ])
    runner.enqueueDetectionFrame(1, makeFrame(1), makeHandle(1))
    await settle()
    runner.enqueueDetectionFrame(1, makeFrame(2), makeHandle(2))
    await settle()
    runner.stop()
    expect(captured).toHaveLength(1)
  })

  it('an absent detectionSources runs the ML root step — unchanged behaviour', async () => {
    const { runner, processFrame, captured } = bootRunner(undefined)
    runner.enqueueDetectionFrame(1, makeFrame(1), makeHandle(1))
    await settle()
    runner.stop()
    expect(processFrame).toHaveBeenCalledTimes(1)
    expect(captured[0]?.source).toBe('pipeline')
  })

  it('a camera that names BOTH still runs the ML root step', async () => {
    const { runner, processFrame } = bootRunner(['pipeline', 'onboard'])
    runner.enqueueDetectionFrame(1, makeFrame(1), makeHandle(1))
    await settle()
    runner.stop()
    expect(processFrame).toHaveBeenCalledTimes(1)
  })

  // BOTH means both, on ONE frame result. Collecting the camera's boxes into
  // a slot that only the onboard-ONLY path ever reads is the shape of defect
  // D391 names: a branch that accepts work and produces nothing. It shipped
  // that way and the slot filled up for nothing.
  it('BOTH merges the camera boxes into the ML result, on one frame', async () => {
    const { runner, captured } = bootRunner(['pipeline', 'onboard'])
    runner.reportNativeDetection(1, [
      { class: 'animal', timestamp: Date.now(), bbox: [0.25, 0.5, 0.1, 0.2] },
    ])
    runner.enqueueDetectionFrame(1, makeFrame(1), makeHandle(1))
    await settle()
    runner.stop()

    expect(captured).toHaveLength(1)
    // The ML fake returns no detections, so anything here is the camera's.
    const classes = (captured[0]!.result.detections ?? []).map((d) => d.macroClass)
    expect(classes).toEqual(['animal'])
    // The result is still attributed to the plane that ROOTED it. A frame the
    // ML pass looked at is a pipeline frame that the camera also contributed
    // to — calling it 'onboard' would hide that the accelerator ran.
    expect(captured[0]!.source).toBe('pipeline')
  })

  it('BOTH does not re-use one push on the next frame either', async () => {
    const { runner, captured } = bootRunner(['pipeline', 'onboard'])
    runner.reportNativeDetection(1, [
      { class: 'animal', timestamp: Date.now(), bbox: [0.25, 0.5, 0.1, 0.2] },
    ])
    runner.enqueueDetectionFrame(1, makeFrame(1), makeHandle(1))
    await settle()
    runner.enqueueDetectionFrame(1, makeFrame(2), makeHandle(2))
    await settle()
    runner.stop()
    expect(captured).toHaveLength(2)
    expect(captured[1]!.result.detections ?? []).toEqual([])
  })

  it('releases the frame it decided not to use — a skipped frame is not a leaked slot', async () => {
    const releaseRetention = vi.fn()
    const processFrame = vi.fn()
    const runner = new PipelineRunner({
      maxQueueDepth: 3,
      maxConcurrentInferences: 1,
      targetLoadPercent: 80,
      minThrottledFps: 1,
      processFrame: processFrame as never,
      analyzeMotion: async () => undefined,
      releaseRetention,
    })
    runner.registerCamera(1, { detectionMode: 'always-on', fps: 10, detectionSources: ['onboard'] })
    runner.start()
    runner.enqueueDetectionFrame(1, makeFrame(1), makeHandle(1))
    await settle()
    runner.stop()
    expect(releaseRetention).toHaveBeenCalledWith(expect.objectContaining({ seq: 1 }), 'drop')
  })
})
