/**
 * Task 3 review BLOCK — runner retention lifecycle.
 * Production change that would fail these tests: leaving pending maps/refs
 * after overwrite/null/throw/timeout/detach, writing a store entry for a
 * no-detection result, or dropping a transferred detection in the runner finally.
 */
import type { DecodedFrame, FrameResult } from '@camstack/types'
import { makeObjectDetection } from '../../__tests__/support/object-detection.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LocalFrameRegistry } from '../../session-decode/local-frame-registry.js'
import { RetainedFrameStore } from '../../session-decode/retained-frame-store.js'
import type { FrameImage } from '../../session-decode/video-frame-generator.js'
import { FrameLazyTelemetry } from '../frame-lazy-metrics.js'
import { OnDemandRetentionSession } from '../on-demand-retention.js'
import type { RunnerConfig } from '../runner.js'
import { PipelineRunner } from '../runner.js'

function logger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child() {
      return this
    },
    withTags() {
      return this
    },
  }
}

function pixelFree(timestamp = 1): DecodedFrame {
  return { data: Buffer.alloc(0), width: 1920, height: 1080, format: 'rgb', timestamp }
}

function image(jpegBytes = 2048): FrameImage & { toBuffer: ReturnType<typeof vi.fn> } {
  return {
    width: 1920,
    height: 1080,
    format: 'rgb',
    toBuffer: vi.fn(async ({ format }: { format?: string } = {}) =>
      format === 'jpeg' ? new Uint8Array(jpegBytes) : new Uint8Array(640 * 360 * 3),
    ),
    close: vi.fn(),
    releaseNativeLease: vi.fn(),
  }
}

function result(detections: number): FrameResult {
  return {
    kind: 'frame',
    frameId: 'f',
    deviceId: 1,
    timestamp: 0,
    width: 640,
    height: 360,
    detections: Array.from({ length: detections }, (_, i) =>
      makeObjectDetection({ id: `d-${i}`, macroClass: 'person', score: 0.9 }),
    ),
    debug: { totalInferenceMs: 1 },
  }
}

function delay(ms = 40): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function harness(overrides: Partial<RunnerConfig> = {}) {
  const registry = new LocalFrameRegistry({
    registryId: 'local-process',
    maxFrames: 8,
    maxBytes: 10_000_000,
  })
  const retained = new RetainedFrameStore({
    nodeId: 'hub',
    logger: logger(),
    budgetBytes: 8_000_000,
    perDeviceFloor: 2,
    timeFloorMs: 0,
  })
  const telemetry = new FrameLazyTelemetry()
  const session = new OnDemandRetentionSession({
    store: retained,
    registry,
    telemetry,
    nodeId: 'hub',
    continuousRetain: false,
  })
  const processFrame = vi.fn().mockResolvedValue(result(0))
  const runner = new PipelineRunner({
    maxQueueDepth: 3,
    maxConcurrentInferences: 1,
    targetLoadPercent: 80,
    minThrottledFps: 1,
    analyzeMotion: async () => undefined,
    releaseFrameRef: (ref, reason) => registry.release(ref, reason),
    releaseRetention: (handle, reason) => session.release(handle, reason),
    processFrame,
    ...overrides,
  })
  runner.onResult((deviceId, _frame, frameResult, _stream, handle) => {
    session.noteInferenceResult(deviceId, handle, frameResult)
  })
  runner.registerCamera(1, { detectionMode: 'always-on', fps: 1000 })
  return { registry, retained, telemetry, session, processFrame, runner }
}

function admit(session: OnDemandRetentionSession, registry: LocalFrameRegistry, timestamp: number) {
  const img = image()
  const ref = registry.register(img, { timestamp })!
  const frame: DecodedFrame = { ...pixelFree(timestamp), frameRef: ref }
  const handle = session.admitFrame(1, frame)!
  return { frame, handle, ref, img }
}

describe('PipelineRunner retention lifecycle', () => {
  const runners: PipelineRunner[] = []

  afterEach(() => {
    for (const runner of runners) {
      runner.stop()
      runner.unregisterCamera(1)
    }
    runners.length = 0
  })

  it('queue overwrite drops the overwritten pending handle and leaves no store entry', () => {
    const { session, retained, registry, runner } = harness()
    runners.push(runner)
    const first = admit(session, registry, 1)
    const second = admit(session, registry, 2)
    expect(session.pendingSize).toBe(2)
    expect(runner.enqueueReservedDetectionFrame(1, first.frame, first.handle)).toBe(true)
    expect(runner.enqueueReservedDetectionFrame(1, second.frame, second.handle)).toBe(true)
    expect(session.pendingSize).toBe(1)
    expect(session.hasPending(first.handle)).toBe(false)
    expect(session.hasPending(second.handle)).toBe(true)
    expect(retained.size).toBe(0)
  })

  it('a null inference result leaves no pending map/refs and store size 0', async () => {
    const { session, retained, registry, runner, processFrame } = harness()
    runners.push(runner)
    processFrame.mockResolvedValue(null)
    const admitted = admit(session, registry, 1)
    runner.start()
    runner.enqueueReservedDetectionFrame(1, admitted.frame, admitted.handle)
    await delay()
    expect(session.pendingSize).toBe(0)
    expect(retained.size).toBe(0)
    expect(registry.size).toBe(0)
  })

  it('a thrown inference leaves no pending map/refs and store size 0', async () => {
    const { session, retained, registry, runner, processFrame } = harness()
    runners.push(runner)
    processFrame.mockRejectedValue(new Error('inference failed'))
    const admitted = admit(session, registry, 1)
    runner.start()
    runner.enqueueReservedDetectionFrame(1, admitted.frame, admitted.handle)
    await delay()
    expect(session.pendingSize).toBe(0)
    expect(retained.size).toBe(0)
    expect(registry.size).toBe(0)
  })

  it('an inference timeout leaves no pending map/refs and store size 0', async () => {
    const { session, retained, registry, runner, processFrame } = harness({
      inferenceTimeoutMs: 30,
    })
    runners.push(runner)
    processFrame.mockImplementation(() => new Promise(() => undefined))
    const admitted = admit(session, registry, 1)
    runner.start()
    runner.enqueueReservedDetectionFrame(1, admitted.frame, admitted.handle)
    await delay(80)
    expect(session.pendingSize).toBe(0)
    expect(retained.size).toBe(0)
    expect(registry.size).toBe(0)
  })

  it('detach of a queued frame leaves no pending map/refs and store size 0', () => {
    const { session, retained, registry, runner } = harness()
    runners.push(runner)
    const admitted = admit(session, registry, 1)
    expect(runner.enqueueReservedDetectionFrame(1, admitted.frame, admitted.handle)).toBe(true)
    expect(session.pendingSize).toBe(1)
    runner.unregisterCamera(1)
    expect(session.pendingSize).toBe(0)
    expect(retained.size).toBe(0)
    expect(registry.size).toBe(0)
  })

  it('a 0-detection result leaves store size 0', async () => {
    const { session, retained, registry, runner, processFrame } = harness()
    runners.push(runner)
    processFrame.mockResolvedValue(result(0))
    const admitted = admit(session, registry, 1)
    runner.start()
    runner.enqueueReservedDetectionFrame(1, admitted.frame, admitted.handle)
    await delay()
    expect(session.pendingSize).toBe(0)
    expect(retained.size).toBe(0)
    expect(await session.requestMedia(admitted.handle, { kind: 'full-frame' })).toMatchObject({
      tier: 'miss',
    })
  })

  it('a detection stays pullable after the runner finally (one bounded store entry)', async () => {
    const { session, retained, registry, runner, processFrame } = harness()
    runners.push(runner)
    processFrame.mockResolvedValue(result(1))
    const admitted = admit(session, registry, 1)
    runner.start()
    runner.enqueueReservedDetectionFrame(1, admitted.frame, admitted.handle)
    await delay()
    expect(session.pendingSize).toBe(0)
    expect(retained.size).toBe(1)
    const served = await session.requestMedia(admitted.handle, { kind: 'full-frame' })
    expect(served.tier).toBe('fallback-jpeg')
    expect(served.jpeg?.byteLength).toBe(2048)
  })
})
