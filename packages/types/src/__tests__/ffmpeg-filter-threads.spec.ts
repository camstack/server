/**
 * `-filter_threads`, which `-threads` does not cover.
 *
 * ffmpeg sizes libavfilter's slice pool to the core count independently of the
 * codec threads, PER GRAPH. On the hub's 20-core CPU that is ~15 threads per
 * graph, on outputs where they do nothing measurable — and the container's pid
 * cgroup counts every one. The ceiling is 2048 and it was being HIT: 22 refused
 * thread creations in 45 minutes, costing a lost subject tile on camera 107, a
 * snapshot that could not open a decoder, and a dead Alexa egress. None of them
 * said "out of pids".
 */
import { describe, expect, it } from 'vitest'
import { buildFfmpegArgs } from '../ffmpeg/invocation.js'
import type { FfmpegInvocation } from '../ffmpeg/invocation.js'

function invocation(filterThreadCount?: number): FfmpegInvocation {
  return {
    logLevel: 'error',
    decodeHwAccel: null,
    input: { url: 'rtsp://127.0.0.1:8554/a', rtspTransport: 'tcp' },
    video: { kind: 'copy' },
    audio: { kind: 'none' },
    threadCount: 2,
    ...(filterThreadCount === undefined ? {} : { filterThreadCount }),
    outputArgs: [],
    sink: { kind: 'stdout', container: 'mpegts' },
  }
}

describe('filterThreadCount', () => {
  it('emits the filter pool size beside the codec thread count', () => {
    const args = buildFfmpegArgs(invocation(1))
    expect(args[args.indexOf('-threads') + 1]).toBe('2')
    expect(args[args.indexOf('-filter_threads') + 1]).toBe('1')
  })

  it('changes NO argv when it is not asked for', () => {
    expect(buildFfmpegArgs(invocation())).not.toContain('-filter_threads')
    expect(buildFfmpegArgs(invocation(0))).not.toContain('-filter_threads')
  })
})
