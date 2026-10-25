/* eslint-disable @typescript-eslint/no-explicit-any -- test file: vi.fn() mocks need narrow casts to match callback signatures */

import type { FrameResult } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunnerConfig } from '../runner.js'
import { PipelineRunner } from '../runner.js'

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

/**
 * Occupancy-recheck arm/disarm state machine (Task 9). The timer fires
 * `onOccupancyRecheck` only while `watching && occupancyArmed`. Arming is
 * decided at the active→watching transition from the runner's last-known
 * detection result (`noteDetectionResult`); disarming happens after 2
 * consecutive empty burst outcomes (`reportOccupancyBurstOutcome`).
 */
describe('PipelineRunner — occupancy recheck arm/disarm', () => {
  let runner: PipelineRunner
  let processFrame: ReturnType<typeof vi.fn>
  let analyzeMotion: ReturnType<typeof vi.fn>
  let onOccupancyRecheck: ReturnType<typeof vi.fn>

  const MOTION_COOLDOWN_MS = 1_000
  const OCCUPANCY_RECHECK_SEC = 5

  beforeEach(() => {
    vi.useFakeTimers()
    processFrame = vi.fn().mockResolvedValue(makePipelineResult())
    analyzeMotion = vi.fn().mockResolvedValue(undefined)
    onOccupancyRecheck = vi.fn()
  })

  afterEach(() => {
    runner?.stop()
    vi.useRealTimers()
  })

  function createRunner(overrides: Partial<RunnerConfig> = {}): PipelineRunner {
    return new PipelineRunner({
      maxQueueDepth: 3,
      maxConcurrentInferences: 2,
      targetLoadPercent: 80,
      minThrottledFps: 1,
      processFrame: processFrame as any,
      analyzeMotion: analyzeMotion as any,
      onOccupancyRecheck,
      ...overrides,
    })
  }

  function registerOccupancyCamera(r: PipelineRunner, deviceId: number): void {
    r.registerCamera(deviceId, {
      detectionMode: 'on-motion',
      fps: 10,
      motionCooldownMs: MOTION_COOLDOWN_MS,
      occupancyRecheckEnabled: true,
      occupancyRecheckSec: OCCUPANCY_RECHECK_SEC,
      occupancyRecheckFrames: 4,
    })
  }

  /** Drive a full active session that closes with `detections` in the last result. */
  function closeSessionWith(r: PipelineRunner, deviceId: number, detections: number): void {
    r.reportMotion(deviceId, true)
    r.noteDetectionResult(deviceId, detections)
    vi.advanceTimersByTime(MOTION_COOLDOWN_MS)
  }

  // (a0) BOOT. The case the recheck exists for and the one it could not serve:
  // a camera comes back with an object already parked in view. No session has
  // ever closed, so the old `occupancyArmed: false` meant the only mechanism
  // that looks at a still scene never ran, and the object stayed invisible to
  // the stationary registry — and to every occupancy rule — until something
  // else moved in front of it.
  it('is armed from registration, before any session has ever closed', () => {
    runner = createRunner()
    registerOccupancyCamera(runner, 1)
    expect(runner.getPhase(1)).toBe('watching')

    vi.advanceTimersByTime(OCCUPANCY_RECHECK_SEC * 1000)
    expect(onOccupancyRecheck).toHaveBeenCalledWith(1, 4)
  })

  // (a1) …and an empty scene stops paying for it on its own.
  it('a camera with nothing parked disarms after its two boot bursts', () => {
    runner = createRunner()
    registerOccupancyCamera(runner, 1)

    runner.reportOccupancyBurstOutcome(1, false)
    vi.advanceTimersByTime(OCCUPANCY_RECHECK_SEC * 1000)
    expect(onOccupancyRecheck).toHaveBeenCalledTimes(1)

    runner.reportOccupancyBurstOutcome(1, false)
    onOccupancyRecheck.mockClear()
    vi.advanceTimersByTime(OCCUPANCY_RECHECK_SEC * 1000)
    expect(onOccupancyRecheck).not.toHaveBeenCalled()
  })

  // (a) close with detections>0 → timer fires the callback
  it('arms the occupancy timer when the last session closed with detections', () => {
    runner = createRunner()
    registerOccupancyCamera(runner, 1)

    closeSessionWith(runner, 1, 3)
    expect(runner.getPhase(1)).toBe('watching')

    vi.advanceTimersByTime(OCCUPANCY_RECHECK_SEC * 1000)
    expect(onOccupancyRecheck).toHaveBeenCalledWith(1, 4)
  })

  // (b) close with 0 → timer silent
  it('does not arm the occupancy timer when the last session closed empty', () => {
    runner = createRunner()
    registerOccupancyCamera(runner, 1)

    closeSessionWith(runner, 1, 0)
    expect(runner.getPhase(1)).toBe('watching')

    vi.advanceTimersByTime(OCCUPANCY_RECHECK_SEC * 1000)
    expect(onOccupancyRecheck).not.toHaveBeenCalled()
  })

  // (c) two empty outcomes → disarmed, timer silent
  it('disarms after 2 consecutive empty burst outcomes', () => {
    runner = createRunner()
    registerOccupancyCamera(runner, 1)

    closeSessionWith(runner, 1, 2)

    // First empty burst: streak=1, still armed.
    runner.reportOccupancyBurstOutcome(1, false)
    vi.advanceTimersByTime(OCCUPANCY_RECHECK_SEC * 1000)
    expect(onOccupancyRecheck).toHaveBeenCalledTimes(1)

    // Second consecutive empty burst: streak=2 → disarm.
    runner.reportOccupancyBurstOutcome(1, false)
    onOccupancyRecheck.mockClear()
    vi.advanceTimersByTime(OCCUPANCY_RECHECK_SEC * 1000)
    expect(onOccupancyRecheck).not.toHaveBeenCalled()
  })

  // (d) a found outcome re-arms the streak
  it('a found outcome resets the empty-burst streak', () => {
    runner = createRunner()
    registerOccupancyCamera(runner, 1)

    closeSessionWith(runner, 1, 2)

    runner.reportOccupancyBurstOutcome(1, false) // streak=1
    runner.reportOccupancyBurstOutcome(1, true) // streak reset to 0, stays armed
    runner.reportOccupancyBurstOutcome(1, false) // streak=1 again (NOT 2 — no disarm)

    vi.advanceTimersByTime(OCCUPANCY_RECHECK_SEC * 1000)
    expect(onOccupancyRecheck).toHaveBeenCalledWith(1, 4)
  })

  // (e) next session close re-evaluates from scratch
  it('the next session close re-evaluates the arm from scratch after a disarm', () => {
    runner = createRunner()
    registerOccupancyCamera(runner, 1)

    // Disarm via 2 consecutive empty bursts.
    closeSessionWith(runner, 1, 2)
    runner.reportOccupancyBurstOutcome(1, false)
    runner.reportOccupancyBurstOutcome(1, false)
    onOccupancyRecheck.mockClear()
    vi.advanceTimersByTime(OCCUPANCY_RECHECK_SEC * 1000)
    expect(onOccupancyRecheck).not.toHaveBeenCalled()

    // A brand-new session opens and closes with detections again — must
    // re-arm regardless of the prior disarmed state.
    closeSessionWith(runner, 1, 5)
    vi.advanceTimersByTime(OCCUPANCY_RECHECK_SEC * 1000)
    expect(onOccupancyRecheck).toHaveBeenCalledWith(1, 4)
  })

  // (f) a session with no inference result must not inherit a stale
  // detection count from the PRIOR session — regression coverage for
  // `transitionToActive` resetting `lastResultDetections`.
  it('does not carry a stale detection count into a session with no inference result', () => {
    runner = createRunner()
    registerOccupancyCamera(runner, 1)

    // Session 1 closes with detections>0 — armed.
    closeSessionWith(runner, 1, 3)
    expect(runner.getPhase(1)).toBe('watching')

    // Session 2 opens via motion and closes WITHOUT any
    // `noteDetectionResult` call. Before the fix, `lastResultDetections`
    // still held session 1's stale count of 3 and the closing re-arm read
    // as armed regardless of what (nothing) happened during session 2.
    runner.reportMotion(1, true)
    expect(runner.getPhase(1)).toBe('active')
    vi.advanceTimersByTime(MOTION_COOLDOWN_MS)
    expect(runner.getPhase(1)).toBe('watching')

    vi.advanceTimersByTime(OCCUPANCY_RECHECK_SEC * 1000)
    expect(onOccupancyRecheck).not.toHaveBeenCalled()
  })
})
