/**
 * Decode, filter, hand the PIXELS on — no encoder at all.
 *
 * A composition this repo assembles itself copies its tiles into a canvas, so
 * encoding each tile on the way out and decoding it again on the way in would
 * be two codecs paid to deliver the frames that were already there.
 */
import { describe, expect, it } from 'vitest'
import { buildFfmpegArgs, buildVideoArgs } from '../ffmpeg/invocation.js'
import type { FfmpegInvocation } from '../ffmpeg/invocation.js'

function invocation(): FfmpegInvocation {
  return {
    logLevel: 'error',
    decodeHwAccel: null,
    threadCount: 0,
    input: { url: 'rtsp://127.0.0.1:8554/a/muted', rtspTransport: 'tcp' },
    video: { kind: 'raw', pixelFormat: 'yuv420p', filter: 'scale=960:540', fps: 10 },
    audio: { kind: 'none' },
    outputArgs: [],
    sink: { kind: 'stdout', container: 'rawvideo' },
  }
}

describe('raw video output', () => {
  it('names no encoder, states the pixel format, and writes rawvideo to stdout', () => {
    const args = buildFfmpegArgs(invocation())
    expect(args).toContain('-c:v')
    expect(args[args.indexOf('-c:v') + 1]).toBe('rawvideo')
    expect(args[args.indexOf('-pix_fmt') + 1]).toBe('yuv420p')
    expect(args.slice(-3)).toEqual(['-f', 'rawvideo', 'pipe:1'])
  })

  it('puts the filter BEFORE the codec, where ffmpeg reads it', () => {
    const args = buildFfmpegArgs(invocation())
    expect(args.indexOf('-vf')).toBeLessThan(args.indexOf('-c:v'))
    expect(args[args.indexOf('-vf') + 1]).toBe('scale=960:540')
  })

  it('REFUSES a filter that would feed an output a complex graph already feeds', () => {
    expect(() =>
      buildVideoArgs({ kind: 'raw', pixelFormat: 'yuv420p', filter: 'scale=2:2' }, [], {
        graph: 'x',
        videoOutLabel: 'v',
      }),
    ).toThrow(/fold the filter into the graph/)
  })

  it('emits no filter at all when none is asked for', () => {
    expect(buildVideoArgs({ kind: 'raw', pixelFormat: 'yuv420p' }, [])).toEqual([
      '-c:v',
      'rawvideo',
      '-pix_fmt',
      'yuv420p',
    ])
  })
})
