/**
 * `parseFfmpegStreamInfo` — the stream probe's reading of the pinned ffmpeg's
 * input report, which replaced an `ffprobe` spawned by name off PATH (D540).
 */
import { describe, expect, it } from 'vitest'
import {
  buildStreamProbeArgs,
  parseFfmpegStreamInfo,
  probeFoundAStream,
} from './ffmpeg-stream-info'

/**
 * VERBATIM: `ffmpeg -hide_banner -nostdin -i sample.m4s` on the recorded-segment
 * fixture (`addon-pipeline/.../recorded/__tests__/fixtures/sample.m4s`),
 * 2026-09-29 — a real camera's HEVC + AAC fragment.
 */
const RECORDED_FRAGMENT = `Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'sample.m4s':
  Metadata:
    major_brand     : iso5
    minor_version   : 512
    compatible_brands: iso5iso6mp41
    title           : Media Presentation
    encoder         : Lavf61.7.100
  Duration: 00:00:04.01, start: 0.000000, bitrate: 176 kb/s
  Stream #0:0[0x1](und): Video: hevc (Main) (hev1 / 0x31766568), yuvj420p(pc), 1280x720 [SAR 1:1 DAR 16:9], 139 kb/s, 9.97 fps, 25 tbr, 90k tbn (default)
      Metadata:
        handler_name    : VideoHandler
        vendor_id       : [0][0][0][0]
  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 8000 Hz, mono, fltp, 32 kb/s (default)
      Metadata:
        handler_name    : SoundHandler
        vendor_id       : [0][0][0][0]
At least one output file must be specified`

/** The RTSP shape: no per-stream bitrate, an `fps`, µ-law audio. */
const RTSP_H264_PCMU = `Input #0, rtsp, from 'rtsp://***@192.0.2.10:554/h264Preview_01_main':
  Metadata:
    title           : Session streamed by "preview"
  Duration: N/A, start: 0.000000, bitrate: N/A
  Stream #0:0: Video: h264 (High), yuvj420p(pc, bt709, progressive), 2560x1440, 20 fps, 20 tbr, 90k tbn
  Stream #0:1: Audio: pcm_mulaw, 8000 Hz, mono, s16, 64 kb/s
At least one output file must be specified`

describe('parseFfmpegStreamInfo', () => {
  it('reads codec, size, rate and bitrate off a real recorded fragment', () => {
    expect(parseFfmpegStreamInfo(RECORDED_FRAGMENT)).toEqual({
      codec: 'h265',
      width: 1280,
      height: 720,
      fps: 9.97,
      bitrateKbps: 139,
      audio: { codec: 'aac', profile: 'LC', sampleRate: 8000, channels: 1, bitrateKbps: 32 },
    })
  })

  it('reads an RTSP camera: no video bitrate, µ-law audio with no profile', () => {
    expect(parseFfmpegStreamInfo(RTSP_H264_PCMU)).toEqual({
      codec: 'h264',
      width: 2560,
      height: 1440,
      fps: 20,
      audio: { codec: 'pcm_mulaw', sampleRate: 8000, channels: 1, bitrateKbps: 64 },
    })
  })

  it('keeps the FIRST video and FIRST audio stream', () => {
    const two = `${RTSP_H264_PCMU}\n  Stream #0:2: Video: mjpeg (Baseline), yuvj420p(pc), 640x360, 5 fps, 5 tbr, 90k tbn`
    expect(parseFfmpegStreamInfo(two).codec).toBe('h264')
  })

  it('answers nothing — never a throw — for a report with no streams', () => {
    const refused = `[rtsp @ 0x1] method DESCRIBE failed: 401 Unauthorized
rtsp://***@192.0.2.10:554/x: Server returned 401 Unauthorized (authorization failed)`
    expect(parseFfmpegStreamInfo(refused)).toEqual({})
    expect(parseFfmpegStreamInfo('')).toEqual({})
  })
})

describe('parseFfmpegStreamInfo — line endings and multipliers', () => {
  it('reads a CRLF report exactly like an LF one', () => {
    expect(parseFfmpegStreamInfo(RECORDED_FRAGMENT.replace(/\n/g, '\r\n'))).toEqual(
      parseFfmpegStreamInfo(RECORDED_FRAGMENT),
    )
  })

  it('keeps the `k` of a `tbr` — 90k is 90 000, not 90', () => {
    const noFps = '  Stream #0:0: Video: h264 (High), yuv420p, 640x360, 90k tbr, 90k tbn\n'
    expect(parseFfmpegStreamInfo(noFps).fps).toBe(90_000)
  })
})

describe('buildStreamProbeArgs — each scheme gets only the options it consumes', () => {
  // The ffmpeg CLI refuses an unconsumed input option (exit 8), where ffprobe
  // ignored it: one argv for every URL failed every non-RTSP probe.
  it('rtsp: tcp transport and the socket timeout', () => {
    expect(buildStreamProbeArgs('rtsp://cam/main')).toEqual([
      '-hide_banner',
      '-nostdin',
      '-rtsp_transport',
      'tcp',
      '-timeout',
      '5000000',
      '-i',
      'rtsp://cam/main',
    ])
  })

  it('rtsps: the same as rtsp', () => {
    expect(buildStreamProbeArgs('RTSPS://cam/main')).toContain('-rtsp_transport')
  })

  it('http and https: the timeout only — never `-rtsp_transport`', () => {
    for (const url of ['http://cam/flv', 'https://cam/live.m3u8']) {
      expect(buildStreamProbeArgs(url)).toEqual([
        '-hide_banner',
        '-nostdin',
        '-timeout',
        '5000000',
        '-i',
        url,
      ])
    }
  })

  it('anything else (rtmp, a file): neither — on rtmp `-timeout` would mean LISTEN', () => {
    for (const url of ['rtmp://cam/live', '/data/sample.mp4', 'file:///data/a.mp4']) {
      expect(buildStreamProbeArgs(url)).toEqual(['-hide_banner', '-nostdin', '-i', url])
    }
  })
})

describe('probeFoundAStream', () => {
  it('an empty result is a FAILED probe', () => {
    expect(probeFoundAStream({})).toBe(false)
    expect(probeFoundAStream({ codec: 'h264' })).toBe(true)
    expect(probeFoundAStream({ audio: { codec: 'aac' } })).toBe(true)
  })
})
