/**
 * `-f rawvideo` and the three facts it cannot discover.
 *
 * Raw video has no container and no metadata. Given no pixel format, size or
 * rate, ffmpeg guesses — and the guess produces a PICTURE rather than an error:
 * skewed, tinted, or played at the wrong speed. So the three travel together or
 * not at all, and they are emitted before `-i` like every other input option.
 */
import { describe, expect, it } from 'vitest'
import { buildFfmpegArgs } from '../ffmpeg/invocation.js'
import type { FfmpegInvocation } from '../ffmpeg/invocation.js'

function invocation(raw: boolean): FfmpegInvocation {
  return {
    logLevel: 'error',
    decodeHwAccel: null,
    threadCount: 0,
    input: {
      url: 'pipe:0',
      ...(raw
        ? { rawVideo: { pixelFormat: 'yuv420p', width: 1920, height: 1080, framerate: 10 } }
        : {}),
    },
    video: { kind: 'copy' },
    audio: { kind: 'none' },
    outputArgs: [],
    sink: { kind: 'stdout', container: 'flv' },
  }
}

describe('rawVideo input', () => {
  it('states format, pixel format, size and rate, all BEFORE the input', () => {
    const args = buildFfmpegArgs(invocation(true))
    const at = args.indexOf('-f')
    expect(args.slice(at, at + 8)).toEqual([
      '-f',
      'rawvideo',
      '-pix_fmt',
      'yuv420p',
      '-video_size',
      '1920x1080',
      '-framerate',
      '10',
    ])
    expect(at).toBeLessThan(args.indexOf('-i'))
  })

  it('changes no argv at all when the input is not raw', () => {
    expect(buildFfmpegArgs(invocation(false))).not.toContain('rawvideo')
  })
})
