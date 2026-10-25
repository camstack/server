import { expandAudioChunkToF32le } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { alawToPcm, mulawToPcm } from '../stream-broker/g711-mulaw.js'
import { AudioRtpDecoder } from '../rtsp/audio-rtp-decoder.js'

/**
 * ONE G.711, ONE ANSWER.
 *
 * This repo decoded G.711 twice. `g711-mulaw.ts` fed the WebRTC/Opus egress —
 * what the operator HEARS — and was right. The table inside
 * `audio-rtp-decoder.ts` fed the audio chunk plane — what the CLASSIFIER and
 * the dBFS level meter measure — and was wrong by a constant: every μ-law
 * sample came out at exactly 1/4 of its ITU-T value (−12.04 dB) and every
 * A-law sample at exactly −1/8 (−18.06 dB **and inverted in sign**). It
 * survived for exactly that reason: the audio you hear was right, the audio
 * the detector measures was four to eight times quieter.
 *
 * The anchor here is deliberately NOT "the two implementations agree" — that
 * would go green the moment both are wrong in the same way. It is the ITU-T
 * G.711 expansion written out independently below, plus the published
 * constants of the standard.
 */

// ── ITU-T G.711 reference expansion, written from the standard ──────────
//
// μ-law (Table 2a/G.711): the 8-bit code is stored complemented. Uncomplement,
// split into sign (bit 7), 3-bit segment/exponent (bits 6-4) and 4-bit
// mantissa (bits 3-0). The magnitude is
//     ((2·mantissa + 1) · 2^(segment+1) + 2^(segment+1) · 16 − 33)
// which reduces to the closed form ((8·m + 132) << e) − 132. Full scale is
// ±32124; the lowest code is exactly 0.
function ituMulaw(code: number): number {
  const u = ~code & 0xff
  const sign = (u & 0x80) !== 0 ? -1 : 1
  const exponent = (u >> 4) & 0x07
  const mantissa = u & 0x0f
  const magnitude = ((8 * mantissa + 132) << exponent) - 132
  return sign * magnitude
}

// A-law (Table 1/G.711): the code is stored with its even bits inverted.
// XOR 0x55 to restore it. Bit 7 SET means POSITIVE — the opposite of μ-law,
// and the half of the standard the shipped table also got backwards. Segment
// 0 is linear (magnitude 16·m + 8); every higher segment doubles
// (magnitude (16·m + 264) << (segment − 1)). Full scale is ±32256; the
// smallest magnitude is ±8 — A-law has no exact zero.
function ituAlaw(code: number): number {
  const a = code ^ 0x55
  const sign = (a & 0x80) !== 0 ? 1 : -1
  const segment = (a >> 4) & 0x07
  const mantissa = a & 0x0f
  const magnitude = segment === 0 ? 16 * mantissa + 8 : (16 * mantissa + 264) << (segment - 1)
  return sign * magnitude
}

/**
 * Decode all 256 codes through the RTP decoder, as normalized floats.
 *
 * THIS SPEC WAS DISARMED BY ITS OWN AUTHOR'S ASSUMPTION, and it is worth
 * saying how. D459 claimed it "goes through the decoder, not through the table
 * functions, so it keeps guarding the behaviour wherever the tables end up
 * living — including after D455's move into `@camstack/types`." D455 did not
 * only move the tables: it stopped `AudioRtpDecoder` decoding at all. The
 * decoder emits the CODED payload now, one byte per sample, and this helper
 * read those bytes as Float32 — 256 codes came back as 64 "samples", the
 * `expect(written).toBe(256)` blew up, and all five assertions below have been
 * red on `main` ever since the two records landed on the same day (D461).
 *
 * So the chain under test is the real one, end to end: the decoder emits coded
 * bytes and `expandAudioChunkToF32le` — the ONE place a coded window becomes
 * floats (D455 §4) — turns them into what the classifier and the level meter
 * actually see. That is the path the whole fleet's G.711 takes.
 */
function decodeAllCodes(codec: 'PCMU' | 'PCMA'): Float32Array {
  const out = new Float32Array(256)
  let written = 0
  const decoder = new AudioRtpDecoder(codec, (chunk) => {
    const format = chunk.format ?? 'f32le'
    const bytes = format === 'f32le' ? chunk.data : expandAudioChunkToF32le(chunk.data, format)
    const floats = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4)
    for (const sample of floats) out[written++] = sample
  })

  const header = Buffer.alloc(12)
  header[0] = 0x80
  const payload = Buffer.alloc(256)
  for (let i = 0; i < 256; i++) payload[i] = i
  decoder.processPacket(Buffer.concat([header, payload]))
  decoder.flush()

  expect(written).toBe(256)
  return out
}

describe('G.711 reference constants (ITU-T)', () => {
  it('states the full-scale and minimum magnitudes the standard defines', () => {
    // These are the numbers that pin the SCALE. A decoder off by a factor
    // fails here first, and the factor is readable from the failure.
    expect(ituMulaw(0x80)).toBe(32124)
    expect(ituMulaw(0x00)).toBe(-32124)
    // μ-law's two lowest codes are exact zero (±0 — the standard has a signed
    // zero, so compare the magnitude).
    expect(Math.abs(ituMulaw(0xff))).toBe(0)
    expect(Math.abs(ituMulaw(0x7f))).toBe(0)

    expect(ituAlaw(0xd5)).toBe(8)
    expect(ituAlaw(0x55)).toBe(-8)
    expect(Math.max(...Array.from({ length: 256 }, (_, i) => ituAlaw(i)))).toBe(32256)
    expect(Math.min(...Array.from({ length: 256 }, (_, i) => ituAlaw(i)))).toBe(-32256)
  })
})

describe('AudioRtpDecoder — the chunk plane carries ITU-T amplitude', () => {
  it('decodes every μ-law code to its ITU-T value, normalized to ±1', () => {
    const decoded = decodeAllCodes('PCMU')
    for (let code = 0; code < 256; code++) {
      expect(decoded[code]).toBeCloseTo(ituMulaw(code) / 32768, 6)
    }
  })

  it('decodes every A-law code to its ITU-T value, sign included', () => {
    const decoded = decodeAllCodes('PCMA')
    for (let code = 0; code < 256; code++) {
      expect(decoded[code]).toBeCloseTo(ituAlaw(code) / 32768, 6)
    }
  })

  it('reaches full scale — a peak reads as a peak, not as −12 dB of one', () => {
    // The whole defect in one assertion. The shipped table peaked at 0.2451
    // (μ-law) and 0.1230 (A-law); ITU-T peaks are 0.9803 and 0.9844. Anything
    // that quietly re-introduces a constant gain lands here.
    const ulawPeak = Math.max(...Array.from(decodeAllCodes('PCMU'), Math.abs))
    const alawPeak = Math.max(...Array.from(decodeAllCodes('PCMA'), Math.abs))
    expect(ulawPeak).toBeGreaterThan(0.97)
    expect(alawPeak).toBeGreaterThan(0.97)
  })
})

describe('the two G.711 decoders of this repo agree', () => {
  // The egress decoder (`g711-mulaw.ts`) was always right. This is the
  // regression that keeps them from drifting apart again — it is a SECOND
  // check, never the primary one: both could be wrong together and it would
  // still pass, which is why the ITU-T anchors above come first.
  it('matches the WebRTC/Opus egress decoder on all 256 μ-law codes', () => {
    const decoded = decodeAllCodes('PCMU')
    const egress = mulawToPcm(Uint8Array.from({ length: 256 }, (_, i) => i))
    for (let code = 0; code < 256; code++) {
      expect(decoded[code]).toBeCloseTo(egress[code]! / 32768, 6)
    }
  })

  it('matches the WebRTC/Opus egress decoder on all 256 A-law codes', () => {
    const decoded = decodeAllCodes('PCMA')
    const egress = alawToPcm(Uint8Array.from({ length: 256 }, (_, i) => i))
    for (let code = 0; code < 256; code++) {
      expect(decoded[code]).toBeCloseTo(egress[code]! / 32768, 6)
    }
  })
})
