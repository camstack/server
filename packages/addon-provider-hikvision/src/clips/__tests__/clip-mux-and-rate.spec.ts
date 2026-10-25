/**
 * What ffmpeg is told, and the D447 gate that catches a hop which stopped
 * taking bytes.
 */
import { describe, expect, it, vi } from 'vitest'

import {
  estimateReplayFps,
  replayFpsIsExact,
  REPLAY_RATE_EXACT_SPANS,
} from '../clip-replay-rate.js'
import {
  buildClipFileMuxArgs,
  buildClipStreamMuxArgs,
  CLIP_MUX_PROBE_BYTES,
  CLIP_STREAM_MAX_INTERLEAVE_DELTA_US,
  clipStreamContainerFor,
  clipStreamContentTypeFor,
  createDrainGate,
} from '../clip-stream-mux.js'

describe('estimateReplayFps', () => {
  it('measures the rate from the replay’s own 90 kHz timestamps', () => {
    // The real stamps of the fixture replay: 7 200 ticks apart at 90 kHz.
    const stamps = [86_400, 93_600, 100_800, 108_000, 115_200, 122_400]
    expect(estimateReplayFps(stamps, 90_000)).toEqual({
      fps: 12.5,
      source: 'timestamps',
      accessUnits: 6,
    })
  })

  it('reports the average it measured, and never rounds it to a nicer one', () => {
    // A first version snapped an estimate within 4 % of an integer. The
    // fixture's own rate is 12.5, which is within 4 % of 13, so the rule
    // turned an exact measurement into a wrong one.
    const stamps = [0, 7_400, 14_600, 22_000, 29_100]
    expect(estimateReplayFps(stamps, 90_000).fps).toBeCloseTo(12.37, 2)
  })

  it('answers `unmeasured` rather than a number, on a span it cannot read', () => {
    // Never a fallback number: `-r` at a rate nobody measured plays the clip
    // at the wrong speed with nothing in the file to say so (D567, D604).
    expect(estimateReplayFps([], 90_000).source).toBe('unmeasured')
    expect(estimateReplayFps([1_000], 90_000).source).toBe('unmeasured')
    expect(estimateReplayFps([1_000, 1_000], 90_000).source).toBe('unmeasured')
    // A wrapped u32 clock goes BACKWARD. A negative span is not a rate.
    expect(estimateReplayFps([4_294_000_000, 1_000], 90_000).fps).toBeNull()
  })
})

describe('replayFpsIsExact', () => {
  it('is the same number a full window would have produced, and says so early', () => {
    // The arithmetic, not a confidence threshold: equal spans mean
    // `(n-1)·rate ÷ ((n-1)·span)` for every n, so four units and sixteen
    // answer identically. Proving it here is what licenses the probe to stop.
    const span = 7_200
    const all = Array.from({ length: 16 }, (_, i) => 86_400 + i * span)
    const few = all.slice(0, REPLAY_RATE_EXACT_SPANS + 1)
    expect(replayFpsIsExact(few)).toBe(true)
    expect(estimateReplayFps(few, 90_000).fps).toBe(estimateReplayFps(all, 90_000).fps)
  })

  it('needs the spans to be EXACTLY equal, and needs enough of them', () => {
    const span = 7_200
    const short = Array.from({ length: REPLAY_RATE_EXACT_SPANS }, (_, i) => i * span)
    expect(replayFpsIsExact(short)).toBe(false)
    // One tick of variation is a variable-rate replay, and it falls through to
    // the full window — the behaviour that shipped. Never a tolerance.
    expect(replayFpsIsExact([0, span, span * 2, span * 3 + 1])).toBe(false)
    // A stalled clock and a wrapped one are not rates.
    expect(replayFpsIsExact([0, 0, 0, 0])).toBe(false)
    expect(replayFpsIsExact([10, 5, 0, -5])).toBe(false)
  })
})

describe('buildClipStreamMuxArgs', () => {
  it('probes only as far as one WHOLE access unit of this stream', () => {
    // A Hikvision replay arrives at 1×, so ffmpeg's 5 MB / 5 s input probe is
    // paid in the operator's wait — but the bound must still contain a whole
    // frame, and a 4K HEVC keyframe off 1436 measured 550 354 bytes. This
    // shipped at 32 KiB, six per cent of one frame, which is indefensible
    // whatever it gets away with.
    const silent = buildClipStreamMuxArgs({ videoCodec: 'h265', fps: 12.5, audio: null })
    expect(silent.join(' ')).toContain('-analyzeduration 0 -probesize 262144 -f hevc -i pipe:0')
    // Eight times the headroom for 31 ms — but NOT a fix for anything: every
    // probe size from 32 KiB to 768 KiB reproduced the header-and-no-media
    // fault identically. That one was the interleave window.
    expect(CLIP_MUX_PROBE_BYTES).toBeGreaterThan(32_768)
    const sound = buildClipStreamMuxArgs({ videoCodec: 'h265', fps: 12.5, audio: 'pcmu' })
    // BOTH inputs: an input option applies only to the input that follows it,
    // so the audio pipe would keep the default probe and hold the video
    // hostage for it (D600's shape, one layer down).
    expect(sound.join(' ')).toContain('-analyzeduration 0 -probesize 262144 -f mulaw')
  })

  it('never lets the muxer WAIT for one track while the other is ready', () => {
    // The whole reason a clip with sound would not play. Measured on 1436: a
    // silent stream delivered 1 299 KiB by the halfway point of a 6 s clip,
    // and the same clip with sound delivered 1 KiB — the init segment — until
    // the inputs ended, when all 3.78 MB arrived at once.
    const args = buildClipStreamMuxArgs({ videoCodec: 'h265', fps: 12.5, audio: 'opus' })
    expect(args.join(' ')).toContain('-max_interleave_delta 100000')
    // Small and POSITIVE: `0` means unlimited in ffmpeg, and it reproduced the
    // fault exactly.
    expect(CLIP_STREAM_MAX_INTERLEAVE_DELTA_US).toBeGreaterThan(0)
    expect(CLIP_STREAM_MAX_INTERLEAVE_DELTA_US).toBeLessThanOrEqual(200_000)
    // A silent mux has one input and nothing to interleave, but the flag is
    // harmless there and one arg list is easier to reason about than two.
    expect(
      buildClipStreamMuxArgs({ videoCodec: 'h265', fps: 12.5, audio: null }).join(' '),
    ).toContain('-max_interleave_delta')
  })

  it('closes a fragment on time as well as on a keyframe, and flushes it', () => {
    // `frag_keyframe` alone spans a whole GOP — 4 s of media on 1436, which
    // is 4 s of wall clock at 1× arrival. And ffmpeg's AVIO buffer holds the
    // 942-byte init segment until 32 KiB piles up behind it, so without
    // `-flush_packets` the peer sees nothing at all until the first fragment.
    const args = buildClipStreamMuxArgs({ videoCodec: 'h265', fps: 12.5, audio: null })
    expect(args.join(' ')).toContain('-frag_duration 500000')
    expect(args.join(' ')).toContain('-flush_packets 1')
    // The FILE form is not fragmented, so neither belongs to it.
    const file = buildClipFileMuxArgs({ videoCodec: 'h265', fps: 12.5, audio: null }, '/tmp/x.part')
    expect(file).not.toContain('-frag_duration')
    expect(file).not.toContain('-flush_packets')
  })

  it('names the demuxer from the codec, and passes the measured rate', () => {
    const args = buildClipStreamMuxArgs({ videoCodec: 'h265', fps: 12.5, audio: null })
    expect(args.join(' ')).toContain('-r 12.5')
    expect(args.join(' ')).toContain('-f hevc -i pipe:0')
    expect(args.join(' ')).toContain('-c:v copy')
    expect(args.join(' ')).toContain('-movflags frag_keyframe+empty_moov+default_base_moof')
    expect(args.at(-1)).toBe('pipe:1')
    expect(buildClipStreamMuxArgs({ videoCodec: 'h264', fps: 15, audio: null })).toContain('h264')
  })

  it('omits the audio INPUT entirely for a silent mux', () => {
    // ffmpeg probes every input before it writes a byte of output, so an
    // input that never delivers holds the VIDEO hostage (D600).
    const args = buildClipStreamMuxArgs({ videoCodec: 'h265', fps: 12.5, audio: null })
    expect(args).not.toContain('pipe:3')
    expect(args).not.toContain('-map')
  })

  it('declares the µ-law input with its rate and channel count', () => {
    const args = buildClipStreamMuxArgs({ videoCodec: 'h265', fps: 12.5, audio: 'pcmu' })
    // A headerless PCM stream carries neither; getting either wrong is the
    // audio bug that passes every unit test and arrives as a chipmunk.
    expect(args.join(' ')).toContain('-f mulaw -ar 8000 -ac 1 -i pipe:3')
    expect(args.join(' ')).toContain('-map 0:v -map 1:a')
  })

  it('COPIES µ-law and containers it as mov', () => {
    // The archive IS µ-law at 8 kHz mono, which is what a `pcmu` session
    // sends — and ffmpeg's MP4 muxer refuses `pcm_mulaw` outright.
    const args = buildClipStreamMuxArgs({ videoCodec: 'h265', fps: 12.5, audio: 'pcmu' })
    expect(args.join(' ')).toContain('-c:a copy')
    expect(args.join(' ')).toContain('-f mov')
    expect(clipStreamContainerFor('pcmu')).toBe('mov')
    expect(clipStreamContentTypeFor('pcmu')).toBe('video/quicktime')
  })

  it('ENCODES opus, mono at 48 kHz, into mp4', () => {
    const args = buildClipStreamMuxArgs({ videoCodec: 'h265', fps: 12.5, audio: 'opus' })
    expect(args.join(' ')).toContain('-c:a libopus -ar 48000 -ac 1 -b:a 24k')
    expect(args.join(' ')).toContain('-f mp4')
    expect(clipStreamContentTypeFor('opus')).toBe('video/mp4')
    expect(clipStreamContentTypeFor(null)).toBe('video/mp4')
  })

  it('omits `-r` for a null rate, because that is what the flag means', () => {
    expect(buildClipStreamMuxArgs({ videoCodec: 'h265', fps: null, audio: null })).not.toContain(
      '-r',
    )
  })
})

describe('buildClipFileMuxArgs', () => {
  it('writes a faststart file to a PATH, never to a pipe', () => {
    // `+faststart` is a second pass over a finished file; the output must be
    // seekable, which is the whole difference from the stream.
    const args = buildClipFileMuxArgs(
      { videoCodec: 'h265', fps: 12.5, audio: 'opus' },
      '/tmp/x.mp4',
    )
    expect(args.join(' ')).toContain('-movflags +faststart')
    expect(args.at(-1)).toBe('/tmp/x.mp4')
    expect(args).not.toContain('pipe:1')
  })

  it('names the output FORMAT, because the scratch path is not a .mp4', () => {
    // The scratch writes to `<key>.mp4.<pid>.part` so a crash never leaves a
    // truncated file under the real key. ffmpeg picks its muxer from the
    // extension and answers `Unable to choose an output format` to that one —
    // measured on a real clip, against a suite whose fixture path ended
    // `.mp4` and never reached the branch.
    const args = buildClipFileMuxArgs(
      { videoCodec: 'h265', fps: 12.5, audio: null },
      '/tmp/x.mp4.123.part',
    )
    expect(args.join(' ')).toContain('-f mp4 -y /tmp/x.mp4.123.part')
  })
})

describe('createDrainGate', () => {
  it('arms on a refused write and fires once', () => {
    vi.useFakeTimers()
    const onStall = vi.fn()
    const gate = createDrainGate({ timeoutMs: 1_000, onStall })
    gate.wrote(false)
    expect(gate.waiting()).toBe(true)
    // A second refusal does not push the deadline out.
    gate.wrote(false)
    vi.advanceTimersByTime(1_000)
    expect(onStall).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(10_000)
    expect(onStall).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  it('does NOT stall while the consumer is demonstrably still working', () => {
    // MEASURED, 2026-09-23, with the production args against a 1x feed: the
    // µ-law pipe fills (64 KiB is EIGHT SECONDS of 8 kHz sound) and Node
    // never emits another `drain` on it, because ffmpeg is ahead on audio
    // and simply is not hungry. Ten seconds later the gate severed a stream
    // that had already delivered 9 993 026 bytes — the operator's own log,
    // `branch: "mux-audio-stalled"`, `elapsedMs: 24941`. A hop that is not
    // taking bytes while its owner is still PRODUCING them has not stalled.
    vi.useFakeTimers()
    const onStall = vi.fn()
    let alive = true
    const gate = createDrainGate({ timeoutMs: 1_000, onStall, stillMoving: () => alive })
    gate.wrote(false)
    vi.advanceTimersByTime(1_000)
    expect(onStall).not.toHaveBeenCalled()
    // And it is ARMED again: a consumer that then dies is still caught.
    expect(gate.waiting()).toBe(true)
    vi.advanceTimersByTime(1_000)
    expect(onStall).not.toHaveBeenCalled()
    alive = false
    vi.advanceTimersByTime(1_000)
    expect(onStall).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  it('disarms on drain', () => {
    vi.useFakeTimers()
    const onStall = vi.fn()
    const gate = createDrainGate({ timeoutMs: 1_000, onStall })
    gate.wrote(false)
    gate.drained()
    expect(gate.waiting()).toBe(false)
    vi.advanceTimersByTime(10_000)
    expect(onStall).not.toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('is silent for ever once disposed', () => {
    // Node emits no `drain` after `end()`, so a gate armed at EOF can never
    // be disarmed: it would fire `timeoutMs` later and sever a stream that
    // was already served. That is D604's second defect and it is the ORDINARY
    // case, not a rare one.
    vi.useFakeTimers()
    const onStall = vi.fn()
    const gate = createDrainGate({ timeoutMs: 1_000, onStall })
    gate.wrote(false)
    gate.dispose()
    vi.advanceTimersByTime(10_000)
    expect(onStall).not.toHaveBeenCalled()
    gate.wrote(false)
    vi.advanceTimersByTime(10_000)
    expect(onStall).not.toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('does not arm on a write the hop took', () => {
    vi.useFakeTimers()
    const onStall = vi.fn()
    const gate = createDrainGate({ timeoutMs: 1_000, onStall })
    gate.wrote(true)
    expect(gate.waiting()).toBe(false)
    vi.advanceTimersByTime(10_000)
    expect(onStall).not.toHaveBeenCalled()
    vi.useRealTimers()
  })
})
