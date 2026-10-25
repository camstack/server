/**
 * The ONE ffmpeg argv builder — argument POSITION and shape.
 *
 * The position assertions are not decoration. `-hwaccel` is an INPUT option:
 * ffmpeg accepts it AFTER `-i` without error and silently decodes in software,
 * so the CPU cost stays and every log line still claims hardware. That failure
 * is invisible to a "does the flag appear" test, which is why every case here
 * asserts an INDEX relative to `-i`, never mere membership.
 */
import { describe, it, expect } from 'vitest'
import {
  buildFfmpegArgs,
  invocationFromEncodeProfile,
  type FfmpegInvocation,
} from '../ffmpeg/invocation.js'
import type { EncodeProfile } from '../encode-profile.js'

function baseInvocation(over: Partial<FfmpegInvocation> = {}): FfmpegInvocation {
  return {
    logLevel: 'warning',
    decodeHwAccel: null,
    input: { url: 'rtsp://cam/live', rtspTransport: 'tcp' },
    video: { kind: 'copy' },
    audio: { kind: 'none' },
    threadCount: 0,
    outputArgs: [],
    sink: { kind: 'stdout', container: 'h264' },
    ...over,
  }
}

/** Index of `-i` — every input option must sort BEFORE this. */
function inputIndex(args: readonly string[]): number {
  const i = args.indexOf('-i')
  expect(i).toBeGreaterThan(-1)
  return i
}

describe('buildFfmpegArgs — the input PROBE is bounded', () => {
  it('emits -analyzeduration and -probesize BEFORE -i', () => {
    // Both are input options. After `-i` ffmpeg accepts them and ignores them,
    // so the stall stays and the argv still looks correct — the same trap as
    // `-hwaccel`. Assert the INDEX, never membership.
    const args = buildFfmpegArgs(
      baseInvocation({
        input: { url: 'rtsp://x/y', analyzeDurationUs: 0, probeSizeBytes: 32 },
      }),
    )
    const a = args.indexOf('-analyzeduration')
    const p = args.indexOf('-probesize')
    expect(args[a + 1]).toBe('0')
    expect(args[p + 1]).toBe('32')
    expect(a).toBeLessThan(inputIndex(args))
    expect(p).toBeLessThan(inputIndex(args))
  })

  it('emits NEITHER when the caller does not ask — ffmpeg keeps its defaults', () => {
    // An input that genuinely needs discovery must not silently lose it.
    const args = buildFfmpegArgs(baseInvocation({ input: { url: 'rtsp://x/y' } }))
    expect(args).not.toContain('-analyzeduration')
    expect(args).not.toContain('-probesize')
  })

  it('accepts zero as a REAL value, not as absent', () => {
    // `analyzeDurationUs: 0` is the whole point — a falsy check would drop it
    // and reinstate the five-second default while the plan says otherwise.
    const args = buildFfmpegArgs(
      baseInvocation({
        input: { url: 'rtsp://x/y', analyzeDurationUs: 0, probeSizeBytes: 0 },
      }),
    )
    expect(args).toContain('-analyzeduration')
    expect(args).toContain('-probesize')
  })
})

describe('buildFfmpegArgs — hwaccel is an INPUT option', () => {
  it('emits -hwaccel BEFORE -i', () => {
    const args = buildFfmpegArgs(baseInvocation({ decodeHwAccel: 'vaapi' }))
    const hw = args.indexOf('-hwaccel')
    expect(hw).toBeGreaterThan(-1)
    expect(args[hw + 1]).toBe('vaapi')
    expect(hw).toBeLessThan(inputIndex(args))
  })

  it('emits -hwaccel before caller-supplied input extraArgs, still before -i', () => {
    const args = buildFfmpegArgs(
      baseInvocation({
        decodeHwAccel: 'vaapi',
        input: {
          url: 'rtsp://cam/live',
          rtspTransport: 'tcp',
          fflags: ['+discardcorrupt'],
          extraArgs: ['-probesize', '1M'],
        },
      }),
    )
    const hw = args.indexOf('-hwaccel')
    const probe = args.indexOf('-probesize')
    const fflags = args.indexOf('-fflags')
    const i = inputIndex(args)
    expect(hw).toBeLessThan(probe)
    expect(probe).toBeLessThan(i)
    expect(fflags).toBeLessThan(i)
  })

  it('never emits -hwaccel for a software decode (null / none / copy)', () => {
    for (const value of [null, 'none', 'copy']) {
      expect(buildFfmpegArgs(baseInvocation({ decodeHwAccel: value })).includes('-hwaccel')).toBe(
        false,
      )
    }
  })

  it("passes the literal 'auto' through (ffmpeg self-selects + software-fallbacks)", () => {
    const args = buildFfmpegArgs(baseInvocation({ decodeHwAccel: 'auto' }))
    expect(args[args.indexOf('-hwaccel') + 1]).toBe('auto')
  })

  it('emits -rtsp_transport before -i, and omits it when the transport is null', () => {
    const withT = buildFfmpegArgs(baseInvocation())
    expect(withT.indexOf('-rtsp_transport')).toBeLessThan(inputIndex(withT))
    const withoutT = buildFfmpegArgs(
      baseInvocation({ input: { url: 'pipe:0', rtspTransport: null } }),
    )
    expect(withoutT.includes('-rtsp_transport')).toBe(false)
  })
})

describe('buildFfmpegArgs — every OUTPUT option lands after -i', () => {
  it('places the video encode block, threads, audio, outputArgs and sink after -i', () => {
    const args = buildFfmpegArgs(
      baseInvocation({
        decodeHwAccel: 'vaapi',
        video: {
          kind: 'encode',
          encoder: 'libx264',
          scale: { mode: 'fit', width: 1280, height: 720 },
          preset: 'veryfast',
          level: '3.1',
        },
        audio: { kind: 'encode', codec: 'opus', bitrateKbps: 64 },
        sink: { kind: 'stdout', container: 'mpegts' },
        threadCount: 4,
        outputArgs: ['-x264-params', 'scenecut=0'],
      }),
    )
    const i = inputIndex(args)
    for (const flag of ['-c:v', '-vf', '-preset', '-level', '-threads', '-c:a', '-x264-params']) {
      expect(args.indexOf(flag), `${flag} must follow -i`).toBeGreaterThan(i)
    }
    // Terminal: the sink is last.
    expect(args.slice(-3)).toEqual(['-f', 'mpegts', 'pipe:1'])
  })

  it('keeps consumer outputArgs after the encode block and before the sink', () => {
    const args = buildFfmpegArgs(baseInvocation({ outputArgs: ['-movflags', '+faststart'] }))
    expect(args.indexOf('-movflags')).toBeGreaterThan(args.indexOf('-c:v'))
    expect(args.indexOf('-movflags')).toBeLessThan(args.indexOf('-f'))
  })
})

describe('buildFfmpegArgs — video plan', () => {
  it('copy emits -c:v copy and no encoder knobs', () => {
    const args = buildFfmpegArgs(baseInvocation({ video: { kind: 'copy' } }))
    expect(args.join(' ')).toContain('-c:v copy')
    expect(args.includes('-preset')).toBe(false)
    expect(args.includes('-vf')).toBe(false)
  })

  it('copy can still carry a bitstream filter (HAP needs -bsf:v dump_extra on both branches)', () => {
    const args = buildFfmpegArgs(
      baseInvocation({
        video: { kind: 'copy', bitstreamFilter: 'dump_extra' },
      }),
    )
    expect(args.join(' ')).toContain('-c:v copy -bsf:v dump_extra')
  })

  it("scale mode 'fit' never upscales and forces even dimensions", () => {
    const args = buildFfmpegArgs(
      baseInvocation({
        video: {
          kind: 'encode',
          encoder: 'libx264',
          scale: { mode: 'fit', width: 1280, height: 720 },
        },
      }),
    )
    expect(args[args.indexOf('-vf') + 1]).toBe(
      "scale='min(1280,iw)':'min(720,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",
    )
  })

  it("scale mode 'exact' emits a plain scale filter", () => {
    const args = buildFfmpegArgs(
      baseInvocation({
        video: {
          kind: 'encode',
          encoder: 'libx264',
          scale: { mode: 'exact', width: 640, height: 360 },
        },
      }),
    )
    expect(args[args.indexOf('-vf') + 1]).toBe('scale=640:360')
  })

  it('a consumer -vf in outputArgs suppresses the builder scale (never two -vf)', () => {
    const args = buildFfmpegArgs(
      baseInvocation({
        video: {
          kind: 'encode',
          encoder: 'libx264',
          scale: { mode: 'exact', width: 640, height: 360 },
        },
        outputArgs: ['-vf', 'crop=100:100:0:0'],
      }),
    )
    expect(args.filter((a) => a === '-vf')).toHaveLength(1)
    expect(args[args.indexOf('-vf') + 1]).toBe('crop=100:100:0:0')
  })

  it('emits the rate-control triple with the requested VBV window', () => {
    const oneSecond = buildFfmpegArgs(
      baseInvocation({
        video: {
          kind: 'encode',
          encoder: 'libx264',
          bitrateKbps: 800,
          rateControl: { kind: 'cbr', vbvSeconds: 1 },
        },
      }),
    ).join(' ')
    expect(oneSecond).toContain('-b:v 800k -maxrate 800k -bufsize 800k')

    const twoSecond = buildFfmpegArgs(
      baseInvocation({
        video: {
          kind: 'encode',
          encoder: 'libx264',
          bitrateKbps: 800,
          rateControl: { kind: 'cap', vbvSeconds: 2 },
        },
      }),
    ).join(' ')
    // A CAP never sets a target bitrate — it only bounds the peak.
    expect(twoSecond).toContain('-maxrate 800k -bufsize 1600k')
    expect(twoSecond).not.toContain('-b:v')
  })

  it('emits -level and -pix_fmt when asked (a stream must match its own advertisement)', () => {
    const args = buildFfmpegArgs(
      baseInvocation({
        video: {
          kind: 'encode',
          encoder: 'libx264',
          profile: 'baseline',
          level: '3.1',
          pixelFormat: 'yuv420p',
        },
      }),
    ).join(' ')
    expect(args).toContain('-profile:v baseline')
    expect(args).toContain('-level 3.1')
    expect(args).toContain('-pix_fmt yuv420p')
  })
})

describe('buildFfmpegArgs — audio plan', () => {
  it("'none' emits -an and no encoder", () => {
    const args = buildFfmpegArgs(baseInvocation({ audio: { kind: 'none' } }))
    expect(args.includes('-an')).toBe(true)
    expect(args.includes('-c:a')).toBe(false)
  })

  it("'copy' emits -c:a copy", () => {
    expect(
      buildFfmpegArgs(
        baseInvocation({
          audio: { kind: 'copy' },
          sink: { kind: 'stdout', container: 'mpegts' },
        }),
      ).join(' '),
    ).toContain('-c:a copy')
  })

  it('maps every audio codec to its ffmpeg encoder', () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ['opus', 'libopus'],
      ['aac', 'aac'],
      ['pcmu', 'pcm_mulaw'],
      ['pcma', 'pcm_alaw'],
    ]
    for (const [codec, encoder] of cases) {
      const args = buildFfmpegArgs(
        baseInvocation({
          audio: { kind: 'encode', codec: codec as 'opus' },
          sink: { kind: 'stdout', container: 'mpegts' },
        }),
      )
      expect(args[args.indexOf('-c:a') + 1]).toBe(encoder)
    }
  })

  it('carries the low-latency Opus knobs HAP needs', () => {
    const args = buildFfmpegArgs(
      baseInvocation({
        audio: {
          kind: 'encode',
          codec: 'opus',
          bitrateKbps: 24,
          sampleRateHz: 16000,
          channels: 1,
          application: 'lowdelay',
          frameDurationMs: 20,
          vbvBufferKbits: 96,
          globalHeader: true,
          filter: 'aresample=async=1000:first_pts=0',
        },
        sink: { kind: 'stdout', container: 'mpegts' },
      }),
    ).join(' ')
    expect(args).toContain('-c:a libopus')
    expect(args).toContain('-application lowdelay')
    expect(args).toContain('-frame_duration 20')
    expect(args).toContain('-flags +global_header')
    expect(args).toContain('-ar 16000')
    expect(args).toContain('-b:a 24k')
    expect(args).toContain('-bufsize 96k')
    expect(args).toContain('-ac 1')
    expect(args).toContain('-af aresample=async=1000:first_pts=0')
  })

  it('an elementary video sink cannot mux audio — forces -an', () => {
    for (const container of ['h264', 'hevc'] as const) {
      const args = buildFfmpegArgs(
        baseInvocation({
          audio: { kind: 'encode', codec: 'aac' },
          sink: { kind: 'stdout', container },
        }),
      )
      expect(args.includes('-an')).toBe(true)
      expect(args.includes('-c:a')).toBe(false)
    }
  })

  it('an mpegts sink DOES carry audio', () => {
    const args = buildFfmpegArgs(
      baseInvocation({
        audio: { kind: 'copy' },
        sink: { kind: 'stdout', container: 'mpegts' },
      }),
    )
    expect(args.join(' ')).toContain('-c:a copy')
    expect(args.slice(-3)).toEqual(['-f', 'mpegts', 'pipe:1'])
  })
})

describe('buildFfmpegArgs — the key-frame grid an fMP4 fragment length rides on', () => {
  it('emits -force_key_frames on an expression grid, AFTER -i', () => {
    // It is an ENCODER option. Before `-i` ffmpeg reads it as an input option
    // and it applies to nothing — the same class of silent no-op as `-hwaccel`
    // after `-i`, and equally invisible to a membership assertion.
    const args = buildFfmpegArgs(
      baseInvocation({
        video: { kind: 'encode', encoder: 'libx264', forceKeyFramesSeconds: 4 },
      }),
    )
    const f = args.indexOf('-force_key_frames')
    expect(args[f + 1]).toBe('expr:gte(t,n_forced*4)')
    expect(f).toBeGreaterThan(inputIndex(args))
  })

  it('omits it when the caller does not ask', () => {
    const args = buildFfmpegArgs(baseInvocation({ video: { kind: 'encode', encoder: 'libx264' } }))
    expect(args).not.toContain('-force_key_frames')
  })

  it('a COPY plan cannot carry one at all — there is no encoder to instruct', () => {
    // Structural, not a runtime check: `forceKeyFramesSeconds` lives only on
    // the encode plan. ffmpeg ACCEPTS the flag alongside `-c:v copy`, warns,
    // and ignores it, so a caller that believed it had 4 s fragments would get
    // whatever the source's GOP happens to be with nothing in the argv to say so.
    const args = buildFfmpegArgs(baseInvocation({ video: { kind: 'copy' } }))
    expect(args).not.toContain('-force_key_frames')
  })
})

describe('buildFfmpegArgs — sinks', () => {
  it('rtsp-listen terminates with the url', () => {
    const args = buildFfmpegArgs(
      baseInvocation({
        sink: { kind: 'rtsp-listen', url: 'rtsp://127.0.0.1:8554/x' },
      }),
    )
    expect(args.slice(-7)).toEqual([
      '-f',
      'rtsp',
      '-rtsp_transport',
      'tcp',
      '-rtsp_flags',
      'listen',
      'rtsp://127.0.0.1:8554/x',
    ])
  })

  it('rtp-outputs writes two independent mapped outputs (video then audio)', () => {
    const args = buildFfmpegArgs(
      baseInvocation({
        video: { kind: 'copy' },
        audio: { kind: 'encode', codec: 'opus', bitrateKbps: 24 },
        sink: {
          kind: 'rtp-outputs',
          video: {
            url: 'rtp://127.0.0.1:5000?pkt_size=1316',
            payloadType: 99,
            ssrc: 12345,
          },
          audio: {
            url: 'rtp://127.0.0.1:5002?pkt_size=188',
            payloadType: 110,
            ssrc: 67890,
          },
        },
      }),
    )
    const joined = args.join(' ')
    expect(joined).toContain('-map 0:v:0')
    expect(joined).toContain('-payload_type 99')
    expect(joined).toContain('-ssrc 12345')
    expect(joined).toContain('rtp://127.0.0.1:5000?pkt_size=1316')
    expect(joined).toContain('-map 0:a:0?')
    expect(joined).toContain('-payload_type 110')
    expect(args[args.length - 1]).toBe('rtp://127.0.0.1:5002?pkt_size=188')
    // The video output is mute and the audio output carries no video.
    expect(joined).toContain('-an -map 0:v:0')
    expect(joined).toContain('-vn -map 0:a:0?')
  })

  it('rtp-outputs with no audio leg emits only the video output', () => {
    const args = buildFfmpegArgs(
      baseInvocation({
        sink: {
          kind: 'rtp-outputs',
          video: { url: 'rtp://127.0.0.1:5000', payloadType: 99, ssrc: 1 },
          audio: null,
        },
      }),
    )
    expect(args.includes('-vn')).toBe(false)
    expect(args[args.length - 1]).toBe('rtp://127.0.0.1:5000')
  })

  it('the fMP4 sink emits the fragmenting movflags, and every one of them', () => {
    // All three flags are load-bearing and each one's absence is a different
    // silent breakage: without `frag_keyframe` there are no fragments at all,
    // without `empty_moov` the muxer wants to seek back and rewrite `moov`
    // (impossible on a pipe), without `default_base_moof` a fragment cannot be
    // demuxed apart from the bytes before it.
    const args = buildFfmpegArgs(
      baseInvocation({
        sink: { kind: 'stdout', container: 'mp4', fragmentMs: 4000 },
      }),
    )
    const flags = args[args.indexOf('-movflags') + 1] ?? ''
    for (const flag of ['frag_keyframe', 'empty_moov', 'default_base_moof']) {
      expect(flags, flags).toContain(flag)
    }
    expect(args.slice(-3)).toEqual(['-f', 'mp4', 'pipe:1'])
  })

  it('carries the negotiated fragment length as -min_frag_duration, in MICROseconds', () => {
    // HKSV negotiates a fragment length in milliseconds; the muxer's unit is
    // microseconds. A 1000× error here reads as "the fragments are the wrong
    // length", which is indistinguishable from a source-GOP problem.
    const args = buildFfmpegArgs(
      baseInvocation({
        sink: { kind: 'stdout', container: 'mp4', fragmentMs: 4000 },
      }),
    )
    // 90 % of 4000 ms — see the next test for why it is not 4000000.
    expect(args[args.indexOf('-min_frag_duration') + 1]).toBe('3600000')
  })

  it('holds -min_frag_duration BELOW the requested length — equal DOUBLES every fragment', () => {
    // Measured on the live fleet (D84): camera 101, `-c:v copy`, key-frame grid
    // 4.0 s on both the 720p and the 4K slot. `-min_frag_duration 4000000`
    // produced a median gap of 7944 / 8042 ms; 3600000 produced 3973 / 3998 ms.
    // The deadline lands on the same instant as the key frame, loses, and skips
    // to the next one. A doubled fragment violates HKSV's "no longer than the
    // SELECTED fragment length", so this margin is the contract, not a tweak.
    for (const fragmentMs of [2000, 4000, 6000]) {
      const args = buildFfmpegArgs(
        baseInvocation({ sink: { kind: 'stdout', container: 'mp4', fragmentMs } }),
      )
      const emitted = Number(args[args.indexOf('-min_frag_duration') + 1])
      expect(emitted).toBeLessThan(fragmentMs * 1000)
      // …and not so far below that an early key frame cuts a short fragment.
      expect(emitted).toBeGreaterThanOrEqual(fragmentMs * 1000 * 0.85)
    }
  })

  it('never emits -frag_duration — a wall-clock cut would open a fragment on a delta frame', () => {
    // `-frag_duration` cuts whether or not a key frame has arrived. HKSV
    // requires every fragment to start on a sync sample, so the pair is
    // `frag_keyframe` + `-min_frag_duration` (which can only DELAY a cut).
    const args = buildFfmpegArgs(
      baseInvocation({
        sink: { kind: 'stdout', container: 'mp4', fragmentMs: 4000 },
      }),
    )
    expect(args).not.toContain('-frag_duration')
  })

  it('an fMP4 sink DOES carry audio — HKSV takes AAC in-band, not on a sidecar', () => {
    // The elementary sinks force `-an` because they cannot mux audio. mp4 can,
    // and it must: HKSV accepts AAC-LC / AAC-ELD in the fragment itself and has
    // no second RTP plane to graft one onto.
    const args = buildFfmpegArgs(
      baseInvocation({
        audio: {
          kind: 'encode',
          codec: 'aac',
          bitrateKbps: 32,
          sampleRateHz: 32000,
          channels: 1,
        },
        sink: { kind: 'stdout', container: 'mp4', fragmentMs: 4000 },
      }),
    ).join(' ')
    expect(args).toContain('-c:a aac')
    expect(args).toContain('-ar 32000')
    expect(args).not.toContain('-an')
  })

  it('an rtp audio sidecar writes its own SDP file', () => {
    const args = buildFfmpegArgs(
      baseInvocation({
        sink: { kind: 'stdout', container: 'h264' },
        audioSidecar: {
          codec: 'aac',
          rtpUrl: 'rtp://127.0.0.1:41000',
          sdpFile: '/tmp/x.sdp',
        },
      }),
    ).join(' ')
    expect(args).toContain('-map 0:a:0?')
    expect(args).toContain('-sdp_file /tmp/x.sdp')
    expect(args).toContain('-f rtp rtp://127.0.0.1:41000')
  })
})

describe('invocationFromEncodeProfile — the EncodeProfile adapter', () => {
  const profile: EncodeProfile = {
    video: {
      codec: 'h264',
      profile: 'baseline',
      width: 1280,
      height: 720,
      fps: 25,
      bitrateKbps: 2500,
      gopFrames: 25,
      bf: 0,
      preset: 'veryfast',
      tune: 'zerolatency',
    },
    audio: { codec: 'opus', bitrateKbps: 64, sampleRateHz: 48000, channels: 1 },
  }

  it('re-encodes when the source codec differs from the target', () => {
    const inv = invocationFromEncodeProfile({
      profile,
      sourceCodec: 'h265',
      sourceUrl: 'rtsp://x/y',
      sink: { kind: 'stdout', container: 'h264' },
      decodeHwAccel: 'vaapi',
    })
    expect(inv.video.kind).toBe('encode')
    const args = buildFfmpegArgs(inv)
    expect(args.join(' ')).toContain('-c:v libx264')
    expect(args.indexOf('-hwaccel')).toBeLessThan(inputIndex(args))
  })

  /**
   * `-tune zerolatency` turns on x264's sliced threads: a frame leaves the
   * encoder as five NAL slices sharing one RTP timestamp with one marker bit,
   * and a libwebrtc depacketiser sees five frame-starts per frame-end. The
   * Echo rendered the first pictures and then froze for good while the audio,
   * on its own plane, played on — measured on this hub 2026-09-13.
   */
  it('asks x264 for ONE slice per access unit when the consumer said so', () => {
    const inv = invocationFromEncodeProfile({
      profile: { ...profile, video: { ...profile.video, singleSlicePerFrame: true } },
      sourceCodec: 'h265',
      sourceUrl: 'rtsp://x/y',
      sink: { kind: 'stdout', container: 'h264' },
      decodeHwAccel: null,
    })
    const args = buildFfmpegArgs(inv)
    const at = args.indexOf('-x264-params')
    expect(at).toBeGreaterThan(inputIndex(args))
    expect(args[at + 1]).toBe('sliced-threads=0')
  })

  it('says nothing about slices when the consumer did not ask', () => {
    const inv = invocationFromEncodeProfile({
      profile,
      sourceCodec: 'h265',
      sourceUrl: 'rtsp://x/y',
      sink: { kind: 'stdout', container: 'h264' },
      decodeHwAccel: null,
    })
    expect(buildFfmpegArgs(inv)).not.toContain('-x264-params')
  })

  it('never hands the flag to a HARDWARE encoder, which would reject it', () => {
    const inv = invocationFromEncodeProfile({
      profile: { ...profile, video: { ...profile.video, singleSlicePerFrame: true } },
      sourceCodec: 'h265',
      sourceUrl: 'rtsp://x/y',
      sink: { kind: 'stdout', container: 'h264' },
      decodeHwAccel: null,
      hardwareEncoders: true,
    })
    const args = buildFfmpegArgs(inv)
    if (inv.video.kind === 'encode' && inv.video.encoder !== 'libx264') {
      expect(args).not.toContain('-x264-params')
    }
  })

  it('smart-copies when the source already speaks the target codec', () => {
    const inv = invocationFromEncodeProfile({
      profile,
      sourceCodec: 'h264',
      sourceUrl: 'rtsp://x/y',
      sink: { kind: 'stdout', container: 'h264' },
      decodeHwAccel: null,
    })
    expect(inv.video.kind).toBe('copy')
  })

  it('forceReencode defeats smart-copy (a derived stream must apply its profile)', () => {
    const inv = invocationFromEncodeProfile({
      profile,
      sourceCodec: 'h264',
      sourceUrl: 'rtsp://x/y',
      sink: { kind: 'stdout', container: 'mpegts' },
      decodeHwAccel: null,
      forceReencode: true,
    })
    expect(inv.video.kind).toBe('encode')
  })

  it("maps audio 'passthrough' to -an", () => {
    const inv = invocationFromEncodeProfile({
      profile: { ...profile, audio: 'passthrough' },
      sourceCodec: 'h265',
      sourceUrl: 'rtsp://x/y',
      sink: { kind: 'stdout', container: 'h264' },
      decodeHwAccel: null,
    })
    expect(inv.audio).toEqual({ kind: 'none' })
  })

  it('carries the profile inputArgs/outputArgs through, inputArgs before -i', () => {
    const args = buildFfmpegArgs(
      invocationFromEncodeProfile({
        profile: {
          ...profile,
          inputArgs: ['-probesize', '2M'],
          outputArgs: ['-aq-mode', '3'],
        },
        sourceCodec: 'h265',
        sourceUrl: 'rtsp://x/y',
        sink: { kind: 'stdout', container: 'h264' },
        decodeHwAccel: 'vaapi',
      }),
    )
    const i = inputIndex(args)
    expect(args.indexOf('-probesize')).toBeLessThan(i)
    expect(args.indexOf('-aq-mode')).toBeGreaterThan(i)
  })

  it('picks the hardware encoder when one is supplied for the backend', () => {
    const inv = invocationFromEncodeProfile({
      profile,
      sourceCodec: 'h265',
      sourceUrl: 'rtsp://x/y',
      sink: { kind: 'stdout', container: 'h264' },
      decodeHwAccel: 'vaapi',
      hardwareEncoders: true,
    })
    expect(inv.video.kind === 'encode' && inv.video.encoder).toBe('h264_vaapi')
  })
})
