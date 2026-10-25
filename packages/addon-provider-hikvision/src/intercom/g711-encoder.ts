/**
 * G.711 PCM ↔ µ-law / A-law encoders.
 *
 * Hikvision's ISAPI two-way audio channel typically negotiates one of:
 *   - `G.711ulaw` → ITU-T G.711 µ-law (PCM_MULAW)
 *   - `G.711alaw` → ITU-T G.711 A-law (PCM_ALAW)
 *
 * Wire shape: 8 kHz, mono, 8-bit per sample (one byte per PCM sample).
 * Camera reads the long-running `audioData` PUT body as a contiguous
 * byte stream of these samples — no header, no framing, no length
 * prefix. Just raw bytes written at roughly real-time.
 *
 * The encoders here are pure functions: PCM s16le in, encoded byte
 * buffer out. No I/O, no logging, no allocation beyond the output
 * Buffer. Easy to unit-test against reference vectors.
 */

const BIAS = 0x84
const CLIP = 32635

/**
 * µ-law encode a single 16-bit signed PCM sample. Standard ITU-T G.711
 * lookup-free implementation — branches on sign + segment exponent.
 * Output is the inverted 8-bit code that the wire format expects.
 */
function pcm16ToUlawSample(pcm: number): number {
  let sample = pcm
  let sign = (sample >> 8) & 0x80
  if (sign !== 0) sample = -sample
  if (sample > CLIP) sample = CLIP
  sample = sample + BIAS

  let exponent = 7
  for (let mask = 0x4000; (sample & mask) === 0 && exponent > 0; mask >>= 1) {
    exponent--
  }
  const mantissa = (sample >> (exponent + 3)) & 0x0f
  const ulaw = ~(sign | (exponent << 4) | mantissa) & 0xff
  return ulaw
}

/**
 * A-law encode a single 16-bit signed PCM sample. Mirrors the µ-law
 * pattern but with A-law's segmentation (top bit XOR'd with 0x55 by
 * convention to spread bit-flip errors across the wire).
 */
function pcm16ToAlawSample(pcm: number): number {
  let sample = pcm
  let sign = (~sample >> 8) & 0x80
  if (sign === 0) sample = -sample
  if (sample > CLIP) sample = CLIP

  let alaw: number
  if (sample >= 256) {
    let exponent = 7
    for (let mask = 0x4000; (sample & mask) === 0 && exponent > 0; mask >>= 1) {
      exponent--
    }
    const mantissa = (sample >> (exponent + 3)) & 0x0f
    alaw = (exponent << 4) | mantissa
  } else {
    alaw = sample >> 4
  }
  return (alaw ^ sign ^ 0x55) & 0xff
}

/**
 * Encode a buffer of PCM s16le mono samples to G.711 µ-law. Output
 * length is exactly `pcm.length / 2` bytes (one sample per byte).
 * Input length MUST be even — odd-length buffers throw, since a
 * trailing half-sample would corrupt the wire alignment.
 *
 * Samples are read with `readInt16LE` rather than an `Int16Array` view:
 * the PCM chunk arrives as a Buffer/Uint8Array that is a *view* into a
 * larger MsgPack frame-decode buffer (audio-codec → hikvision crosses a
 * UDS hop), and its `byteOffset` is payload-dependent — odd ~63% of the
 * time. `new Int16Array(buf.buffer, oddByteOffset)` throws RangeError
 * ("start offset … should be a multiple of 2"), which would drop the
 * chunk. `readInt16LE` has no alignment constraint and is explicitly LE,
 * matching the s16le wire format on every host endianness.
 */
export function encodePcm16ToUlaw(pcm: Buffer): Buffer {
  if ((pcm.length & 1) !== 0) {
    throw new Error(`encodePcm16ToUlaw: odd-length PCM buffer (${pcm.length})`)
  }
  const sampleCount = pcm.length / 2
  const out = Buffer.allocUnsafe(sampleCount)
  for (let i = 0; i < sampleCount; i++) {
    out[i] = pcm16ToUlawSample(pcm.readInt16LE(i * 2))
  }
  return out
}

/**
 * Encode a buffer of PCM s16le mono samples to G.711 A-law. Same
 * shape as `encodePcm16ToUlaw` — odd-length input rejected, samples read
 * with `readInt16LE` so misaligned (odd-byteOffset) views from the
 * MsgPack transport encode correctly instead of throwing.
 */
export function encodePcm16ToAlaw(pcm: Buffer): Buffer {
  if ((pcm.length & 1) !== 0) {
    throw new Error(`encodePcm16ToAlaw: odd-length PCM buffer (${pcm.length})`)
  }
  const sampleCount = pcm.length / 2
  const out = Buffer.allocUnsafe(sampleCount)
  for (let i = 0; i < sampleCount; i++) {
    out[i] = pcm16ToAlawSample(pcm.readInt16LE(i * 2))
  }
  return out
}

/**
 * Wire-codec discriminator. Maps the strings Hikvision returns from
 * `/ISAPI/System/TwoWayAudio/channels` (`G.711ulaw`, `G.711alaw`,
 * sometimes spelled `G711U` / `G711A`) onto an internal enum the
 * intercom session uses to pick the encoder. Unknown values fall back
 * to µ-law; G.711 µ-law is the firmware's out-of-the-box default on
 * every Hikvision model we've probed.
 */
export type HikvisionAudioCodec = 'g711ulaw' | 'g711alaw'

export function resolveHikvisionAudioCodec(raw: string | null | undefined): HikvisionAudioCodec {
  if (!raw) return 'g711ulaw'
  const norm = raw.replace(/[\s.\-_]/g, '').toLowerCase()
  if (norm.includes('alaw') || norm === 'g711a') return 'g711alaw'
  return 'g711ulaw'
}

export function encodePcm16(pcm: Buffer, codec: HikvisionAudioCodec): Buffer {
  return codec === 'g711alaw' ? encodePcm16ToAlaw(pcm) : encodePcm16ToUlaw(pcm)
}
