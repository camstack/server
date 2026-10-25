import type { FrameHandle, IScopedLogger } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import type { TryNativeCropFn } from '../capture-crop.js'
import { captureCropFrameRect, createCaptureCrop } from '../capture-crop.js'

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

describe('createCaptureCrop — enrichment crops are native-strict (S4)', () => {
  it('returns null on a native miss (no ≤640 raster fallback)', async () => {
    const tryNativeCrop: TryNativeCropFn = async () => null
    const bumpCropMetric = vi.fn()
    const logger = stubLogger()
    const captureCrop = createCaptureCrop({
      tryNativeCrop,
      bumpCropMetric,
      logger,
    })

    const result = await captureCrop(handle, { x: 10, y: 20, w: 100, h: 80 }, 640, 360, 0.1)

    expect(result).toBeNull()
    expect(bumpCropMetric).toHaveBeenCalledWith(false)
    expect(logger.debug).toHaveBeenCalledTimes(1)
  })

  it('returns the native crop buffer on a hit and records the metric', async () => {
    const native = Buffer.from([1, 2, 3])
    const tryNativeCrop: TryNativeCropFn = async () => native
    const bumpCropMetric = vi.fn()
    const logger = stubLogger()
    const captureCrop = createCaptureCrop({
      tryNativeCrop,
      bumpCropMetric,
      logger,
    })

    const result = await captureCrop(handle, { x: 10, y: 20, w: 100, h: 80 }, 640, 360, 0)

    expect(result).toBe(native)
    expect(bumpCropMetric).toHaveBeenCalledWith(true)
    expect(logger.debug).not.toHaveBeenCalled()
  })

  it('normalizes + pads the pixel bbox before querying the native surface', async () => {
    const seen: Array<{ x: number; y: number; w: number; h: number }> = []
    const tryNativeCrop: TryNativeCropFn = async (_h, paddedNorm) => {
      seen.push(paddedNorm)
      return Buffer.from([9])
    }
    const captureCrop = createCaptureCrop({
      tryNativeCrop,
      bumpCropMetric: vi.fn(),
      logger: stubLogger(),
    })

    // pixel bbox 64x36 at (64,36) in a 640x360 frame → normalized 0.1,0.1,0.1,0.1;
    // padding 0 keeps it identity.
    await captureCrop(handle, { x: 64, y: 36, w: 64, h: 36 }, 640, 360, 0)

    expect(seen).toHaveLength(1)
    const padded = seen[0]
    if (padded === undefined) {
      throw new Error('expected one padded bbox')
    }
    expect(padded.x).toBeCloseTo(0.1, 5)
    expect(padded.y).toBeCloseTo(0.1, 5)
    expect(padded.w).toBeCloseTo(0.1, 5)
    expect(padded.h).toBeCloseTo(0.1, 5)
  })

  it('forwards the optional maxWidth to the native fetch', async () => {
    const seenMax: Array<number | undefined> = []
    const tryNativeCrop: TryNativeCropFn = async (_h, _b, maxWidth) => {
      seenMax.push(maxWidth)
      return Buffer.from([0])
    }
    const captureCrop = createCaptureCrop({
      tryNativeCrop,
      bumpCropMetric: vi.fn(),
      logger: stubLogger(),
    })

    await captureCrop(handle, { x: 0, y: 0, w: 10, h: 10 }, 640, 360, 0, 1920)

    expect(seenMax).toEqual([1920])
  })
})

describe('captureCropFrameRect — the window a capture asked for, in frame pixels', () => {
  it('is exactly the window the runner was asked for, scaled back to the frame', async () => {
    const asked: Array<{ x: number; y: number; w: number; h: number }> = []
    const tryNativeCrop: TryNativeCropFn = async (_handle, paddedNorm) => {
      asked.push(paddedNorm)
      return Buffer.from([1])
    }
    const captureCrop = createCaptureCrop({
      tryNativeCrop,
      bumpCropMetric: vi.fn(),
      logger: stubLogger(),
    })
    const bbox = { x: 100, y: 50, w: 200, h: 100 }
    await captureCrop(handle, bbox, 640, 360, 0.15)

    const rect = captureCropFrameRect(bbox, 640, 360, 0.15)
    expect(asked).toHaveLength(1)
    expect(rect.x).toBeCloseTo(asked[0]!.x * 640)
    expect(rect.y).toBeCloseTo(asked[0]!.y * 360)
    expect(rect.w).toBeCloseTo(asked[0]!.w * 640)
    expect(rect.h).toBeCloseTo(asked[0]!.h * 360)
    // 15% of the box on each side.
    expect(rect.x).toBeCloseTo(70)
    expect(rect.y).toBeCloseTo(35)
    expect(rect.w).toBeCloseTo(260)
    expect(rect.h).toBeCloseTo(130)
  })
})
