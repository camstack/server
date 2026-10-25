/**
 * Cropping a retained frame whose pixels are NOT 3-plane YUV420P.
 *
 * The subject-tile cutter assumed the retained frame always had three planes
 * (`planes[0..2]`), which is true for the vaapi/software lease download and
 * false the moment a frame arrives as **NV12** — two planes, Y plus one
 * INTERLEAVED UV plane. On dev:102 (macmini, videotoolbox) that produced
 * `retained frame missing planar YUV420P data` 533 times in a handful of
 * sessions: every subject of every frame, a tile tier that could not cut, and a
 * message that never said what the format actually was.
 *
 * What is pinned here is the offset math, semantically: a synthetic raster is
 * filled so that every byte identifies its own (plane, row, column), and the
 * assertions read the FIRST BYTE of each returned view. Arithmetic alone would
 * pass with the chroma planes swapped or a half-height plane indexed at full
 * height; a value check would not.
 */
import { describe, expect, it } from 'vitest'
import {
  nativeCropSourceTag,
  type PlanarCropRegion,
  resolvePlanarCropSource,
  softwareRoiKind,
} from '../planar-crop-source.js'

const WIDTH = 64
const HEIGHT = 32

/** Y byte value for (row, col) — unique per position, mod 251 to stay in a byte. */
function yValue(row: number, col: number): number {
  return (row * 7 + col * 3 + 1) % 251
}

/** Chroma byte value for a subsampled (row, col), tagged per component. */
function cValue(component: 'u' | 'v', row: number, col: number): number {
  return ((component === 'u' ? 100 : 200) + row * 5 + col * 2) % 251
}

interface Yuv420pFrame {
  readonly planes: readonly Uint8Array[]
  readonly strides: readonly number[]
}

function makeYuv420p(): Yuv420pFrame {
  // Strides deliberately WIDER than the visible width — a real decoder aligns
  // them, and a helper that assumes stride === width breaks only on real frames.
  const yStride = WIDTH + 16
  const cStride = WIDTH / 2 + 8
  const y = new Uint8Array(yStride * HEIGHT)
  const u = new Uint8Array(cStride * (HEIGHT / 2))
  const v = new Uint8Array(cStride * (HEIGHT / 2))
  for (let row = 0; row < HEIGHT; row += 1) {
    for (let col = 0; col < WIDTH; col += 1) y[row * yStride + col] = yValue(row, col)
  }
  for (let row = 0; row < HEIGHT / 2; row += 1) {
    for (let col = 0; col < WIDTH / 2; col += 1) {
      u[row * cStride + col] = cValue('u', row, col)
      v[row * cStride + col] = cValue('v', row, col)
    }
  }
  return { planes: [y, u, v], strides: [yStride, cStride, cStride] }
}

function makeNv12(): Yuv420pFrame {
  const yStride = WIDTH + 16
  // NV12's chroma plane holds (U,V) PAIRS: width/2 pairs = width bytes per row.
  const uvStride = WIDTH + 8
  const y = new Uint8Array(yStride * HEIGHT)
  const uv = new Uint8Array(uvStride * (HEIGHT / 2))
  for (let row = 0; row < HEIGHT; row += 1) {
    for (let col = 0; col < WIDTH; col += 1) y[row * yStride + col] = yValue(row, col)
  }
  for (let row = 0; row < HEIGHT / 2; row += 1) {
    for (let col = 0; col < WIDTH / 2; col += 1) {
      uv[row * uvStride + col * 2] = cValue('u', row, col)
      uv[row * uvStride + col * 2 + 1] = cValue('v', row, col)
    }
  }
  return { planes: [y, uv], strides: [yStride, uvStride] }
}

const REGION: PlanarCropRegion = { left: 8, top: 4, width: 16, height: 8 }

describe('resolvePlanarCropSource — NV12 (two planes, interleaved chroma)', () => {
  it('offsets Y by top*stride+left and the INTERLEAVED UV by (top/2)*stride+left', () => {
    const frame = makeNv12()
    const source = resolvePlanarCropSource('nv12', frame.planes, frame.strides, REGION)
    expect(source).not.toBeNull()
    if (!source) return
    expect(source.planes).toHaveLength(2)
    expect(source.strides).toEqual(frame.strides)
    // Y: the crop origin's own pixel value.
    expect(source.planes[0]?.[0]).toBe(yValue(REGION.top, REGION.left))
    // UV: the pair at chroma (top/2, left/2) — U first, V immediately after.
    // `left` is the byte offset because each chroma column is 2 bytes wide.
    expect(source.planes[1]?.[0]).toBe(cValue('u', REGION.top / 2, REGION.left / 2))
    expect(source.planes[1]?.[1]).toBe(cValue('v', REGION.top / 2, REGION.left / 2))
  })

  it('a full-frame crop reads both planes from byte 0', () => {
    const frame = makeNv12()
    const source = resolvePlanarCropSource('nv12', frame.planes, frame.strides, {
      left: 0,
      top: 0,
      width: WIDTH,
      height: HEIGHT,
    })
    expect(source?.planes[0]?.[0]).toBe(yValue(0, 0))
    expect(source?.planes[1]?.[0]).toBe(cValue('u', 0, 0))
  })

  it('rejects a two-plane frame that claims to be yuv420p — never reads a missing V plane', () => {
    const frame = makeNv12()
    expect(resolvePlanarCropSource('yuv420p', frame.planes, frame.strides, REGION)).toBeNull()
  })

  it('returns null rather than a short view when the region runs past the plane', () => {
    const frame = makeNv12()
    const source = resolvePlanarCropSource('nv12', frame.planes, frame.strides, {
      left: 0,
      top: HEIGHT - 2,
      width: WIDTH,
      height: HEIGHT,
    })
    expect(source).toBeNull()
  })
})

describe('resolvePlanarCropSource — YUV420P stays byte-for-byte what it was', () => {
  it('offsets Y by top*stride+left and BOTH chroma planes by (top/2)*stride+(left/2)', () => {
    const frame = makeYuv420p()
    const source = resolvePlanarCropSource('yuv420p', frame.planes, frame.strides, REGION)
    expect(source).not.toBeNull()
    if (!source) return
    expect(source.planes).toHaveLength(3)
    expect(source.strides).toEqual(frame.strides)
    expect(source.planes[0]?.[0]).toBe(yValue(REGION.top, REGION.left))
    expect(source.planes[1]?.[0]).toBe(cValue('u', REGION.top / 2, REGION.left / 2))
    expect(source.planes[2]?.[0]).toBe(cValue('v', REGION.top / 2, REGION.left / 2))
  })

  it('returns null when a plane is missing (the old throw, now a counted miss)', () => {
    const frame = makeYuv420p()
    expect(
      resolvePlanarCropSource('yuv420p', [frame.planes[0], frame.planes[1]], frame.strides, REGION),
    ).toBeNull()
    expect(resolvePlanarCropSource('yuv420p', undefined, frame.strides, REGION)).toBeNull()
  })

  it('floors an ODD origin to the chroma grid instead of reading a half-sample', () => {
    const frame = makeYuv420p()
    const odd: PlanarCropRegion = { left: 9, top: 5, width: 16, height: 8 }
    const source = resolvePlanarCropSource('yuv420p', frame.planes, frame.strides, odd)
    // Y follows the exact origin; chroma floors to (2,4) — the sample that
    // CONTAINS it. Reading (2.5, 4.5) is not expressible and must not be faked.
    expect(source?.planes[0]?.[0]).toBe(yValue(5, 9))
    expect(source?.planes[1]?.[0]).toBe(cValue('u', 2, 4))
  })
})

/**
 * The BOTTOM EDGE, which is where the closest and largest subjects live.
 *
 * The span check asked each plane for `stride * region.height` bytes measured
 * from the crop ORIGIN. The last row of a crop only needs `left + width` bytes,
 * not a whole stride, so the demand overshot the plane's end by exactly `left`
 * whenever the crop's bottom was the frame's last row — and
 * `resolveNativeTileRegion` clamps a padded box to precisely that. Every
 * subject standing near the camera therefore lost its tile, silently, and
 * `handleNativeCrop` threw for the same rectangles on the hold path.
 *
 * Measured on the live cluster over 6 h (2026-09-07): 100 of 100 logged
 * `retained yuv420p frame missing plane data` geometries satisfy
 * `top + height === frameHeight` with `left > 0`; 101 of 102 were on dev:104
 * (hall, 3840x2160), e.g. `746x968+1218+1192` — 968 + 1192 = 2160.
 */
describe('resolvePlanarCropSource — a crop flush with the frame bottom', () => {
  it('YUV420P: resolves a bottom-flush crop with a non-zero left offset', () => {
    const frame = makeYuv420p()
    const region: PlanarCropRegion = { left: 16, top: HEIGHT - 8, width: 16, height: 8 }
    const source = resolvePlanarCropSource('yuv420p', frame.planes, frame.strides, region)
    expect(source).not.toBeNull()
    if (!source) return
    expect(source.planes[0]?.[0]).toBe(yValue(region.top, region.left))
    expect(source.planes[1]?.[0]).toBe(cValue('u', region.top / 2, region.left / 2))
    expect(source.planes[2]?.[0]).toBe(cValue('v', region.top / 2, region.left / 2))
  })

  it('NV12: resolves a bottom-flush crop with a non-zero left offset', () => {
    const frame = makeNv12()
    const region: PlanarCropRegion = { left: 16, top: HEIGHT - 8, width: 16, height: 8 }
    const source = resolvePlanarCropSource('nv12', frame.planes, frame.strides, region)
    expect(source).not.toBeNull()
    if (!source) return
    expect(source.planes[0]?.[0]).toBe(yValue(region.top, region.left))
    expect(source.planes[1]?.[0]).toBe(cValue('u', region.top / 2, region.left / 2))
  })

  it('the bottom-RIGHT corner resolves — the largest left offset a frame has', () => {
    const frame = makeYuv420p()
    const region: PlanarCropRegion = { left: WIDTH - 8, top: HEIGHT - 6, width: 8, height: 6 }
    const source = resolvePlanarCropSource('yuv420p', frame.planes, frame.strides, region)
    expect(source).not.toBeNull()
    expect(source?.planes[0]?.[0]).toBe(yValue(region.top, region.left))
  })

  it('still refuses a region whose LAST ROW runs past the plane — the guard survives', () => {
    const frame = makeYuv420p()
    // One row lower than the frame has: the last row's bytes do not exist.
    expect(
      resolvePlanarCropSource('yuv420p', frame.planes, frame.strides, {
        left: 16,
        top: HEIGHT - 8,
        width: 16,
        height: 10,
      }),
    ).toBeNull()
  })

  it('still refuses a region whose last row runs past the plane to the RIGHT', () => {
    const frame = makeYuv420p()
    const yStride = frame.strides[0] ?? 0
    expect(
      resolvePlanarCropSource('yuv420p', frame.planes, frame.strides, {
        left: yStride - 4,
        top: HEIGHT - 4,
        width: 8,
        height: 4,
      }),
    ).toBeNull()
  })
})

describe('nativeCropSourceTag — a scaler cache slot per SOURCE format', () => {
  it('gives each format its own tag, so three scalers never alias one slot', () => {
    const tags = new Set([
      nativeCropSourceTag('yuv420p'),
      nativeCropSourceTag('nv12'),
      nativeCropSourceTag('rgb24'),
    ])
    expect(tags.size).toBe(3)
  })

  it('keeps yuv420p as the historical UNPREFIXED tag', () => {
    expect(nativeCropSourceTag('yuv420p')).toBe('')
  })
})

describe('softwareRoiKind — detection toBuffer accepts the lease layouts', () => {
  const C = { AV_PIX_FMT_YUV420P: 0, AV_PIX_FMT_NV12: 23, AV_PIX_FMT_RGB24: 2 }

  it('accepts YUV420P, NV12, and the pinned-RGB24 lease (VAAPI 4K miss)', () => {
    expect(softwareRoiKind(C.AV_PIX_FMT_YUV420P, C)).toBe('yuv420p')
    expect(softwareRoiKind(C.AV_PIX_FMT_NV12, C)).toBe('nv12')
    expect(softwareRoiKind(C.AV_PIX_FMT_RGB24, C)).toBe('rgb24')
  })

  it('refuses an unnamed format instead of guessing chroma', () => {
    expect(softwareRoiKind(99, C)).toBeNull()
  })
})
