/**
 * Helpers for AAC stream framing.
 *
 * Two pieces:
 *
 * 1. `parseAudioSpecificConfig` — decode the hex `config=` blob from the
 *    SDP `fmtp:` line for `mpeg4-generic`/`MP4A-LATM`. Returns the
 *    samplerate + channel config the camera advertises.
 *
 * 2. `depacketizeRfc3640` — strip AU-headers from an RTP `mode=AAC-hbr`
 *    payload and return one or more raw AAC AccessUnits ready to feed
 *    libavcodec. Reolink uses `sizeLength=13; indexLength=3` which is
 *    the RFC 3640 default for AAC-hbr.
 *
 * Both are pure functions over `Uint8Array` — keep them free of
 * libav/node-av deps so they're easy to unit-test.
 */

// AAC sample-rate frequency table (ISO/IEC 14496-3 §1.6.3.4).
const SAMPLERATE_TABLE: readonly number[] = [
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350,
]

export interface AudioSpecificConfig {
  /** Object type (e.g. 2 = AAC-LC, 5 = HE-AAC, 29 = HE-AAC v2). */
  readonly objectType: number
  /** Decoded sample rate in Hz. */
  readonly sampleRate: number
  /** Channel configuration (1 = mono, 2 = stereo, 6 = 5.1, …). */
  readonly channelConfig: number
}

class BitReader {
  private bitPos = 0
  constructor(private readonly buf: Uint8Array) {}
  read(n: number): number {
    let v = 0
    for (let i = 0; i < n; i++) {
      const bytePos = this.bitPos >> 3
      const bit = 7 - (this.bitPos & 7)
      const b = bytePos < this.buf.length ? this.buf[bytePos]! : 0
      v = (v << 1) | ((b >> bit) & 1)
      this.bitPos++
    }
    return v
  }
  remainingBits(): number {
    return this.buf.length * 8 - this.bitPos
  }
}

/**
 * Decode hex `config=` blob (or raw `Uint8Array`) into an
 * `AudioSpecificConfig`. Throws on malformed input.
 *
 * Layout per ISO/IEC 14496-3 §1.6.2.1:
 *   - 5 bits: audioObjectType (extension-escape if 31)
 *   - 4 bits: samplingFrequencyIndex (0xf = explicit 24-bit value follows)
 *   - 4 bits: channelConfiguration
 */
export function parseAudioSpecificConfig(input: string | Uint8Array): AudioSpecificConfig {
  const buf = typeof input === 'string' ? hexToBytes(input) : input
  if (buf.length < 2) {
    throw new Error(`audio-codec: AudioSpecificConfig too short (${buf.length} bytes)`)
  }
  const reader = new BitReader(buf)
  let objectType = reader.read(5)
  if (objectType === 31) {
    objectType = 32 + reader.read(6)
  }
  const sampleRateIndex = reader.read(4)
  let sampleRate: number
  if (sampleRateIndex === 0xf) {
    sampleRate = reader.read(24)
  } else {
    const v = SAMPLERATE_TABLE[sampleRateIndex]
    if (!v) throw new Error(`audio-codec: invalid samplingFrequencyIndex ${sampleRateIndex}`)
    sampleRate = v
  }
  const channelConfig = reader.read(4)
  return { objectType, sampleRate, channelConfig }
}

function hexToBytes(hex: string): Uint8Array {
  const trimmed = hex.replace(/\s+/g, '')
  if (trimmed.length % 2 !== 0) {
    throw new Error(`audio-codec: hex string has odd length (${trimmed.length})`)
  }
  const out = new Uint8Array(trimmed.length / 2)
  for (let i = 0; i < out.length; i++) {
    const byte = parseInt(trimmed.slice(i * 2, i * 2 + 2), 16)
    if (Number.isNaN(byte)) {
      throw new Error(`audio-codec: invalid hex at offset ${i * 2}`)
    }
    out[i] = byte
  }
  return out
}

/**
 * Depacketize an RFC 3640 `mode=AAC-hbr` RTP payload (typical
 * `sizeLength=13; indexLength=3`) into one or more raw AAC AccessUnits.
 *
 * RFC 3640 §3.2 layout:
 *   AU Headers Length (16 bits, big-endian) — total bits in the AU
 *     headers section.
 *   AU headers — `sizeLength` bits AU-size, `indexLength` bits AU-index
 *     (or AU-index-delta after the first). Padding aligns to byte.
 *   AU data — `auCount` access units back-to-back, each `auSize` bytes.
 *
 * `payload` is the RTP payload (after the 12+ byte RTP header, i.e.
 * what callers pass via `onAudioRtp` minus the header strip).
 */
export interface Rfc3640Options {
  readonly sizeLength: number // bits per AU-size — default 13
  readonly indexLength: number // bits per AU-index — default 3
  readonly indexDeltaLength?: number
}

export function depacketizeRfc3640(
  payload: Uint8Array,
  opts: Rfc3640Options = { sizeLength: 13, indexLength: 3 },
): Uint8Array[] {
  if (payload.length < 2) return []
  const sizeLen = opts.sizeLength
  const idxLen = opts.indexLength
  const idxDeltaLen = opts.indexDeltaLength ?? idxLen
  const headersBitLength = (payload[0]! << 8) | payload[1]!
  if (headersBitLength === 0) return []

  const headersStartByte = 2
  const headersByteLength = (headersBitLength + 7) >> 3
  const headersEndByte = headersStartByte + headersByteLength
  if (headersEndByte > payload.length) return []

  const headersSlice = payload.subarray(headersStartByte, headersEndByte)
  const reader = new BitReader(headersSlice)
  const sizes: number[] = []
  let consumed = 0
  let firstAu = true
  while (consumed < headersBitLength) {
    if (reader.remainingBits() < sizeLen + (firstAu ? idxLen : idxDeltaLen)) break
    const auSize = reader.read(sizeLen)
    reader.read(firstAu ? idxLen : idxDeltaLen) // index/delta — ignored
    sizes.push(auSize)
    consumed += sizeLen + (firstAu ? idxLen : idxDeltaLen)
    firstAu = false
  }

  const units: Uint8Array[] = []
  let offset = headersEndByte
  for (const sz of sizes) {
    if (offset + sz > payload.length) break
    units.push(payload.subarray(offset, offset + sz))
    offset += sz
  }
  return units
}
