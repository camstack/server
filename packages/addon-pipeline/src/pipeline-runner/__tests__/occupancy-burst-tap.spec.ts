/**
 * Task 10 — occupancy bursts reuse decoded motion frames on analyzer
 * cameras.
 *
 * `runOccupancyBurst` normally dials a fresh main-stream decode session for
 * every burst — since the shm-ring removal (2026-07-16) that dial is a
 * per-session decode worker (`startGuardedSessionDecode` → broker restream
 * acquire → `startSessionDecodePump`), no longer the deleted shm
 * frame-handle poller. When the camera's motion analyzer already holds a
 * live substream subscription (`attachment.motionUnsubscribe !== null` —
 * set at attach time when `motionSources` includes `'analyzer'`), the burst
 * should instead TEE already-arriving substream frames into detection
 * admission (`runner.enqueueOccupancyFrame`) via the existing motion-frame
 * path (`runMotionAnalysis`), and report the outcome through the SAME
 * found/report path Task 9 wired up (`occupancyBurstFound` →
 * `reportOccupancyBurstOutcome`) — no new decode session.
 *
 * `startSessionDecodePump` is the module-level factory the dial path uses
 * to spin the decode worker; mocking the whole module (plus asserting on
 * the broker `getStreamWithCodec` acquire) lets these tests verify the
 * dial is NEVER started on the tap path (and IS started on the unchanged
 * dial path for onboard-only cameras) without forking a real worker.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const { startSessionDecodePumpMock } = vi.hoisted(() => ({ startSessionDecodePumpMock: vi.fn() }))
vi.mock('../../session-decode/session-decode-pump.js', () => ({
  startSessionDecodePump: startSessionDecodePumpMock,
}))

import PipelineRunnerAddon from '../index.js'
import type { PipelineRunner } from '../runner.js'
import type { DecodedFrame, FrameHandle, FrameResult, RunnerCameraConfig } from '@camstack/types'

// ── helpers ────────────────────────────────────────────────────────────────

function makeConfig(patch: Partial<RunnerCameraConfig> = {}): RunnerCameraConfig {
  return {
    deviceId: 1,
    detectionMode: 'on-motion',
    audioMode: 'always-on',
    motionCooldownMs: 5_000,
    motionFps: 4,
    detectionFps: 10,
    motionStreamId: 'low',
    detectionStreamId: 'low',
    motionSources: ['analyzer'],
    pipelineEnabled: true,
    zones: [],
    // A root step, so a burst frame is really INFERRED: since D652 a burst
    // that inferred nothing produces no verdict at all.
    steps: [{ addonId: 'object-detection', modelId: 'yolo', enabled: true }],
    onboardMotionDrivesAnalyzer: false,
    // Off, as an absent value read at runtime: these specs are not about them.
    preRollInferenceEnabled: false,
    preRollInferenceFrames: 0,
    occupancyRecheckEnabled: false,
    occupancyRecheckSec: 0,
    occupancyRecheckFrames: 0,
    ...patch,
  }
}

/** An inference that ran and found nothing — a real look at an empty scene. */
function emptyResult(deviceId: number): FrameResult {
  return {
    kind: 'frame',
    frameId: 'f-empty',
    deviceId,
    timestamp: Date.now(),
    width: 2,
    height: 2,
    detections: [],
  }
}

function makeFrame(patch: Partial<DecodedFrame> = {}): DecodedFrame {
  return {
    data: Buffer.alloc(4),
    width: 2,
    height: 2,
    format: 'gray',
    timestamp: Date.now(),
    ...patch,
  }
}

function makeHandle(patch: Partial<FrameHandle> = {}): FrameHandle {
  return {
    shmId: 'test-shm',
    slot: 0,
    seq: 2,
    width: 2,
    height: 2,
    format: 'gray',
    pts: 0,
    byteLength: 4,
    nodeId: 'hub',
    slotCount: 8,
    ...patch,
  }
}

/**
 * Typed accessor for the private internals these white-box tests drive.
 * Single type-boundary cast, matching the pattern used across this test
 * suite (see `onboard-motion-analyzer.spec.ts`).
 */
interface AddonInternals {
  onInitialize(): Promise<unknown>
  runOccupancyBurst(deviceId: number, frames: number): Promise<void>
  runMotionAnalysis(
    deviceId: number,
    frame: DecodedFrame,
    handle: FrameHandle | undefined,
  ): Promise<void>
  readonly occupancyBurstFound: Set<number>
  readonly occupancyTaps: Map<number, unknown>
  readonly runner: PipelineRunner | null
}

function asInternals(addon: PipelineRunnerAddon): AddonInternals {
  return addon as unknown as AddonInternals
}

function makeFakeCtx() {
  const analyze = vi.fn().mockResolvedValue({
    detected: false,
    regionCount: 0,
    regions: [],
    rawRegions: [],
    frameWidth: 2,
    frameHeight: 2,
    analysisMs: 1,
  })
  const runPipeline = vi.fn<(input: { deviceId: number }) => Promise<FrameResult | null>>(
    async (input) => emptyResult(input.deviceId),
  )
  // Session-decode acquire surface for the occupancy DIAL path: resolve the
  // profile the camStream feeds, then acquire the copy restream. Every suite
  // device (101–106) maps its 'low' camStream to a same-named profile.
  const listAllProfileSlots = vi.fn().mockResolvedValue(
    [101, 102, 103, 104, 105, 106].map((deviceId) => ({
      deviceId,
      sourceCamStreamId: 'low',
      profile: 'low',
    })),
  )
  const getStreamWithCodec = vi.fn().mockResolvedValue({
    url: 'rtsp://127.0.0.1/copy',
    videoCodec: 'H264',
    pipelineKey: 'pk-occupancy',
  })

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
    eventBus: { emit: vi.fn(), subscribe: vi.fn(() => () => {}), getRecent: () => [] },
    api: {
      motionDetection: { analyze: { mutate: analyze } },
      pipelineExecutor: { runPipeline: { mutate: runPipeline } },
      streamBroker: {
        listAllProfileSlots: { query: listAllProfileSlots },
        getStreamWithCodec: { mutate: getStreamWithCodec },
        releaseStreamWithCodec: { mutate: vi.fn().mockResolvedValue(undefined) },
      },
    },
    settings: {
      readAddonStore: vi.fn(async () => ({})),
      writeAddonStore: vi.fn(async () => undefined),
      readDeviceStore: vi.fn(async () => ({})),
      writeDeviceStore: vi.fn(async () => undefined),
      getSection: vi.fn(async () => ({})),
      setSection: vi.fn(async () => undefined),
    },
  }
  return { ctx, analyze, runPipeline, getStreamWithCodec, logger }
}

/**
 * Flush the microtask queue enough turns for the dial path's guarded
 * background acquire (`listAllProfileSlots` → `getStreamWithCodec` →
 * `startPump`) to complete — it is fire-and-forget inside
 * `startGuardedSessionDecode`, so tests must yield before asserting on it.
 * Microtask-only (works under fake timers too: the acquire chain awaits
 * immediately-resolved mocks, never a timer).
 */
async function flushDialAcquire(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

describe('occupancy burst — analyzer-flowing tap (Task 10)', () => {
  let addon: PipelineRunnerAddon
  let internals: AddonInternals

  beforeEach(() => {
    startSessionDecodePumpMock.mockReset()
    // Default: the pump "starts" but never delivers a frame (mirrors the old
    // never-resolving poller default) — bursts settle via their safety timer.
    startSessionDecodePumpMock.mockReturnValue(() => {})
    addon = new PipelineRunnerAddon()
  })

  afterEach(async () => {
    vi.useRealTimers()
    await addon.shutdown().catch(() => {
      /* swallow */
    })
  })

  async function bootWithFlowingAnalyzer(
    ctx: ReturnType<typeof makeFakeCtx>['ctx'],
    deviceId: number,
  ): Promise<() => void> {
    Object.defineProperty(addon, 'ctx', { value: ctx, configurable: true })
    await asInternals(addon).onInitialize()
    internals = asInternals(addon)

    // Stub the analyzer's live substream subscription directly (mirrors
    // `onboard-motion-analyzer.spec.ts`) — this is the runtime signal
    // (`attachment.motionUnsubscribe !== null`) `runOccupancyBurst` reads
    // to decide tap-vs-dial. Bypassing the real `subscribeMotionFrames`
    // body means the pump mock + broker acquire start this suite un-called,
    // so any call recorded during the BURST itself is unambiguous.
    const motionUnsub = vi.fn()
    vi.spyOn(
      addon as unknown as {
        subscribeMotionFrames(c: RunnerCameraConfig): Promise<(() => void) | null>
      },
      'subscribeMotionFrames',
    ).mockResolvedValue(motionUnsub)

    await addon.attachCamera(makeConfig({ deviceId }))
    return motionUnsub
  }

  it('consumes N tee-d motion frames, never dials, and reports found=true from the tee-d results', async () => {
    const { ctx } = makeFakeCtx()
    const deviceId = 101
    await bootWithFlowingAnalyzer(ctx, deviceId)

    // Seed the freshness signal (Task 10 hardening #1) via a real
    // motion-frame delivery through the existing motion-frame path, BEFORE
    // the burst starts — `runOccupancyBurst` reads `lastMotionFrameAt`
    // synchronously at call time. No tap is armed yet, so this tee is a
    // no-op and doesn't affect the enqueue-count assertions below.
    await internals.runMotionAnalysis(deviceId, makeFrame(), makeHandle())

    const runner = internals.runner
    expect(runner).not.toBeNull()
    const enqueueSpy = vi.spyOn(runner as PipelineRunner, 'enqueueOccupancyFrame')
    const reportSpy = vi.spyOn(runner as PipelineRunner, 'reportOccupancyBurstOutcome')

    const burstPromise = internals.runOccupancyBurst(deviceId, 3)

    // Feed 3 motion frames through the EXISTING motion-frame path — the
    // same call site `drainMotionQueues` invokes per arriving substream
    // frame in production.
    await internals.runMotionAnalysis(deviceId, makeFrame({ timestamp: 1 }), makeHandle({ seq: 2 }))
    await internals.runMotionAnalysis(deviceId, makeFrame({ timestamp: 2 }), makeHandle({ seq: 4 }))
    // Simulate the `onResult` handler having already flagged a detection
    // for this in-flight burst (Task 9's found/report contract, unchanged
    // by Task 10 — see `occupancyBurstFound`'s doc in index.ts) before the
    // budget-draining frame arrives.
    internals.occupancyBurstFound.add(deviceId)
    await internals.runMotionAnalysis(deviceId, makeFrame({ timestamp: 3 }), makeHandle({ seq: 6 }))

    await burstPromise

    expect(enqueueSpy).toHaveBeenCalledTimes(3)
    expect(enqueueSpy.mock.calls[0]).toEqual([
      deviceId,
      expect.objectContaining({ timestamp: 1 }),
      expect.objectContaining({ seq: 2 }),
      // The frame's settler: the burst completes on inference (D652).
      expect.any(Function),
    ])

    expect(reportSpy).toHaveBeenCalledExactlyOnceWith(deviceId, true)

    // The tap path must never open a new main-stream decode session.
    expect(startSessionDecodePumpMock).not.toHaveBeenCalled()
    expect(ctx.api.streamBroker.getStreamWithCodec.mutate).not.toHaveBeenCalled()
  })

  it('reports found=false when no tee-d frame carried a detection', async () => {
    const { ctx } = makeFakeCtx()
    const deviceId = 102
    await bootWithFlowingAnalyzer(ctx, deviceId)

    // Seed the freshness signal (Task 10 hardening #1) before the burst
    // starts — see the identical seed step in the previous test.
    await internals.runMotionAnalysis(deviceId, makeFrame(), makeHandle())

    const runner = internals.runner
    const reportSpy = vi.spyOn(runner as PipelineRunner, 'reportOccupancyBurstOutcome')

    const burstPromise = internals.runOccupancyBurst(deviceId, 2)
    await internals.runMotionAnalysis(deviceId, makeFrame(), makeHandle())
    await internals.runMotionAnalysis(deviceId, makeFrame(), makeHandle())
    await burstPromise

    expect(reportSpy).toHaveBeenCalledExactlyOnceWith(deviceId, false)
    expect(startSessionDecodePumpMock).not.toHaveBeenCalled()
  })

  it('completes and reports via the safety timeout when motion frames stop arriving mid-burst', async () => {
    vi.useFakeTimers()
    const { ctx } = makeFakeCtx()
    const deviceId = 103
    await bootWithFlowingAnalyzer(ctx, deviceId)

    // Seed the freshness signal (Task 10 hardening #1) before the burst
    // starts — see the identical seed step in the first test above.
    await internals.runMotionAnalysis(deviceId, makeFrame(), makeHandle())

    const runner = internals.runner
    const enqueueSpy = vi.spyOn(runner as PipelineRunner, 'enqueueOccupancyFrame')
    const reportSpy = vi.spyOn(runner as PipelineRunner, 'reportOccupancyBurstOutcome')

    const burstPromise = internals.runOccupancyBurst(deviceId, 5)

    // Only 1 of the 5 requested frames ever arrives DURING the burst — the
    // motion watch closes mid-burst (e.g. camera detaches, cooldown fires) —
    // mirroring the dial path's safety-timeout regression coverage. Since
    // this 1 frame is collected (> 0), the burst reports normally instead
    // of taking the Task 10 hardening #2 zero-collected dial fallback (see
    // the dedicated test for that path below).
    await internals.runMotionAnalysis(deviceId, makeFrame(), makeHandle())

    // Mirrors the dial path's 8s safety timeout.
    await vi.advanceTimersByTimeAsync(8_000)
    await burstPromise

    expect(enqueueSpy).toHaveBeenCalledTimes(1)
    expect(reportSpy).toHaveBeenCalledExactlyOnceWith(deviceId, false)
    expect(startSessionDecodePumpMock).not.toHaveBeenCalled()
  })

  it('onboard-only cameras (no analyzer flowing) keep dialing — dial path unchanged', async () => {
    const { ctx } = makeFakeCtx()
    Object.defineProperty(addon, 'ctx', { value: ctx, configurable: true })
    await asInternals(addon).onInitialize()
    internals = asInternals(addon)

    const deviceId = 104
    // `motionSources: ['onboard']` — `attachCamera` never calls
    // `subscribeMotionFrames`, so `attachment.motionUnsubscribe` stays
    // `null` and `runOccupancyBurst` must take the dial path.
    await addon.attachCamera(makeConfig({ deviceId, motionSources: ['onboard'] }))

    void internals.runOccupancyBurst(deviceId, 4)
    // Yield so the dial path's fire-and-forget guarded acquire
    // (listAllProfileSlots → getStreamWithCodec → startPump) completes.
    await flushDialAcquire()

    // The dial acquired the occupancy restream and started the decode pump.
    expect(ctx.api.streamBroker.getStreamWithCodec.mutate).toHaveBeenCalledOnce()
    const call = ctx.api.streamBroker.getStreamWithCodec.mutate.mock.calls[0]![0] as Record<
      string,
      unknown
    >
    expect(call['tag']).toBe(`session-decode:occupancy:${deviceId}`)
    expect(startSessionDecodePumpMock).toHaveBeenCalledOnce()
  })

  it('motionUnsubscribe non-null but lastMotionFrameAt stale (>5s) — burst dials immediately, no tap', async () => {
    vi.useFakeTimers()
    const { ctx } = makeFakeCtx()
    const deviceId = 105
    await bootWithFlowingAnalyzer(ctx, deviceId)

    // A motion frame arrived once, but long enough ago that the analyzer
    // subscription can no longer be trusted as "flowing" (Task 10
    // hardening #1 — `attachment.motionUnsubscribe !== null` alone is not
    // a truthful liveness signal; see MOTION_FRESHNESS_WINDOW_MS in
    // index.ts). Advance past the 5s freshness window before starting the
    // burst.
    await internals.runMotionAnalysis(deviceId, makeFrame(), makeHandle())
    await vi.advanceTimersByTimeAsync(5_001)

    void internals.runOccupancyBurst(deviceId, 4)
    // Yield so the dial path's fire-and-forget guarded acquire
    // (listAllProfileSlots → getStreamWithCodec → startPump) completes.
    await flushDialAcquire()

    // The dial acquired the occupancy restream and started the decode pump.
    expect(ctx.api.streamBroker.getStreamWithCodec.mutate).toHaveBeenCalledOnce()
    const call = ctx.api.streamBroker.getStreamWithCodec.mutate.mock.calls[0]![0] as Record<
      string,
      unknown
    >
    expect(call['tag']).toBe(`session-decode:occupancy:${deviceId}`)
    expect(startSessionDecodePumpMock).toHaveBeenCalledOnce()
    // No tap was ever armed for this device.
    expect(internals.occupancyTaps.has(deviceId)).toBe(false)
  })

  it('tap that collects zero frames by the safety timeout falls back to dial exactly once, no double-report', async () => {
    vi.useFakeTimers()
    const { ctx } = makeFakeCtx()
    const deviceId = 106
    await bootWithFlowingAnalyzer(ctx, deviceId)

    // Seed the freshness signal so the burst takes the tap path.
    await internals.runMotionAnalysis(deviceId, makeFrame(), makeHandle())

    const runner = internals.runner
    const reportSpy = vi.spyOn(runner as PipelineRunner, 'reportOccupancyBurstOutcome')

    // The Task 10 hardening #2 fallback dial delivers its frames
    // synchronously (the pump mock fires `onDecodedFrame` twice at start) so
    // the fallback burst completes deterministically instead of relying on a
    // second 8s safety timeout.
    startSessionDecodePumpMock.mockImplementationOnce(
      (deps: { onDecodedFrame: (frame: DecodedFrame) => void }) => {
        deps.onDecodedFrame(makeFrame())
        deps.onDecodedFrame(makeFrame())
        return () => {}
      },
    )

    const burstPromise = internals.runOccupancyBurst(deviceId, 2)

    // No motion frames arrive during the burst — the tap collects nothing
    // and its safety timeout fires.
    await vi.advanceTimersByTimeAsync(8_000)
    await burstPromise
    // The fallback dial's guarded acquire is fire-and-forget — flush it so
    // the pump mock delivers its frames — then let the runner's tick infer
    // them: the burst reports once its admitted frames settle (D652).
    await flushDialAcquire()
    await vi.advanceTimersByTimeAsync(100)

    // Fallback dial happened exactly once (not the tap path again).
    expect(startSessionDecodePumpMock).toHaveBeenCalledOnce()
    // Outcome reported exactly once, from the dial results — never from
    // the zero-collected tap.
    expect(reportSpy).toHaveBeenCalledExactlyOnceWith(deviceId, false)
    // The settled tap entry is gone and was never re-armed.
    expect(internals.occupancyTaps.has(deviceId)).toBe(false)
  })
})

/**
 * D652 — the DIAL burst completes on inference, not on enqueue.
 *
 * `runOccupancyDial` used to enqueue its last frame and call `cleanup()` in the
 * same synchronous turn: teardown killed the decode worker the lazy frames
 * lived in, and the verdict was read before any of them had been inferred —
 * 122 of 187 live bursts lost at least one frame, silently.
 */
describe('occupancy burst — the dial completes on inference (D652)', () => {
  let addon: PipelineRunnerAddon
  let internals: AddonInternals

  beforeEach(() => {
    startSessionDecodePumpMock.mockReset()
    addon = new PipelineRunnerAddon()
  })

  afterEach(async () => {
    await addon.shutdown().catch(() => {
      /* swallow */
    })
  })

  it('waits for the frames it admitted, reports the verdict they produced, and names what it lost', async () => {
    const { ctx, runPipeline, logger } = makeFakeCtx()
    Object.defineProperty(addon, 'ctx', { value: ctx, configurable: true })
    await asInternals(addon).onInitialize()
    internals = asInternals(addon)
    const deviceId = 104
    await addon.attachCamera(makeConfig({ deviceId, motionSources: ['onboard'] }))

    // Inference is held open until the test releases it — the window in which
    // the old code had already reported and killed the worker.
    let releaseInference: () => void = () => undefined
    runPipeline.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseInference = () =>
            resolve({
              kind: 'frame',
              frameId: 'f-1',
              deviceId,
              timestamp: Date.now(),
              width: 2,
              height: 2,
              detections: [
                {
                  id: 'd-1',
                  kind: 'first-level',
                  macroClass: 'person',
                  score: 0.9,
                  labels: [{ label: 'person', score: 0.9 }],
                  bbox: { x: 0, y: 0, width: 1, height: 1 },
                },
              ],
            })
        }),
    )
    const stopPump = vi.fn()
    startSessionDecodePumpMock.mockImplementationOnce(
      (deps: { onDecodedFrame: (frame: DecodedFrame) => void }) => {
        // Four frames in one turn: the latest-only queue keeps the newest and
        // lets the other three go — three frames the verdict will not see.
        for (let i = 0; i < 4; i++) deps.onDecodedFrame(makeFrame({ timestamp: i + 1 }))
        return stopPump
      },
    )
    const reportSpy = vi.spyOn(internals.runner as PipelineRunner, 'reportOccupancyBurstOutcome')

    void internals.runOccupancyBurst(deviceId, 4)
    await flushDialAcquire()
    await new Promise((resolve) => setTimeout(resolve, 40))

    // All four collected, one in inference: NOT complete yet. Collection is
    // over, so decoding stops at once — a DRAIN, which keeps the admitted
    // frame readable until its inference is done (M2).
    expect(runPipeline).toHaveBeenCalledTimes(1)
    expect(reportSpy).not.toHaveBeenCalled()
    expect(stopPump).toHaveBeenCalledExactlyOnceWith('drain')

    releaseInference()
    await new Promise((resolve) => setTimeout(resolve, 40))

    expect(reportSpy).toHaveBeenCalledExactlyOnceWith(deviceId, true)
    // Three frames were SUPERSEDED on the latest-only queue by the fourth —
    // the queue's design, not a loss (M3): the line stays at debug.
    expect(logger.debug).toHaveBeenCalledWith(
      'occupancy re-check: burst complete',
      expect.objectContaining({
        tags: { deviceId },
        meta: expect.objectContaining({
          frames: 4,
          inferred: 1,
          superseded: 3,
          lost: 0,
          found: true,
        }),
      }),
    )
  })

  // D652 ruling (D49): a burst that inferred NOTHING observed nothing. It is
  // not an empty scene, so it must not count toward disarming the recheck.
  it('a burst that inferred nothing produces NO verdict, and says so at info', async () => {
    const { ctx, runPipeline, logger } = makeFakeCtx()
    Object.defineProperty(addon, 'ctx', { value: ctx, configurable: true })
    await asInternals(addon).onInitialize()
    internals = asInternals(addon)
    const deviceId = 105
    await addon.attachCamera(makeConfig({ deviceId, motionSources: ['onboard'] }))
    // Every inference answers with nothing — the executor is not there.
    runPipeline.mockImplementation(async () => null)
    startSessionDecodePumpMock.mockImplementationOnce(
      (deps: { onDecodedFrame: (frame: DecodedFrame) => void }) => {
        deps.onDecodedFrame(makeFrame({ timestamp: 1 }))
        return vi.fn()
      },
    )
    const reportSpy = vi.spyOn(internals.runner as PipelineRunner, 'reportOccupancyBurstOutcome')

    void internals.runOccupancyBurst(deviceId, 1)
    await flushDialAcquire()
    await new Promise((resolve) => setTimeout(resolve, 40))

    expect(reportSpy).not.toHaveBeenCalled()
    expect(logger.info).toHaveBeenCalledWith(
      'occupancy re-check: burst complete — nothing inferred, no verdict',
      expect.objectContaining({
        tags: { deviceId },
        meta: expect.objectContaining({ frames: 1, inferred: 0, lost: 1, verdict: null }),
      }),
    )
  })
})
