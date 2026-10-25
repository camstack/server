import { describe, it, expect, vi } from 'vitest'
import { defined } from '../../../__tests__/support/vitest-mock.js'
import type { FrameHandle, IScopedLogger } from '@camstack/types'
import { createDisplayCrop } from '../display-crop.js'
import type {
  FetchNativeRoiJpegFn,
  FetchFallbackFrameRgbFn,
  DisplayFallbackFrameRgb,
} from '../display-crop.js'

const handle: FrameHandle = {
  shmId: 'seg',
  slot: 0,
  seq: 2,
  width: 640,
  height: 360,
  format: 'rgb',
  pts: 1,
  byteLength: 640 * 360 * 3,
  nodeId: 'hub',
  slotCount: 4,
}

function stubLogger(): IScopedLogger {
  const logger: IScopedLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

/** LEG 2's frame — the only pixels in this file, as in the subject. */
const rgb = (label: number): DisplayFallbackFrameRgb => ({
  bytes: Buffer.from([label]),
  width: 100,
  height: 80,
})

/** LEG 1's arrival — a finished JPEG the runner already cut and encoded. */
const roiJpeg = (label: number): Buffer => Buffer.from([0xff, 0xd8, label])

function build(overrides: {
  fetchNativeRoiJpeg?: FetchNativeRoiJpegFn
  fetchFallbackFrame?: FetchFallbackFrameRgbFn
  logger?: IScopedLogger
}) {
  const logger = overrides.logger ?? stubLogger()
  const cropRegionToJpeg = vi.fn(async (bytes: Buffer) =>
    Buffer.concat([Buffer.from('crop:'), bytes]),
  )
  const displayCrop = createDisplayCrop({
    fetchNativeRoiJpeg: overrides.fetchNativeRoiJpeg ?? (async () => null),
    fetchFallbackFrame: overrides.fetchFallbackFrame ?? (async () => null),
    cropRegionToJpeg,
    logger,
  })
  return { displayCrop, cropRegionToJpeg, logger }
}

const BBOX = { x: 64, y: 36, w: 64, h: 36 }

describe('createDisplayCrop — bounded display fallback (native → full-frame → null)', () => {
  it('LEG 1 native ROI hit → the runner’s JPEG VERBATIM, no fallback, no log', async () => {
    const native = roiJpeg(1)
    const fetchNativeRoiJpeg = vi.fn(async () => native)
    const fetchFallbackFrame = vi.fn(async () => null)
    const { displayCrop, cropRegionToJpeg, logger } = build({
      fetchNativeRoiJpeg,
      fetchFallbackFrame,
    })

    const out = await displayCrop(handle, BBOX, 640, 360, 0, 'track-1')

    // BYTE IDENTITY: leg 1 is a pass-through. Anything that re-encoded would
    // not reproduce these bytes, and there is no encoder on this leg to do it.
    expect(out?.equals(native)).toBe(true)
    expect(fetchFallbackFrame).not.toHaveBeenCalled()
    expect(cropRegionToJpeg).not.toHaveBeenCalled()
    expect(logger.info).not.toHaveBeenCalled()
  })

  it('native miss + keyframe-native fallback → crops the full frame, logs once with reason', async () => {
    const fetchNativeRoiJpeg = vi.fn(async () => null)
    const fetchFallbackFrame = vi.fn(async () => ({
      frame: rgb(7),
      reason: 'keyframe-native' as const,
    }))
    const { displayCrop, cropRegionToJpeg, logger } = build({
      fetchNativeRoiJpeg,
      fetchFallbackFrame,
    })

    const out = await displayCrop(handle, BBOX, 640, 360, 0, 'track-1')

    expect(out?.toString()).toBe('crop:\x07')
    expect(cropRegionToJpeg).toHaveBeenCalledTimes(1)
    expect(logger.info).toHaveBeenCalledTimes(1)
    expect(logger.info).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ meta: expect.objectContaining({ reason: 'keyframe-native' }) }),
    )
  })

  it('native miss + RAM/detection-raster fallback → crops it, reason=detection-raster', async () => {
    const fetchFallbackFrame = vi.fn(async () => ({
      frame: rgb(3),
      reason: 'detection-raster' as const,
    }))
    const { displayCrop, logger } = build({ fetchFallbackFrame })

    const out = await displayCrop(handle, BBOX, 640, 360, 0, 'track-1')

    expect(out?.toString()).toBe('crop:\x03')
    expect(logger.info).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ meta: expect.objectContaining({ reason: 'detection-raster' }) }),
    )
  })

  it('all miss → returns null and logs once (unavailable)', async () => {
    const { displayCrop, logger } = build({})

    const out = await displayCrop(handle, BBOX, 640, 360, 0, 'track-1')

    expect(out).toBeNull()
    expect(logger.info).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ meta: expect.objectContaining({ reason: 'unavailable' }) }),
    )
  })

  it('logs the fallback only ONCE per owner across repeated calls', async () => {
    const fetchFallbackFrame = vi.fn(async () => ({
      frame: rgb(3),
      reason: 'detection-raster' as const,
    }))
    const { displayCrop, logger } = build({ fetchFallbackFrame })

    await displayCrop(handle, BBOX, 640, 360, 0, 'track-1')
    await displayCrop(handle, BBOX, 640, 360, 0, 'track-1')
    await displayCrop(handle, BBOX, 640, 360, 0, 'track-2')

    expect(logger.info).toHaveBeenCalledTimes(2) // track-1 once, track-2 once
  })

  it('forwards maxWidth and the padded normalized ROI to the native fetch', async () => {
    const seen: Array<{ norm: NormalizedSeen; maxWidth?: number }> = []
    const fetchNativeRoiJpeg: FetchNativeRoiJpegFn = async (_h, paddedNorm, maxWidth) => {
      seen.push({ norm: paddedNorm, maxWidth })
      return roiJpeg(9)
    }
    const { displayCrop } = build({ fetchNativeRoiJpeg })

    // 64x36 at (64,36) in 640x360 → normalized 0.1,0.1,0.1,0.1; padding 0 identity.
    await displayCrop(handle, BBOX, 640, 360, 0, 'track-1', 1920)

    expect(seen).toHaveLength(1)
    const call = defined(seen[0], 'seen[0]')
    expect(call.maxWidth).toBe(1920)
    expect(call.norm.x).toBeCloseTo(0.1, 5)
    expect(call.norm.w).toBeCloseTo(0.1, 5)
  })

  it('falls through to LEG 2 when leg 1 yields null (miss, or a skew encode failure)', async () => {
    // Leg 1 has no encoder any more, so the ONLY way it declines is `null` —
    // which is exactly what a miss and a version-skew encode failure both
    // produce. Leg 2 must still run.
    const fetchNativeRoiJpeg = vi.fn(async () => null)
    const fetchFallbackFrame = vi.fn(async () => ({
      frame: rgb(5),
      reason: 'keyframe-native' as const,
    }))
    const { displayCrop } = build({ fetchNativeRoiJpeg, fetchFallbackFrame })

    const out = await displayCrop(handle, BBOX, 640, 360, 0, 'track-1')

    expect(out?.toString()).toBe('crop:\x05')
    expect(fetchFallbackFrame).toHaveBeenCalledTimes(1)
  })
})

interface NormalizedSeen {
  x: number
  y: number
  w: number
  h: number
}
