#!/usr/bin/env node
/**
 * Pack PNG files into a Windows .ico — no ImageMagick.
 *
 * `build-icons.sh` used to need ImageMagick for `assets/icon.ico`, which a
 * build host rarely has, so the file was never generated and the Windows build
 * pointed at an icon that did not exist. ICO has carried PNG-compressed images
 * since Windows Vista, so the container is a 6-byte header, one 16-byte entry
 * per image and the PNG bytes themselves.
 *
 *   node png-to-ico.mjs out.ico icon-16.png icon-32.png ...
 *
 * The image size is read from each PNG's IHDR, not from its file name.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const ICONDIR_BYTES = 6
const ICONDIRENTRY_BYTES = 16
/** An ICO entry stores 0 for 256, and cannot store anything larger. */
const MAX_ICO_DIMENSION = 256

/** `{ width, height }` out of a PNG's IHDR chunk; throws on anything else. */
export function pngDimensions(png) {
  if (png.length < 24 || !png.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('not a PNG file')
  }
  if (png.toString('ascii', 12, 16) !== 'IHDR') throw new Error('PNG has no IHDR chunk')
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) }
}

/** @param {readonly Buffer[]} pngs @returns {Buffer} */
export function buildIco(pngs) {
  if (pngs.length === 0) throw new Error('an .ico needs at least one image')
  const dims = pngs.map((png) => pngDimensions(png))
  for (const { width, height } of dims) {
    if (width > MAX_ICO_DIMENSION || height > MAX_ICO_DIMENSION) {
      throw new Error(`${width}x${height} is larger than the ${MAX_ICO_DIMENSION}px an .ico holds`)
    }
  }
  const header = Buffer.alloc(ICONDIR_BYTES)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(pngs.length, 4)

  let offset = ICONDIR_BYTES + ICONDIRENTRY_BYTES * pngs.length
  const entries = pngs.map((png, i) => {
    const entry = Buffer.alloc(ICONDIRENTRY_BYTES)
    const { width, height } = dims[i]
    entry.writeUInt8(width === MAX_ICO_DIMENSION ? 0 : width, 0)
    entry.writeUInt8(height === MAX_ICO_DIMENSION ? 0 : height, 1)
    entry.writeUInt8(0, 2) // palette colours: none
    entry.writeUInt8(0, 3) // reserved
    entry.writeUInt16LE(1, 4) // colour planes
    entry.writeUInt16LE(32, 6) // bits per pixel
    entry.writeUInt32LE(png.length, 8)
    entry.writeUInt32LE(offset, 12)
    offset += png.length
    return entry
  })
  return Buffer.concat([header, ...entries, ...pngs])
}

function main() {
  const [out, ...inputs] = process.argv.slice(2)
  if (!out || inputs.length === 0) {
    console.error('usage: png-to-ico.mjs <out.ico> <icon.png>...')
    process.exit(2)
  }
  writeFileSync(out, buildIco(inputs.map((f) => readFileSync(f))))
  console.log(`wrote ${out} (${inputs.length} images)`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main()
