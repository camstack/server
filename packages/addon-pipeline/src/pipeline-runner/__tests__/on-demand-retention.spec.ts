/**
 * Task 3 RED — on-demand retention, media channels, rollback, release.
 * Production change that would fail these tests: writing raw/JPEG on every
 * admitted frame, recovering no-detection frames from detection-retention,
 * aliasing a stale ref, shipping frameRef cross-node, or leaving resident bytes.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DecodedFrame, FrameResult, IScopedLogger, ObjectDetection } from '@camstack/types'
import { LocalFrameRegistry } from '../../session-decode/local-frame-registry.js'
import {
  CONTENT_SIZED_RESERVE_BYTES,
  RetainedFrameStore,
} from '../../session-decode/retained-frame-store.js'
import type { FrameImage } from '../../session-decode/video-frame-generator.js'
import { FrameLazyTelemetry } from '../frame-lazy-metrics.js'
import {
  CAMSTACK_CONTINUOUS_RETAIN,
  OnDemandRetentionSession,
  canRecoverNotificationMedia,
  encodeCrossNodeCrop,
  isContinuousRetainEnabled,
  resolveOnDemandCropSource,
  shouldRetainDetectionFrame,
} from '../on-demand-retention.js'

function logger(): IScopedLogger {
  const l: IScopedLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(() => l),
    withTags: vi.fn(() => l),
  }
  return l
}

function pixelFree(width = 1920, height = 1080, timestamp = 1): DecodedFrame {
  return { data: Buffer.alloc(0), width, height, format: 'rgb', timestamp }
}

function rawFrame(width = 640, height = 360, fill = 7): DecodedFrame {
  return {
    data: Buffer.alloc(width * height * 3, fill),
    width,
    height,
    format: 'rgb',
    timestamp: 1,
  }
}

function image(jpegBytes = 2048): FrameImage & { toBuffer: ReturnType<typeof vi.fn> } {
  return {
    width: 1920,
    height: 1080,
    format: 'rgb',
    toBuffer: vi.fn(async ({ format }: { format?: string } = {}) =>
      format === 'jpeg' ? new Uint8Array(jpegBytes) : new Uint8Array(640 * 360 * 3),
    ),
    close: vi.fn(),
    releaseNativeLease: vi.fn(),
  }
}

function detection(i: number): ObjectDetection {
  return {
    id: `d${i}`,
    kind: 'first-level',
    macroClass: 'person',
    score: 0.9,
    bbox: { x: 64, y: 36, width: 128, height: 72 },
    labels: [],
  }
}

function result(detections: number, deviceId = 1): FrameResult {
  return {
    kind: 'frame',
    frameId: 'f',
    deviceId,
    timestamp: 0,
    width: 640,
    height: 360,
    detections: Array.from({ length: detections }, (_, i) => detection(i)),
    debug: { totalInferenceMs: 1 },
  }
}

function pixelFreeWithRef(
  ref: NonNullable<DecodedFrame['frameRef']>,
  width = 1920,
  height = 1080,
  timestamp = 1,
): DecodedFrame {
  return { ...pixelFree(width, height, timestamp), frameRef: ref }
}

function store(): RetainedFrameStore {
  return new RetainedFrameStore({
    nodeId: 'hub',
    logger: logger(),
    budgetBytes: 8_000_000,
    perDeviceFloor: 2,
    timeFloorMs: 0,
  })
}

function session(opts?: { continuousRetain?: boolean }) {
  const registry = new LocalFrameRegistry({
    registryId: 'local-process',
    maxFrames: 4,
    maxBytes: 10_000_000,
  })
  const telemetry = new FrameLazyTelemetry()
  const retained = store()
  return {
    registry,
    telemetry,
    retained,
    gate: new OnDemandRetentionSession({
      store: retained,
      registry,
      telemetry,
      nodeId: 'hub',
      continuousRetain: opts?.continuousRetain ?? false,
    }),
  }
}

describe('on-demand retention policy', () => {
  const prev = process.env[CAMSTACK_CONTINUOUS_RETAIN]
  afterEach(() => {
    if (prev === undefined) delete process.env[CAMSTACK_CONTINUOUS_RETAIN]
    else process.env[CAMSTACK_CONTINUOUS_RETAIN] = prev
  })

  it('does not retain an admitted or dropped frame without a detection', () => {
    expect(
      shouldRetainDetectionFrame({ admitted: true, hasDetection: false, continuousRetain: false }),
    ).toBe(false)
    expect(
      shouldRetainDetectionFrame({ admitted: false, hasDetection: false, continuousRetain: false }),
    ).toBe(false)
    expect(isContinuousRetainEnabled({ [CAMSTACK_CONTINUOUS_RETAIN]: '1' })).toBe(true)
    expect(isContinuousRetainEnabled({})).toBe(false)
  })

  it('frame admission/drop without detection writes no retention and zero media bytes', async () => {
    const { gate, retained, telemetry, registry } = session()
    const img = image()
    const ref = registry.register(img, { timestamp: 1 })!
    const handle = gate.admitFrame(1, pixelFreeWithRef(ref))
    expect(handle).toBeDefined()
    expect(retained.size).toBe(0)
    expect(retained.retainedBytes).toBe(0)

    gate.noteFrame({ deviceId: 1, decoded: true, admitted: true, droppedPixelFree: false })
    gate.noteInferenceResult(1, handle, result(0))
    expect(retained.size).toBe(0)
    expect(retained.retainedBytes).toBe(0)
    expect(await gate.requestMedia(handle!, { kind: 'full-frame' })).toMatchObject({
      tier: 'miss',
    })
    expect(telemetry.snapshot([1]).node.retainedWritesAvoided).toBeGreaterThan(0)
    expect(telemetry.snapshot([1]).node.runnerToPoolRawBytes).toBe(0)
  })

  it('detection crop request prefers native/tile and releases the hold', async () => {
    const { gate, retained } = session()
    const handle = gate.admitFrame(1, pixelFree())!
    const native = { bytes: new Uint8Array([1, 2, 3]), width: 80, height: 80 }
    const served = await gate.requestMedia(handle, {
      kind: 'crop',
      nativeHit: native,
      tileHit: { bytes: new Uint8Array([9]), width: 40, height: 40, jpeg: true },
    })
    expect(served.tier).toBe('native')
    expect(served.bytes).toEqual(native.bytes)
    expect('frameRef' in served).toBe(false)
    expect(retained.size).toBe(0)
    gate.release(handle, 'success')
    expect(retained.retainedBytes).toBe(0)
  })

  it('native/tile miss after a detection requests one JPEG and never writes continuous raw', async () => {
    const { gate, retained, registry, telemetry } = session()
    const img = image(4096)
    const ref = registry.register(img, { timestamp: 2 })!
    const handle = gate.admitFrame(1, pixelFreeWithRef(ref))!
    gate.noteInferenceResult(1, handle, result(1))

    const first = await gate.requestMedia(handle, { kind: 'full-frame' })
    const second = await gate.requestMedia(handle, { kind: 'full-frame' })
    expect(first.tier).toBe('fallback-jpeg')
    expect(first.jpeg?.byteLength).toBe(4096)
    expect(first.bytes).toBeUndefined()
    expect(second.tier).toBe('fallback-jpeg')
    expect(img.toBuffer).toHaveBeenCalledTimes(1)
    expect(img.toBuffer).toHaveBeenCalledWith(
      expect.objectContaining({ format: 'jpeg', resize: { width: 640, height: 360 } }),
    )
    expect(retained.retainedBytes).toBeLessThan(640 * 360 * 3)
    expect(telemetry.snapshot([1]).node.onDemandFullFrameRequests).toBe(2)
    expect(telemetry.snapshot([1]).node.fallbackHits).toBe(2)
  })

  it('a no-detection frame is not recoverable from the notification detection-retention channel', async () => {
    const { gate } = session()
    const handle = gate.admitFrame(1, pixelFree())!
    gate.noteInferenceResult(1, handle, result(0))
    expect(
      canRecoverNotificationMedia({
        channel: 'detection-retention',
        hasDetection: false,
        handleAvailable: true,
      }),
    ).toBe(false)
    expect(await gate.requestMedia(handle, { kind: 'full-frame' })).toMatchObject({ tier: 'miss' })
    expect(
      canRecoverNotificationMedia({
        channel: 'camera-snapshot',
        hasDetection: false,
        handleAvailable: false,
      }),
    ).toBe(true)
    expect(
      canRecoverNotificationMedia({
        channel: 'recorded-still',
        hasDetection: false,
        handleAvailable: false,
      }),
    ).toBe(true)
  })

  it('a stale ref cannot alias a newer frame', async () => {
    const { gate, registry } = session()
    const first = image(111)
    const second = image(222)
    const oldRef = registry.register(first, { timestamp: 1 })!
    const staleId = oldRef.id
    registry.release(oldRef, 'success')
    const newer = registry.register(second, { timestamp: 2 })!
    expect(newer.id).not.toBe(staleId)

    const handle = gate.admitFrame(1, pixelFreeWithRef({ ...oldRef }))!
    gate.noteInferenceResult(1, handle, result(1))
    const served = await gate.requestMedia(handle, { kind: 'full-frame' })
    expect(served.tier).toBe('miss')
    expect(served.jpeg).toBeUndefined()
    expect(second.toBuffer).not.toHaveBeenCalled()
  })

  it('cross-node crop returns compressed JPEG/bytes and never a frameRef', () => {
    expect(
      resolveOnDemandCropSource({ nativeHit: false, tileHit: false, recordedStillHit: false }),
    ).toBe('fallback-jpeg')
    // `jpeg` is the JPEG's BYTES since D462; base64 is what this function
    // PRODUCES for a caller that did not declare it reads bytes.
    const payload = encodeCrossNodeCrop({
      jpeg: new Uint8Array([0xff, 0xd8]),
      bytes: new Uint8Array([1, 2, 3]),
      frameRef: { registryId: 'local-process', id: 'nope' },
    })
    expect(payload).toEqual({ jpeg: Buffer.from([0xff, 0xd8]).toString('base64') })
    expect(payload).not.toHaveProperty('frameRef')
    expect(payload).not.toHaveProperty('bytes')
  })

  it('rollback CAMSTACK_CONTINUOUS_RETAIN=1 restores write-on-admit', () => {
    const { gate, retained } = session({ continuousRetain: true })
    const handle = gate.admitFrame(1, rawFrame())
    expect(handle).toBeDefined()
    expect(retained.size).toBe(1)
    expect(retained.retainedBytes).toBe(640 * 360 * 3)
    expect(retained.getFrame(handle!)?.data.byteLength).toBe(640 * 360 * 3)
  })

  it('zeros per-camera resident after the last entry is evicted without a new frame', () => {
    const registry = new LocalFrameRegistry({
      registryId: 'local-process',
      maxFrames: 8,
      maxBytes: 10_000_000,
    })
    const telemetry = new FrameLazyTelemetry()
    const retained = new RetainedFrameStore({
      nodeId: 'hub',
      logger: logger(),
      budgetBytes: CONTENT_SIZED_RESERVE_BYTES + 10,
      perDeviceFloor: 0,
      timeFloorMs: 0,
    })
    const gate = new OnDemandRetentionSession({
      store: retained,
      registry,
      telemetry,
      nodeId: 'hub',
      continuousRetain: false,
    })

    const refA = registry.register(image(), { timestamp: 1 })!
    const handleA = gate.admitFrame(1, pixelFreeWithRef(refA))!
    gate.noteInferenceResult(1, handleA, result(1, 1))
    const occupied = telemetry.snapshot([1]).cameras[0]
    expect(occupied?.residentRefs).toBeGreaterThan(0)
    expect(occupied?.residentBytes).toBeGreaterThan(0)
    expect(retained.has(handleA)).toBe(true)

    const refB = registry.register(image(), { timestamp: 2 })!
    const handleB = gate.admitFrame(2, pixelFreeWithRef(refB))!
    gate.noteInferenceResult(2, handleB, result(1, 2))
    retained.drop(handleA)
    expect(retained.has(handleA)).toBe(false)
    expect(retained.statsByDevice(1).entries).toBe(0)

    gate.syncResident()
    const snap = telemetry.snapshot([1, 2])
    const cameraA = snap.cameras.find((camera) => camera.deviceId === 1)
    expect(cameraA?.residentRefs).toBe(0)
    expect(cameraA?.residentBytes).toBe(0)
    expect(cameraA?.retainedWritesAvoided).toBeGreaterThan(0)
    expect(telemetry.trackedCameraCount()).toBe(2)
  })

  it('counts retainedWritesAvoided once per admitted on-demand frame, detection or not', () => {
    const { gate, telemetry } = session()
    const noneA = gate.admitFrame(1, pixelFree())!
    const noneB = gate.admitFrame(1, pixelFree())!
    const detected = gate.admitFrame(1, pixelFree())!
    gate.noteInferenceResult(1, noneA, result(0))
    gate.noteInferenceResult(1, noneB, result(0))
    gate.noteInferenceResult(1, detected, result(1))
    expect(telemetry.snapshot([1]).node.retainedWritesAvoided).toBe(3)
    expect(telemetry.snapshot([1]).cameras[0]?.retainedWritesAvoided).toBe(3)
  })

  it('release success after a detection keeps the store entry pullable', async () => {
    const { gate, retained, registry } = session()
    const img = image(2048)
    const ref = registry.register(img, { timestamp: 3 })!
    const handle = gate.admitFrame(1, pixelFreeWithRef(ref))!
    expect(gate.pendingSize).toBe(1)
    gate.noteInferenceResult(1, handle, result(1))
    expect(gate.pendingSize).toBe(0)
    expect(retained.size).toBe(1)
    gate.release(handle, 'success')
    registry.release(ref, 'success')
    expect(gate.pendingSize).toBe(0)
    expect(retained.size).toBe(1)
    const served = await gate.requestMedia(handle, { kind: 'full-frame' })
    expect(served.tier).toBe('fallback-jpeg')
    expect(served.jpeg?.byteLength).toBe(2048)
  })

  it('success/error/drop/detach release hold/ref and leave no resident bytes', async () => {
    const { gate, retained, registry } = session()
    for (const reason of ['success', 'error', 'drop', 'detach'] as const) {
      const img = image()
      const ref = registry.register(img, { timestamp: 1 })!
      const handle = gate.admitFrame(2, pixelFreeWithRef(ref))!
      gate.noteInferenceResult(2, handle, result(1, 2))
      await gate.requestMedia(handle, { kind: 'full-frame' })
      gate.release(handle, reason)
      registry.release(ref, reason)
    }
    registry.clear('detach')
    retained.clear()
    expect(registry.size).toBe(0)
    expect(registry.estimatedBytes).toBe(0)
    expect(retained.size).toBe(0)
    expect(retained.retainedBytes).toBe(0)
  })
})
