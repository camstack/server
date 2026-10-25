import { describe, it, expect } from 'vitest'
import { clampEven, normalizedBboxToCrop, resolveNativeCropGeometry } from '../crop-geometry.js'

describe('crop-geometry — native bbox → pixel mapping', () => {
  it('maps a normalized bbox to native pixels against the real frame dims', () => {
    // A face at the centre of a 3840x2160 native frame, 10% wide / 20% tall.
    const crop = normalizedBboxToCrop(3840, 2160, { x: 0.45, y: 0.4, w: 0.1, h: 0.2 })
    expect(crop).toEqual({
      left: Math.round(0.45 * 3840), // 1728
      top: Math.round(0.4 * 2160), // 864
      width: Math.round(0.1 * 3840), // 384
      height: Math.round(0.2 * 2160), // 432
    })
  })

  it('resolveNativeCropGeometry produces an even-aligned region (YUV420P chroma)', () => {
    // A box that lands on odd pixel boundaries must floor to even.
    const { region } = resolveNativeCropGeometry(
      1000,
      1000,
      { x: 0.101, y: 0.101, w: 0.05, h: 0.05 },
      undefined,
    )
    expect(region.left % 2).toBe(0)
    expect(region.top % 2).toBe(0)
    expect(region.width % 2).toBe(0)
    expect(region.height % 2).toBe(0)
  })

  it('without maxWidth the target equals the native crop region (true native res)', () => {
    const { region, target } = resolveNativeCropGeometry(
      1920,
      1080,
      { x: 0.4, y: 0.4, w: 0.2, h: 0.2 },
      undefined,
    )
    expect(target.width).toBe(region.width)
    expect(target.height).toBe(region.height)
  })

  it('maxWidth caps the output width aspect-preserving; only shrinks (never upsizes)', () => {
    // Native crop ~384x432; cap to 200 wide.
    const { region, target } = resolveNativeCropGeometry(
      3840,
      2160,
      { x: 0.45, y: 0.4, w: 0.1, h: 0.2 },
      200,
    )
    expect(target.width).toBe(200)
    expect(target.height).toBe(Math.max(1, Math.round((200 * region.height) / region.width)))
    // A maxWidth larger than the region does NOT upscale.
    const wide = resolveNativeCropGeometry(3840, 2160, { x: 0.45, y: 0.4, w: 0.1, h: 0.2 }, 5000)
    expect(wide.target.width).toBe(wide.region.width)
  })

  it('a degenerate (zero-area) bbox is widened to the 2px chroma minimum, never empty', () => {
    const { region } = resolveNativeCropGeometry(
      1920,
      1080,
      { x: 0.5, y: 0.5, w: 0, h: 0 },
      undefined,
    )
    expect(region.width).toBeGreaterThanOrEqual(2)
    expect(region.height).toBeGreaterThanOrEqual(2)
  })

  it('clamps an out-of-frame (padded) bbox inside the frame', () => {
    const { region } = resolveNativeCropGeometry(
      1920,
      1080,
      { x: 0.95, y: 0.95, w: 0.2, h: 0.2 },
      undefined,
    )
    expect(region.left + region.width).toBeLessThanOrEqual(1920)
    expect(region.top + region.height).toBeLessThanOrEqual(1080)
  })

  it('clampEven floors to the nearest even inside [min,max]', () => {
    expect(clampEven(7, 0, 100)).toBe(6)
    expect(clampEven(-4, 0, 100)).toBe(0)
    expect(clampEven(200, 0, 100)).toBe(100)
  })
})
