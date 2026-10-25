/**
 * `buildDerivedTranscodeArgs` reuses the shared `EncodeProfile`→argv builder
 * and terminates on the MPEG-TS stdout sink the derived feeder's `MpegTsDemux`
 * consumes. These assertions match the ACTUAL tokens the shared builder emits
 * (min-based aspect-preserving scale, `libx264` encoder, `-maxrate`/`-bufsize`
 * for bitrate), not assumed spellings.
 *
 * ## The audio assertions are the point of this file
 *
 * A derived stream's audio MUST survive TWO hops, and `-c:a copy` only clears
 * the first one:
 *
 *   1. the MPEG-TS muxer — measured with ffmpeg 7.1: `-c:a copy` of a
 *      G.711 (`pcm_mulaw`) track into `-f mpegts` does NOT fail. It emits
 *      `Stream 1, codec pcm_mulaw, is muxed as a private data stream and may
 *      not be recognized upon reading` and writes stream_type `0x06`;
 *   2. `MpegTsDemux`, which adopts an elementary audio PID only for
 *      stream_type `0x0f` (AAC) or `0x03`/`0x04` (MP2).
 *
 * So a copied G.711 track is muxed, is never demuxed, and the derived broker
 * is never told it has audio — the exact shape of camera 108's silent derived
 * stream. The whole fleet's cameras speak G.711, which is why NO `derived:*`
 * stream has ever carried audio.
 */

import type { EncodeProfile } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  buildDerivedTranscodeArgs,
  resolveDerivedAudio,
} from '../derived/derived-transcode-args.js'

describe('buildDerivedTranscodeArgs', () => {
  const loopbackUrl = 'rtsp://127.0.0.1:8554/derived-source'
  const profile: EncodeProfile = {
    video: { codec: 'h264', width: 640, height: 360, bitrateKbps: 800 },
    audio: 'passthrough',
  }

  it('reads the loopback url as the ffmpeg input', () => {
    const { args } = buildDerivedTranscodeArgs({ profile, loopbackUrl })
    const inputIdx = args.indexOf('-i')
    expect(inputIdx).toBeGreaterThanOrEqual(0)
    expect(args[inputIdx + 1]).toBe(loopbackUrl)
  })

  it('re-encodes (defeats smart-copy) to libx264 with the profile scale', () => {
    const { args } = buildDerivedTranscodeArgs({ profile, loopbackUrl })

    const vfIdx = args.indexOf('-vf')
    expect(vfIdx).toBeGreaterThanOrEqual(0)
    // Shared builder emits a min-based, aspect-preserving scale on 640x360.
    expect(args[vfIdx + 1]).toBe(
      "scale='min(640,iw)':'min(360,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",
    )

    const cvIdx = args.indexOf('-c:v')
    expect(cvIdx).toBeGreaterThanOrEqual(0)
    expect(args[cvIdx + 1]).toBe('libx264')
    // Video is NOT copied: the derived stream always applies its profile.
    expect(args[cvIdx + 1]).not.toBe('copy')
  })

  it('re-encodes a G.711 source to AAC — the only audio an MPEG-TS derived carries end to end', () => {
    const { args, audio } = buildDerivedTranscodeArgs({
      profile,
      loopbackUrl,
      sourceAudioCodec: 'PCMU',
    })
    expect(args).not.toContain('-an')
    const caIdx = args.indexOf('-c:a')
    expect(caIdx).toBeGreaterThanOrEqual(0)
    // `copy` here is the 618 bug: muxed as private data, never demuxed.
    expect(args[caIdx + 1]).toBe('aac')
    expect(args).toContain('-ac')
    expect(audio.decision).toEqual({ kind: 'recode-aac', sourceCodec: 'pcmu' })
  })

  it('re-encodes to AAC when the source audio codec is UNKNOWN — never a silent copy', () => {
    // The safe direction: an unread/cold source must not decide the derived
    // stream is mute for the rest of its life.
    const { args, audio } = buildDerivedTranscodeArgs({ profile, loopbackUrl })
    const caIdx = args.indexOf('-c:a')
    expect(args[caIdx + 1]).toBe('aac')
    expect(audio.decision).toEqual({ kind: 'recode-aac', sourceCodec: null })
  })

  it('COPIES an AAC source — the one codec that survives both hops untouched', () => {
    const { args, audio } = buildDerivedTranscodeArgs({
      profile,
      loopbackUrl,
      sourceAudioCodec: 'AAC',
    })
    const caIdx = args.indexOf('-c:a')
    expect(args[caIdx + 1]).toBe('copy')
    expect(audio.decision).toEqual({ kind: 'copy', sourceCodec: 'aac' })
  })

  it('honours an explicit operator-chosen audio encode verbatim', () => {
    const opusProfile: EncodeProfile = {
      ...profile,
      audio: { codec: 'opus', bitrateKbps: 64 },
    }
    const { args, audio } = buildDerivedTranscodeArgs({
      profile: opusProfile,
      loopbackUrl,
      sourceAudioCodec: 'PCMU',
    })
    const caIdx = args.indexOf('-c:a')
    expect(args[caIdx + 1]).toBe('libopus')
    expect(audio.decision).toEqual({ kind: 'profile' })
  })

  it("expresses the profile bitrate in the builder's -maxrate/-bufsize form", () => {
    const { args } = buildDerivedTranscodeArgs({ profile, loopbackUrl })
    const maxrateIdx = args.indexOf('-maxrate')
    expect(maxrateIdx).toBeGreaterThanOrEqual(0)
    expect(args[maxrateIdx + 1]).toBe('800k')
    expect(args).toContain('-bufsize')
  })

  it('terminates with the MPEG-TS stdout sink (not the elementary h264 sink)', () => {
    const { args } = buildDerivedTranscodeArgs({ profile, loopbackUrl })
    expect(args.slice(-3)).toEqual(['-f', 'mpegts', 'pipe:1'])
    expect(args).not.toContain('h264')
  })
})

describe('resolveDerivedAudio', () => {
  it('treats an explicit profile `copy` exactly like `passthrough` — the carrier decides', () => {
    // Both mean "carry the source's audio"; neither can make MPEG-TS carry G.711.
    expect(resolveDerivedAudio({ codec: 'copy' }, 'pcma').decision).toEqual({
      kind: 'recode-aac',
      sourceCodec: 'pcma',
    })
    expect(resolveDerivedAudio('passthrough', 'pcma').decision).toEqual({
      kind: 'recode-aac',
      sourceCodec: 'pcma',
    })
  })

  it('never forces a sample rate on the AAC re-encode', () => {
    // An 8 kHz camera mic upsampled to 48 kHz spends bitrate on nothing; the
    // ADTS header carries the true rate to `parseAdtsAudioParams` either way.
    const plan = resolveDerivedAudio('passthrough', 'pcmu')
    expect(plan.audio).toEqual({ codec: 'aac', channels: 1 })
  })
})

const PROFILE_NO_GOP: EncodeProfile = {
  video: {
    codec: 'h264',
    width: 640,
    height: 360,
    fps: 25,
    bitrateKbps: 600,
  },
  audio: 'passthrough',
}

describe('buildDerivedTranscodeArgs — the GOP is never left to the encoder default', () => {
  it('a profile without gopFrames still emits -g at one second of frames', () => {
    // Live failure (2026-08-19, camera dispensa): the mid-to-low derived
    // profile carried no gopFrames, the builder only passes -g when set, and
    // x264 defaulted to keyint=250 — TEN seconds of GOP at 25 fps (measured on
    // a recorded low segment: 1 I-frame in 250). A WebRTC viewer joining
    // mid-GOP decoded P-frames without a reference for up to 10 s: the smear
    // artifacts and the "not fluid" open the operator reported. Every camera
    // whose low profile is a derived stream joins this way — grid tiles too.
    const { args } = buildDerivedTranscodeArgs({
      profile: PROFILE_NO_GOP,
      loopbackUrl: 'rtsp://127.0.0.1:8554/tok',
    })
    const gIdx = args.indexOf('-g')
    expect(gIdx).toBeGreaterThan(-1)
    expect(args[gIdx + 1]).toBe('25')
  })

  it('an explicit gopFrames is honoured verbatim', () => {
    const { args } = buildDerivedTranscodeArgs({
      profile: {
        ...PROFILE_NO_GOP,
        video: { ...PROFILE_NO_GOP.video, gopFrames: 50 },
      },
      loopbackUrl: 'rtsp://127.0.0.1:8554/tok',
    })
    expect(args[args.indexOf('-g') + 1]).toBe('50')
  })

  it('with no fps either, the default assumes the fleet cadence (25)', () => {
    const { video, ...rest } = PROFILE_NO_GOP
    const { args } = buildDerivedTranscodeArgs({
      profile: { ...rest, video: { codec: 'h264', width: 640, height: 360, bitrateKbps: 600 } },
      loopbackUrl: 'rtsp://127.0.0.1:8554/tok',
    })
    expect(args[args.indexOf('-g') + 1]).toBe('25')
  })
})

/**
 * The carrier pins the LATENCY shape too, for the same reason it pins the GOP
 * and the audio codec: nothing downstream of a derived stream can absorb what
 * the encoder chooses to hold back.
 *
 * Measured live on camera 1438 (2026-08-20), reading the camera's own burnt-in
 * OSD out of RECORDED segments and comparing it to the wall clock the recorder
 * named the file with — same camera, so the same OSD clock, four mid-roll
 * samples per tier:
 *
 *   native `high`  (-c:v copy): -1s, -1s, -1s, -2s
 *   derived `low`  (transcode): -3s, -3s, -3s, -3s
 *
 * A ~2 s delta, and it is the encoder's: x264 `preset medium` carries
 * `rc-lookahead=40` (1.6 s at 25 fps) plus `bframes=3` with b-adapt and
 * b-pyramid. The recorder stamps a segment with the wall clock at WRITE time,
 * so every one of those seconds mislabels the footage — seeking a derived tier
 * to an event's timestamp lands ~2 s past it, while the native tier of the
 * same camera lands on it.
 */
describe('buildDerivedTranscodeArgs — the carrier pins the latency shape', () => {
  const loopbackUrl = 'rtsp://127.0.0.1:8554/tok'

  it('emits no B-frames: the MPEG-TS → demux → broker → RTP carrier gains nothing from reordering', () => {
    const { args } = buildDerivedTranscodeArgs({ profile: PROFILE_NO_GOP, loopbackUrl })
    const bfIdx = args.indexOf('-bf')
    expect(bfIdx).toBeGreaterThan(-1)
    expect(args[bfIdx + 1]).toBe('0')
  })

  it('encodes without lookahead — preset veryfast, tune zerolatency', () => {
    const { args } = buildDerivedTranscodeArgs({ profile: PROFILE_NO_GOP, loopbackUrl })
    expect(args[args.indexOf('-preset') + 1]).toBe('veryfast')
    expect(args[args.indexOf('-tune') + 1]).toBe('zerolatency')
  })

  it('an explicit bf / preset / tune is honoured verbatim', () => {
    const { args } = buildDerivedTranscodeArgs({
      profile: {
        ...PROFILE_NO_GOP,
        video: { ...PROFILE_NO_GOP.video, bf: 2, preset: 'medium', tune: 'film' },
      },
      loopbackUrl,
    })
    expect(args[args.indexOf('-bf') + 1]).toBe('2')
    expect(args[args.indexOf('-preset') + 1]).toBe('medium')
    expect(args[args.indexOf('-tune') + 1]).toBe('film')
  })
})

/**
 * A derived tier is RECORDED, and the scrub reads a `low` segment whole only
 * while it is under `SCRUB_WHOLE_SEGMENT_MAX_BYTES` (1.5 MB — D163). An
 * uncapped CRF encode has no relationship to that ceiling at all.
 *
 * Measured on 1438/low the same day: 537–941 kbps for 640x360@25, against
 * 142 kbps for camera 101's NATIVE low at the identical geometry — 4-6x, and
 * it doubled when the GOP went to 25 because a ~68 KB I-frame now lands every
 * second. Peaks reached 1.19 MB in a 10 s segment; the ceiling is 1.5 MB.
 *
 * So the carrier states a CEILING (`-maxrate`, no `-b:v` — quiet scenes still
 * spend less). It is the shared live-egress bit density
 * (`BASE_LIVE_EGRESS_PROFILE`: 2500 kbps at 1280x720@25) scaled to the derived
 * geometry, which is 625 kbps at 640x360@25 → ~780 KB per 10 s segment, half
 * the ceiling.
 */
describe('buildDerivedTranscodeArgs — a recorded derived tier is bounded in bytes', () => {
  const loopbackUrl = 'rtsp://127.0.0.1:8554/tok'

  it('caps an uncapped profile at the shared egress bit density for its geometry', () => {
    const { video, ...rest } = PROFILE_NO_GOP
    const { args } = buildDerivedTranscodeArgs({
      profile: { ...rest, video: { codec: 'h264', width: 640, height: 360, fps: 25 } },
      loopbackUrl,
    })
    // A CEILING, not a target: no -b:v.
    expect(args).not.toContain('-b:v')
    expect(args[args.indexOf('-maxrate') + 1]).toBe('625k')
  })

  it('an explicit bitrateKbps is honoured verbatim', () => {
    const { args } = buildDerivedTranscodeArgs({ profile: PROFILE_NO_GOP, loopbackUrl })
    expect(args[args.indexOf('-maxrate') + 1]).toBe('600k')
  })

  it('leaves the rate uncapped when the profile names no geometry to scale by', () => {
    const { video, ...rest } = PROFILE_NO_GOP
    const { args } = buildDerivedTranscodeArgs({
      profile: { ...rest, video: { codec: 'h264' } },
      loopbackUrl,
    })
    expect(args).not.toContain('-maxrate')
  })
})
