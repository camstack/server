import { describe, it, expect } from 'vitest'
import { resolveSourceColor, sourceColorKey } from '../color-conversion.js'
import {
  buildLeaseDownloadDescription,
  leaseDownloadFilterKey,
  nativeCropScalerKey,
  resolveRgbCropSource,
  retainedFrameBytes,
  rgbCropSourceOffset,
  RGB_CROP_SIMD_SLACK,
} from '../pinned-rgb-crop.js'

// FFmpeg AVColorSpace / AVColorRange ABI integers (mirror color-conversion's map).
const SPC_BT709 = 1
const SPC_UNSPECIFIED = 2 // cam 102: no color-matrix metadata
const SPC_SMPTE170M = 6
const RANGE_UNSPECIFIED = 0
const RANGE_MPEG = 1
const RANGE_JPEG = 2

const SCALE_FILTER = 'scale_vaapi'

describe('pinnedRgbCrop — lease-download filter DESCRIPTION decision', () => {
  it('flag OFF (color=null) → the historical YUV420P download, byte-for-byte', () => {
    // This is the exact legacy string; asserting it verifies flag-off is unchanged.
    expect(buildLeaseDownloadDescription(SCALE_FILTER, null)).toBe(
      'scale_vaapi=w=iw:h=ih,hwdownload,format=nv12,format=yuv420p',
    )
  })

  it('flag ON → a single pinned-color GPU download that converges on rgb24', () => {
    const color = resolveSourceColor(SPC_UNSPECIFIED, RANGE_UNSPECIFIED) // cam 102
    const desc = buildLeaseDownloadDescription(SCALE_FILTER, color)
    // One pinned sws convert, ending in rgb24 — NOT yuv420p.
    expect(desc).toBe(
      'scale_vaapi=w=iw:h=ih,hwdownload,format=nv12,' +
        'scale=in_color_matrix=bt709:in_range=limited:out_range=full,format=rgb24',
    )
    expect(desc).not.toContain('format=yuv420p')
  })

  it('flag ON pins the SAME resolved color the full-frame path uses (bt709/limited default for UNSPECIFIED)', () => {
    // The whole point: crop uses the SAME resolved color as the full frame. The
    // full-frame path builds `scale=${colorConvertFilterOptions(color)}` from the
    // identical resolveSourceColor(...) — so the pinned fragment must match.
    const color = resolveSourceColor(SPC_UNSPECIFIED, RANGE_UNSPECIFIED)
    expect(buildLeaseDownloadDescription(SCALE_FILTER, color)).toContain(
      'in_color_matrix=bt709:in_range=limited:out_range=full',
    )
  })

  it('flag ON reflects a stream that DOES carry color tags (no default applied)', () => {
    const color = resolveSourceColor(SPC_SMPTE170M, RANGE_JPEG) // bt601 / full
    expect(buildLeaseDownloadDescription(SCALE_FILTER, color)).toContain(
      'in_color_matrix=bt601:in_range=full:out_range=full',
    )
  })
})

describe('pinnedRgbCrop — lease-download filter CACHE KEY threading', () => {
  it('flag OFF → the historical geometry-only key, byte-for-byte', () => {
    expect(leaseDownloadFilterKey(1920, 1080, null)).toBe('1920x1080')
  })

  it('flag ON → the resolved color is folded into the key', () => {
    const color = resolveSourceColor(SPC_BT709, RANGE_MPEG)
    expect(leaseDownloadFilterKey(1920, 1080, color)).toBe(`1920x1080:rgb:${sourceColorKey(color)}`)
  })

  it('flag ON → a colorspace/range TRANSITION changes the key so the graph rebuilds', () => {
    const a = resolveSourceColor(SPC_BT709, RANGE_MPEG) // bt709 / limited
    const b = resolveSourceColor(SPC_SMPTE170M, RANGE_JPEG) // bt601 / full
    expect(leaseDownloadFilterKey(1920, 1080, a)).not.toBe(leaseDownloadFilterKey(1920, 1080, b))
  })

  it('flag ON → same color + geometry reuses the same key (cache hit)', () => {
    const a = resolveSourceColor(SPC_UNSPECIFIED, RANGE_UNSPECIFIED)
    const b = resolveSourceColor(SPC_UNSPECIFIED, RANGE_UNSPECIFIED)
    expect(leaseDownloadFilterKey(1920, 1080, a)).toBe(leaseDownloadFilterKey(1920, 1080, b))
  })
})

describe('pinnedRgbCrop — native-crop scaler source-format selection', () => {
  it('YUV420P (flag OFF / degrade) → the historical geometry-only key, byte-for-byte', () => {
    expect(nativeCropScalerKey(320, 240, 160, 120, 'yuv420p')).toBe('320x240->160x120')
  })

  it('RGB24 (flag ON) → an rgb-prefixed key so it never aliases the YUV scaler', () => {
    expect(nativeCropScalerKey(320, 240, 160, 120, 'rgb24')).toBe('rgb:320x240->160x120')
  })

  it('NV12 (a two-plane retained frame) gets its own slot too', () => {
    expect(nativeCropScalerKey(320, 240, 160, 120, 'nv12')).toBe('nv12:320x240->160x120')
  })

  it('scalers of identical geometry but different SOURCE format never alias one slot', () => {
    const keys = new Set([
      nativeCropScalerKey(320, 240, 160, 120, 'yuv420p'),
      nativeCropScalerKey(320, 240, 160, 120, 'rgb24'),
      nativeCropScalerKey(320, 240, 160, 120, 'nv12'),
    ])
    expect(keys.size).toBe(3)
  })
})

describe('pinnedRgbCrop — RGB24 crop is a PLAIN spatial crop (no color math)', () => {
  it('offsets the packed plane by top*stride + left*3 (single plane, no chroma halving)', () => {
    // A 1920-wide RGB24 frame → stride 5760; crop origin (left=100, top=50).
    expect(rgbCropSourceOffset(50, 100, 5760)).toBe(50 * 5760 + 100 * 3)
    expect(rgbCropSourceOffset(50, 100, 5760)).toBe(288_300)
  })

  it('origin (0,0) offsets to 0 — a full-frame RGB crop reads from the plane start', () => {
    expect(rgbCropSourceOffset(0, 0, 5760)).toBe(0)
  })

  it('the RGB crop reads a single plane offset, unlike the YUV path (3 planes, chroma /2)', () => {
    // RGB is 3 bytes/px on ONE plane; the offset never divides left/top by 2
    // (there is no subsampled chroma plane) — proving the crop is purely spatial.
    const stride = 1280 * 3
    expect(rgbCropSourceOffset(40, 60, stride)).toBe(40 * stride + 60 * 3)
  })
})

describe('pinnedRgbCrop — retained-frame RAM budget accounting', () => {
  it('YUV420P frame ≈ 1.5 bytes/px (flag OFF, unchanged)', () => {
    expect(retainedFrameBytes(1920, 1080, false)).toBe(Math.ceil(1920 * 1080 * 1.5))
  })

  it('RGB24 frame = 3 bytes/px (flag ON, ~2x cost)', () => {
    expect(retainedFrameBytes(1920, 1080, true)).toBe(1920 * 1080 * 3)
  })

  it('documents the ~2x RAM cost of pinned-RGB retention', () => {
    const yuv = retainedFrameBytes(1920, 1080, false)
    const rgb = retainedFrameBytes(1920, 1080, true)
    expect(rgb / yuv).toBeCloseTo(2, 5)
    // ~6.22 MB RGB24 vs ~3.11 MB YUV420P per 1080p frame (documented flag cost).
    expect(rgb).toBe(6_220_800)
    expect(yuv).toBe(3_110_400)
  })
})

// resolveRgbCropSource — the subject-ROI-vs-full-frame native-crop fix. A
// bottom/right-edge ROI leaves the packed-RGB plane tail short of the span
// libswscale reads (full rows + a SIMD overshoot on the last row); the fast
// zero-copy stride-offset view then over-reads the allocation and the crop
// scaler THROWS → reported as a native miss. A full-frame crop is always
// exactly sized (landed). resolveRgbCropSource keeps the zero-copy view when it
// is provably in-bounds and repacks ONLY the short edge ROIs.
describe('resolveRgbCropSource', () => {
  // A 16x8 RGB24 frame (stride = 16*3 = 48), packed tight.
  const W = 16
  const H = 8
  const STRIDE = W * 3
  const plane = new Uint8Array(STRIDE * H)
  for (let i = 0; i < plane.length; i++) plane[i] = i % 251

  it('returns a zero-copy view for a mid-frame ROI that stays in-bounds', () => {
    const region = { left: 2, top: 1, width: 6, height: 3 }
    const { src, stride } = resolveRgbCropSource(plane, STRIDE, region)
    expect(stride).toBe(STRIDE) // unchanged → zero-copy path
    // The view starts at the crop origin (top*stride + left*3).
    expect(src[0]).toBe(plane[1 * STRIDE + 2 * 3])
  })

  it('repacks a bottom-edge ROI whose zero-copy view is short (the throw case)', () => {
    // Bottom-right ROI: top+height touches the frame bottom, left>0.
    const region = { left: 10, top: 5, width: 6, height: 3 }
    const offset = region.top * STRIDE + region.left * 3
    // Prove the zero-copy view is too short for the sws span (regression guard).
    expect(plane.length - offset).toBeLessThan(STRIDE * region.height + RGB_CROP_SIMD_SLACK)

    const { src, stride } = resolveRgbCropSource(plane, STRIDE, region)
    expect(stride).toBe(region.width * 3) // repacked to a tight stride
    // Repacked buffer is large enough for the full sws span (no over-read).
    expect(src.length).toBeGreaterThanOrEqual(stride * region.height + RGB_CROP_SIMD_SLACK)
    // Row-for-row pixels match the source ROI exactly (same crop, just packed).
    for (let row = 0; row < region.height; row++) {
      for (let b = 0; b < region.width * 3; b++) {
        expect(src[row * stride + b]).toBe(plane[offset + row * STRIDE + b])
      }
    }
  })

  it('repacks any full-height ROI at a non-zero left offset', () => {
    // Full-height column at the right edge — the exact shape that under-runs.
    const region = { left: 13, top: 0, width: 3, height: H }
    const { src, stride } = resolveRgbCropSource(plane, STRIDE, region)
    expect(stride).toBe(region.width * 3)
    expect(src.length).toBeGreaterThanOrEqual(stride * region.height + RGB_CROP_SIMD_SLACK)
  })
})
