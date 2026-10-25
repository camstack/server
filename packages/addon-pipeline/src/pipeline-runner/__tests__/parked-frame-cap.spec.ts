/**
 * The three park cap methods, wired through the REAL runner addon (D422):
 * `parkTrackFrame` resolves through the same node-wide registry `getNativeCrop`
 * uses, encodes once, and `getParkedTrackFrame` answers by `(deviceId,
 * trackId, kind)` — with no handle in the ask.
 *
 * The refusal case uses the measured number from D419 (a 30 099 ms handle):
 * the park is refused, the worker is never asked, and the line carries the
 * numeric `deviceId` and the age. That line is the whole point — a park that
 * arrives after the surface was swept is the defect, and it must be countable
 * per camera.
 */
import type { FrameHandle } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import PipelineRunnerAddon from '../index.js'

const DEVICE_ID = 111
const NODE_ID = 'MacMiniAgent.localdomain'
const MEASURED_LATE_AGE_MS = 30_099

function makeFrameHandle(): FrameHandle {
  return {
    shmId: 'csr.dev1443',
    slot: 0,
    seq: 7,
    width: 3840,
    height: 2160,
    format: 'rgb',
    pts: 0,
    byteLength: 3840 * 2160 * 3,
    nodeId: NODE_ID,
    slotCount: 4,
  }
}

interface FakeRequester {
  (
    bbox: unknown,
    maxWidth?: number,
  ): Promise<{
    kind: 'crop'
    crop: { bytes: Uint8Array; width: number; height: number; source: string }
  }>
  release(): void
  markInferred(): void
  cutTiles(bboxes: readonly unknown[]): void
}

/** A worker that answers with a 64×64 tile — so an encode has real pixels. */
function makeRequester(): FakeRequester {
  return Object.assign(
    vi.fn(async () => ({
      kind: 'crop' as const,
      crop: { bytes: Buffer.alloc(64 * 64 * 3, 128), width: 64, height: 64, source: 'tile' },
    })),
    { release: vi.fn(), markInferred: vi.fn(), cutTiles: vi.fn() },
  )
}

interface AddonInternals {
  onInitialize(): Promise<unknown>
  nativeCropRegistry: {
    register(handle: FrameHandle, request: FakeRequester, deviceId: number): void
  }
}

function asInternals(addon: PipelineRunnerAddon): AddonInternals {
  // Single documented type boundary — white-box access to the node-wide
  // registry, the same convention as `native-crop-age-refusal.spec.ts`.
  return addon as unknown as AddonInternals
}

function makeFakeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}

type FakeLogger = ReturnType<typeof makeFakeLogger>

function makeFakeCtx(logger: FakeLogger) {
  return {
    id: 'pipeline-runner',
    logger: {
      ...logger,
      child: vi.fn(function (this: unknown) {
        return this
      }),
      withTags: vi.fn(function (this: unknown) {
        return this
      }),
    },
    kernel: { localNodeId: NODE_ID },
    eventBus: { emit: vi.fn(), subscribe: vi.fn(() => () => {}), getRecent: () => [] },
    api: { pipelineExecutor: { runPipeline: { mutate: vi.fn() } }, streamBroker: {} },
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

describe('parkTrackFrame / getParkedTrackFrame / releaseParkedTrackFrames', () => {
  let addon: PipelineRunnerAddon
  let logger: FakeLogger

  beforeEach(async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-09T10:00:00Z'))
    logger = makeFakeLogger()
    addon = new PipelineRunnerAddon()
    const ctx = makeFakeCtx(logger)
    Object.defineProperty(addon, 'ctx', { value: ctx, configurable: true })
    Object.defineProperty(addon, 'ctxIfReady', { value: ctx, configurable: true })
    await asInternals(addon).onInitialize()
  })

  afterEach(async () => {
    vi.useRealTimers()
    await addon.shutdown().catch(() => {
      /* swallow */
    })
  })

  it('a young handle is parked once and retrieved by (deviceId, trackId, kind) with no handle in the ask', async () => {
    const handle = makeFrameHandle()
    const requester = makeRequester()
    asInternals(addon).nativeCropRegistry.register(handle, requester, DEVICE_ID)

    vi.setSystemTime(Date.now() + 300)
    const parked = await addon.parkTrackFrame({
      deviceId: DEVICE_ID,
      trackId: 'd64ace88',
      kind: 'thumbnail',
      handle,
      bbox: { x: 0.4, y: 0.35, w: 0.12, h: 0.2 },
      timestamp: 1_757_412_000_300,
    })
    expect(parked).toMatchObject({ parked: true, nodeId: NODE_ID, width: 64, height: 64 })
    expect(requester).toHaveBeenCalledTimes(1)

    // Retrieval names the track, never the frame — and works at ANY age.
    vi.setSystemTime(Date.now() + 5 * 60_000)
    const parcel = await addon.getParkedTrackFrame({
      deviceId: DEVICE_ID,
      trackId: 'd64ace88',
      kind: 'thumbnail',
    })
    expect(parcel).not.toBeNull()
    expect(parcel?.width).toBe(64)
    expect(parcel?.timestamp).toBe(1_757_412_000_300)
    const bytes = Buffer.from(parcel?.jpeg ?? '', 'base64')
    // A real JPEG (SOI marker) — the runner's own encode, handed on verbatim.
    expect(bytes[0]).toBe(0xff)
    expect(bytes[1]).toBe(0xd8)
    // The worker was not asked again for the retrieval.
    expect(requester).toHaveBeenCalledTimes(1)

    const released = await addon.releaseParkedTrackFrames({
      deviceId: DEVICE_ID,
      trackId: 'd64ace88',
    })
    expect(released).toEqual({ released: 1 })
    expect(
      await addon.getParkedTrackFrame({
        deviceId: DEVICE_ID,
        trackId: 'd64ace88',
        kind: 'thumbnail',
      }),
    ).toBeNull()
  })

  it('a park for a handle past the lease bound is REFUSED, the worker is never asked, and the line carries deviceId + age', async () => {
    const handle = makeFrameHandle()
    const requester = makeRequester()
    asInternals(addon).nativeCropRegistry.register(handle, requester, DEVICE_ID)

    vi.setSystemTime(Date.now() + MEASURED_LATE_AGE_MS + 1)
    const result = await addon.parkTrackFrame({
      deviceId: DEVICE_ID,
      trackId: 'd64ace88',
      kind: 'keyFrame',
      handle,
      bbox: { x: 0, y: 0, w: 1, h: 1 },
      maxWidth: 4096,
      timestamp: 1,
    })
    expect(result).toMatchObject({ parked: false, reason: 'handle-gone', nodeId: NODE_ID })
    if (!result.parked) expect(result.handleAgeMs).toBe(MEASURED_LATE_AGE_MS + 1)
    expect(requester).not.toHaveBeenCalled()

    const refusals = logger.warn.mock.calls.filter(([m]) => /park refused/.test(String(m)))
    expect(refusals).toHaveLength(1)
    expect(refusals[0]?.[1]).toMatchObject({
      tags: { deviceId: DEVICE_ID },
      meta: {
        trackId: 'd64ace88',
        kind: 'keyFrame',
        reason: 'handle-gone',
        handleAgeMs: MEASURED_LATE_AGE_MS + 1,
      },
    })
    expect(
      await addon.getParkedTrackFrame({
        deviceId: DEVICE_ID,
        trackId: 'd64ace88',
        kind: 'keyFrame',
      }),
    ).toBeNull()
  })

  it('a key nothing was parked under answers null — and releasing it is a no-op', async () => {
    expect(
      await addon.getParkedTrackFrame({ deviceId: DEVICE_ID, trackId: 'nobody', kind: 'keyFrame' }),
    ).toBeNull()
    expect(
      await addon.releaseParkedTrackFrames({ deviceId: DEVICE_ID, trackId: 'nobody' }),
    ).toEqual({ released: 0 })
  })
})
