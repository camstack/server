/**
 * The runner half of a PARK (D422): pixels this node already holds, cut for
 * the rectangle the hub named, encoded ONCE, kept under `(deviceId, trackId,
 * kind)`.
 *
 * Pinned here:
 *  - a park that resolves stores the runner's own JPEG and answers with the
 *    node that holds it;
 *  - a park whose handle is already gone is REFUSED, logged with
 *    `tags: { deviceId }` and the measured handle age — and the native surface
 *    is asked exactly once (never retried into a loop);
 *  - a `ram-fullframe` tier is a refusal too: a parcel is native or nothing
 *    (the same rule the subject-crop tier gate applies);
 *  - an encode failure is its own reason, because it is the one failure that
 *    is not a timing problem.
 */
import type { IScopedLogger } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { ParkedFrameStore } from '../../session-decode/parked-frame-store.js'
import {
  parkTrackFrame,
  type TrackFrameParkDeps,
  type ParkTrackFrameInput,
} from '../track-frame-park.js'

const NODE_ID = 'agent-a'
const DEVICE_ID = 102

interface LoggerSpy {
  readonly logger: IScopedLogger
  readonly calls: { level: string; message: string; extras?: unknown }[]
}

function makeLoggerSpy(): LoggerSpy {
  const calls: { level: string; message: string; extras?: unknown }[] = []
  const record =
    (level: string) =>
    (message: string, extras?: unknown): void => {
      calls.push({ level, message, ...(extras !== undefined ? { extras } : {}) })
    }
  const logger: IScopedLogger = {
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    child: () => logger,
    withTags: () => logger,
  }
  return { logger, calls }
}

const input: ParkTrackFrameInput = {
  deviceId: DEVICE_ID,
  trackId: 't-1',
  kind: 'keyFrame',
  handle: {
    shmId: 'ram:agent-a:102',
    slot: 3,
    seq: 12,
    width: 640,
    height: 360,
    format: 'rgb',
    pts: 1,
    byteLength: 640 * 360 * 3,
    nodeId: NODE_ID,
    slotCount: 1024,
  },
  bbox: { x: 0, y: 0, w: 1, h: 1 },
  maxWidth: 4096,
  timestamp: 1_000,
}

const NATIVE_PIXELS = { bytes: new Uint8Array(3840 * 2160 * 3), width: 3840, height: 2160 }

function makeDeps(
  overrides: Partial<TrackFrameParkDeps> & { readonly logger: IScopedLogger },
): TrackFrameParkDeps {
  return {
    nodeId: NODE_ID,
    store: new ParkedFrameStore(),
    resolvePixels: vi.fn(async () => ({
      pixels: NATIVE_PIXELS,
      tier: 'native' as const,
      missReason: null,
      handleAgeMs: 220,
      workerReason: undefined,
    })),
    encodeJpeg: vi.fn(async () => Buffer.from('jpeg-bytes')),
    ...overrides,
  }
}

describe('parkTrackFrame (runner side)', () => {
  it('cuts, encodes ONCE and parks under (deviceId, trackId, kind), answering with the holding node', async () => {
    const spy = makeLoggerSpy()
    const store = new ParkedFrameStore()
    const deps = makeDeps({ logger: spy.logger, store })
    const result = await parkTrackFrame(deps, input)
    expect(result).toEqual({
      parked: true,
      nodeId: NODE_ID,
      width: 3840,
      height: 2160,
      bytes: Buffer.from('jpeg-bytes').byteLength,
      replaced: false,
    })
    expect(deps.encodeJpeg).toHaveBeenCalledTimes(1)
    const parcel = store.get(DEVICE_ID, 't-1', 'keyFrame')
    expect(parcel?.jpeg.toString()).toBe('jpeg-bytes')
    expect(parcel?.timestamp).toBe(1_000)
    // The rectangle and cap the hub named are what the runner cut.
    expect(deps.resolvePixels).toHaveBeenCalledWith({
      handle: input.handle,
      bbox: input.bbox,
      maxWidth: 4096,
    })
  })

  it('a second park for the same key REPLACES and says so', async () => {
    const spy = makeLoggerSpy()
    const deps = makeDeps({ logger: spy.logger })
    await parkTrackFrame(deps, input)
    const again = await parkTrackFrame(deps, { ...input, timestamp: 2_000 })
    expect(again.parked).toBe(true)
    if (again.parked) expect(again.replaced).toBe(true)
  })

  it('a handle already gone is REFUSED once, logged with the deviceId and the measured age, never retried', async () => {
    const spy = makeLoggerSpy()
    const resolvePixels = vi.fn(async () => ({
      pixels: null,
      tier: 'miss' as const,
      missReason: 'worker-lease-gone' as const,
      handleAgeMs: 4_310,
      workerReason: 'frame 12 released and no retained tile for this frame',
    }))
    const store = new ParkedFrameStore()
    const deps = makeDeps({ logger: spy.logger, resolvePixels, store })
    const result = await parkTrackFrame(deps, {
      ...input,
      kind: 'thumbnail',
      bbox: { x: 0.2, y: 0.1, w: 0.3, h: 0.5 },
    })
    expect(result).toEqual({
      parked: false,
      nodeId: NODE_ID,
      reason: 'handle-gone',
      handleAgeMs: 4_310,
      detail: 'worker-lease-gone: frame 12 released and no retained tile for this frame',
    })
    expect(resolvePixels).toHaveBeenCalledTimes(1)
    expect(deps.encodeJpeg).not.toHaveBeenCalled()
    expect(store.size).toBe(0)
    const warned = spy.calls.filter((c) => c.level === 'warn')
    expect(warned).toHaveLength(1)
    expect(warned[0]!.message).toMatch(/park refused/)
    expect(warned[0]!.extras).toMatchObject({
      tags: { deviceId: DEVICE_ID },
      meta: {
        trackId: 't-1',
        kind: 'thumbnail',
        reason: 'handle-gone',
        missReason: 'worker-lease-gone',
        handleAgeMs: 4_310,
      },
    })
  })

  it('a ram-fullframe tier is refused — a parcel is native or nothing', async () => {
    const spy = makeLoggerSpy()
    const deps = makeDeps({
      logger: spy.logger,
      resolvePixels: vi.fn(async () => ({
        pixels: null,
        tier: 'ram-fullframe' as const,
        missReason: 'no-registry-entry' as const,
        handleAgeMs: null,
        workerReason: undefined,
      })),
    })
    const result = await parkTrackFrame(deps, input)
    expect(result.parked).toBe(false)
    if (!result.parked) {
      expect(result.reason).toBe('handle-gone')
      expect(result.handleAgeMs).toBeNull()
      expect(result.detail).toBe('no-registry-entry')
    }
    expect(deps.encodeJpeg).not.toHaveBeenCalled()
  })

  it('an encode failure is its own reason, logged with the deviceId', async () => {
    const spy = makeLoggerSpy()
    const store = new ParkedFrameStore()
    const deps = makeDeps({ logger: spy.logger, encodeJpeg: vi.fn(async () => null), store })
    const result = await parkTrackFrame(deps, input)
    expect(result).toMatchObject({ parked: false, reason: 'encode-failed', handleAgeMs: 220 })
    expect(store.size).toBe(0)
    const warned = spy.calls.filter((c) => c.level === 'warn')
    expect(warned).toHaveLength(1)
    expect(warned[0]!.extras).toMatchObject({ tags: { deviceId: DEVICE_ID } })
  })
})
