/**
 * The occasion a frame is inferred on is named by the path that OWNS the frame.
 *
 * `'session'` — a motion session is running and the pipeline was decoding
 * anyway (live frames, and the pre-roll history of that same session).
 * `'burst'` — the periodic occupancy recheck, admitted only while the camera is
 * `watching`, i.e. while its motion gate says nothing is moving.
 *
 * From 2026-09-14 (d946ce42e) to 2026-09-16 the LIVE path stamped `'burst'` and
 * only the pre-roll lane fell through to a `'session'` default. Measured on the
 * hub: one candidate carried 40 431 "burst" agreements and 55 "session" ones
 * against a recheck that produces at most 1 152 frames a day, and a birth door
 * written to admit "what the recheck saw" admitted every session frame there
 * was. This spec pins each producer to its occasion, end to end through the
 * result callback — the only surface a consumer reads.
 */
import type { DecodedFrame, FrameResult, InferenceOccasion } from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { RunnerConfig } from '../runner.js'
import { PipelineRunner } from '../runner.js'

function logger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withTags: vi.fn(),
    withPrefix: vi.fn(),
  }
}

function frame(timestamp: number): DecodedFrame {
  return {
    width: 4,
    height: 4,
    timestamp,
    format: 'rgb',
    data: new Uint8Array(4 * 4 * 3),
  } as unknown as DecodedFrame
}

function emptyResult(): FrameResult {
  return { detections: [], debug: { totalInferenceMs: 1 } } as unknown as FrameResult
}

function delay(ms = 40): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function harness(overrides: Partial<RunnerConfig> = {}) {
  const occasions: InferenceOccasion[] = []
  const runner = new PipelineRunner({
    maxQueueDepth: 3,
    // Two permits: the pre-roll lane only runs with one to spare (PRE_ROLL_PERMIT_RESERVE).
    maxConcurrentInferences: 2,
    targetLoadPercent: 80,
    minThrottledFps: 1,
    analyzeMotion: async () => undefined,
    releaseFrameRef: () => undefined,
    releaseRetention: () => undefined,
    processFrame: vi.fn().mockResolvedValue(emptyResult()),
    logger: logger(),
    ...overrides,
  } as unknown as RunnerConfig)
  runner.onResult((_deviceId, _frame, _result, _stream, _handle, _source, occasion) => {
    occasions.push(occasion)
  })
  return { runner, occasions }
}

describe('the occasion is named by the path that owns the frame', () => {
  const runners: PipelineRunner[] = []

  afterEach(() => {
    for (const runner of runners) {
      runner.stop()
      runner.unregisterCamera(1)
    }
    runners.length = 0
  })

  it('a LIVE frame of an active session is a session', async () => {
    const { runner, occasions } = harness()
    runners.push(runner)
    runner.registerCamera(1, { detectionMode: 'always-on', fps: 1000 })
    runner.start()
    expect(runner.enqueueReservedDetectionFrame(1, frame(1), undefined)).toBe(true)
    await delay()
    expect(occasions).toEqual(['session'])
  })

  it('the session history (pre-roll) is a session too', async () => {
    const { runner, occasions } = harness()
    runners.push(runner)
    runner.registerCamera(1, { detectionMode: 'always-on', fps: 1000 })
    runner.start()
    expect(runner.enqueuePreRollFrame(1, frame(1), undefined)).toBe(true)
    await delay()
    expect(occasions).toEqual(['session'])
  })

  // Two things at once, on purpose: the label, and that the frame is RUN while
  // the camera is still watching. The picker used to dispatch `active` cameras
  // only, so a recheck frame accepted here was inferred on the next session's
  // first tick — minutes stale — and this assertion read `[]`.
  it('an occupancy recheck of a WATCHING camera is a burst, inferred while watching', async () => {
    const { runner, occasions } = harness()
    runners.push(runner)
    runner.registerCamera(1, { detectionMode: 'on-motion', fps: 1000 })
    runner.start()
    expect(runner.enqueueOccupancyFrame(1, frame(1), undefined)).toBe(true)
    await delay()
    expect(occasions).toEqual(['burst'])
  })

  // The recheck exists to look at a STILL scene; a camera with a session open
  // is not one, and its frames must never be filed as a burst.
  it('the recheck refuses a camera whose session is open', () => {
    const { runner } = harness()
    runners.push(runner)
    runner.registerCamera(1, { detectionMode: 'always-on', fps: 1000 })
    expect(runner.enqueueOccupancyFrame(1, frame(1), undefined)).toBe(false)
  })
})
