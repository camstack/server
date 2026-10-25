/**
 * The composite's argv, pinned.
 *
 * This suite exists to prove ONE child does N decodes, one composition and ONE
 * encode — and that the composite is assembled by the shared builder in
 * `@camstack/types`, never by a second argv builder of this addon's own
 * (`scripts/check-ffmpeg-primitive.ts`, Rule 1).
 */
import { buildFfmpegArgs } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import type { GridLayout } from '../grid-filter-graph.js'
import { gridStreamInvocation } from '../grid-stream-invocation.js'
import type { GridStreamSource } from '../grid-stream-invocation.js'

const FULL_FRAME = { x: 0, y: 0, width: 1, height: 1 } as const

function quadLayout(): GridLayout {
  return {
    width: 1920,
    height: 1080,
    cells: [
      { inputIndex: 0, source: FULL_FRAME, cell: { x: 0, y: 0, width: 0.5, height: 0.5 } },
      { inputIndex: 1, source: FULL_FRAME, cell: { x: 0.5, y: 0, width: 0.5, height: 0.5 } },
      { inputIndex: 2, source: FULL_FRAME, cell: { x: 0, y: 0.5, width: 0.5, height: 0.5 } },
      { inputIndex: 3, source: FULL_FRAME, cell: { x: 0.5, y: 0.5, width: 0.5, height: 0.5 } },
    ],
  }
}

const QUAD_SOURCES: readonly GridStreamSource[] = [
  { deviceId: 611, url: 'rtsp://127.0.0.1:8554/a' },
  { deviceId: 612, url: 'rtsp://127.0.0.1:8554/b' },
  { deviceId: 613, url: 'rtsp://127.0.0.1:8554/c' },
  { deviceId: 105, url: 'rtsp://127.0.0.1:8554/d' },
]

const EXPECTED_QUAD_GRAPH =
  'color=c=black:s=1920x1080:d=1[canvas];' +
  '[0:v]scale=960:540[c0];' +
  '[1:v]scale=960:540[c1];' +
  '[2:v]scale=960:540[c2];' +
  '[3:v]scale=960:540[c3];' +
  '[canvas][c0]overlay=0:0[s0];' +
  '[s0][c1]overlay=960:0[s1];' +
  '[s1][c2]overlay=0:540[s2];' +
  '[s2][c3]overlay=960:540[grid]'

function inputBlock(url: string): readonly string[] {
  return [
    // 0 and 32: the probe returns from the SDP instead of reading media. The
    // byte budget is what cost the seconds — 1 MB of a 640x360 sub-stream is
    // tens of seconds of video, so `-analyzeduration 1s` never got to stop it.
    // Measured on the hub, two sources, three runs each: first composed frame
    // 8986/9728/9712 ms with 1s+1MB, 2281/2270/2304 ms with 0+32, and the skew
    // between the two tiles' burnt-in clocks went 5s/5s/4s → 1s/1s/0s.
    '-analyzeduration',
    '0',
    '-probesize',
    '32',
    // `low_delay` stops the h264 decoder reordering output it has nothing to
    // reorder — measured at 4050 → 1796 ms to first frame. `+nobuffer` was
    // here too and was measured at 6292 ms: removed.
    '-flags',
    'low_delay',
    // NO `-use_wallclock_as_timestamps`: measured to turn smooth 84 ms output
    // pacing into bursts with ten stalls over a second in an 18 s run.
    '-fflags',
    '+discardcorrupt',
    '-rtsp_transport',
    'tcp',
    '-i',
    url,
  ]
}

describe('gridStreamInvocation — a 2x2 grid', () => {
  it('produces exactly one child, four inputs, one graph and one encode', () => {
    const args = buildFfmpegArgs(
      gridStreamInvocation({
        layout: quadLayout(),
        sources: QUAD_SOURCES,
        decodeHwAccel: null,
        encoder: 'libx264',
        fps: 10,
        bitrateKbps: 4000,
      }),
    )
    expect(args).toEqual([
      '-hide_banner',
      '-loglevel',
      'error',
      ...inputBlock('rtsp://127.0.0.1:8554/a'),
      ...inputBlock('rtsp://127.0.0.1:8554/b'),
      ...inputBlock('rtsp://127.0.0.1:8554/c'),
      ...inputBlock('rtsp://127.0.0.1:8554/d'),
      '-filter_complex',
      EXPECTED_QUAD_GRAPH,
      '-map',
      '[grid]',
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-tune',
      'zerolatency',
      '-pix_fmt',
      'yuv420p',
      '-r',
      '10',
      '-g',
      '10',
      '-maxrate',
      '4000k',
      '-bufsize',
      '8000k',
      '-an',
      '-f',
      'flv',
      'pipe:1',
    ])
  })

  it('emits exactly one -c:v and one -filter_complex — N decodes, ONE encode', () => {
    const args = buildFfmpegArgs(
      gridStreamInvocation({
        layout: quadLayout(),
        sources: QUAD_SOURCES,
        decodeHwAccel: null,
        encoder: 'libx264',
        fps: 10,
        bitrateKbps: 4000,
      }),
    )
    expect(args.filter((a) => a === '-c:v')).toHaveLength(1)
    expect(args.filter((a) => a === '-filter_complex')).toHaveLength(1)
    expect(args.filter((a) => a === '-i')).toHaveLength(4)
  })

  it('carries NO audio plane at all — a grid has no microphone', () => {
    const args = buildFfmpegArgs(
      gridStreamInvocation({
        layout: quadLayout(),
        sources: QUAD_SOURCES,
        decodeHwAccel: null,
        encoder: 'libx264',
        fps: 10,
        bitrateKbps: 4000,
      }),
    )
    expect(args).toContain('-an')
    expect(args.some((a) => a.startsWith('-c:a'))).toBe(false)
    expect(args.some((a) => a === '0:a:0?')).toBe(false)
  })

  it('puts -hwaccel BEFORE every -i, once per input', () => {
    const args = buildFfmpegArgs(
      gridStreamInvocation({
        layout: quadLayout(),
        sources: QUAD_SOURCES,
        decodeHwAccel: 'vaapi',
        encoder: 'h264_vaapi',
        fps: 10,
        bitrateKbps: 4000,
      }),
    )
    const hwIndexes = args.flatMap((a, i) => (a === '-hwaccel' ? [i] : []))
    const inputIndexes = args.flatMap((a, i) => (a === '-i' ? [i] : []))
    expect(hwIndexes).toHaveLength(4)
    hwIndexes.forEach((hw, n) => {
      expect(hw).toBeLessThan(inputIndexes[n] as number)
    })
  })

  it('refuses a layout whose cell count does not match the sources it was given', () => {
    // A mismatch means the graph would address an input ordinal that does not
    // exist. ffmpeg fails at start-up with a message about a pad; saying so
    // here names the PLAN that is wrong.
    expect(() =>
      gridStreamInvocation({
        layout: quadLayout(),
        sources: QUAD_SOURCES.slice(0, 2),
        decodeHwAccel: null,
        encoder: 'libx264',
        fps: 10,
        bitrateKbps: 4000,
      }),
    ).toThrow(/input ordinal/i)
  })

  it('refuses a grid with no sources rather than spawning a child that emits nothing', () => {
    expect(() =>
      gridStreamInvocation({
        layout: { width: 1920, height: 1080, cells: [] },
        sources: [],
        decodeHwAccel: null,
        encoder: 'libx264',
        fps: 10,
        bitrateKbps: 4000,
      }),
    ).toThrow(/at least one cell/i)
  })
})
