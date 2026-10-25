/**
 * Unit tests for the onboard-motion → analyzer dynamic gate.
 *
 * Tests cover two layers:
 *
 * 1. `shouldStartOnboardAnalyzer` — pure decision helper; no I/O.
 *    Fast, no mocking required.
 *
 * 2. `handleOnboardMotionAnalyzer` (via `PipelineRunnerAddon` private API) —
 *    exercises the open/idempotent/teardown/no-op paths using fake timers.
 *    We use the same "inject ctx then call onInitialize" pattern as the
 *    existing dispatch spec.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import PipelineRunnerAddon, {
  resolveMotionFrameSource,
  rgbFrameToGrayFrame,
  shouldStartOnboardAnalyzer,
} from '../index.js'
import type { RunnerCameraConfig } from '@camstack/types'
import { makeRunnerCameraConfig } from '../../__tests__/support/runner-camera-config.js'

// ── helpers ────────────────────────────────────────────────────────────────

function makeConfig(patch: Partial<RunnerCameraConfig> = {}): RunnerCameraConfig {
  return makeRunnerCameraConfig({ deviceId: 1, motionSources: ['onboard'], ...patch })
}

/**
 * Typed accessor for private internals we need to drive in tests.
 * Using an accessor interface (not `as any`) keeps the "no as-casts" rule —
 * we cast once here at the boundary with a clear doc comment.
 */
interface AddonInternals {
  onInitialize(): Promise<unknown>
  handleOnboardMotionAnalyzer(deviceId: number, detected: boolean): Promise<void>
  onboardAnalyzerSubs: Map<number, () => void>
  onboardAnalyzerTeardownTimers: Map<number, ReturnType<typeof setTimeout>>
}

function asInternals(addon: PipelineRunnerAddon): AddonInternals {
  // Single type-boundary cast — private access for white-box testing.
  return addon as unknown as AddonInternals
}

function makeFakeCtx(_subscribeMotionFramesImpl?: () => Promise<(() => void) | null>) {
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

  const ctx = {
    id: 'pipeline-runner',
    logger,
    kernel: { localNodeId: 'hub' },
    eventBus: {
      emit: vi.fn(),
      subscribe: vi.fn(() => () => {}),
      getRecent: () => [],
    },
    api: {
      pipelineExecutor: {
        runPipeline: { mutate: vi.fn().mockResolvedValue(null) },
      },
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
  return { ctx, logger }
}

// ── Part 1: pure decision helper ───────────────────────────────────────────

describe('shouldStartOnboardAnalyzer', () => {
  it('returns true when flag is on and motionSources is onboard-only', () => {
    expect(shouldStartOnboardAnalyzer(makeConfig())).toBe(true)
  })

  it('returns false when flag is explicitly false', () => {
    expect(shouldStartOnboardAnalyzer(makeConfig({ onboardMotionDrivesAnalyzer: false }))).toBe(
      false,
    )
  })

  it('returns false when motionSources already includes analyzer', () => {
    expect(shouldStartOnboardAnalyzer(makeConfig({ motionSources: ['analyzer'] }))).toBe(false)
  })

  it('returns false when motionSources includes both onboard and analyzer', () => {
    expect(shouldStartOnboardAnalyzer(makeConfig({ motionSources: ['onboard', 'analyzer'] }))).toBe(
      false,
    )
  })

  it('returns true when motionSources is empty (no source, flag on)', () => {
    // Edge case: empty motionSources with flag on — analyzer not present, flag on → true.
    expect(shouldStartOnboardAnalyzer(makeConfig({ motionSources: [] }))).toBe(true)
  })
})

// ── Part 2: handleOnboardMotionAnalyzer orchestration ──────────────────────

describe('handleOnboardMotionAnalyzer', () => {
  let addon: PipelineRunnerAddon
  let internals: AddonInternals

  beforeEach(async () => {
    vi.useFakeTimers()
    addon = new PipelineRunnerAddon()
  })

  afterEach(async () => {
    vi.useRealTimers()
    await addon.shutdown().catch(() => {
      /* swallow */
    })
  })

  /**
   * Boot the addon with a ctx whose `subscribeMotionFrames` path is
   * controllable. We override the real `subscribeMotionFrames` via spying
   * after init, so we can control what it returns.
   */
  async function bootAddon(ctx: ReturnType<typeof makeFakeCtx>['ctx']): Promise<void> {
    Object.defineProperty(addon, 'ctx', { value: ctx, configurable: true })
    await asInternals(addon).onInitialize()
    internals = asInternals(addon)
  }

  it('opens a subscription on detected=true (flag on, onboard-only source)', async () => {
    const { ctx } = makeFakeCtx()
    await bootAddon(ctx)

    const deviceId = 1
    const config = makeConfig({ deviceId })

    // Spy on subscribeMotionFrames — return a mock unsubscribe fn.
    const mockUnsub = vi.fn()
    const subscribeMotionFramesSpy = vi
      .spyOn(
        addon as unknown as {
          subscribeMotionFrames(c: RunnerCameraConfig): Promise<(() => void) | null>
        },
        'subscribeMotionFrames',
      )
      .mockResolvedValue(mockUnsub)

    // Simulate attachCamera so the addon has the attachment record.
    await addon.attachCamera(config)

    // Trigger motion detected.
    await internals.handleOnboardMotionAnalyzer(deviceId, true)

    expect(subscribeMotionFramesSpy).toHaveBeenCalledOnce()
    expect(internals.onboardAnalyzerSubs.has(deviceId)).toBe(true)
    expect(internals.onboardAnalyzerTeardownTimers.has(deviceId)).toBe(true)
  })

  it('does NOT re-subscribe on a second detected=true (idempotent)', async () => {
    const { ctx } = makeFakeCtx()
    await bootAddon(ctx)

    const deviceId = 2
    const config = makeConfig({ deviceId })

    const mockUnsub = vi.fn()
    const subscribeMotionFramesSpy = vi
      .spyOn(
        addon as unknown as {
          subscribeMotionFrames(c: RunnerCameraConfig): Promise<(() => void) | null>
        },
        'subscribeMotionFrames',
      )
      .mockResolvedValue(mockUnsub)

    await addon.attachCamera(config)

    // First call opens the sub.
    await internals.handleOnboardMotionAnalyzer(deviceId, true)
    expect(subscribeMotionFramesSpy).toHaveBeenCalledOnce()

    // Second call must not open another sub.
    await internals.handleOnboardMotionAnalyzer(deviceId, true)
    expect(subscribeMotionFramesSpy).toHaveBeenCalledOnce()
  })

  it('does NOT subscribe when flag is off', async () => {
    const { ctx } = makeFakeCtx()
    await bootAddon(ctx)

    const deviceId = 3
    const config = makeConfig({ deviceId, onboardMotionDrivesAnalyzer: false })

    const subscribeMotionFramesSpy = vi
      .spyOn(
        addon as unknown as {
          subscribeMotionFrames(c: RunnerCameraConfig): Promise<(() => void) | null>
        },
        'subscribeMotionFrames',
      )
      .mockResolvedValue(vi.fn())

    await addon.attachCamera(config)
    await internals.handleOnboardMotionAnalyzer(deviceId, true)

    expect(subscribeMotionFramesSpy).not.toHaveBeenCalled()
    expect(internals.onboardAnalyzerSubs.has(deviceId)).toBe(false)
  })

  it('does NOT subscribe when motionSources includes analyzer', async () => {
    const { ctx } = makeFakeCtx()
    await bootAddon(ctx)

    const deviceId = 4
    // Use onboard-only here so attachCamera does NOT call subscribeMotionFrames.
    // The flag is on but analyzer is already in motionSources → gate is a no-op.
    // We pass motionSources with 'analyzer' directly to handleOnboardMotionAnalyzer
    // by patching the attachment after attaching with a safe config.
    const attachConfig = makeConfig({ deviceId, motionSources: ['onboard'] })

    const subscribeMotionFramesSpy = vi
      .spyOn(
        addon as unknown as {
          subscribeMotionFrames(c: RunnerCameraConfig): Promise<(() => void) | null>
        },
        'subscribeMotionFrames',
      )
      .mockResolvedValue(vi.fn())

    await addon.attachCamera(attachConfig)

    // Now simulate a config that already has 'analyzer' in motionSources by
    // directly invoking shouldStartOnboardAnalyzer logic check — or, simpler:
    // re-attach with the full config (motionSources=['onboard','analyzer']) so
    // the attachment reflects reality, then call the handler.
    await addon.attachCamera(makeConfig({ deviceId, motionSources: ['onboard', 'analyzer'] }))

    // Reset the spy AFTER attachCamera (which calls subscribeMotionFrames once
    // because 'analyzer' is in motionSources). The test verifies that
    // handleOnboardMotionAnalyzer does NOT open an ADDITIONAL dynamic sub.
    subscribeMotionFramesSpy.mockClear()

    await internals.handleOnboardMotionAnalyzer(deviceId, true)

    expect(subscribeMotionFramesSpy).not.toHaveBeenCalled()
    expect(internals.onboardAnalyzerSubs.has(deviceId)).toBe(false)
  })

  it('calls unsubscribe and clears maps after cooldown elapses (fake timers)', async () => {
    const { ctx } = makeFakeCtx()
    await bootAddon(ctx)

    const cooldownMs = 5_000
    const deviceId = 5
    const config = makeConfig({ deviceId, motionCooldownMs: cooldownMs })

    const mockUnsub = vi.fn()
    vi.spyOn(
      addon as unknown as {
        subscribeMotionFrames(c: RunnerCameraConfig): Promise<(() => void) | null>
      },
      'subscribeMotionFrames',
    ).mockResolvedValue(mockUnsub)

    await addon.attachCamera(config)

    // Open the subscription.
    await internals.handleOnboardMotionAnalyzer(deviceId, true)
    expect(internals.onboardAnalyzerSubs.has(deviceId)).toBe(true)

    // Fast-forward past the cooldown.
    vi.advanceTimersByTime(cooldownMs + 1)

    // Unsub must have been called and maps cleared.
    expect(mockUnsub).toHaveBeenCalledOnce()
    expect(internals.onboardAnalyzerSubs.has(deviceId)).toBe(false)
    expect(internals.onboardAnalyzerTeardownTimers.has(deviceId)).toBe(false)
  })

  it('re-arms the teardown timer on each motion event (timer reset)', async () => {
    const { ctx } = makeFakeCtx()
    await bootAddon(ctx)

    const cooldownMs = 5_000
    const deviceId = 6
    const config = makeConfig({ deviceId, motionCooldownMs: cooldownMs })

    const mockUnsub = vi.fn()
    vi.spyOn(
      addon as unknown as {
        subscribeMotionFrames(c: RunnerCameraConfig): Promise<(() => void) | null>
      },
      'subscribeMotionFrames',
    ).mockResolvedValue(mockUnsub)

    await addon.attachCamera(config)

    // Open sub.
    await internals.handleOnboardMotionAnalyzer(deviceId, true)

    // Advance 4 s — timer has not fired yet.
    vi.advanceTimersByTime(4_000)
    expect(mockUnsub).not.toHaveBeenCalled()

    // Another motion event re-arms the timer.
    await internals.handleOnboardMotionAnalyzer(deviceId, true)

    // Advance 4 s more (total 8 s since open, but only 4 s since re-arm).
    vi.advanceTimersByTime(4_000)
    expect(mockUnsub).not.toHaveBeenCalled()

    // Advance the remaining 1 s to cross the cooldown since re-arm.
    vi.advanceTimersByTime(1_001)
    expect(mockUnsub).toHaveBeenCalledOnce()
  })

  it('is a no-op when the camera is not attached', async () => {
    const { ctx } = makeFakeCtx()
    await bootAddon(ctx)

    const subscribeMotionFramesSpy = vi
      .spyOn(
        addon as unknown as {
          subscribeMotionFrames(c: RunnerCameraConfig): Promise<(() => void) | null>
        },
        'subscribeMotionFrames',
      )
      .mockResolvedValue(vi.fn())

    // Call without attaching camera first.
    await internals.handleOnboardMotionAnalyzer(999, true)

    expect(subscribeMotionFramesSpy).not.toHaveBeenCalled()
    expect(internals.onboardAnalyzerSubs.size).toBe(0)
  })
})

describe('resolveMotionFrameSource', () => {
  it('persistent (not shared) → gray on the motion (sub) stream', () => {
    const src = resolveMotionFrameSource(
      makeConfig({ motionStreamId: 'sub', detectionStreamId: 'main' }),
      false,
    )
    expect(src).toEqual({ streamId: 'sub', format: 'gray', shared: false })
  })

  it('sensor-triggered (shared) → rgb on the detection (main) stream — one shared decode', () => {
    const src = resolveMotionFrameSource(
      makeConfig({
        motionStreamId: 'sub',
        detectionStreamId: 'main',
        detectionMode: 'on-motion',
      }),
      true,
    )
    expect(src).toEqual({ streamId: 'main', format: 'rgb', shared: true })
  })

  it('shared requested but detection disabled → falls back to the sub-stream gray decode', () => {
    const src = resolveMotionFrameSource(
      makeConfig({ motionStreamId: 'sub', detectionStreamId: 'main', detectionMode: 'disabled' }),
      true,
    )
    expect(src).toEqual({ streamId: 'sub', format: 'gray', shared: false })
  })
})

describe('rgbFrameToGrayFrame', () => {
  it('converts RGB24 to GRAY8 via BT.601 luma and packs one byte per pixel', () => {
    // 2x1 image: pixel0 = pure white (255,255,255), pixel1 = pure black.
    const rgb = Buffer.from([255, 255, 255, 0, 0, 0])
    const out = rgbFrameToGrayFrame({
      data: rgb,
      width: 2,
      height: 1,
      format: 'rgb',
      timestamp: 42,
    })
    expect(out.format).toBe('gray')
    expect(out.width).toBe(2)
    expect(out.height).toBe(1)
    expect(out.timestamp).toBe(42)
    expect(out.data.byteLength).toBe(2) // one byte per pixel
    expect(out.data[0]).toBe(255) // white → 255
    expect(out.data[1]).toBe(0) // black → 0
  })

  it('weights green most (BT.601)', () => {
    // pure red, pure green, pure blue
    const rgb = Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255])
    const out = rgbFrameToGrayFrame({ data: rgb, width: 3, height: 1, format: 'rgb', timestamp: 0 })
    const [r, g, b] = [out.data[0]!, out.data[1]!, out.data[2]!]
    expect(g).toBeGreaterThan(r)
    expect(r).toBeGreaterThan(b)
    // Integer BT.601 approximations: 77, 150, 29 (over 256).
    expect(r).toBe(76)
    expect(g).toBe(149)
    expect(b).toBe(28)
  })
})
