/**
 * `png-to-ico.mjs` — the Windows icon is built without ImageMagick. The header
 * and entry fields below are what Windows reads; a wrong offset or a 256 stored
 * as 256 (it must be 0) gives an icon Explorer silently refuses.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildIco, pngDimensions } from '../../scripts/png-to-ico.mjs'

/** A signature + IHDR is all the packer reads. */
function fakePng(width: number, height: number, padding = 8): Buffer {
  const png = Buffer.alloc(33 + padding)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0)
  png.writeUInt32BE(13, 8)
  png.write('IHDR', 12, 'ascii')
  png.writeUInt32BE(width, 16)
  png.writeUInt32BE(height, 20)
  return png
}

describe('buildIco', () => {
  it('writes the directory, one entry per image, then the PNG bytes at the recorded offsets', () => {
    const small = fakePng(16, 16, 4)
    const large = fakePng(48, 48, 10)
    const ico = buildIco([small, large])

    expect(ico.readUInt16LE(0)).toBe(0)
    expect(ico.readUInt16LE(2)).toBe(1) // icon
    expect(ico.readUInt16LE(4)).toBe(2)

    const first = 6
    const second = 6 + 16
    expect(ico.readUInt8(first)).toBe(16)
    expect(ico.readUInt8(second)).toBe(48)
    expect(ico.readUInt32LE(first + 8)).toBe(small.length)
    expect(ico.readUInt32LE(second + 8)).toBe(large.length)
    const firstOffset = ico.readUInt32LE(first + 12)
    const secondOffset = ico.readUInt32LE(second + 12)
    expect(firstOffset).toBe(6 + 16 * 2)
    expect(secondOffset).toBe(firstOffset + small.length)
    expect(ico.subarray(firstOffset, firstOffset + small.length).equals(small)).toBe(true)
    expect(ico.subarray(secondOffset, secondOffset + large.length).equals(large)).toBe(true)
    expect(ico.length).toBe(secondOffset + large.length)
  })

  it('stores 256 as 0, which is how ICO spells it', () => {
    const ico = buildIco([fakePng(256, 256)])
    expect(ico.readUInt8(6)).toBe(0)
    expect(ico.readUInt8(7)).toBe(0)
  })

  it('refuses what an .ico cannot hold', () => {
    expect(() => buildIco([])).toThrow(/at least one/)
    expect(() => buildIco([fakePng(512, 512)])).toThrow(/larger than/)
    expect(() => buildIco([Buffer.from('not a png at all, just text')])).toThrow(/not a PNG/)
  })

  it('reads the real size from the PNG, not from a file name', () => {
    expect(pngDimensions(fakePng(64, 32))).toEqual({ width: 64, height: 32 })
  })

  it('the shipped Windows icon is a valid multi-size .ico', () => {
    const file = path.join(__dirname, '..', '..', 'assets', 'icon.ico')
    const ico = fs.readFileSync(file)
    expect(ico.readUInt16LE(2)).toBe(1)
    const count = ico.readUInt16LE(4)
    expect(count).toBeGreaterThanOrEqual(4)
    const sizes: number[] = []
    for (let i = 0; i < count; i++) {
      const w = ico.readUInt8(6 + i * 16)
      sizes.push(w === 0 ? 256 : w)
      const offset = ico.readUInt32LE(6 + i * 16 + 12)
      expect(
        ico
          .subarray(offset, offset + 8)
          .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
      ).toBe(true)
    }
    expect(sizes).toContain(256)
    expect(sizes).toContain(16)
  })
})
