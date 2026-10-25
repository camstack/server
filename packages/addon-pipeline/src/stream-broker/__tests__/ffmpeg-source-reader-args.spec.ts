import { describe, expect, it } from 'vitest'
import {
  buildFfmpegSourceReaderArgs,
  HTTP_MJPEG_H264_OUTPUT_ARGS,
} from '../rtsp/ffmpeg-source-reader-args.js'

const join = (a: string[]) => a.join(' ')

describe('buildFfmpegSourceReaderArgs', () => {
  it('normalizes HTTP MJPEG to low-latency H.264 MPEG-TS', () => {
    const args = buildFfmpegSourceReaderArgs({
      sourceUrl: 'http://127.0.0.1:1234/terminal.mjpeg',
      sourceKind: 'http',
      transport: 'tcp',
      outputArgs: HTTP_MJPEG_H264_OUTPUT_ARGS,
    })
    expect(args).not.toContain('-rtsp_transport')
    expect(args).toContain('libx264')
    expect(args).toContain('zerolatency')
    expect(args.slice(-3)).toEqual(['-f', 'mpegts', 'pipe:1'])
  })

  it('rtsp/tcp: input args, transport, -i, -c copy, mpegts stdout', () => {
    const s = join(
      buildFfmpegSourceReaderArgs({
        sourceUrl: 'rtsp://cam/main',
        sourceKind: 'rtsp',
        transport: 'tcp',
      }),
    )
    expect(s).toContain('-rtsp_transport tcp')
    expect(s).toContain('-i rtsp://cam/main')
    expect(s).toContain('-c copy')
    expect(s).toContain('-f mpegts pipe:1')
    // transport flag precedes -i
    expect(s.indexOf('-rtsp_transport')).toBeLessThan(s.indexOf('-i '))
    // mpegts stdout muxer is the tail of the argv
    expect(s.endsWith('-f mpegts pipe:1')).toBe(true)
    // -c copy precedes the output muxer
    expect(s.indexOf('-c copy')).toBeLessThan(s.indexOf('-f mpegts'))
  })
  it('rtsp/udp: emits -rtsp_transport udp', () => {
    const s = join(
      buildFfmpegSourceReaderArgs({
        sourceUrl: 'rtsp://cam/main',
        sourceKind: 'rtsp',
        transport: 'udp',
      }),
    )
    expect(s).toContain('-rtsp_transport udp')
  })
  it('rtmp: no -rtsp_transport flag', () => {
    const s = join(
      buildFfmpegSourceReaderArgs({
        sourceUrl: 'rtmp://cam/live',
        sourceKind: 'rtmp',
        transport: 'tcp',
      }),
    )
    expect(s).not.toContain('-rtsp_transport')
    expect(s).toContain('-i rtmp://cam/live')
    expect(s).toContain('-f mpegts pipe:1')
  })
  it('http (HTTP-FLV): no -rtsp_transport flag, -i directly, mpegts stdout', () => {
    const s = join(
      buildFfmpegSourceReaderArgs({
        sourceUrl: 'http://cam/flv?port=1935&app=bcs&stream=channel0_main.bcs',
        sourceKind: 'http',
        transport: 'tcp',
      }),
    )
    expect(s).not.toContain('-rtsp_transport')
    expect(s).toContain('-i http://cam/flv?port=1935&app=bcs&stream=channel0_main.bcs')
    expect(s).toContain('-c copy')
    expect(s).toContain('-f mpegts pipe:1')
  })
  it('injects operator input/output args at the seam (normalization hook)', () => {
    const s = join(
      buildFfmpegSourceReaderArgs({
        sourceUrl: 'rtsp://cam/main',
        sourceKind: 'rtsp',
        transport: 'tcp',
        inputArgs: ['-use_wallclock_as_timestamps', '1'],
        outputArgs: ['-avoid_negative_ts', 'make_zero'],
      }),
    )
    // input args BEFORE -i, output args AFTER -c copy and BEFORE the muxer
    expect(s.indexOf('-use_wallclock_as_timestamps')).toBeLessThan(s.indexOf('-i '))
    expect(s.indexOf('-avoid_negative_ts')).toBeGreaterThan(s.indexOf('-c copy'))
    expect(s.indexOf('-avoid_negative_ts')).toBeLessThan(s.indexOf('-f mpegts'))
  })

  it('tokenizes multi-token arg entries on whitespace (settings widget stores one line per entry)', () => {
    // The settings widget persists a flag+value as ONE array element (a textarea
    // line), e.g. `'-use_wallclock_as_timestamps 1'`. It MUST become two separate
    // argv tokens, not a single spaced argument spawn would pass verbatim.
    const args = buildFfmpegSourceReaderArgs({
      sourceUrl: 'rtsp://cam/main',
      sourceKind: 'rtsp',
      transport: 'tcp',
      inputArgs: ['-use_wallclock_as_timestamps 1', '-fflags +genpts+igndts'],
      outputArgs: ['-avoid_negative_ts make_zero', '   '],
    })
    // Each token is its own argv element.
    expect(args).toContain('-use_wallclock_as_timestamps')
    expect(args).toContain('1')
    expect(args).toContain('-fflags')
    expect(args).toContain('+genpts+igndts')
    expect(args).toContain('-avoid_negative_ts')
    expect(args).toContain('make_zero')
    // No element retains an embedded space, and blank entries are dropped.
    expect(args.some((a) => a.includes(' '))).toBe(false)
    expect(args.some((a) => a.trim().length === 0)).toBe(false)
  })
})
