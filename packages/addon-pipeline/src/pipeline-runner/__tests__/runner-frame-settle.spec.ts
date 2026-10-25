/**
 * D652 — a burst frame reports how it ENDED, exactly once.
 *
 * The occupancy burst can only complete on inference if the runner tells it
 * when each of its frames is done: inferred (after the result callbacks ran, so
 * the burst's `found` flag is already set), or let go without a result —
 * superseded on the latest-only queue, cleared by a detach, or failed. Every
 * such exit is a frame the burst's verdict did NOT see, and it has to count.
 */
import type { DecodedFrame, FrameResult } from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeScopedLogger } from '../../__tests__/support/scoped-logger.js'

import type { RunnerConfig } from '../runner.js'
import { PipelineRunner } from '../runner.js'

function logger() {
  return makeScopedLogger()
}

function frame(timestamp: number): DecodedFrame {
  return {
    width: 4,
    height: 4,
    timestamp,
    format: 'rgb',
    data: Buffer.alloc(4 * 4 * 3),
  }
}

function result(): FrameResult {
  return {
    kind: 'frame',
    frameId: 'f',
    deviceId: 1,
    timestamp: 1,
    width: 4,
    height: 4,
    detections: [],
  }
}

function delay(ms = 40): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function harness(processFrame: RunnerConfig['processFrame'], log = logger()) {
  const config: RunnerConfig = {
    maxQueueDepth: 3,
    maxConcurrentInferences: 2,
    targetLoadPercent: 80,
    minThrottledFps: 1,
    analyzeMotion: async () => undefined,
    releaseFrameRef: () => undefined,
    releaseRetention: () => undefined,
    processFrame,
    logger: log,
  }
  return new PipelineRunner(config)
}

describe('runner — occupancy frames report how they settled (D652)', () => {
  const runners: PipelineRunner[] = []
  afterEach(() => {
    for (const runner of runners) {
      runner.stop()
      runner.unregisterCamera(1)
    }
    runners.length = 0
  })

  it("an inferred burst frame settles 'inferred', once, after the result callbacks ran", async () => {
    const runner = harness(vi.fn().mockResolvedValue(result()))
    runners.push(runner)
    const order: string[] = []
    runner.onResult(() => {
      order.push('result')
    })
    runner.registerCamera(1, { detectionMode: 'on-motion', fps: 1000 })
    runner.start()
    const settled = vi.fn((outcome: string) => order.push(`settled:${outcome}`))
    expect(runner.enqueueOccupancyFrame(1, frame(1), undefined, settled)).toBe(true)
    await delay()
    expect(settled).toHaveBeenCalledTimes(1)
    expect(order).toEqual(['result', 'settled:inferred'])
  })

  it("a frame superseded on the latest-only queue settles 'superseded' — not a loss", async () => {
    const runner = harness(vi.fn().mockResolvedValue(result()))
    runners.push(runner)
    runner.registerCamera(1, { detectionMode: 'on-motion', fps: 1000 })
    const older = vi.fn()
    const newer = vi.fn()
    runner.enqueueOccupancyFrame(1, frame(1), undefined, older)
    runner.enqueueOccupancyFrame(1, frame(2), undefined, newer)
    expect(older).toHaveBeenCalledExactlyOnceWith('superseded')
    runner.start()
    await delay()
    expect(newer).toHaveBeenCalledExactlyOnceWith('inferred')
  })

  it("a queued frame cleared by a detach settles 'lost'", () => {
    const runner = harness(vi.fn().mockResolvedValue(result()))
    runners.push(runner)
    runner.registerCamera(1, { detectionMode: 'on-motion', fps: 1000 })
    const settled = vi.fn()
    runner.enqueueOccupancyFrame(1, frame(1), undefined, settled)
    runner.unregisterCamera(1)
    expect(settled).toHaveBeenCalledExactlyOnceWith('lost')
  })

  it("a frame whose inference failed settles 'lost'", async () => {
    const runner = harness(
      vi.fn().mockRejectedValue(new Error('worker exited before toBuffer reply')),
    )
    runners.push(runner)
    runner.registerCamera(1, { detectionMode: 'on-motion', fps: 1000 })
    runner.start()
    const settled = vi.fn()
    runner.enqueueOccupancyFrame(1, frame(1), undefined, settled)
    await delay()
    expect(settled).toHaveBeenCalledExactlyOnceWith('lost')
  })

  // D391: a frame the runner admitted and now throws away is on the record.
  it('an AWAITED frame discarded with a detach is LOGGED at info, with the count and the camera', () => {
    const log = logger()
    const runner = harness(vi.fn().mockResolvedValue(result()), log)
    runners.push(runner)
    runner.registerCamera(1, { detectionMode: 'on-motion', fps: 1000 })
    runner.enqueueOccupancyFrame(1, frame(1), undefined, vi.fn())
    runner.unregisterCamera(1)
    expect(log.info).toHaveBeenCalledWith(
      'detection frames discarded with the session',
      expect.objectContaining({
        tags: { deviceId: 1 },
        meta: expect.objectContaining({ reason: 'detach', queued: 1, awaited: 1 }),
      }),
    )
  })

  it('a detach with nothing queued says nothing', () => {
    const log = logger()
    const runner = harness(vi.fn().mockResolvedValue(result()), log)
    runners.push(runner)
    runner.registerCamera(1, { detectionMode: 'on-motion', fps: 1000 })
    runner.unregisterCamera(1)
    expect(log.info).not.toHaveBeenCalledWith(
      'detection frames discarded with the session',
      expect.anything(),
    )
  })

  // M3: the routine close of a live session drops its one latest-only frame —
  // on the record, but at debug: nobody was waiting on it.
  it('a routine discard (nobody waiting, no history) is debug, not info', () => {
    const log = logger()
    const runner = harness(vi.fn().mockResolvedValue(result()), log)
    runners.push(runner)
    runner.registerCamera(1, { detectionMode: 'on-motion', fps: 1000 })
    runner.enqueueOccupancyFrame(1, frame(1), undefined)
    runner.unregisterCamera(1)
    expect(log.info).not.toHaveBeenCalledWith(
      'detection frames discarded with the session',
      expect.anything(),
    )
    expect(log.debug).toHaveBeenCalledWith(
      'detection frames discarded with the session',
      expect.objectContaining({ meta: expect.objectContaining({ queued: 1, awaited: 0 }) }),
    )
  })

  // I2 / D393: a lane count that cannot be read is null, never 0.
  it('the pre-roll refusal count of a detached camera is null, not 0', () => {
    const runner = harness(vi.fn().mockResolvedValue(result()))
    runners.push(runner)
    runner.registerCamera(1, { detectionMode: 'always-on', fps: 1000 })
    expect(runner.preRollRefusedCount(1)).toBe(0)
    runner.unregisterCamera(1)
    expect(runner.preRollRefusedCount(1)).toBeNull()
  })
})
