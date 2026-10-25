/**
 * `-flags low_delay` on an INPUT, and why it is a field rather than an
 * `extraArgs` string somebody remembers to add.
 *
 * ffmpeg's h264 decoder reorders output to undo B-frame ordering, which means
 * it holds a frame until it knows none that follows will precede it. On a
 * stream with no B-frames there is nothing to reorder and the wait buys
 * nothing — it is pure added latency on every hop that decodes. A composite
 * decodes N of them per grid.
 */
import { describe, expect, it } from 'vitest'
import { buildFfmpegArgs } from '../ffmpeg/invocation.js'
import type { FfmpegInvocation } from '../ffmpeg/invocation.js'

function invocation(lowDelay: boolean | undefined): FfmpegInvocation {
  return {
    logLevel: 'error',
    decodeHwAccel: null,
    threadCount: 0,
    input: {
      url: 'rtsp://127.0.0.1:8554/x',
      rtspTransport: 'tcp',
      ...(lowDelay === undefined ? {} : { lowDelay }),
    },
    video: { kind: 'copy' },
    audio: { kind: 'none' },
    outputArgs: [],
    sink: { kind: 'stdout', container: 'mpegts' },
  }
}

describe('input lowDelay', () => {
  it('emits `-flags low_delay` BEFORE the input it applies to', () => {
    const args = buildFfmpegArgs(invocation(true))
    const flagIndex = args.indexOf('low_delay')
    const inputIndex = args.indexOf('-i')
    expect(flagIndex).toBeGreaterThan(-1)
    expect(args[flagIndex - 1]).toBe('-flags')
    expect(flagIndex).toBeLessThan(inputIndex)
  })

  it('is absent unless asked for — an unset field changes no argv', () => {
    expect(buildFfmpegArgs(invocation(undefined))).not.toContain('low_delay')
    expect(buildFfmpegArgs(invocation(false))).not.toContain('low_delay')
  })
})
