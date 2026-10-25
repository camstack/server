import type { IScopedLogger } from '@camstack/types'
import { mockFirstCall } from '../../../__tests__/support/vitest-mock.js'
import { describe, expect, it, vi } from 'vitest'
import type { KeyFrameCropDeps } from '../keyframe-crop.js'
import { createKeyFrameCrop } from '../keyframe-crop.js'
import type { SubjectPathSample } from '../subject-agreement.js'

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

const BASE_INPUT = {
  deviceId: 102,
  mediaId: 6001,
  bbox: { x: 64, y: 36, w: 64, h: 36 },
  frameWidth: 640,
  frameHeight: 360,
  padding: 0,
  timestamp: 1000,
}

/**
 * The two subjects the motion guard has to tell apart, sampled every 100 ms
 * across the SAME span so a fixture can hold skew fixed and vary only motion.
 *
 *  - `CROSSING` is cam 102's traffic: the box translates a full width per
 *    second, so two instants 800 ms apart share no pixels (IoU 0).
 *  - `PARKED` is `7613c0fa`: the box never moves, so ANY two instants agree
 *    (IoU 1) however far apart they are.
 *
 * A guard that refuses everything fails every PARKED expectation; a guard that
 * does nothing fails every CROSSING one. Neither can pass this table.
 */
function samplePath(startX: number, pxPerSample: number): SubjectPathSample[] {
  const path: SubjectPathSample[] = []
  for (let i = 0; i <= 60; i += 1) {
    path.push({
      timestamp: 1000 + i * 100,
      bbox: { x: startX + i * pxPerSample, y: 50, w: 80, h: 60 },
    })
  }
  return path
}
const CROSSING = samplePath(0, 20)
const PARKED = samplePath(0, 0)

function build(over: Partial<KeyFrameCropDeps> & { logger?: IScopedLogger } = {}) {
  const logger = over.logger ?? stubLogger()
  const cropRegionToJpeg = vi.fn(
    async (
      _bytes: Buffer,
      _width: number,
      _height: number,
      _norm: { x: number; y: number; w: number; h: number },
    ) => Buffer.from('KFCROP'),
  )
  const deps: KeyFrameCropDeps = {
    getMedia: over.getMedia ?? (async () => ({ bytes: Buffer.from('zzz'), timestamp: 1000 })),
    decodeJpegToRgb:
      over.decodeJpegToRgb ??
      (async () => ({ bytes: Buffer.from([1, 2, 3]), width: 1920, height: 1080 })),
    cropRegionToJpeg: over.cropRegionToJpeg ?? cropRegionToJpeg,
    maxSkewMs: over.maxSkewMs ?? 1500,
    minSubjectIou: over.minSubjectIou ?? 0.5,
    maxSubjectSampleGapMs: over.maxSubjectSampleGapMs ?? 1000,
    logger,
  }
  return { fn: createKeyFrameCrop(deps), cropRegionToJpeg, logger }
}

describe('createKeyFrameCrop — durable keyFrame-derived last-resort crop', () => {
  it('crops the normalized bbox from the decoded keyFrame when the skew is within the guard', async () => {
    const { fn, cropRegionToJpeg } = build({
      getMedia: async () => ({ bytes: Buffer.from('zzz'), timestamp: 1232 }), // 232ms skew
    })
    const out = await fn(BASE_INPUT)
    expect(out).not.toBeNull()
    expect(out!.jpeg.toString()).toBe('KFCROP')
    expect(out!.skewMs).toBe(232)
    // Crops the decoded FULL frame (1920x1080), not the detail-frame dims.
    const call = mockFirstCall(cropRegionToJpeg)
    expect(call[1]).toBe(1920)
    expect(call[2]).toBe(1080)
    // Normalized 64/640=0.1, 36/360=0.1 with padding 0 identity.
    expect(call[3].x).toBeCloseTo(0.1, 5)
    expect(call[3].w).toBeCloseTo(0.1, 5)
  })

  it('hands the stored bytes to the decoder and the decoded surface to the crop WITHOUT copying either (D867)', async () => {
    const stored = Buffer.from('jpeg-bytes')
    const surface = Buffer.alloc(12, 7)
    let decoded: Uint8Array | null = null
    let cropped: Buffer | null = null
    const { fn } = build({
      getMedia: async () => ({ bytes: stored, timestamp: 1000 }),
      decodeJpegToRgb: async (jpeg) => {
        decoded = jpeg
        return { bytes: surface, width: 2, height: 2 }
      },
      cropRegionToJpeg: async (bytes) => {
        cropped = bytes
        return Buffer.from('x')
      },
    })
    await fn(BASE_INPUT)
    // Identity, not equality: a base64 round trip or a `Buffer.from(...)` of the
    // RGB surface (6.2 MB at 1920 wide) is exactly what was removed.
    expect(decoded).toBe(stored)
    expect(cropped).toBe(surface)
  })

  it('REJECTS a keyFrame whose skew exceeds maxSkewMs when no trail says otherwise', async () => {
    const { fn, cropRegionToJpeg, logger } = build({
      getMedia: async () => ({ bytes: Buffer.from('zzz'), timestamp: 5000 }), // 4000ms skew > 1500
    })
    const out = await fn(BASE_INPUT)
    expect(out).toBeNull()
    expect(cropRegionToJpeg).not.toHaveBeenCalled()
    // A dropped crop is a missing gallery tile — it is REPORTED, per camera.
    expect(logger.info).toHaveBeenCalledWith(
      'keyframe crop refused — temporal skew too large, no motion evidence',
      expect.objectContaining({ tags: { deviceId: 102 } }),
    )
  })

  it('returns null when the keyFrame media is absent', async () => {
    const { fn, cropRegionToJpeg } = build({ getMedia: async () => null })
    expect(await fn(BASE_INPUT)).toBeNull()
    expect(cropRegionToJpeg).not.toHaveBeenCalled()
  })

  it('returns null for degenerate detail-frame dims (cannot normalize)', async () => {
    const { fn } = build()
    expect(await fn({ ...BASE_INPUT, frameWidth: 0 })).toBeNull()
  })

  it('returns null (not throw) when decode fails', async () => {
    const { fn } = build({
      decodeJpegToRgb: async () => {
        throw new Error('bad jpeg')
      },
    })
    expect(await fn(BASE_INPUT)).toBeNull()
  })

  it('accepts a keyFrame exactly at the skew boundary', async () => {
    const { fn } = build({
      getMedia: async () => ({ bytes: Buffer.from('zzz'), timestamp: 1000 + 1500 }),
    })
    const out = await fn(BASE_INPUT)
    expect(out).not.toBeNull()
    expect(out!.skewMs).toBe(1500)
  })
})

/**
 * The motion guard, as a 2×2 over (subject moved / stood still) × (skew inside
 * / outside the temporal bound). MOTION decides both diagonals — which is the
 * point: the two crops the operator reported wrong sat INSIDE the time bound
 * (`4126f977` at 531 ms, `e9c024bb` at 1179 ms) and the one correct crop sat
 * OUTSIDE it (`7613c0fa` at 2579 ms).
 */
describe('createKeyFrameCrop — the motion guard', () => {
  // Same 800 ms skew in both rows: only the subject's motion differs, so no
  // outcome here can be explained by the temporal bound.
  const SKEW_INSIDE = async (): Promise<{ bytes: Buffer; timestamp: number }> => ({
    bytes: Buffer.from('zzz'),
    timestamp: 1800,
  })
  // Same 4000 ms skew in both rows, this time outside the temporal bound.
  const SKEW_OUTSIDE = async (): Promise<{ bytes: Buffer; timestamp: number }> => ({
    bytes: Buffer.from('zzz'),
    timestamp: 5000,
  })

  it('REFUSES a crossing subject even INSIDE the temporal bound (the 4126f977 shape)', async () => {
    const { fn, cropRegionToJpeg, logger } = build({ getMedia: SKEW_INSIDE })
    const out = await fn({ ...BASE_INPUT, subjectPath: CROSSING })
    expect(out).toBeNull()
    expect(cropRegionToJpeg).not.toHaveBeenCalled()
    expect(logger.info).toHaveBeenCalledWith(
      'keyframe crop refused — subject moved between the two instants',
      expect.objectContaining({ tags: { deviceId: 102 } }),
    )
  })

  it('CROPS a stationary subject at the identical skew (the same 800 ms, other verdict)', async () => {
    const { fn, cropRegionToJpeg } = build({ getMedia: SKEW_INSIDE })
    const out = await fn({ ...BASE_INPUT, subjectPath: PARKED })
    expect(out).not.toBeNull()
    expect(out!.skewMs).toBe(800)
    expect(out!.motion).toBe('agrees')
    expect(out!.subjectIou).toBe(1)
    expect(cropRegionToJpeg).toHaveBeenCalledTimes(1)
  })

  it('CROPS a stationary subject BEYOND the temporal bound (the 7613c0fa rescue)', async () => {
    // 2579 ms of skew, IoU 1.000, and the stored plate was perfectly framed —
    // the case the pure time bound refused and should not have. This is also
    // the answer to 20da3195, which was "fixed" by deleting the guard instead.
    const { fn } = build({ getMedia: SKEW_OUTSIDE })
    const out = await fn({ ...BASE_INPUT, subjectPath: PARKED })
    expect(out).not.toBeNull()
    expect(out!.skewMs).toBe(4000)
    expect(out!.motion).toBe('agrees')
  })

  it('REFUSES a crossing subject beyond the temporal bound too', async () => {
    const { fn } = build({ getMedia: SKEW_OUTSIDE })
    expect(await fn({ ...BASE_INPUT, subjectPath: CROSSING })).toBeNull()
  })

  it('an EMPTY trail carries no evidence — the temporal bound alone decides, both ways', async () => {
    const inside = build({ getMedia: SKEW_INSIDE })
    const within = await inside.fn({ ...BASE_INPUT, subjectPath: [] })
    expect(within).not.toBeNull()
    // Never `agrees`: nothing was measured, and a confident verdict would be a lie.
    expect(within!.motion).toBe('unknown')
    expect(within!.subjectIou).toBeUndefined()

    const outside = build({ getMedia: SKEW_OUTSIDE })
    expect(await outside.fn({ ...BASE_INPUT, subjectPath: [] })).toBeNull()
  })

  it('a trail DOWNSAMPLED past one instant is unknown, not an interpolated guess', async () => {
    // Samples exist, but every one of them is ≥3 s from BOTH instants — the
    // shape a long track's downsampled trail takes.
    const sparse: SubjectPathSample[] = [
      { timestamp: 4800, bbox: { x: 0, y: 50, w: 80, h: 60 } },
      { timestamp: 5800, bbox: { x: 900, y: 50, w: 80, h: 60 } },
    ]
    const { fn } = build({ getMedia: SKEW_INSIDE })
    const out = await fn({ ...BASE_INPUT, subjectPath: sparse })
    // Inside the temporal bound, so it passes — but as `unknown`, never as
    // `moved` off two samples that describe different moments.
    expect(out).not.toBeNull()
    expect(out!.motion).toBe('unknown')
  })

  it('accepts exactly AT the IoU threshold (a boundary, not a slope)', async () => {
    // Two 100×100 boxes overlapping on 1/3 of their union → IoU 0.5 exactly.
    const half: SubjectPathSample[] = [
      { timestamp: 1000, bbox: { x: 0, y: 0, w: 100, h: 100 } },
      { timestamp: 1800, bbox: { x: 50, y: 0, w: 100, h: 100 } },
    ]
    const { fn } = build({ getMedia: SKEW_INSIDE, minSubjectIou: 1 / 3 })
    const out = await fn({ ...BASE_INPUT, subjectPath: half })
    expect(out).not.toBeNull()
    expect(out!.subjectIou).toBeCloseTo(1 / 3, 6)
  })
})
