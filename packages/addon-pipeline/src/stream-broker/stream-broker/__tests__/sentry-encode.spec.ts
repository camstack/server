/**
 * The sentry's picture is encoded ONCE, at the camera's own geometry, into a
 * single self-contained IDR.
 *
 * Every assertion here is one of the two failures this encode exists to avoid:
 *
 *  - **A different geometry than the real stream.** `stream-broker.ts` records
 *    what a fixed 1280x720 placeholder SPS did in front of a camera's real IDR:
 *    "Chrome's decoder freezes on the last placeholder frame until the user
 *    manually restarts". So the scale is `exact` and it is the PLAN's, never a
 *    default.
 *  - **A frame a mid-sentry joiner cannot decode.** The pump re-emits ONE
 *    cached buffer at 1 fps, so every emission is the same access unit: it has
 *    to carry its own parameter sets (`repeat-headers`, `-g 1`) or a consumer
 *    that attached on tick 4 has nothing to initialise from.
 *
 * And one thing that is NOT here: a continuous ffmpeg. The picture changes at
 * most hourly, so `-frames:v 1` and the child is gone — a per-camera child
 * running for the whole sentry would be a process per sleeping camera.
 */
import { describe, expect, it } from 'vitest'
import { buildPrestreamEncodeArgs } from '../sentry-encode.js'

/** Index of `flag` in argv, or -1. */
function at(args: readonly string[], flag: string): number {
  return args.indexOf(flag)
}

describe('buildPrestreamEncodeArgs', () => {
  it('encodes at the PLAN geometry, exactly — never a default size', () => {
    const args = buildPrestreamEncodeArgs({ width: 2560, height: 1920, codec: 'h264' })
    expect(args).toContain('-vf')
    expect(args[at(args, '-vf') + 1]).toBe('scale=2560:1920')
    expect(args.join(' ')).not.toContain('1280')
  })

  it('reads the input from stdin as a single image, before -i', () => {
    const args = buildPrestreamEncodeArgs({ width: 640, height: 480, codec: 'h264' })
    const i = at(args, '-i')
    expect(args[i + 1]).toBe('pipe:0')
    // `-f image2pipe` is an INPUT option: after `-i` ffmpeg accepts it and
    // ignores it, exactly like `-hwaccel`.
    expect(at(args, '-f')).toBeLessThan(i)
    expect(args[at(args, '-f') + 1]).toBe('image2pipe')
  })

  it('emits exactly ONE frame and exits', () => {
    const args = buildPrestreamEncodeArgs({ width: 640, height: 480, codec: 'h264' })
    expect(args).toContain('-frames:v')
    expect(args[at(args, '-frames:v') + 1]).toBe('1')
  })

  it('makes every frame a complete IDR with inline parameter sets (h264)', () => {
    const args = buildPrestreamEncodeArgs({ width: 640, height: 480, codec: 'h264' })
    expect(args[at(args, '-g') + 1]).toBe('1')
    expect(args).toContain('-x264-params')
    expect(args[at(args, '-x264-params') + 1]).toContain('repeat-headers=1')
    expect(args[at(args, '-c:v') + 1]).toBe('libx264')
  })

  it('makes every frame a complete IDR with inline parameter sets (h265)', () => {
    const args = buildPrestreamEncodeArgs({ width: 1920, height: 1080, codec: 'h265' })
    expect(args[at(args, '-g') + 1]).toBe('1')
    expect(args).toContain('-x265-params')
    expect(args[at(args, '-x265-params') + 1]).toContain('repeat-headers=1')
    expect(args[at(args, '-c:v') + 1]).toBe('libx265')
  })

  it('writes the elementary stream of the PLAN codec to stdout', () => {
    const h264 = buildPrestreamEncodeArgs({ width: 640, height: 480, codec: 'h264' })
    expect(h264.slice(-3)).toEqual(['-f', 'h264', 'pipe:1'])
    const h265 = buildPrestreamEncodeArgs({ width: 640, height: 480, codec: 'h265' })
    expect(h265.slice(-3)).toEqual(['-f', 'hevc', 'pipe:1'])
  })

  it('never draws text with ffmpeg — D118, only one of the two builds has libfreetype', () => {
    const args = buildPrestreamEncodeArgs({ width: 640, height: 480, codec: 'h264' })
    expect(args.join(' ')).not.toContain('drawtext')
  })

  it('carries no audio', () => {
    expect(buildPrestreamEncodeArgs({ width: 640, height: 480, codec: 'h264' })).toContain('-an')
  })
})
