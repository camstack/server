import type { IScopedLogger } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PipelineTimingSampler } from '../timing-sampler.js'

const REPORT_INTERVAL_MS = 10_000

interface LoggerHarness {
  readonly logger: IScopedLogger
  readonly info: ReturnType<typeof vi.fn>
}

function makeLogger(): LoggerHarness {
  const info = vi.fn()
  const logger: IScopedLogger = {
    debug: vi.fn(),
    info,
    warn: vi.fn(),
    error: vi.fn(),
    child: (): IScopedLogger => logger,
    withTags: (): IScopedLogger => logger,
  }
  return { logger, info }
}

interface StatsCall {
  readonly tags: { deviceId: number }
  readonly meta: Record<string, unknown>
}

function pipelineStatsCalls(info: ReturnType<typeof vi.fn>): StatsCall[] {
  return info.mock.calls.filter((c) => c[0] === 'pipeline stats').map((c) => c[1] as StatsCall)
}

function addDetectionSample(sampler: PipelineTimingSampler, deviceId: number): void {
  sampler.addSample(deviceId, {
    queueWait: 1,
    semaphoreWait: 1,
    inference: 10,
    resultToEmit: 1,
    endToEnd: 13,
    frameAge: 5,
    detections: 0,
  })
}

describe('PipelineTimingSampler — dropped-frames delta reporting', () => {
  let sampler: PipelineTimingSampler
  let harness: LoggerHarness

  beforeEach(() => {
    vi.useFakeTimers()
    harness = makeLogger()
    sampler = new PipelineTimingSampler()
    sampler.setLogger(harness.logger)
    sampler.start()
  })

  afterEach(() => {
    sampler.stop()
    vi.useRealTimers()
  })

  it('reports the per-interval DELTA of a cumulative dropped-frames source', () => {
    // Simulates the runner's detection FrameQueue: a monotonically
    // increasing cumulative counter read through a source callback.
    let cumulativeDropped = 0
    sampler.setDroppedFramesSource(7, () => cumulativeDropped)

    // Interval 1 — 3 drops accumulate, one inference completes.
    cumulativeDropped = 3
    addDetectionSample(sampler, 7)
    vi.advanceTimersByTime(REPORT_INTERVAL_MS)

    let stats = pipelineStatsCalls(harness.info)
    expect(stats).toHaveLength(1)
    expect(stats[0]!.tags.deviceId).toBe(7)
    expect(stats[0]!.meta['dropped']).toBe(3)

    // Interval 2 — cumulative rises 3 → 5: the line must report the DELTA
    // (2), not the cumulative (5). Was previously ALWAYS 0 (dead addDrop()).
    cumulativeDropped = 5
    addDetectionSample(sampler, 7)
    vi.advanceTimersByTime(REPORT_INTERVAL_MS)

    stats = pipelineStatsCalls(harness.info)
    expect(stats).toHaveLength(2)
    expect(stats[1]!.meta['dropped']).toBe(2)

    // Interval 3 — no new drops: delta is 0.
    addDetectionSample(sampler, 7)
    vi.advanceTimersByTime(REPORT_INTERVAL_MS)

    stats = pipelineStatsCalls(harness.info)
    expect(stats).toHaveLength(3)
    expect(stats[2]!.meta['dropped']).toBe(0)
  })

  it('emits a drop-only stats line under full overload (zero completed frames)', () => {
    // With inference slower than the report interval, a device can shed
    // frames without completing a single inference in the window — the
    // overload must still be visible.
    let cumulativeDropped = 0
    sampler.setDroppedFramesSource(3, () => cumulativeDropped)

    cumulativeDropped = 9
    vi.advanceTimersByTime(REPORT_INTERVAL_MS)

    const stats = pipelineStatsCalls(harness.info)
    expect(stats).toHaveLength(1)
    expect(stats[0]!.tags.deviceId).toBe(3)
    expect(stats[0]!.meta['dropped']).toBe(9)
    expect(stats[0]!.meta['frames']).toBe(0)
  })

  it('stays silent for a device with no samples and no drops', () => {
    sampler.setDroppedFramesSource(4, () => 0)
    vi.advanceTimersByTime(REPORT_INTERVAL_MS)
    expect(pipelineStatsCalls(harness.info)).toHaveLength(0)
  })

  it('baselines at registration — pre-existing cumulative drops are not re-reported', () => {
    // Source registered when the queue has already dropped 5 frames
    // (e.g. sampler restart): only drops AFTER registration count.
    let cumulativeDropped = 5
    sampler.setDroppedFramesSource(2, () => cumulativeDropped)

    cumulativeDropped = 6
    vi.advanceTimersByTime(REPORT_INTERVAL_MS)

    const stats = pipelineStatsCalls(harness.info)
    expect(stats).toHaveLength(1)
    expect(stats[0]!.meta['dropped']).toBe(1)
  })

  it('clearDroppedFramesSource stops drop reporting for the device', () => {
    let cumulativeDropped = 0
    sampler.setDroppedFramesSource(5, () => cumulativeDropped)
    sampler.clearDroppedFramesSource(5)

    cumulativeDropped = 4
    vi.advanceTimersByTime(REPORT_INTERVAL_MS)
    expect(pipelineStatsCalls(harness.info)).toHaveLength(0)
  })

  it('reports dropped=0 for a device with samples but no registered source', () => {
    addDetectionSample(sampler, 9)
    vi.advanceTimersByTime(REPORT_INTERVAL_MS)

    const stats = pipelineStatsCalls(harness.info)
    expect(stats).toHaveLength(1)
    expect(stats[0]!.meta['dropped']).toBe(0)
  })

  it('never reports a negative delta when the cumulative source resets', () => {
    let cumulativeDropped = 0
    sampler.setDroppedFramesSource(6, () => cumulativeDropped)

    cumulativeDropped = 4
    vi.advanceTimersByTime(REPORT_INTERVAL_MS)
    expect(pipelineStatsCalls(harness.info)[0]!.meta['dropped']).toBe(4)

    // Queue replaced — counter restarts at 0. Delta clamps to 0.
    cumulativeDropped = 0
    addDetectionSample(sampler, 6)
    vi.advanceTimersByTime(REPORT_INTERVAL_MS)
    expect(pipelineStatsCalls(harness.info)[1]!.meta['dropped']).toBe(0)
  })
})

describe('PipelineTimingSampler — boxes the class floor dropped (D665)', () => {
  let sampler: PipelineTimingSampler
  let harness: LoggerHarness

  beforeEach(() => {
    vi.useFakeTimers()
    harness = makeLogger()
    sampler = new PipelineTimingSampler()
    sampler.setLogger(harness.logger)
    sampler.start()
  })

  afterEach(() => {
    sampler.stop()
    vi.useRealTimers()
  })

  it('sums the per-frame below-floor tallies on the per-camera stats line, then resets', () => {
    sampler.addSample(7, {
      queueWait: 1,
      semaphoreWait: 1,
      inference: 10,
      resultToEmit: 1,
      endToEnd: 13,
      frameAge: 5,
      detections: 0,
      belowFloor: { person: { '0.50-0.65': 2 } },
    })
    sampler.addSample(7, {
      queueWait: 1,
      semaphoreWait: 1,
      inference: 10,
      resultToEmit: 1,
      endToEnd: 13,
      frameAge: 5,
      detections: 1,
      belowFloor: { person: { '0.50-0.65': 1, '0.35-0.50': 3 } },
    })
    vi.advanceTimersByTime(REPORT_INTERVAL_MS)
    const first = pipelineStatsCalls(harness.info)
    expect(first).toHaveLength(1)
    expect(first[0]!.tags.deviceId).toBe(7)
    expect(first[0]!.meta['belowFloor']).toEqual({
      person: { '0.50-0.65': 3, '0.35-0.50': 3 },
    })

    addDetectionSample(sampler, 7)
    vi.advanceTimersByTime(REPORT_INTERVAL_MS)
    // Measured, and nothing was below the floor: a zero, not an absence.
    expect(pipelineStatsCalls(harness.info)[1]!.meta['belowFloor']).toEqual({})
  })
})

describe('PipelineTimingSampler — the elected device on the per-camera line', () => {
  let sampler: PipelineTimingSampler
  let harness: LoggerHarness

  beforeEach(() => {
    vi.useFakeTimers()
    harness = makeLogger()
    sampler = new PipelineTimingSampler()
    sampler.setLogger(harness.logger)
    sampler.start()
  })

  afterEach(() => {
    sampler.stop()
    vi.useRealTimers()
  })

  it('names each camera’s elected deviceKey, and null for the default pool', () => {
    const elected = new Map<number, string>([[3835, 'edgetpu:usb']])
    sampler.setElectedDeviceKeyResolver((deviceId) => elected.get(deviceId) ?? null)
    addDetectionSample(sampler, 3835)
    addDetectionSample(sampler, 637)
    vi.advanceTimersByTime(REPORT_INTERVAL_MS)
    const calls = pipelineStatsCalls(harness.info)
    expect(calls.find((c) => c.tags.deviceId === 3835)?.meta['deviceKey']).toBe('edgetpu:usb')
    expect(calls.find((c) => c.tags.deviceId === 637)?.meta['deviceKey']).toBeNull()
  })
})
