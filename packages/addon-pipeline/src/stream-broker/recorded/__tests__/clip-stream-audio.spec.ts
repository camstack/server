/**
 * The framing between a clip stream's container samples and the RTP sender
 * (D600) — proved on the REAL fixtures the production mux produces, because
 * the shape that matters (a 512-byte µ-law run that is not a whole number of
 * frames) is exactly what a hand-written fake would round off.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  createClipAudioFramer,
  PCMU_FRAME_BYTES,
  PCMU_FRAME_MS,
  PCMU_REANCHOR_TOLERANCE_MS,
} from '../clip-stream-audio'
import { createFmp4StreamDemuxer, type Fmp4AudioUnit } from '../fmp4-stream-demux'

const OPUS = readFileSync(join(__dirname, 'fixtures/clip-frag-opus.mp4'))
const PCMU = readFileSync(join(__dirname, 'fixtures/clip-frag-pcmu.mov'))

function samplesOf(bytes: Uint8Array): Fmp4AudioUnit[] {
  const out: Fmp4AudioUnit[] = []
  const demuxer = createFmp4StreamDemuxer({ onAudio: (u) => out.push(u) })
  demuxer.push(bytes)
  demuxer.end()
  return out
}

describe('createClipAudioFramer: Opus', () => {
  it('passes every packet through untouched — an mp4 Opus sample IS an RTP payload', () => {
    const framer = createClipAudioFramer('opus')
    const units = samplesOf(OPUS)
    expect(units.length).toBeGreaterThan(100)
    const frames = units.flatMap((u) => [...framer.push(u)])
    expect(frames).toHaveLength(units.length)
    for (let i = 0; i < frames.length; i++) {
      const frame = frames[i]
      const unit = units[i]
      if (frame === undefined || unit === undefined) throw new Error('unreachable')
      expect(frame.ptsMs).toBe(unit.ptsMs)
      expect(frame.durationMs).toBe(unit.durationMs)
      expect(Buffer.from(frame.data).equals(Buffer.from(unit.data))).toBe(true)
    }
    expect(framer.carriedBytes).toBe(0)
  })
})

describe('createClipAudioFramer: µ-law', () => {
  it('re-cuts the muxer runs into fixed 20 ms frames, carrying the remainder', () => {
    const units = samplesOf(PCMU)
    // The measured shape: ffmpeg hands over 512-byte (64 ms) runs, which are
    // NOT a whole number of 160-byte frames. If they were, this whole module
    // would be unnecessary and the carry would never be exercised.
    expect(units.some((u) => u.data.byteLength % PCMU_FRAME_BYTES !== 0)).toBe(true)

    const framer = createClipAudioFramer('pcmu')
    const frames = units.flatMap((u) => [...framer.push(u)])
    expect(frames.length).toBeGreaterThan(150)
    for (const frame of frames) {
      expect(frame.data.byteLength).toBe(PCMU_FRAME_BYTES)
      expect(frame.durationMs).toBe(PCMU_FRAME_MS)
    }
    // Nothing is invented and nothing is lost: what came out plus what is
    // still carried is exactly what went in.
    const inBytes = units.reduce((sum, u) => sum + u.data.byteLength, 0)
    const outBytes = frames.length * PCMU_FRAME_BYTES + framer.carriedBytes
    expect(outBytes).toBe(inBytes)
    expect(framer.carriedBytes).toBeLessThan(PCMU_FRAME_BYTES)
    expect(framer.reanchors).toBe(0)
  })

  it('counts the clock in BYTES, so a long run cannot drift', () => {
    const framer = createClipAudioFramer('pcmu')
    const frames = samplesOf(PCMU).flatMap((u) => [...framer.push(u)])
    const first = frames[0]
    if (first === undefined) throw new Error('unreachable')
    // Every frame is exactly 20 ms after the one before it, for the whole
    // run. Re-deriving each frame from its container sample's ROUNDED ptsMs
    // would put a fraction of a millisecond on each boundary instead, which
    // is the drift that only ever shows up on a long clip.
    for (let i = 0; i < frames.length; i++) {
      expect(frames[i]?.ptsMs).toBeCloseTo(first.ptsMs + i * PCMU_FRAME_MS, 9)
    }
  })

  it('re-anchors on a GAP rather than stretching the count across it', () => {
    const units = samplesOf(PCMU)
    const framer = createClipAudioFramer('pcmu')
    const head = units.slice(0, 3)
    for (const u of head) framer.push(u)
    expect(framer.reanchors).toBe(0)
    const next = units[3]
    if (next === undefined) throw new Error('unreachable')
    // Two seconds further on than the count expects: a skipped run, not a
    // rounding error.
    const jumped: Fmp4AudioUnit = { ...next, ptsMs: next.ptsMs + 2_000 }
    const frames = framer.push(jumped)
    expect(framer.reanchors).toBe(1)
    expect(frames[0]?.ptsMs).toBe(jumped.ptsMs)
    // The carry from before the seam is DROPPED — a frame built across it
    // would carry neither side's timestamp.
    expect(framer.carriedBytes).toBeLessThan(PCMU_FRAME_BYTES)
  })

  it('does NOT re-anchor on the container’s own millisecond rounding', () => {
    const units = samplesOf(PCMU)
    const framer = createClipAudioFramer('pcmu')
    for (const unit of units.slice(0, 5)) {
      framer.push({ ...unit, ptsMs: unit.ptsMs + PCMU_REANCHOR_TOLERANCE_MS - 1 })
    }
    expect(framer.reanchors).toBe(0)
  })

  it('yields nothing for an empty sample rather than an empty frame', () => {
    const framer = createClipAudioFramer('pcmu')
    const unit = samplesOf(PCMU)[0]
    if (unit === undefined) throw new Error('unreachable')
    expect(framer.push({ ...unit, data: new Uint8Array(0) })).toHaveLength(0)
  })
})

/**
 * The check a framing test cannot make: that what comes out is the SOUND that
 * went in.
 *
 * Silence, a burst, a rate that is off by a factor and a channel-count
 * mismatch all pass a test that only counts frames and bytes — they are
 * wrong in the ear, not on paper. µ-law decodes with a pure function
 * (ITU-T G.711), so the fixture's 440 Hz tone can be recovered and measured
 * here with nothing external: a resample error moves the peak, a mismatched
 * channel count halves the level, and silence has no peak at all.
 */
function muLawToPcm(byte: number): number {
  const u = ~byte & 0xff
  let t = ((u & 0x0f) << 3) + 0x84
  t <<= (u & 0x70) >> 4
  return (u & 0x80) === 0 ? t - 0x84 : 0x84 - t
}

/** Goertzel power at `hz` over `samples` taken at `rateHz`. */
function tonePower(samples: Float64Array, rateHz: number, hz: number): number {
  const w = (2 * Math.PI * hz) / rateHz
  const c = 2 * Math.cos(w)
  let s1 = 0
  let s2 = 0
  for (const x of samples) {
    const s = x + c * s1 - s2
    s2 = s1
    s1 = s
  }
  return s1 * s1 + s2 * s2 - c * s1 * s2
}

describe('the µ-law a clip stream carries is the sound the camera sent', () => {
  it('recovers the fixture’s 440 Hz tone at 8 kHz, at a real level', () => {
    const framer = createClipAudioFramer('pcmu')
    const frames = samplesOf(PCMU).flatMap((u) => [...framer.push(u)])
    const bytes = Buffer.concat(frames.map((f) => Buffer.from(f.data)))
    // Skip the first 100 ms: the encoder's own ramp-in is not the tone.
    const samples = new Float64Array(bytes.byteLength - 800)
    for (let i = 0; i < samples.length; i++) {
      samples[i] = muLawToPcm(bytes[i + 800] ?? 0) / 32_768
    }
    const rms = Math.sqrt(samples.reduce((sum, x) => sum + x * x, 0) / samples.length)
    // Not silence, and not clipped: a real signal at a sane level.
    expect(rms).toBeGreaterThan(0.02)
    expect(rms).toBeLessThan(0.5)
    // The peak is at 440 Hz and nowhere else. An 8 kHz stream read as 16 kHz
    // (or a stereo one read as mono) puts the peak somewhere else entirely.
    const at440 = tonePower(samples, 8_000, 440)
    for (const other of [220, 330, 880, 1_320, 2_000]) {
      expect(at440).toBeGreaterThan(tonePower(samples, 8_000, other) * 20)
    }
  })
})
