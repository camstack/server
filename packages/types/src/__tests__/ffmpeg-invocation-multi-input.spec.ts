/**
 * The ONE ffmpeg argv builder, carrying N inputs and an explicit filter graph.
 *
 * A composite (grid) camera is ONE child doing N decodes, one composition and
 * ONE encode — frames never cross a process boundary at frame-rate (D9/D18).
 * That makes the number of inputs, and the `-map` that selects what leaves the
 * graph, properties of the INVOCATION rather than constants in the builder.
 *
 * Every case here pins the ARGV the builder produces. The single-input vector
 * is part of the suite on purpose: it fails loudly if the N-input extension
 * changes one byte for the callers that were already shipping.
 */
import { describe, expect, it } from 'vitest'
import { buildFfmpegArgs, type FfmpegInvocation } from '../ffmpeg/invocation.js'

function baseInvocation(over: Partial<FfmpegInvocation> = {}): FfmpegInvocation {
  return {
    logLevel: 'error',
    decodeHwAccel: null,
    input: { url: 'rtsp://cam/live', rtspTransport: 'tcp' },
    video: { kind: 'copy' },
    audio: { kind: 'none' },
    threadCount: 0,
    outputArgs: [],
    sink: { kind: 'stdout', container: 'mpegts' },
    ...over,
  }
}

describe('buildFfmpegArgs — the single-input argv is unchanged', () => {
  it('emits no -map and no -filter_complex for one input without a graph', () => {
    const args = buildFfmpegArgs(
      baseInvocation({
        input: { url: 'rtsp://cam/live', rtspTransport: 'tcp', fflags: ['+discardcorrupt'] },
        video: { kind: 'encode', encoder: 'libx264', fps: 10, gopFrames: 20 },
        threadCount: 2,
      }),
    )
    expect(args).toEqual([
      '-hide_banner',
      '-loglevel',
      'error',
      '-fflags',
      '+discardcorrupt',
      '-rtsp_transport',
      'tcp',
      '-i',
      'rtsp://cam/live',
      '-c:v',
      'libx264',
      '-r',
      '10',
      '-g',
      '20',
      '-threads',
      '2',
      '-an',
      '-f',
      'mpegts',
      'pipe:1',
    ])
    // Derived, not hardcoded: one input and no graph means ffmpeg's own stream
    // selection, exactly what every shipping call site already gets.
    expect(args).not.toContain('-map')
    expect(args).not.toContain('-filter_complex')
  })
})

describe('buildFfmpegArgs — N inputs and a filter graph', () => {
  it('emits a SECOND input and maps the graph video pad', () => {
    const args = buildFfmpegArgs(
      baseInvocation({
        input: { url: 'rtsp://cam/a', rtspTransport: 'tcp' },
        extraInputs: [{ url: 'rtsp://cam/b', rtspTransport: 'tcp' }],
        filterGraph: {
          graph: '[0:v]scale=640:360[l];[1:v]scale=640:360[r];[l][r]hstack=inputs=2[grid]',
          videoOutLabel: 'grid',
        },
        video: { kind: 'encode', encoder: 'libx264', fps: 10 },
      }),
    )
    expect(args).toEqual([
      '-hide_banner',
      '-loglevel',
      'error',
      '-rtsp_transport',
      'tcp',
      '-i',
      'rtsp://cam/a',
      '-rtsp_transport',
      'tcp',
      '-i',
      'rtsp://cam/b',
      '-filter_complex',
      '[0:v]scale=640:360[l];[1:v]scale=640:360[r];[l][r]hstack=inputs=2[grid]',
      '-map',
      '[grid]',
      '-c:v',
      'libx264',
      '-r',
      '10',
      '-an',
      '-f',
      'mpegts',
      'pipe:1',
    ])
  })

  it('carries FOUR inputs for a 2x2 grid, each input option before ITS own -i', () => {
    const graph =
      '[0:v]scale=640:360[a];[1:v]scale=640:360[b];[2:v]scale=640:360[c];[3:v]scale=640:360[d];' +
      '[a][b]hstack=inputs=2[top];[c][d]hstack=inputs=2[bottom];[top][bottom]vstack=inputs=2[grid]'
    const args = buildFfmpegArgs(
      baseInvocation({
        decodeHwAccel: 'vaapi',
        input: { url: 'rtsp://cam/1', rtspTransport: 'tcp', fflags: ['+discardcorrupt'] },
        extraInputs: [
          { url: 'rtsp://cam/2', rtspTransport: 'tcp', fflags: ['+discardcorrupt'] },
          { url: 'rtsp://cam/3', rtspTransport: 'tcp', fflags: ['+discardcorrupt'] },
          { url: 'rtsp://cam/4', rtspTransport: 'tcp', fflags: ['+discardcorrupt'] },
        ],
        filterGraph: { graph, videoOutLabel: 'grid' },
        video: { kind: 'encode', encoder: 'h264_vaapi', fps: 10, gopFrames: 20 },
        threadCount: 4,
      }),
    )
    expect(args).toEqual([
      '-hide_banner',
      '-loglevel',
      'error',
      '-hwaccel',
      'vaapi',
      '-fflags',
      '+discardcorrupt',
      '-rtsp_transport',
      'tcp',
      '-i',
      'rtsp://cam/1',
      '-hwaccel',
      'vaapi',
      '-fflags',
      '+discardcorrupt',
      '-rtsp_transport',
      'tcp',
      '-i',
      'rtsp://cam/2',
      '-hwaccel',
      'vaapi',
      '-fflags',
      '+discardcorrupt',
      '-rtsp_transport',
      'tcp',
      '-i',
      'rtsp://cam/3',
      '-hwaccel',
      'vaapi',
      '-fflags',
      '+discardcorrupt',
      '-rtsp_transport',
      'tcp',
      '-i',
      'rtsp://cam/4',
      '-filter_complex',
      graph,
      '-map',
      '[grid]',
      '-c:v',
      'h264_vaapi',
      '-r',
      '10',
      '-g',
      '20',
      '-threads',
      '4',
      '-an',
      '-f',
      'mpegts',
      'pipe:1',
    ])
    // Every `-hwaccel` belongs to the input that FOLLOWS it. A decode option
    // emitted after its `-i` is accepted, ignored, and silently software — the
    // one failure this whole file's ordering exists to prevent, now multiplied
    // by the number of inputs.
    const inputAt = args.flatMap((a, i) => (a === '-i' ? [i] : []))
    const hwAt = args.flatMap((a, i) => (a === '-hwaccel' ? [i] : []))
    expect(inputAt).toHaveLength(4)
    expect(hwAt).toHaveLength(4)
    for (let k = 0; k < 4; k++) expect(hwAt[k] ?? -1).toBeLessThan(inputAt[k] ?? -1)
  })

  it('maps the graph audio pad when the graph declares one', () => {
    const args = buildFfmpegArgs(
      baseInvocation({
        input: { url: 'rtsp://cam/a' },
        extraInputs: [{ url: 'rtsp://cam/b' }],
        filterGraph: {
          graph: '[0:v][1:v]hstack=inputs=2[grid];[0:a][1:a]amix=inputs=2[mix]',
          videoOutLabel: 'grid',
          audioOutLabel: 'mix',
        },
        video: { kind: 'encode', encoder: 'libx264' },
        audio: { kind: 'encode', codec: 'aac', bitrateKbps: 64 },
      }),
    )
    expect(args).toEqual([
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      'rtsp://cam/a',
      '-i',
      'rtsp://cam/b',
      '-filter_complex',
      '[0:v][1:v]hstack=inputs=2[grid];[0:a][1:a]amix=inputs=2[mix]',
      '-map',
      '[grid]',
      '-c:v',
      'libx264',
      '-map',
      '[mix]',
      '-c:a',
      'aac',
      '-b:a',
      '64k',
      '-f',
      'mpegts',
      'pipe:1',
    ])
  })

  it('maps input 0 explicitly when there are N inputs and NO graph', () => {
    // With more than one input and nothing saying which one is the picture,
    // ffmpeg's own heuristic picks the "best" stream across ALL inputs — the
    // egress would silently become whichever camera has the largest frame.
    const args = buildFfmpegArgs(
      baseInvocation({
        input: { url: 'rtsp://cam/a' },
        extraInputs: [{ url: 'rtsp://cam/b' }],
        audio: { kind: 'copy' },
      }),
    )
    expect(args).toEqual([
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      'rtsp://cam/a',
      '-i',
      'rtsp://cam/b',
      '-map',
      '0:v:0',
      '-c:v',
      'copy',
      '-map',
      '0:a:0?',
      '-c:a',
      'copy',
      '-f',
      'mpegts',
      'pipe:1',
    ])
    expect(args).not.toContain('-filter_complex')
  })

  it('refuses a scale in the video plan while a graph feeds the same output', () => {
    // ffmpeg rejects a simple `-vf` on an output fed by a complex graph.
    // Dropping the scale silently instead would be the no-op shape the
    // primitive exists to prevent, so the plan is refused where it is written.
    expect(() =>
      buildFfmpegArgs(
        baseInvocation({
          input: { url: 'rtsp://cam/a' },
          extraInputs: [{ url: 'rtsp://cam/b' }],
          filterGraph: { graph: '[0:v][1:v]hstack=inputs=2[grid]', videoOutLabel: 'grid' },
          video: {
            kind: 'encode',
            encoder: 'libx264',
            scale: { mode: 'exact', width: 1280, height: 720 },
          },
        }),
      ),
    ).toThrow(/filter graph/i)
  })

  it('refuses a COPY video plan under a graph — a composed picture has no bitstream', () => {
    expect(() =>
      buildFfmpegArgs(
        baseInvocation({
          input: { url: 'rtsp://cam/a' },
          extraInputs: [{ url: 'rtsp://cam/b' }],
          filterGraph: { graph: '[0:v][1:v]hstack=inputs=2[grid]', videoOutLabel: 'grid' },
          video: { kind: 'copy' },
        }),
      ),
    ).toThrow(/encode/i)
  })

  it('maps the graph output on the RTP video leg too', () => {
    const args = buildFfmpegArgs(
      baseInvocation({
        input: { url: 'rtsp://cam/a' },
        extraInputs: [{ url: 'rtsp://cam/b' }],
        filterGraph: { graph: '[0:v][1:v]hstack=inputs=2[grid]', videoOutLabel: 'grid' },
        video: { kind: 'encode', encoder: 'libx264' },
        sink: {
          kind: 'rtp-outputs',
          video: { url: 'rtp://127.0.0.1:5000', payloadType: 99 },
          audio: null,
        },
      }),
    )
    expect(args).toEqual([
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      'rtsp://cam/a',
      '-i',
      'rtsp://cam/b',
      '-filter_complex',
      '[0:v][1:v]hstack=inputs=2[grid]',
      '-an',
      '-map',
      '[grid]',
      '-c:v',
      'libx264',
      '-payload_type',
      '99',
      '-f',
      'rtp',
      'rtp://127.0.0.1:5000',
    ])
    expect(args).not.toContain('0:v:0')
  })
})
