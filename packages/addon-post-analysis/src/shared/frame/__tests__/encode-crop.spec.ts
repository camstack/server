import { describe, it, expect } from 'vitest'
import { decodeJpegToRgb, encodeRgbCropToJpeg } from '../encode-crop.js'

// Bug 1 (cross-node native media): the owning runner ships a COMPRESSED base64
// JPEG cross-node (never raw RGB — a native 4K frame exceeds Moleculer's 10 MB
// maxPacketSize). The post-processing node decodes it back to RGB in-process so
// every downstream consumer keeps its raw-RGB contract. This round-trips that
// path: RGB → JPEG (owning node) → base64 (wire) → RGB (post node).
describe('cross-node crop JPEG round-trip', () => {
  it('decodes a base64 JPEG back to raw RGB with the original dimensions', async () => {
    const width = 8
    const height = 6
    const rgb = new Uint8Array(width * height * 3)
    for (let i = 0; i < rgb.length; i += 3) {
      rgb[i] = 200 // R
      rgb[i + 1] = 40 // G
      rgb[i + 2] = 120 // B
    }
    const jpeg = await encodeRgbCropToJpeg(rgb, width, height)
    const decoded = await decodeJpegToRgb(jpeg.toString('base64'))
    expect(decoded.width).toBe(width)
    expect(decoded.height).toBe(height)
    expect(decoded.bytes.length).toBe(width * height * 3)
    // JPEG is lossy, but a flat color survives within a wide tolerance.
    expect(Math.abs(decoded.bytes[0]! - 200)).toBeLessThan(25)
    expect(Math.abs(decoded.bytes[1]! - 40)).toBeLessThan(25)
    expect(Math.abs(decoded.bytes[2]! - 120)).toBeLessThan(25)
  })
})
