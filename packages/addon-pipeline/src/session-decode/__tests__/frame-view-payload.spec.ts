import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import { FRAME_VIEW_PAYLOAD_POLICY, compareFrameViewPayload } from '../frame-view-payload.js'

function sampleRgb(width: number, height: number): Buffer {
  const data = Buffer.allocUnsafe(width * height * 3)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 3
      data[offset] = (x * 3 + y) % 256
      data[offset + 1] = (x + y * 2) % 256
      data[offset + 2] = (x + y) % 256
    }
  }
  return data
}

describe('content-sized frame payload policy', () => {
  for (const [width, height] of [
    [320, 180],
    [640, 360],
  ] as const) {
    it(`counts raw and one JPEG payload at ${width}x${height}`, async () => {
      const raw = sampleRgb(width, height)
      const jpeg = await sharp(raw, { raw: { width, height, channels: 3 } })
        .jpeg({ quality: 85, mozjpeg: false })
        .toBuffer()
      const comparison = compareFrameViewPayload(width, height, jpeg.byteLength)

      expect(comparison.rawBytes).toBe(width * height * 3)
      expect(comparison.jpegBytes).toBe(jpeg.byteLength)
      expect(comparison.jpegBytes).toBeLessThan(comparison.rawBytes)
      expect(comparison.payloadsMeasured).toBe(2)
    })
  }

  it('keeps one explicit worker-to-provider payload policy', () => {
    expect(FRAME_VIEW_PAYLOAD_POLICY).toBe('jpeg')
  })
})
