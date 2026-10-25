import { describe, expect, it } from 'vitest'
import { buildPassthroughArgs, type PassthroughArgs } from '../ffmpeg-args.js'
import { segmentListSize } from '../segment-watcher.js'

const base: PassthroughArgs = {
  rtspUrl: 'rtsp://127.0.0.1:8554/abc',
  outDir: '/tmp/rec/1/low',
  segmentSeconds: 10,
  consumerTag: 'recorder/1/low/3',
}

/** Assert `-tag:v hvc1` is present and sits inside the video-copy stanza. */
function hasHvc1Tag(args: readonly string[]): boolean {
  const i = args.indexOf('-tag:v')
  return i >= 0 && args[i + 1] === 'hvc1'
}

describe('buildPassthroughArgs — HEVC hvc1 sample-entry relabel', () => {
  it('adds `-tag:v hvc1` for an HEVC (H265) source (Apple/WebKit)', () => {
    const args = buildPassthroughArgs({ ...base, videoCodec: 'H265' })
    expect(hasHvc1Tag(args)).toBe(true)
    // Still passthrough — zero re-encode.
    expect(args).toContain('copy')
    const copyIdx = args.indexOf('-c:v')
    expect(args[copyIdx + 1]).toBe('copy')
  })

  it('does NOT add `-tag:v hvc1` for an H.264 source', () => {
    const args = buildPassthroughArgs({ ...base, videoCodec: 'H264' })
    expect(hasHvc1Tag(args)).toBe(false)
    expect(args).not.toContain('-tag:v')
  })

  it('does NOT add `-tag:v hvc1` when the codec is unknown (undefined)', () => {
    const args = buildPassthroughArgs(base)
    expect(hasHvc1Tag(args)).toBe(false)
    expect(args).not.toContain('-tag:v')
  })

  it('keeps the tag adjacent to the video-copy stanza (before -c:a)', () => {
    const args = buildPassthroughArgs({ ...base, videoCodec: 'H265' })
    const tagIdx = args.indexOf('-tag:v')
    const audioIdx = args.indexOf('-c:a')
    expect(tagIdx).toBeGreaterThan(args.indexOf('-c:v'))
    expect(tagIdx).toBeLessThan(audioIdx)
  })
})

describe('buildPassthroughArgs — Opus audio transcode', () => {
  it('re-encodes audio to libopus (never AAC)', () => {
    const args = buildPassthroughArgs(base)
    const audioIdx = args.indexOf('-c:a')
    expect(audioIdx).toBeGreaterThanOrEqual(0)
    expect(args[audioIdx + 1]).toBe('libopus')
    expect(args).not.toContain('aac')
  })

  it('sets a sane Opus bitrate right after the codec', () => {
    const args = buildPassthroughArgs(base)
    const bIdx = args.indexOf('-b:a')
    expect(bIdx).toBeGreaterThan(args.indexOf('-c:a'))
    expect(args[bIdx + 1]).toBe('48k')
  })

  it('keeps the source channel layout (no forced -ac)', () => {
    const args = buildPassthroughArgs(base)
    expect(args).not.toContain('-ac')
  })

  it('still copies video (passthrough) while transcoding audio', () => {
    const args = buildPassthroughArgs(base)
    const vIdx = args.indexOf('-c:v')
    expect(args[vIdx + 1]).toBe('copy')
  })
})

/**
 * Without `-segment_list_size` the muxer uses the default 0 = "keep every segment
 * for the whole life of the writer", and the watcher re-parses the entire body every 2 s:
 * 3.3 MB/s across 30 writers at 5 h of uptime, linear growth, no ceiling.
 */
describe('buildPassthroughArgs — the playlist is bounded', () => {
  it('passes -segment_list_size, derived from the segment duration', () => {
    const args = buildPassthroughArgs(base)
    const i = args.indexOf('-segment_list_size')
    expect(i).toBeGreaterThanOrEqual(0)
    expect(args[i + 1]).toBe(String(segmentListSize(base.segmentSeconds)))
  })

  it('a shorter segment buys more entries — the ceiling is in TIME, not in lines', () => {
    const short = buildPassthroughArgs({ ...base, segmentSeconds: 2 })
    const long = buildPassthroughArgs({ ...base, segmentSeconds: 30 })
    const sizeOf = (args: readonly string[]): number =>
      Number(args[args.indexOf('-segment_list_size') + 1])
    expect(sizeOf(short)).toBeGreaterThan(sizeOf(long))
  })

  it('stays an output option next to -segment_list (after -f segment)', () => {
    const args = buildPassthroughArgs(base)
    expect(args.indexOf('-segment_list_size')).toBeGreaterThan(args.indexOf('-f'))
    expect(args.indexOf('-segment_list_size')).toBeGreaterThan(args.indexOf('-segment_list'))
  })
})

describe('buildPassthroughArgs — the dial carries a correlatable identity', () => {
  /**
   * The `User-Agent` is the ONLY thing that crosses from this ffmpeg into the
   * broker's RTSP session, and it was the constant string `recorder` — so every
   * writer on the node produced the same value and no broker line could be tied
   * back to one writer's files. Correlating a served pre-roll burst with the
   * segment it should be inside needs a per-attach key, and this is where it is
   * put on the wire.
   */
  it('sends the per-attach consumer tag as the User-Agent', () => {
    const args = buildPassthroughArgs(base)
    const uaIdx = args.indexOf('-user_agent')
    expect(uaIdx).toBeGreaterThanOrEqual(0)
    expect(args[uaIdx + 1]).toBe('recorder/1/low/3')
  })

  it('keeps -user_agent an INPUT option (before -i), or ffmpeg ignores it', () => {
    const args = buildPassthroughArgs(base)
    expect(args.indexOf('-user_agent')).toBeLessThan(args.indexOf('-i'))
  })
})

describe('buildPassthroughArgs — threads, because the pid ceiling is real', () => {
  // A writer COPIES video and encodes a low-bitrate mono Opus track; it is not
  // a parallel job. ffmpeg still sizes codec threads AND libavfilter's slice
  // pool to the core count, independently, per child — 29 writers were holding
  // 551 threads on this hub against a 2048 pid ceiling it was already hitting
  // (22 refused thread creations in 45 minutes, costing a lost subject tile on
  // camera 107 and a dead Alexa egress). Measured 20 -> 5 per writer.
  it('pins ONE codec thread and ONE filter thread', () => {
    const args = buildPassthroughArgs(base)
    expect(args[args.indexOf('-threads') + 1]).toBe('1')
    expect(args[args.indexOf('-filter_threads') + 1]).toBe('1')
  })

  it('states them BEFORE the input, where they bind to the decoder too', () => {
    const args = buildPassthroughArgs(base)
    expect(args.indexOf('-threads')).toBeLessThan(args.indexOf('-i'))
    expect(args.indexOf('-filter_threads')).toBeLessThan(args.indexOf('-i'))
  })
})
