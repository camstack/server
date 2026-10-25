/**
 * IMA ADPCM (DVI4) encoder — Reolink Baichuan talk-back wire format.
 *
 * Reolink cameras expect ADPCM blocks of (4 + N) bytes:
 *   - 2 bytes: little-endian Int16 predictor (first PCM sample of the
 *     block, used to seed the decoder state on the camera side)
 *   - 1 byte: index into the IMA step table (always 0 — we re-seed
 *     the predictor on every block instead of carrying state forward)
 *   - 1 byte: padding
 *   - N bytes: 2 nibbles per byte, low nibble first, each nibble
 *     encodes one PCM sample's delta as `sign | delta3` (4 bits)
 *
 * The block size is camera-firmware specific; the lib reports it as
 * `TalkSessionInfo.blockSize` per session.
 *
 * Why standalone?
 *   - Pure function — no I/O, easy to unit-test
 *   - Reusable from the (currently stub) WebRTC server-side intercom
 *     path AND from any future direct-PCM caller
 *   - Decoupled from werift / lib types
 */

const IMA_INDEX_TABLE = Int8Array.from([-1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8])

const IMA_STEP_TABLE = Int16Array.from([
  7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73,
  80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494,
  544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499,
  2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487,
  12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767,
])

function clamp16(x: number): number {
  if (x > 32767) return 32767
  if (x < -32768) return -32768
  return x | 0
}

/**
 * Encode a PCM s16le buffer into IMA ADPCM blocks of size
 * `(4 + blockSizeBytes)` each. The output length is a multiple of
 * `4 + blockSizeBytes`. PCM samples that don't fit a full block at
 * the end get folded into a final partial block (the camera tolerates
 * trailing zeros from the unpopulated nibbles).
 *
 * Block layout per Reolink's wire format:
 *   bytes [0..1]   = predictor (Int16 LE)
 *   byte  [2]      = step index (always 0 — re-seed each block)
 *   byte  [3]      = padding (0x00)
 *   bytes [4..N+3] = packed nibbles (2 samples per byte, low first)
 *
 * Each block carries `blockSizeBytes * 2 + 1` PCM samples (the +1
 * is the predictor sample stored explicitly in the header).
 */
export function encodeImaAdpcm(pcm: Int16Array, blockSizeBytes: number): Buffer {
  const samplesPerBlock = blockSizeBytes * 2 + 1
  const totalBlocks = Math.ceil(pcm.length / samplesPerBlock)
  const outBlocks: Buffer[] = []

  let sampleIndex = 0
  for (let b = 0; b < totalBlocks; b++) {
    const block = Buffer.alloc(4 + blockSizeBytes)
    const first = pcm[sampleIndex] ?? 0
    let predictor = first
    let index = 0
    block.writeInt16LE(predictor, 0)
    block.writeUInt8(index, 2)
    block.writeUInt8(0, 3)
    sampleIndex++

    const codes = new Uint8Array(blockSizeBytes * 2)
    for (let i = 0; i < codes.length; i++) {
      const sample = pcm[sampleIndex] ?? predictor
      sampleIndex++
      let diff = sample - predictor
      let sign = 0
      if (diff < 0) {
        sign = 8
        diff = -diff
      }
      let step = IMA_STEP_TABLE[index] ?? 7
      let delta = 0
      let vpdiff = step >> 3
      if (diff >= step) {
        delta |= 4
        diff -= step
        vpdiff += step
      }
      step >>= 1
      if (diff >= step) {
        delta |= 2
        diff -= step
        vpdiff += step
      }
      step >>= 1
      if (diff >= step) {
        delta |= 1
        vpdiff += step
      }
      predictor = sign ? clamp16(predictor - vpdiff) : clamp16(predictor + vpdiff)
      index += IMA_INDEX_TABLE[delta] ?? 0
      if (index < 0) index = 0
      if (index > 88) index = 88
      codes[i] = (delta | sign) & 0x0f
    }

    for (let i = 0; i < blockSizeBytes; i++) {
      const lo = codes[i * 2] ?? 0
      const hi = codes[i * 2 + 1] ?? 0
      block[4 + i] = (lo & 0x0f) | ((hi & 0x0f) << 4)
    }
    outBlocks.push(block)
  }
  return Buffer.concat(outBlocks)
}
