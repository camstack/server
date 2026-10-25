/**
 * `-use_wallclock_as_timestamps` on an input, and why a composite needs it.
 *
 * ffmpeg normalises each input so its first frame is pts 0, and `overlay` pairs
 * inputs BY PTS. Two sources that join at different moments therefore compose
 * frames from different moments — permanently, for the life of the child, with
 * no drift correction, because each tile's clock started when that tile's first
 * frame happened to arrive.
 *
 * The spread is not hypothetical. Joining the SAME restream four times in one
 * series measured 1830, 3987, 3985 and 4025 ms (2026-09-18): a `/muted` dial is
 * served immediately only within ~500 ms of an IDR and otherwise waits for the
 * next one, so two tiles of one grid can start up to a key-frame interval
 * apart — ~4 s on this fleet.
 *
 * With wall-clock timestamps each input is stamped by ARRIVAL instead, so
 * `overlay` pairs what actually happened at the same time and the tiles agree.
 */
import { describe, expect, it } from 'vitest'
import { buildFfmpegArgs } from '../ffmpeg/invocation.js'
import type { FfmpegInvocation } from '../ffmpeg/invocation.js'

function invocation(useWallclockTimestamps: boolean | undefined): FfmpegInvocation {
  return {
    logLevel: 'error',
    decodeHwAccel: null,
    threadCount: 0,
    input: {
      url: 'rtsp://127.0.0.1:8554/a/muted',
      rtspTransport: 'tcp',
      ...(useWallclockTimestamps === undefined ? {} : { useWallclockTimestamps }),
    },
    video: { kind: 'copy' },
    audio: { kind: 'none' },
    outputArgs: [],
    sink: { kind: 'stdout', container: 'mpegts' },
  }
}

describe('input useWallclockTimestamps', () => {
  it('emits the flag with its value, BEFORE the input it applies to', () => {
    const args = buildFfmpegArgs(invocation(true))
    const at = args.indexOf('-use_wallclock_as_timestamps')
    expect(at).toBeGreaterThan(-1)
    expect(args[at + 1]).toBe('1')
    expect(at).toBeLessThan(args.indexOf('-i'))
  })

  it('is absent unless asked for — an unset field changes no argv', () => {
    expect(buildFfmpegArgs(invocation(undefined))).not.toContain('-use_wallclock_as_timestamps')
    expect(buildFfmpegArgs(invocation(false))).not.toContain('-use_wallclock_as_timestamps')
  })
})
