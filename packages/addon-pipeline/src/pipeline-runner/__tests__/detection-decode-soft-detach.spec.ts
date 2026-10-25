/**
 * A cooldown detach RELEASES the decode worker — D453.
 *
 * This file used to pin the opposite. A soft detach parked the detection
 * worker for 15 s so the next motion event could adopt it, and the arithmetic
 * that justified it assumed a parked worker idles. It does not: the child's
 * loop is demuxer-driven, `minIntervalMs` throttles only after the decode, and
 * `framesDecoded` advanced in 122 of 122 park windows at full source rate — at
 * 40-80% of a core. On this fleet 272 of 440 windows expired having adopted
 * nothing, and the p50 gap between two sessions of one camera is 61 s, so the
 * park was paying nearly the full price of running for a 12% hit rate.
 *
 * What a soft detach still does is park the DETAIL step tree: a config slice,
 * no process, no CPU, so a track outliving the session can resolve its
 * enrichment steps. That half is unchanged and is asserted here too, because
 * the two were entangled behind one flag and the wrong one must not come back
 * with the right one.
 */
import type { RunnerCameraConfig } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { makeRunnerCameraConfig } from '../../__tests__/support/runner-camera-config.js'
import PipelineRunnerAddon from '../index.js'

function makeConfig(patch: Partial<RunnerCameraConfig> = {}): RunnerCameraConfig {
  // Shaped like `dispatchDetectionSession`'s attach: a pure detector, no local
  // motion gate — the population this stage exists for.
  return makeRunnerCameraConfig({
    deviceId: 101,
    detectionMode: 'always-on',
    audioMode: 'disabled',
    motionCooldownMs: 30_000,
    motionStreamId: 'sub',
    detectionStreamId: 'main',
    motionSources: [],
    onboardMotionDrivesAnalyzer: false,
    ...patch,
  })
}

interface AddonInternals {
  onInitialize(): Promise<unknown>
  parkedDetail: Map<number, unknown>
  attached: Map<number, { detectionUnsubscribe: (() => void) | null }>
}

function asInternals(addon: PipelineRunnerAddon): AddonInternals {
  // Single type-boundary cast — private access for white-box testing (same
  // convention as `onboard-motion-analyzer.spec.ts`).
  return addon as unknown as AddonInternals
}

function makeFakeCtx() {
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
  return {
    id: 'pipeline-runner',
    logger,
    kernel: { localNodeId: 'hub' },
    eventBus: { emit: vi.fn(), subscribe: vi.fn(() => () => {}), getRecent: () => [] },
    api: {
      pipelineExecutor: { runPipeline: { mutate: vi.fn().mockResolvedValue(null) } },
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
    fetchDevice: vi.fn(),
  }
}

describe('detection decode soft detach (motion-cooldown keep-warm)', () => {
  let addon: PipelineRunnerAddon
  let unsubscribe: ReturnType<typeof vi.fn>
  let subscribeSpy: MockInstance<(c: RunnerCameraConfig) => Promise<(() => void) | null>>

  beforeEach(async () => {
    vi.useFakeTimers()
    addon = new PipelineRunnerAddon()
    Object.defineProperty(addon, 'ctx', { value: makeFakeCtx(), configurable: true })
    await asInternals(addon).onInitialize()
    unsubscribe = vi.fn()
    subscribeSpy = vi
      .spyOn(
        addon as unknown as {
          subscribeDetectionFrames(c: RunnerCameraConfig): Promise<(() => void) | null>
        },
        'subscribeDetectionFrames',
      )
      .mockResolvedValue(unsubscribe)
  })

  afterEach(async () => {
    vi.useRealTimers()
    await addon.shutdown().catch(() => {
      /* swallow */
    })
  })

  /** Attach and let the synchronous always-on subscribe settle. */
  async function attach(config: RunnerCameraConfig): Promise<void> {
    await addon.attachCamera(config)
    await vi.advanceTimersByTimeAsync(0)
  }

  it('releases the decode worker on the cooldown detach — it is not held', async () => {
    await attach(makeConfig())
    expect(subscribeSpy).toHaveBeenCalledTimes(1)

    await addon.detachCamera({ deviceId: 101 })

    expect(asInternals(addon).attached.has(101)).toBe(false)
    // The worker is gone at the DETACH, not 15 s later: the window it used to
    // be held for was a window it spent decoding.
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('holds nothing afterwards — no timer can release a second time', async () => {
    await attach(makeConfig())
    await addon.detachCamera({ deviceId: 101 })

    await vi.advanceTimersByTimeAsync(60_000)

    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('a re-attach forks a fresh worker, however soon it comes', async () => {
    await attach(makeConfig())
    await addon.detachCamera({ deviceId: 101 })

    // 10 s later — inside what used to be the keep-warm window.
    await vi.advanceTimersByTimeAsync(10_000)
    await attach(makeConfig())

    expect(subscribeSpy).toHaveBeenCalledTimes(2)
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('still parks the DETAIL step tree — that park costs a config slice, not a core', async () => {
    await attach(makeConfig())
    await addon.detachCamera({ deviceId: 101 })

    expect(asInternals(addon).parkedDetail.has(101)).toBe(true)
  })

  it('shutdown leaves no detail park behind', async () => {
    await attach(makeConfig())
    await addon.detachCamera({ deviceId: 101 })

    await addon.shutdown()

    expect(asInternals(addon).parkedDetail.size).toBe(0)
  })
})
