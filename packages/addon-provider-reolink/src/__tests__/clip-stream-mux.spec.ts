/**
 * The pure half of the streamed clip: the mux it asks for, the rate it
 * measures before asking, and the peer it cuts.
 *
 * A stream restates three of D567/D568's rules and drops none silently: the
 * fragmented container replaces `+faststart` (a second pass over a file that
 * does not exist yet), `-r` is measured over a PROBE because it is an input
 * option, and a rate that did not come from timestamps is not a rate at all.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  buildClipStreamMuxArgs,
  CLIP_STREAM_DRAIN_TIMEOUT_MS,
  CLIP_STREAM_MOVFLAGS,
  CLIP_STREAM_RATE_PROBE_ACCESS_UNITS,
  clipStreamContainerFor,
  clipStreamContentTypeFor,
  createDrainGate,
  probeClipStreamRate,
} from '../clips/clip-stream-mux.js'

/** `n` access units, `intervalUs` apart, starting at `startUs`. */
function stamps(n: number, intervalUs: number, startUs = 1_000_000): number[] {
  return Array.from({ length: n }, (_, i) => startUs + i * intervalUs)
}

describe('the probe rate', () => {
  it('measures the DELIVERED rate over the probe window and snaps it', () => {
    // A hub child declaring 30 and delivering 15.019 (D567): the probe sees
    // 66 104 µs intervals and answers 15, never 30.
    const rate = probeClipStreamRate(stamps(CLIP_STREAM_RATE_PROBE_ACCESS_UNITS, 66_104))
    expect(rate).toEqual({ fps: 15, fpsSource: 'timestamps', accessUnits: 16 })
  })

  it('measures 25 on a 592 main-shaped probe', () => {
    expect(probeClipStreamRate(stamps(16, 40_480)).fps).toBe(25)
  })

  it('answers `null`, never a guess, when the timestamps cannot say', () => {
    // One access unit spans nothing; two on the same stamp span nothing.
    expect(probeClipStreamRate([5_000_000])).toEqual({
      fps: null,
      fpsSource: 'unmeasured',
      accessUnits: 1,
    })
    expect(probeClipStreamRate([5_000_000, 5_000_000]).fps).toBeNull()
    expect(probeClipStreamRate([]).fps).toBeNull()
  })

  it('measures a clip SHORTER than the probe from what it has', () => {
    const rate = probeClipStreamRate(stamps(5, 66_667))
    expect(rate.fps).toBe(15)
    expect(rate.accessUnits).toBe(5)
  })
})

describe('the stream mux arguments', () => {
  it('reads stdin, writes a fragmented MP4 to stdout, copies the video, no audio input', () => {
    const args = buildClipStreamMuxArgs({ videoType: 'H264', fps: 15, audio: null })
    expect(args).toEqual([
      '-hide_banner',
      '-loglevel',
      'error',
      '-nostdin',
      '-r',
      '15',
      '-f',
      'h264',
      '-i',
      'pipe:0',
      '-c:v',
      'copy',
      '-movflags',
      CLIP_STREAM_MOVFLAGS,
      '-f',
      'mp4',
      'pipe:1',
    ])
    // The one input is video: a silent mux declares NO `pipe:3`, because
    // ffmpeg probes every input it is given before it writes a byte, and an
    // input that never delivers would hold the video hostage (D600).
    expect(args.filter((arg) => arg === '-i')).toHaveLength(1)
    expect(args).not.toContain('pipe:3')
    expect(args).not.toContain('-map')
    expect(args).not.toContain('+faststart')
  })

  it('adds the ADTS input on `pipe:3` and encodes Opus, mapping both streams', () => {
    const args = buildClipStreamMuxArgs({ videoType: 'H264', fps: 15, audio: 'opus' })
    expect(args.filter((arg) => arg === '-i')).toHaveLength(2)
    // Input options before their own `-i`, and the audio input AFTER the video.
    expect(args.indexOf('pipe:0')).toBeLessThan(args.indexOf('pipe:3'))
    expect(args.slice(args.indexOf('pipe:3') - 3, args.indexOf('pipe:3') + 1)).toEqual([
      '-f',
      'aac',
      '-i',
      'pipe:3',
    ])
    // Explicit mapping: ffmpeg's default picks one stream per type and would
    // drop the second input's audio if the video input ever carried one.
    expect(args.join(' ')).toContain('-map 0:v -map 1:a')
    expect(args.join(' ')).toContain('-c:a libopus -ar 48000 -ac 1 -b:a 24k')
    // Opus rides in MP4, like the silent stream.
    expect(args.slice(-3)).toEqual(['-f', 'mp4', 'pipe:1'])
  })

  it('encodes µ-law into MOV, because the MP4 muxer refuses pcm_mulaw', () => {
    const args = buildClipStreamMuxArgs({ videoType: 'H264', fps: 15, audio: 'pcmu' })
    expect(args.join(' ')).toContain('-c:a pcm_mulaw -ar 8000 -ac 1')
    // MEASURED: `ffmpeg 7.1` answers `Could not find tag for codec pcm_mulaw
    // in stream #1` for `-f mp4`. The boxes are the same; the container is not.
    expect(args.slice(-3)).toEqual(['-f', 'mov', 'pipe:1'])
    expect(clipStreamContainerFor('pcmu')).toBe('mov')
    expect(clipStreamContentTypeFor('pcmu')).toBe('video/quicktime')
    expect(clipStreamContentTypeFor(null)).toBe('video/mp4')
    expect(clipStreamContentTypeFor('opus')).toBe('video/mp4')
  })

  it('puts `-r` BEFORE its own `-i` — it is an input option', () => {
    const args = buildClipStreamMuxArgs({ videoType: 'H264', fps: 25, audio: null })
    expect(args.indexOf('-r')).toBeLessThan(args.indexOf('-i'))
  })

  it('names the DETECTED codec, and hevc for H.265', () => {
    const args = buildClipStreamMuxArgs({ videoType: 'H265', fps: 15, audio: null })
    expect(args.slice(args.indexOf('-f'), args.indexOf('-f') + 2)).toEqual(['-f', 'hevc'])
  })

  it('omits `-r` entirely when nothing measured a rate (D567)', () => {
    for (const fps of [null, 0, Number.NaN, -1]) {
      expect(buildClipStreamMuxArgs({ videoType: 'H264', fps, audio: null })).not.toContain('-r')
    }
  })

  it('fragments at keyframes with an empty moov first — the container a stream can have', () => {
    expect(CLIP_STREAM_MOVFLAGS.split('+').toSorted()).toEqual([
      'default_base_moof',
      'empty_moov',
      'frag_keyframe',
    ])
  })
})

describe('the drain gate (D447)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('never stalls while every write is accepted', () => {
    const onStall = vi.fn()
    const gate = createDrainGate({ timeoutMs: CLIP_STREAM_DRAIN_TIMEOUT_MS, onStall })
    gate.wrote(true)
    gate.wrote(true)
    vi.advanceTimersByTime(CLIP_STREAM_DRAIN_TIMEOUT_MS * 3)
    expect(onStall).not.toHaveBeenCalled()
    expect(gate.waiting()).toBe(false)
  })

  it('arms on a refused write and disarms on drain', () => {
    const onStall = vi.fn()
    const gate = createDrainGate({ timeoutMs: 1_000, onStall })
    gate.wrote(false)
    expect(gate.waiting()).toBe(true)
    vi.advanceTimersByTime(900)
    gate.drained()
    expect(gate.waiting()).toBe(false)
    vi.advanceTimersByTime(5_000)
    expect(onStall).not.toHaveBeenCalled()
  })

  it('cuts a peer that never drains, once', () => {
    const onStall = vi.fn()
    const gate = createDrainGate({ timeoutMs: 1_000, onStall })
    gate.wrote(false)
    vi.advanceTimersByTime(999)
    expect(onStall).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(onStall).toHaveBeenCalledTimes(1)
    // Nothing after a stall re-arms it: the stream is already cut.
    gate.wrote(false)
    vi.advanceTimersByTime(5_000)
    expect(onStall).toHaveBeenCalledTimes(1)
  })

  it('does not push the deadline out on a second refused write', () => {
    const onStall = vi.fn()
    const gate = createDrainGate({ timeoutMs: 1_000, onStall })
    gate.wrote(false)
    vi.advanceTimersByTime(800)
    gate.wrote(false)
    vi.advanceTimersByTime(200)
    expect(onStall).toHaveBeenCalledTimes(1)
  })

  it('is silent once disposed', () => {
    const onStall = vi.fn()
    const gate = createDrainGate({ timeoutMs: 1_000, onStall })
    gate.wrote(false)
    gate.dispose()
    vi.advanceTimersByTime(5_000)
    expect(onStall).not.toHaveBeenCalled()
  })
})
