/**
 * The broker's ffmpeg ADAPTER. It no longer contains a builder — the argv comes
 * from the ONE builder in `@camstack/types` (`ffmpeg/invocation.ts`), and this
 * module only translates the broker's vocabulary into it.
 *
 * The assertions below are unchanged from when the builder lived here: they now
 * run through `brokerTranscodeInvocation` → `buildBrokerEgressArgs`, which is
 * the migration proof. The argv-shape rules themselves (`-hwaccel` before `-i`,
 * sinks, audio plans) are owned by `packages/types/src/__tests__/
 * ffmpeg-invocation.spec.ts`.
 */
import { describe, it, expect } from 'vitest'
import type { HardwareEncoders, FfmpegSink, FfmpegAudioSidecar } from '@camstack/types'
import {
  hwAccelSettingToPrefer,
  classifyDecodeHwAccel,
  pickVideoEncoder,
  pickDecodeHwAccel,
  FFMPEG_HW_ACCEL_SETTINGS,
  brokerTranscodeInvocation,
  buildBrokerEgressArgs,
  type FfmpegTranscodeInvocation,
} from '../ffmpeg-invocation.js'

/** What the deleted builder took: the invocation plus where it goes. */
type EgressRequest = FfmpegTranscodeInvocation & {
  readonly sink: FfmpegSink
  readonly audioSidecar?: FfmpegAudioSidecar | null
}

/** Shim preserving the deleted builder's signature over the adapter. */
function buildFfmpegArgs(request: EgressRequest): string[] {
  return buildBrokerEgressArgs(
    brokerTranscodeInvocation(request),
    request.sink,
    request.audioSidecar ?? null,
  )
}

function inv(over: Partial<EgressRequest>): EgressRequest {
  return {
    sourceUrl: 'rtsp://127.0.0.1:8554/main',
    targetCodec: 'H264',
    encoder: 'libx264',
    decodeHwAccel: null,
    scale: null,
    audio: 'aac',
    threadCount: 0,
    outputArgs: [],
    sink: { kind: 'rtsp-listen', url: 'rtsp://127.0.0.1:9001/t-1-abcd' },
    ...over,
  }
}

const HW: HardwareEncoders = {
  encoders: [
    { encoder: 'h264_videotoolbox', codec: 'H264', family: 'videotoolbox', available: true },
    { encoder: 'hevc_videotoolbox', codec: 'H265', family: 'videotoolbox', available: true },
    { encoder: 'libx264', codec: 'H264', family: 'software', available: true },
    { encoder: 'libx265', codec: 'H265', family: 'software', available: true },
  ],
  defaultH264: 'h264_videotoolbox',
  defaultH265: 'hevc_videotoolbox',
  probedAt: 0,
}

describe('hwAccelSettingToPrefer', () => {
  it("'auto' → null (not a specific backend — handled by classify)", () => {
    expect(hwAccelSettingToPrefer('auto')).toBeNull()
  })
  it("'copy' → null (software, not a specific backend)", () => {
    expect(hwAccelSettingToPrefer('copy')).toBeNull()
  })
  it("'none' → 'none' (force software decode)", () => {
    expect(hwAccelSettingToPrefer('none')).toBe('none')
  })
  it('specific backend → that backend', () => {
    expect(hwAccelSettingToPrefer('videotoolbox')).toBe('videotoolbox')
    expect(hwAccelSettingToPrefer('cuda')).toBe('cuda')
  })
})

describe('classifyDecodeHwAccel', () => {
  it("'auto' → { kind: 'auto' } (emit literal -hwaccel auto, never collapse)", () => {
    expect(classifyDecodeHwAccel('auto')).toEqual({ kind: 'auto' })
  })
  it("'copy' → { kind: 'software' } (no -hwaccel)", () => {
    expect(classifyDecodeHwAccel('copy')).toEqual({ kind: 'software' })
  })
  it("'none' → { kind: 'software' } (identical to copy)", () => {
    expect(classifyDecodeHwAccel('none')).toEqual({ kind: 'software' })
  })
  it('specific backend → { kind: specific, prefer }', () => {
    expect(classifyDecodeHwAccel('videotoolbox')).toEqual({
      kind: 'specific',
      prefer: 'videotoolbox',
    })
    expect(classifyDecodeHwAccel('vaapi')).toEqual({ kind: 'specific', prefer: 'vaapi' })
    expect(classifyDecodeHwAccel('qsv')).toEqual({ kind: 'specific', prefer: 'qsv' })
    expect(classifyDecodeHwAccel('cuda')).toEqual({ kind: 'specific', prefer: 'cuda' })
  })
})

describe('FFMPEG_HW_ACCEL_SETTINGS', () => {
  it('includes copy + auto + the backend list for the option surface', () => {
    expect(FFMPEG_HW_ACCEL_SETTINGS).toContain('copy')
    expect(FFMPEG_HW_ACCEL_SETTINGS).toContain('auto')
    expect(FFMPEG_HW_ACCEL_SETTINGS).toContain('none')
    expect(FFMPEG_HW_ACCEL_SETTINGS).toContain('videotoolbox')
  })
})

describe('pickVideoEncoder', () => {
  it('uses the probed default when hw is available', () => {
    expect(pickVideoEncoder('H264', HW, 'auto')).toBe('h264_videotoolbox')
    expect(pickVideoEncoder('H265', HW, 'auto')).toBe('hevc_videotoolbox')
  })
  it("forces software when hwAccel setting is 'none'", () => {
    expect(pickVideoEncoder('H264', HW, 'none')).toBe('libx264')
    expect(pickVideoEncoder('H265', HW, 'none')).toBe('libx265')
  })
  it("forces software when hwAccel setting is 'copy'", () => {
    expect(pickVideoEncoder('H264', HW, 'copy')).toBe('libx264')
    expect(pickVideoEncoder('H265', HW, 'copy')).toBe('libx265')
  })
  it('falls back to software when no probe result', () => {
    expect(pickVideoEncoder('H264', null, 'auto')).toBe('libx264')
    expect(pickVideoEncoder('H265', null, 'auto')).toBe('libx265')
  })
})

describe('buildFfmpegArgs — hw-accel decode', () => {
  it('prepends -hwaccel before -i when a decode backend is set', () => {
    const args = buildFfmpegArgs(inv({ decodeHwAccel: 'videotoolbox' }))
    const hwIdx = args.indexOf('-hwaccel')
    const inIdx = args.indexOf('-i')
    expect(hwIdx).toBeGreaterThan(-1)
    expect(args[hwIdx + 1]).toBe('videotoolbox')
    expect(hwIdx).toBeLessThan(inIdx)
  })
  it('omits -hwaccel when decode backend is null', () => {
    expect(buildFfmpegArgs(inv({ decodeHwAccel: null })).includes('-hwaccel')).toBe(false)
  })
  it("omits -hwaccel when decode backend is 'none'", () => {
    expect(buildFfmpegArgs(inv({ decodeHwAccel: 'none' })).includes('-hwaccel')).toBe(false)
  })
  it("omits -hwaccel when decode backend is 'copy' (software sentinel)", () => {
    expect(buildFfmpegArgs(inv({ decodeHwAccel: 'copy' })).includes('-hwaccel')).toBe(false)
  })
  it("emits literal -hwaccel auto when decode value is 'auto' (no forced-backend collapse)", () => {
    const args = buildFfmpegArgs(inv({ decodeHwAccel: 'auto' }))
    const hwIdx = args.indexOf('-hwaccel')
    const inIdx = args.indexOf('-i')
    expect(hwIdx).toBeGreaterThan(-1)
    expect(args[hwIdx + 1]).toBe('auto')
    expect(hwIdx).toBeLessThan(inIdx)
  })
})

describe('buildFfmpegArgs — encoder + codec', () => {
  it('emits the chosen -c:v encoder', () => {
    const args = buildFfmpegArgs(inv({ encoder: 'h264_videotoolbox' }))
    const idx = args.indexOf('-c:v')
    expect(args[idx + 1]).toBe('h264_videotoolbox')
  })
  it('always sources the input with -rtsp_transport tcp -i', () => {
    const args = buildFfmpegArgs(inv({ sourceUrl: 'rtsp://x/y' }))
    const inIdx = args.indexOf('-i')
    expect(args[inIdx + 1]).toBe('rtsp://x/y')
    expect(args[inIdx - 1]).toBe('tcp')
  })
})

describe('buildFfmpegArgs — scale vs consumer -vf', () => {
  it('emits -vf scale when a scale is set and consumer has no -vf', () => {
    const args = buildFfmpegArgs(inv({ scale: { width: 1280, height: 720 } }))
    expect(args.join(' ')).toContain('-vf scale=1280:720')
  })
  it('consumer -vf in outputArgs wins (no duplicate -vf)', () => {
    const args = buildFfmpegArgs(
      inv({
        scale: { width: 1280, height: 720 },
        outputArgs: ['-vf', 'crop=100:100:0:0'],
      }),
    )
    expect(args.filter((a) => a === '-vf').length).toBe(1)
    expect(args.join(' ')).toContain('crop=100:100:0:0')
    expect(args.join(' ')).not.toContain('scale=1280:720')
  })
  it('no scale → no -vf', () => {
    expect(buildFfmpegArgs(inv({ scale: null })).includes('-vf')).toBe(false)
  })
})

describe('buildFfmpegArgs — threads', () => {
  it('emits -threads N when threadCount > 0', () => {
    const args = buildFfmpegArgs(inv({ threadCount: 4 }))
    const idx = args.indexOf('-threads')
    expect(args[idx + 1]).toBe('4')
  })
  it('omits -threads when threadCount is 0 (auto)', () => {
    expect(buildFfmpegArgs(inv({ threadCount: 0 })).includes('-threads')).toBe(false)
  })
})

describe('buildFfmpegArgs — audio', () => {
  it('aac → aac encoder args', () => {
    expect(buildFfmpegArgs(inv({ audio: 'aac' })).join(' ')).toContain('-c:a aac')
  })
  it('none → -an', () => {
    expect(buildFfmpegArgs(inv({ audio: 'none' })).includes('-an')).toBe(true)
  })
  it('copy → -c:a copy', () => {
    expect(buildFfmpegArgs(inv({ audio: 'copy' })).join(' ')).toContain('-c:a copy')
  })
})

describe('buildFfmpegArgs — outputArgs ordering', () => {
  it('appends consumer outputArgs verbatim before the sink', () => {
    const args = buildFfmpegArgs(inv({ outputArgs: ['-x264-params', 'scenecut=0'] }))
    const joined = args.join(' ')
    const argsIdx = joined.indexOf('-x264-params scenecut=0')
    const sinkIdx = joined.indexOf('-f rtsp')
    expect(argsIdx).toBeGreaterThan(-1)
    expect(sinkIdx).toBeGreaterThan(argsIdx)
  })
})

describe('buildFfmpegArgs — sinks', () => {
  it('rtsp-listen sink → -f rtsp -rtsp_transport tcp -rtsp_flags listen <url>', () => {
    const args = buildFfmpegArgs(
      inv({ sink: { kind: 'rtsp-listen', url: 'rtsp://127.0.0.1:9001/x' } }),
    )
    const joined = args.join(' ')
    expect(joined).toContain('-f rtsp')
    expect(joined).toContain('-rtsp_flags listen')
    expect(args[args.length - 1]).toBe('rtsp://127.0.0.1:9001/x')
  })
  it('stdout sink h264 → -f h264 pipe:1', () => {
    const args = buildFfmpegArgs(inv({ sink: { kind: 'stdout', container: 'h264' } }))
    const joined = args.join(' ')
    expect(joined).toContain('-f h264')
    expect(args[args.length - 1]).toBe('pipe:1')
  })
  it('stdout sink mpegts → -f mpegts pipe:1', () => {
    const args = buildFfmpegArgs(inv({ sink: { kind: 'stdout', container: 'mpegts' } }))
    expect(args.join(' ')).toContain('-f mpegts')
  })
})

describe('buildFfmpegArgs — audio dropped for elementary video sinks', () => {
  it('stdout h264 sink → -an (no audio encoder), even when audio is aac', () => {
    const args = buildFfmpegArgs(inv({ audio: 'aac', sink: { kind: 'stdout', container: 'h264' } }))
    expect(args.includes('-an')).toBe(true)
    expect(args.join(' ')).not.toContain('-c:a aac')
  })
  it('stdout hevc sink → -an', () => {
    const args = buildFfmpegArgs(inv({ audio: 'aac', sink: { kind: 'stdout', container: 'hevc' } }))
    expect(args.includes('-an')).toBe(true)
  })
  it('stdout mpegts sink CAN carry audio → keeps the audio encoder', () => {
    const args = buildFfmpegArgs(
      inv({ audio: 'aac', sink: { kind: 'stdout', container: 'mpegts' } }),
    )
    expect(args.join(' ')).toContain('-c:a aac')
  })
  it('rtsp-listen sink keeps audio', () => {
    const args = buildFfmpegArgs(
      inv({ audio: 'aac', sink: { kind: 'rtsp-listen', url: 'rtsp://127.0.0.1:9001/x' } }),
    )
    expect(args.join(' ')).toContain('-c:a aac')
  })
})

describe('audioSidecar', () => {
  const sidecar = {
    codec: 'aac' as const,
    rtpUrl: 'rtp://127.0.0.1:41000',
    sdpFile: '/tmp/egress-1.sdp',
  }

  it('appends a second RTP audio output after the video sink', () => {
    const args = buildFfmpegArgs(
      inv({
        sink: { kind: 'stdout', container: 'h264' },
        audioSidecar: sidecar,
      }),
    )
    const joined = args.join(' ')
    // elementary video sink keeps -an; audio rides the sidecar
    expect(joined).toContain('-an')
    expect(joined).toContain('-f h264 pipe:1')
    // sidecar output comes AFTER the video sink
    expect(args.lastIndexOf('pipe:1')).toBeLessThan(args.indexOf('0:a:0?'))
    expect(joined).toContain('-map 0:a:0?')
    expect(joined).toContain('-c:a aac')
    // `-sdp_file` is a global option and now precedes `-f rtp`, which sits
    // immediately before the output url. Same ffmpeg semantics.
    expect(joined).toContain('-sdp_file /tmp/egress-1.sdp -f rtp rtp://127.0.0.1:41000')
  })

  it('is absent when no sidecar is set (default video-only egress unchanged)', () => {
    const args = buildFfmpegArgs(inv({ sink: { kind: 'stdout', container: 'h264' } }))
    expect(args.join(' ')).not.toContain('-f rtp')
    expect(args).not.toContain('0:a:0?')
  })

  it('uses the sidecar codec args (pcmu)', () => {
    const args = buildFfmpegArgs(
      inv({
        sink: { kind: 'stdout', container: 'hevc' },
        audioSidecar: { ...sidecar, codec: 'pcmu' },
      }),
    )
    expect(args.join(' ')).toContain('-c:a pcm_mulaw')
  })
})

describe('pickDecodeHwAccel', () => {
  it('returns null when nothing is preferred', () => {
    expect(pickDecodeHwAccel([], ['videotoolbox'])).toBeNull()
  })

  it('keeps the top preference when the build reports no methods (probe miss → software fallback covers it)', () => {
    expect(pickDecodeHwAccel(['videotoolbox'], [])).toBe('videotoolbox')
  })

  it('keeps a preference the configured ffmpeg supports', () => {
    expect(pickDecodeHwAccel(['videotoolbox'], ['videotoolbox'])).toBe('videotoolbox')
  })

  it('matches case-insensitively', () => {
    expect(pickDecodeHwAccel(['VideoToolbox'], ['videotoolbox'])).toBe('VideoToolbox')
  })

  it('falls through to the next supported preference', () => {
    expect(pickDecodeHwAccel(['cuda', 'vaapi'], ['vaapi', 'qsv'])).toBe('vaapi')
  })

  it('returns null (software decode) when the build supports none of the preferred backends', () => {
    expect(pickDecodeHwAccel(['cuda'], ['vaapi', 'qsv'])).toBeNull()
  })
})
