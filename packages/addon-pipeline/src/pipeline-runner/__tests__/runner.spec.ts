/* eslint-disable @typescript-eslint/no-explicit-any -- test file: vi.fn() mocks need narrow casts to match callback signatures */
/* eslint-disable @typescript-eslint/no-unsafe-assignment -- test file: same as above */

import type { DecodedFrame, FrameHandle, FrameResult } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DetectionStreamHandler, RunnerConfig } from '../runner.js'
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

/**
 * Stub `FrameHandle` for tests that exercise the scheduler path but
 * don't care about the handle's contents — the runner threads it
 * through unchanged.
 */
function makeHandle(seq: number): FrameHandle {
  return {
    shmId: `csf.runner-test.${seq}`,
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe('PipelineRunner', () => {
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
      targetLoadPercent: 80,
      minThrottledFps: 1,
      processFrame: processFrame as any,
      analyzeMotion: analyzeMotion as any,
      ...overrides,
    })
  }

  it('registers and unregisters cameras with correct metrics', () => {
    runner = createRunner()
    runner.registerCamera(1, { detectionMode: 'on-motion', fps: 10 })
    runner.registerCamera(2, { detectionMode: 'always-on', fps: 5 })

    expect(runner.getMetrics().activeCameras).toBe(2)

    runner.unregisterCamera(1)
    expect(runner.getMetrics().activeCameras).toBe(1)
  })

  it('returns camera-level metrics for a registered camera', () => {
    runner = createRunner()
    runner.registerCamera(1, { detectionMode: 'on-motion', fps: 10 })

    const cm = runner.getCameraMetrics(1)
    expect(cm).toBeDefined()
    expect(cm!.detectionMode).toBe('on-motion')
    expect(cm!.configuredFps).toBe(10)
    expect(cm!.queueDepth).toBe(0)
    expect(cm!.droppedFrames).toBe(0)
  })

  it('returns undefined metrics for an unregistered camera', () => {
    runner = createRunner()
    expect(runner.getCameraMetrics(999)).toBeUndefined()
  })

  it('processes enqueued motion frames via analyzeMotion (not inference)', async () => {
    runner = createRunner()
    runner.registerCamera(1, { detectionMode: 'on-motion', fps: 10 })
    runner.start()

    const frame = makeFrame(100)
    // CB5: enqueueMotionFrame carries the shm FrameHandle (undefined here — no
    // handle in this legacy path) and analyzeMotion receives it as a 3rd arg.
    runner.enqueueMotionFrame(1, frame, undefined)

    await delay(100)

    expect(analyzeMotion).toHaveBeenCalledWith(1, frame, undefined)
    expect(processFrame).not.toHaveBeenCalled()
  })

  it('motion analysis is single-flight per camera (no RPC pile-up while one is in flight)', async () => {
    // First analyzeMotion hangs until released; frames arriving while it is in
    // flight must NOT spawn concurrent calls — the latest-only queue coalesces
    // them and the freshest is processed on release.
    let releaseFirst: (() => void) | undefined
    const firstInFlight = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let callCount = 0
    analyzeMotion.mockImplementation(async () => {
      callCount++
      if (callCount === 1) await firstInFlight
    })

    runner = createRunner()
    runner.registerCamera(1, { detectionMode: 'on-motion', fps: 10 })
    runner.start()

    runner.enqueueMotionFrame(1, makeFrame(1), undefined)
    await delay(50)
    expect(callCount).toBe(1) // first call is in flight

    // Two more frames land while the first is pending. Fire-and-forget (pre-#9)
    // drains each on its own tick → callCount climbs. Single-flight holds at 1.
    runner.enqueueMotionFrame(1, makeFrame(2), undefined)
    runner.enqueueMotionFrame(1, makeFrame(3), undefined)
    await delay(50)
    expect(callCount).toBe(1) // still exactly one in flight — no pile-up

    // Release the in-flight call; the coalesced latest frame is now processed.
    releaseFirst?.()
    await delay(50)
    expect(callCount).toBe(2)
  })

  it('prioritizes always-on cameras over default cameras', async () => {
    const callOrder: string[] = []
    processFrame.mockImplementation(async (deviceId: string) => {
      callOrder.push(deviceId)
      return makePipelineResult()
    })

    runner = createRunner({ maxConcurrentInferences: 1 })
    runner.registerCamera(10, { detectionMode: 'on-motion', fps: 10 })
    runner.registerCamera(11, { detectionMode: 'always-on', fps: 10 })

    runner.reportMotion(10, true)

    runner.enqueueDetectionFrame(10, makeFrame(1), makeHandle(1))
    runner.enqueueDetectionFrame(11, makeFrame(2), makeHandle(2))

    runner.start()
    await delay(150)

    expect(callOrder[0]).toBe(11)
    expect(callOrder[1]).toBe(10)
  })

  it('isolates errors in onResult callbacks', async () => {
    runner = createRunner()
    runner.registerCamera(1, { detectionMode: 'on-motion', fps: 10 })

    const failingCallback = vi.fn().mockRejectedValue(new Error('callback error'))
    const successCallback = vi.fn()

    runner.onResult(failingCallback)
    runner.onResult(successCallback)

    runner.reportMotion(1, true)
    runner.start()
    runner.enqueueDetectionFrame(1, makeFrame(1), makeHandle(1))

    await delay(100)

    expect(failingCallback).toHaveBeenCalled()
    expect(successCallback).toHaveBeenCalled()
  })

  it('ignores frames for unregistered cameras', () => {
    runner = createRunner()
    runner.enqueueMotionFrame(999, makeFrame(1), undefined)
    runner.enqueueDetectionFrame(999, makeFrame(1), makeHandle(1))
    expect(runner.getMetrics().activeCameras).toBe(0)
  })

  it('clears state when unregistering a camera', () => {
    runner = createRunner()
    runner.registerCamera(1, { detectionMode: 'on-motion', fps: 10 })
    runner.enqueueMotionFrame(1, makeFrame(1), undefined)

    runner.unregisterCamera(1)
    expect(runner.getMetrics().activeCameras).toBe(0)
    expect(runner.getCameraMetrics(1)).toBeUndefined()
  })

  it('exposes attached camera ids', () => {
    runner = createRunner()
    runner.registerCamera(1, { detectionMode: 'on-motion', fps: 10 })
    runner.registerCamera(2, { detectionMode: 'always-on', fps: 5 })
    expect([...runner.getAttachedCameras()].toSorted()).toEqual([1, 2])
  })
})

describe('PipelineRunner — phase machine', () => {
  let runner: PipelineRunner
  let detectionStreamHandler: ReturnType<typeof vi.fn> & DetectionStreamHandler
  let processFrame: ReturnType<typeof vi.fn>
  let analyzeMotion: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.useFakeTimers()
    processFrame = vi.fn().mockResolvedValue(makePipelineResult())
    analyzeMotion = vi.fn().mockResolvedValue(undefined)
    detectionStreamHandler = vi.fn() as any
  })

  afterEach(() => {
    runner?.stop()
    vi.useRealTimers()
  })

  function createRunner(overrides: Partial<RunnerConfig> = {}): PipelineRunner {
    const r = new PipelineRunner({
      maxQueueDepth: 3,
      maxConcurrentInferences: 2,
      targetLoadPercent: 80,
      minThrottledFps: 1,
      processFrame: processFrame as any,
      analyzeMotion: analyzeMotion as any,
      ...overrides,
    })
    r.onDetectionStreamChange(detectionStreamHandler)
    return r
  }

  it('default camera starts in WATCHING phase', () => {
    runner = createRunner()
    runner.registerCamera(1, { detectionMode: 'on-motion', fps: 10 })

    expect(runner.getPhase(1)).toBe('watching')
    expect(detectionStreamHandler).not.toHaveBeenCalled()
  })

  it('always-on camera starts in ACTIVE phase', () => {
    runner = createRunner()
    runner.registerCamera(1, { detectionMode: 'always-on', fps: 10 })

    expect(runner.getPhase(1)).toBe('active')
    expect(detectionStreamHandler).toHaveBeenCalledWith(1, 'subscribe')
  })

  it('reportMotion(true) transitions WATCHING → ACTIVE', () => {
    runner = createRunner()
    runner.registerCamera(1, { detectionMode: 'on-motion', fps: 10 })

    runner.reportMotion(1, true)

    expect(runner.getPhase(1)).toBe('active')
    expect(detectionStreamHandler).toHaveBeenCalledWith(1, 'subscribe')
  })

  it('single reportMotion(true) arms cooldown; expiry transitions to WATCHING', () => {
    runner = createRunner()
    runner.registerCamera(1, {
      detectionMode: 'on-motion',
      fps: 10,
      motionCooldownMs: 10_000,
    })

    runner.reportMotion(1, true)
    expect(runner.getPhase(1)).toBe('active')
    detectionStreamHandler.mockClear()

    // No further events → timer expires after the cooldown window.
    vi.advanceTimersByTime(10_000)

    expect(runner.getPhase(1)).toBe('watching')
    expect(detectionStreamHandler).toHaveBeenCalledWith(1, 'unsubscribe')
  })

  it('reportMotion(false) is a no-op (timer keeps running, no cooldown trigger)', () => {
    runner = createRunner()
    runner.registerCamera(1, {
      detectionMode: 'on-motion',
      fps: 10,
      motionCooldownMs: 10_000,
    })

    runner.reportMotion(1, true)
    expect(runner.getPhase(1)).toBe('active')

    // detected:false should NOT shorten or cancel the cooldown.
    runner.reportMotion(1, false)
    vi.advanceTimersByTime(9_999)
    expect(runner.getPhase(1)).toBe('active')

    vi.advanceTimersByTime(2)
    expect(runner.getPhase(1)).toBe('watching')
  })

  it('repeated reportMotion(true) calls rearm the timer (single shared timer)', () => {
    runner = createRunner()
    runner.registerCamera(1, {
      detectionMode: 'on-motion',
      fps: 10,
      motionCooldownMs: 10_000,
    })

    runner.reportMotion(1, true)
    vi.advanceTimersByTime(5_000)

    // Timer would expire 5s from now; rearming pushes expiry 10s out.
    runner.reportMotion(1, true)
    vi.advanceTimersByTime(5_000)
    expect(runner.getPhase(1)).toBe('active')

    // Another 5s — total 10s since the last rearm — and we drop.
    vi.advanceTimersByTime(5_000)
    expect(runner.getPhase(1)).toBe('watching')
  })

  it('reportMotion is ignored for always-on cameras', () => {
    runner = createRunner()
    runner.registerCamera(1, { detectionMode: 'always-on', fps: 10 })

    detectionStreamHandler.mockClear()

    runner.reportMotion(1, false)
    vi.advanceTimersByTime(20_000)

    expect(runner.getPhase(1)).toBe('active')
    expect(detectionStreamHandler).not.toHaveBeenCalled()
  })

  it('detection frames are dropped when WATCHING', () => {
    runner = createRunner()
    runner.registerCamera(1, { detectionMode: 'on-motion', fps: 10 })

    runner.enqueueDetectionFrame(1, makeFrame(1), makeHandle(1))
    expect(runner.getCameraMetrics(1)!.queueDepth).toBe(0)
  })

  it('detection frames are accepted when ACTIVE', () => {
    runner = createRunner()
    runner.registerCamera(1, { detectionMode: 'on-motion', fps: 10 })

    runner.reportMotion(1, true)
    runner.enqueueDetectionFrame(1, makeFrame(1), makeHandle(1))

    expect(runner.getCameraMetrics(1)!.queueDepth).toBe(1)
  })

  it('unregisterCamera clears cooldown timer and unsubscribes detection', () => {
    runner = createRunner()
    runner.registerCamera(1, {
      detectionMode: 'on-motion',
      fps: 10,
      motionCooldownMs: 10_000,
    })

    runner.reportMotion(1, true)
    runner.reportMotion(1, false)

    detectionStreamHandler.mockClear()
    runner.unregisterCamera(1)

    vi.advanceTimersByTime(20_000)

    expect(runner.getPhase(1)).toBeUndefined()
    expect(detectionStreamHandler).toHaveBeenCalledWith(1, 'unsubscribe')
  })

  it('camera metrics include phase information', () => {
    runner = createRunner()
    runner.registerCamera(1, { detectionMode: 'on-motion', fps: 10 })

    expect(runner.getCameraMetrics(1)!.phase).toBe('watching')
    runner.reportMotion(1, true)
    expect(runner.getCameraMetrics(1)!.phase).toBe('active')
  })

  it('uses the default cooldown (30s) when motionCooldownMs is not specified', () => {
    // `DEFAULT_MOTION_COOLDOWN_MS` in `runner.ts` is 30_000 — aligned with the
    // `motionCooldownMsField.default` in `pipeline-runner.cap.ts`. (This test
    // previously asserted a stale 15s value and was never run before the
    // package gained a `test` target in Phase 5 / D9 Task 9.)
    runner = createRunner()
    runner.registerCamera(1, { detectionMode: 'on-motion', fps: 10 })

    runner.reportMotion(1, true)

    vi.advanceTimersByTime(29_900)
    expect(runner.getPhase(1)).toBe('active')

    vi.advanceTimersByTime(200)
    expect(runner.getPhase(1)).toBe('watching')
  })

  // ── Source attribution + onPhaseChanged callback ─────────────────────

  it('mixed sources rearm the same shared timer', () => {
    runner = createRunner()
    runner.registerCamera(1, {
      detectionMode: 'on-motion',
      fps: 10,
      motionCooldownMs: 10_000,
    })

    runner.reportMotion(1, true, 'analyzer')
    vi.advanceTimersByTime(8_000)
    runner.reportMotion(1, true, 'onboard')

    // Onboard rearmed the same timer 2s before analyzer expiry —
    // expiry should now land 10s from the onboard ping, not 2s.
    vi.advanceTimersByTime(8_000)
    expect(runner.getPhase(1)).toBe('active')

    vi.advanceTimersByTime(2_500)
    expect(runner.getPhase(1)).toBe('watching')
  })

  it('onPhaseChanged emits source + regions on ON, source + no regions on OFF', () => {
    const onPhaseChanged = vi.fn()
    const r = new PipelineRunner({
      maxQueueDepth: 3,
      maxConcurrentInferences: 2,
      targetLoadPercent: 80,
      minThrottledFps: 1,
      processFrame: processFrame as any,
      analyzeMotion: analyzeMotion as any,
      onPhaseChanged,
    })
    r.onDetectionStreamChange(detectionStreamHandler)
    r.registerCamera(1, {
      detectionMode: 'on-motion',
      fps: 10,
      motionCooldownMs: 5_000,
    })

    const regions: import('@camstack/types').MotionRegion[] = [
      {
        bbox: { x: 0, y: 0, w: 0.1, h: 0.1 },
        pixelCount: 42,
        intensity: 0.7,
      },
    ]
    r.reportMotion(1, true, 'analyzer', regions)

    expect(onPhaseChanged).toHaveBeenCalledTimes(1)
    expect(onPhaseChanged.mock.calls[0]![0]).toBe(1)
    expect(onPhaseChanged.mock.calls[0]![1]).toBe('active')
    expect(onPhaseChanged.mock.calls[0]![2]).toMatchObject({
      source: 'analyzer',
      regions,
      cooldownMs: 5_000,
    })

    vi.advanceTimersByTime(5_001)

    expect(onPhaseChanged).toHaveBeenCalledTimes(2)
    expect(onPhaseChanged.mock.calls[1]![1]).toBe('watching')
    expect(onPhaseChanged.mock.calls[1]![2]).toMatchObject({
      source: 'analyzer', // last source that armed the timer
      regions: undefined, // OFF transitions don't carry regions
    })

    r.stop()
  })

  it('OFF transition source reflects the LAST source that armed the timer', () => {
    const onPhaseChanged = vi.fn()
    const r = new PipelineRunner({
      maxQueueDepth: 3,
      maxConcurrentInferences: 2,
      targetLoadPercent: 80,
      minThrottledFps: 1,
      processFrame: processFrame as any,
      analyzeMotion: analyzeMotion as any,
      onPhaseChanged,
    })
    r.registerCamera(1, {
      detectionMode: 'on-motion',
      fps: 10,
      motionCooldownMs: 5_000,
    })

    r.reportMotion(1, true, 'analyzer')
    vi.advanceTimersByTime(2_000)
    r.reportMotion(1, true, 'onboard')
    vi.advanceTimersByTime(5_001)

    // First call: ON (analyzer). Second call: ON (onboard, rearm — same phase).
    // Wait — same phase rearm produces no extra ON event because phase
    // didn't change. Only the OFF event should reflect 'onboard'.
    const offCall = onPhaseChanged.mock.calls.find((c) => c[1] === 'watching')!
    expect(offCall[2]).toMatchObject({ cause: 'motion', source: 'onboard' })

    r.stop()
  })

  // ── Attach / detach transitions (2026-10-06) ─────────────────────────
  //
  // Every on-motion detection SESSION attaches always-on. The attach used to
  // claim `source: 'analyzer'` and the detach emitted nothing, so the live
  // phase badge latched "Active" from one session to the next and the events
  // list blamed the analyzer on onboard-only cameras.

  it('an attach with no session trigger emits ACTIVE with cause attach and names no source', () => {
    const onPhaseChanged = vi.fn()
    runner = createRunner({ onPhaseChanged })
    runner.registerCamera(1, { detectionMode: 'always-on', fps: 10 })

    expect(onPhaseChanged).toHaveBeenCalledTimes(1)
    expect(onPhaseChanged.mock.calls[0]![1]).toBe('active')
    const meta = onPhaseChanged.mock.calls[0]![2] as Record<string, unknown>
    expect(meta['cause']).toBe('attach')
    expect(meta).not.toHaveProperty('source')
    expect(meta).not.toHaveProperty('trigger')
    expect(meta).not.toHaveProperty('cooldownMs')
  })

  it('a SESSION attach names the motion that opened it — camera or attached sensor', () => {
    const onPhaseChanged = vi.fn()
    runner = createRunner({ onPhaseChanged })
    runner.registerCamera(1, {
      detectionMode: 'always-on',
      fps: 10,
      sessionTrigger: { source: 'onboard', triggeredBy: { kind: 'camera' } },
    })
    runner.registerCamera(2, {
      detectionMode: 'always-on',
      fps: 10,
      sessionTrigger: {
        source: 'onboard',
        triggeredBy: { kind: 'sensor', deviceId: 3299 },
        sensorName: 'PIR front door',
      },
    })

    expect(onPhaseChanged.mock.calls[0]![2]).toMatchObject({
      cause: 'attach',
      trigger: { source: 'onboard', triggeredBy: { kind: 'camera' } },
    })
    expect(onPhaseChanged.mock.calls[1]![2]).toMatchObject({
      cause: 'attach',
      trigger: {
        source: 'onboard',
        triggeredBy: { kind: 'sensor', deviceId: 3299 },
        sensorName: 'PIR front door',
      },
    })
  })

  it('detaching an ACTIVE camera closes the phase with cause detach', () => {
    const onPhaseChanged = vi.fn()
    runner = createRunner({ onPhaseChanged })
    runner.registerCamera(1, { detectionMode: 'always-on', fps: 10 })
    onPhaseChanged.mockClear()

    runner.unregisterCamera(1)

    expect(onPhaseChanged).toHaveBeenCalledTimes(1)
    expect(onPhaseChanged.mock.calls[0]![0]).toBe(1)
    expect(onPhaseChanged.mock.calls[0]![1]).toBe('watching')
    const meta = onPhaseChanged.mock.calls[0]![2] as Record<string, unknown>
    expect(meta['cause']).toBe('detach')
    expect(meta).not.toHaveProperty('source')
  })

  it('detaching a WATCHING camera emits nothing (there is no phase to close)', () => {
    const onPhaseChanged = vi.fn()
    runner = createRunner({ onPhaseChanged })
    runner.registerCamera(1, { detectionMode: 'on-motion', fps: 10 })

    runner.unregisterCamera(1)

    expect(onPhaseChanged).not.toHaveBeenCalled()
  })

  // ── pipeline stats — real drop counts (dead addDrop() replaced) ─────

  it('surfaces detection-queue drops in the pipeline stats line (per-interval delta)', () => {
    const info = vi.fn()
    const logger: import('@camstack/types').IScopedLogger = {
      debug: vi.fn(),
      info,
      warn: vi.fn(),
      error: vi.fn(),
      child: () => logger,
      withTags: () => logger,
    }

    runner = createRunner()
    runner.timingSampler.setLogger(logger)
    runner.registerCamera(1, { detectionMode: 'always-on', fps: 10 })

    // Latest-frame-only queue (capacity 1): enqueuing 3 frames without a
    // dequeue sheds 2. Not starting the scheduler keeps them undrained.
    runner.enqueueDetectionFrame(1, makeFrame(1), makeHandle(1))
    runner.enqueueDetectionFrame(1, makeFrame(2), makeHandle(2))
    runner.enqueueDetectionFrame(1, makeFrame(3), makeHandle(3))

    runner.timingSampler.start()
    vi.advanceTimersByTime(10_000)

    const statsCalls = info.mock.calls.filter((c) => c[0] === 'pipeline stats')
    expect(statsCalls).toHaveLength(1)
    const extras = statsCalls[0]![1] as {
      tags: { deviceId: number }
      meta: Record<string, unknown>
    }
    expect(extras.tags.deviceId).toBe(1)
    expect(extras.meta['dropped']).toBe(2)

    // Next interval: no new drops → delta back to 0 (line suppressed
    // entirely when there are also no samples).
    vi.advanceTimersByTime(10_000)
    expect(info.mock.calls.filter((c) => c[0] === 'pipeline stats')).toHaveLength(1)

    runner.timingSampler.stop()
  })

  it('unregisterCamera detaches the drop source from the stats line', () => {
    const info = vi.fn()
    const logger: import('@camstack/types').IScopedLogger = {
      debug: vi.fn(),
      info,
      warn: vi.fn(),
      error: vi.fn(),
      child: () => logger,
      withTags: () => logger,
    }

    runner = createRunner()
    runner.timingSampler.setLogger(logger)
    runner.registerCamera(1, { detectionMode: 'always-on', fps: 10 })
    runner.enqueueDetectionFrame(1, makeFrame(1), makeHandle(1))
    runner.enqueueDetectionFrame(1, makeFrame(2), makeHandle(2))
    runner.unregisterCamera(1)

    runner.timingSampler.start()
    vi.advanceTimersByTime(10_000)

    expect(info.mock.calls.filter((c) => c[0] === 'pipeline stats')).toHaveLength(0)
    runner.timingSampler.stop()
  })

  // ── updateLimits() — Phase 6 hot-reload ─────────────────────────────

  it('updateLimits updates all four tuning fields', () => {
    runner = createRunner()
    expect(runner.getLimits()).toEqual({
      maxQueueDepth: 3,
      maxConcurrentInferences: 2,
      targetLoadPercent: 80,
      minThrottledFps: 1,
    })

    runner.updateLimits({
      maxQueueDepth: 15,
      maxConcurrentInferences: 5,
      targetLoadPercent: 90,
      minThrottledFps: 2,
    })

    expect(runner.getLimits()).toEqual({
      maxQueueDepth: 15,
      maxConcurrentInferences: 5,
      targetLoadPercent: 90,
      minThrottledFps: 2,
    })
  })

  it('updateLimits preserves unspecified fields (partial patch)', () => {
    runner = createRunner()
    runner.updateLimits({ maxConcurrentInferences: 8 })
    expect(runner.getLimits()).toEqual({
      maxQueueDepth: 3,
      maxConcurrentInferences: 8,
      targetLoadPercent: 80,
      minThrottledFps: 1,
    })
  })
})
