/**
 * Detail state PARKS across a soft detach — the fleet-wide
 * `runDetailSubtree: camera is not attached` fix.
 *
 * An on-motion session closes (`motion_cleared` / the D261 stillness test) and
 * the runner soft-detaches, but post-analysis tracks stay live for 30 s after
 * `lastSeen` and the detail dispatcher keeps asking for face/clip/plate work on
 * the dead session's frames. Measured over 12 h: the ask arrives on the RIGHT
 * node (5000/5000 — the pin is correct) but `resolveDetailChildSteps` reads
 * `this.attached` alone, so every one of those asks was refused, and person
 * tracks appearing near the end of a session were never embedded (~600–900
 * refusals/h fleet-wide, 70% within 5 s of the detach).
 *
 * The fix: a SOFT detach parks the attach config's detail step tree for
 * `DETAIL_PARK_GRACE_MS` (30 s — the post-analysis durable-track TTL), so a
 * late ask still resolves its steps and cuts from whatever pixels remain (the
 * warm decode worker's subject tiles, the retained store). The window is
 * BOUNDED — an unbounded park would be the lease-TTL inflation D73 rejected —
 * and past it (or on a HARD detach) the refusal becomes a TYPED, wire-crossing
 * error (`runDetailSubtree-refused:not-attached`) so the dispatcher stops
 * burning the two doomed follow-up RPCs.
 */
import type { FrameHandle, RunnerCameraConfig } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeRunnerCameraConfig } from '../../__tests__/support/runner-camera-config.js'
import PipelineRunnerAddon from '../index.js'

const DEVICE_ID = 101

/**
 * Pinned literal, deliberately NOT imported: the grace is aligned to the
 * post-analysis durable-track TTL (`track-store.ts` `ttlMs: 30_000`) — if
 * someone moves `DETAIL_PARK_GRACE_MS` this spec must break so the alignment
 * is re-argued, not silently lost.
 */
const GRACE_MS = 30_000

function makeConfig(patch: Parameters<typeof makeRunnerCameraConfig>[0] = {}) {
  return makeRunnerCameraConfig({
    deviceId: DEVICE_ID,
    detectionMode: 'always-on',
    audioMode: 'disabled',
    motionCooldownMs: 30_000,
    motionFps: 4,
    detectionFps: 10,
    motionStreamId: 'sub',
    detectionStreamId: 'main',
    motionSources: [],
    pipelineEnabled: true,
    onboardMotionDrivesAnalyzer: false,
    zones: [],
    // The detail chain the dispatcher asks for: face-detection (inputClasses
    // ['person'] in the real catalog) with its face-embedding child.
    steps: [
      {
        addonId: 'object-detection',
        modelId: 'yolo',
        enabled: true,
        children: [
          {
            addonId: 'face-detection',
            modelId: 'scrfd-2.5g',
            enabled: true,
            children: [{ addonId: 'face-embedding', modelId: 'arcface', enabled: true }],
          },
        ],
      },
    ],
    ...patch,
  })
}

function makeFrameHandle(): FrameHandle {
  return {
    shmId: 'seg-1',
    slot: 0,
    seq: 1,
    width: 640,
    height: 360,
    format: 'rgb',
    pts: 0,
    byteLength: 640 * 360 * 3,
    nodeId: 'hub',
    slotCount: 4,
  }
}

interface FakeTileRequester {
  (
    bbox: unknown,
    maxWidth?: number,
  ): Promise<
    | {
        kind: 'crop'
        crop: { bytes: Uint8Array; width: number; height: number; source: string }
      }
    | { kind: 'miss'; workerReason?: string }
  >
  cutTiles(bboxes: readonly unknown[]): void
  release(): void
  markInferred(): void
}

/** A requester standing in for the warm decode worker's retained subject TILE. */
function makeTileRequester(): FakeTileRequester {
  const TILE_W = 64
  const TILE_H = 64
  return Object.assign(
    // The typed attempt the real requester resolves since 2026-09-07: a bare
    // crop object here would be read as a MISS by the runner, which is exactly
    // the fake-supplies-what-production-forgot failure this repo has shipped
    // twice.
    vi.fn(async () => ({
      kind: 'crop' as const,
      crop: {
        bytes: Buffer.alloc(TILE_W * TILE_H * 3, 128),
        width: TILE_W,
        height: TILE_H,
        source: 'tile',
      },
    })),
    { cutTiles: vi.fn(), release: vi.fn(), markInferred: vi.fn() },
  )
}

interface AddonInternals {
  onInitialize(): Promise<unknown>
  attached: Map<number, unknown>
  parkedDetail: Map<number, unknown>
  nativeCropRegistry: {
    register(handle: FrameHandle, request: FakeTileRequester, deviceId: number): void
  }
  detachInternal(deviceId: number, keepDecodeWarm?: boolean): void
}

function asInternals(addon: PipelineRunnerAddon): AddonInternals {
  // Single type-boundary cast — private access for white-box testing (same
  // convention as `detection-decode-soft-detach.spec.ts`).
  return addon as unknown as AddonInternals
}

function makeFakeCtx(runPipelineMock: ReturnType<typeof vi.fn>) {
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
    eventBus: {
      emit: vi.fn(),
      subscribe: vi.fn(() => () => {}),
      getRecent: () => [],
    },
    api: {
      pipelineExecutor: { runPipeline: { mutate: runPipelineMock } },
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

describe('detail state parks across a soft detach (not-attached refusal fix)', () => {
  let addon: PipelineRunnerAddon
  let runPipelineMock: ReturnType<typeof vi.fn>
  let unsubscribe: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    vi.useFakeTimers()
    runPipelineMock = vi.fn().mockResolvedValue({
      kind: 'frame',
      frameId: 'f1',
      deviceId: DEVICE_ID,
      timestamp: 0,
      width: 64,
      height: 64,
      detections: [
        {
          id: 'd1',
          kind: 'first-level',
          macroClass: 'face',
          score: 0.91,
          bbox: { x: 4, y: 4, width: 20, height: 24 },
          labels: [],
        },
      ],
    })
    addon = new PipelineRunnerAddon()
    const ctx = makeFakeCtx(runPipelineMock)
    Object.defineProperty(addon, 'ctx', { value: ctx, configurable: true })
    // `runDetailPipeline` reaches the executor through `ctxIfReady` (the
    // boot-order-safe view), which reads the private `_ctx` the harness's
    // `ctx` override never sets — expose the same fake there.
    Object.defineProperty(addon, 'ctxIfReady', {
      value: ctx,
      configurable: true,
    })
    await asInternals(addon).onInitialize()
    unsubscribe = vi.fn()
    vi.spyOn(
      addon as unknown as {
        subscribeDetectionFrames(c: RunnerCameraConfig): Promise<(() => void) | null>
      },
      'subscribeDetectionFrames',
    ).mockResolvedValue(unsubscribe)
  })

  afterEach(async () => {
    vi.useRealTimers()
    await addon.shutdown().catch(() => {
      /* swallow */
    })
  })

  async function attach(config: RunnerCameraConfig = makeConfig()): Promise<void> {
    await addon.attachCamera(config)
    await vi.advanceTimersByTimeAsync(0)
  }

  function dispatchDetail(handle: FrameHandle) {
    return addon.runDetailSubtree({
      deviceId: DEVICE_ID,
      frameHandle: handle,
      parent: { bbox: { x: 100, y: 100, w: 50, h: 80 }, className: 'person' },
      steps: ['face-detection', 'face-embedding'],
    })
  }

  it('(1) a dispatch within the grace window after a SOFT detach resolves the parked steps and cuts from the retained tile', async () => {
    await attach()
    const handle = makeFrameHandle()
    const tile = makeTileRequester()
    asInternals(addon).nativeCropRegistry.register(handle, tile, DEVICE_ID)

    await addon.detachCamera({ deviceId: DEVICE_ID }) // SOFT — motion-cooldown teardown

    await vi.advanceTimersByTimeAsync(4_000) // inside the grace window
    const result = await dispatchDetail(handle)

    // Steps resolved from the PARKED state (today: warn + null)…
    expect(result).not.toBeNull()
    expect(result?.details.length).toBeGreaterThan(0)
    // …and the crop was served from the retained subject tile (the fake
    // requester standing in for the warm decode worker).
    expect(tile).toHaveBeenCalledTimes(1)
    expect(runPipelineMock).toHaveBeenCalledTimes(1)
  })

  it('(2) the same dispatch past the grace window gets the TYPED not-attached refusal — the park is BOUNDED', async () => {
    await attach()
    const handle = makeFrameHandle()
    const tile = makeTileRequester()
    asInternals(addon).nativeCropRegistry.register(handle, tile, DEVICE_ID)

    await addon.detachCamera({ deviceId: DEVICE_ID })

    await vi.advanceTimersByTimeAsync(GRACE_MS + 1)
    await expect(dispatchDetail(handle)).rejects.toThrow(/not-attached/)
    // The doomed pixel work never even starts on a lapsed park.
    expect(tile).not.toHaveBeenCalled()
    expect(runPipelineMock).not.toHaveBeenCalled()
  })

  // 2026-09-30: `native crop refused … handle-expired` ~7 times per handle on
  // the live fleet — the dispatcher kept re-asking because a bare `null` could
  // not tell it the HANDLE was finished. The literal is pinned, not imported:
  // its twin lives in addon-post-analysis `detail-refusal.ts` and the two must
  // be moved together.
  it('(2b) a handle past the lease age bound on an ATTACHED camera gets the TYPED handle-expired refusal', async () => {
    await attach()
    const handle = makeFrameHandle()
    const tile = makeTileRequester()
    asInternals(addon).nativeCropRegistry.register(handle, tile, DEVICE_ID)

    await vi.advanceTimersByTimeAsync(30_001) // past NATIVE_CROP_LEASE_MAX_AGE_MS
    await expect(dispatchDetail(handle)).rejects.toThrow(/runDetailSubtree-refused:handle-expired/)
    expect(tile).not.toHaveBeenCalled()
    expect(runPipelineMock).not.toHaveBeenCalled()
  })

  it('(3) a HARD detach purges immediately: no parked state, worker released (tiles die with it), typed refusal at once', async () => {
    await attach()
    const handle = makeFrameHandle()
    const tile = makeTileRequester()
    asInternals(addon).nativeCropRegistry.register(handle, tile, DEVICE_ID)

    asInternals(addon).detachInternal(DEVICE_ID) // HARD — shutdown/reconfigure path

    expect(asInternals(addon).parkedDetail.size).toBe(0)
    // The decode worker is killed on a hard detach — its subject tiles die
    // with it (the registry entry's requester answers null once it is gone).
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    await expect(dispatchDetail(handle)).rejects.toThrow(/not-attached/)
  })

  it('(4) parked state cannot leak: cleared when the grace elapses, on re-attach, and on shutdown', async () => {
    // Grace elapse clears the entry (unref timer).
    await attach()
    await addon.detachCamera({ deviceId: DEVICE_ID })
    expect(asInternals(addon).parkedDetail.size).toBe(1)
    await vi.advanceTimersByTimeAsync(GRACE_MS + 1)
    expect(asInternals(addon).parkedDetail.size).toBe(0)

    // Re-attach supersedes the park.
    await attach()
    await addon.detachCamera({ deviceId: DEVICE_ID })
    expect(asInternals(addon).parkedDetail.size).toBe(1)
    await attach()
    expect(asInternals(addon).parkedDetail.size).toBe(0)

    // Shutdown clears whatever is parked.
    await addon.detachCamera({ deviceId: DEVICE_ID })
    expect(asInternals(addon).parkedDetail.size).toBe(1)
    await addon.shutdown()
    expect(asInternals(addon).parkedDetail.size).toBe(0)
  })
})
