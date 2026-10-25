/**
 * Encoding on the GPU when the decode stays in software.
 *
 * The operator's rule is blunt: a software transcode must not happen, because
 * it spends cores this hub does not have to spare. The hub HAS a working Intel
 * iGPU, and the transcodes were running `libx264` anyway — first because the
 * bundled ffmpeg had no VAAPI at all (D536), and then because the encoder pick
 * was tied to the DECODE preference, which is `copy` (software) by default for
 * a good reason: hardware decode hard-fails on a fragile HEVC source.
 *
 * Those are two different decisions. A software decode can feed a hardware
 * encoder — that is what `hwupload` is for — and the encode is where the CPU
 * actually goes. For ffmpeg that means three things, and all three or none:
 *
 *   -vaapi_device /dev/dri/renderD128        (a GLOBAL option, before the inputs)
 *   -vf scale=W:H,format=nv12,hwupload       (frames pushed to the GPU, last)
 *   -c:v h264_vaapi
 *
 * Miss the device and the child dies with "No device available for encoder";
 * miss the upload and it dies with "Impossible to convert between the formats".
 */
import { describe, expect, it } from 'vitest'
import { buildFfmpegArgs } from '../ffmpeg/invocation.js'
import type { FfmpegInvocation } from '../ffmpeg/invocation.js'

function invocation(over: Partial<FfmpegInvocation>): FfmpegInvocation {
  return {
    logLevel: 'warning',
    decodeHwAccel: null,
    threadCount: 0,
    input: { url: 'rtsp://127.0.0.1:8554/a', rtspTransport: 'tcp' },
    video: {
      kind: 'encode',
      encoder: 'h264_vaapi',
      scale: { mode: 'exact', width: 896, height: 512 },
    },
    audio: { kind: 'none' },
    outputArgs: [],
    sink: { kind: 'stdout', container: 'mpegts' },
    ...over,
  }
}

describe('vaapi encode from a software decode', () => {
  it('names the render device BEFORE the input — it is a global option', () => {
    const args = buildFfmpegArgs(
      invocation({ hwEncodeDevice: { kind: 'vaapi', renderNode: '/dev/dri/renderD128' } }),
    )
    const at = args.indexOf('-vaapi_device')
    expect(at).toBeGreaterThan(-1)
    expect(args[at + 1]).toBe('/dev/dri/renderD128')
    expect(at).toBeLessThan(args.indexOf('-i'))
  })

  it('uploads the scaled frames to the GPU, with the upload LAST in the chain', () => {
    const args = buildFfmpegArgs(
      invocation({ hwEncodeDevice: { kind: 'vaapi', renderNode: '/dev/dri/renderD128' } }),
    )
    const vf = args[args.indexOf('-vf') + 1]
    expect(vf).toBe('scale=896:512,format=nv12,hwupload')
  })

  it('uploads even when nothing is scaled — the encoder still needs GPU frames', () => {
    const args = buildFfmpegArgs(
      invocation({
        hwEncodeDevice: { kind: 'vaapi', renderNode: '/dev/dri/renderD128' },
        video: { kind: 'encode', encoder: 'h264_vaapi', scale: null },
      }),
    )
    expect(args[args.indexOf('-vf') + 1]).toBe('format=nv12,hwupload')
  })

  it('does NOT upload when the decode already left the frames on the GPU', () => {
    // `-hwaccel vaapi` + vaapi output format means the frames are already
    // surfaces; uploading them a second time is an error, not a no-op.
    const args = buildFfmpegArgs(
      invocation({
        decodeHwAccel: 'vaapi',
        hwEncodeDevice: { kind: 'vaapi', renderNode: '/dev/dri/renderD128' },
        video: { kind: 'encode', encoder: 'h264_vaapi', scale: null },
      }),
    )
    expect(args.join(' ')).not.toContain('hwupload')
  })

  it('changes nothing at all for a software encoder', () => {
    const plain = buildFfmpegArgs(
      invocation({ video: { kind: 'encode', encoder: 'libx264', scale: null } }),
    )
    expect(plain).not.toContain('-vaapi_device')
    expect(plain.join(' ')).not.toContain('hwupload')
  })

  it('refuses a hardware encode whose frames a filter GRAPH produces — the upload belongs in the graph', () => {
    expect(() =>
      buildFfmpegArgs(
        invocation({
          hwEncodeDevice: { kind: 'vaapi', renderNode: '/dev/dri/renderD128' },
          video: { kind: 'encode', encoder: 'h264_vaapi', scale: null },
          filterGraph: { graph: '[0:v][1:v]overlay=0:0[out]', videoOutLabel: 'out' },
        }),
      ),
    ).toThrow(/graph/i)
  })
})
