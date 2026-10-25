/**
 * Sound on the forward-only clip stream (D600), driven through the REAL
 * feeder over the REAL bytes the production mux produces.
 *
 * `clip-frag-opus.mp4` / `clip-frag-pcmu.mov` are written by
 * `buildClipStreamMuxArgs` itself, spawned with the production four-pipe
 * `stdio` and fed video + ADTS in interleaved media order. Everything a fake
 * could get wrong about them — when ffmpeg's muxer first writes an audio run,
 * how big a µ-law sample is, whether the first audio sample is at pts 0 — is
 * therefore whatever it really is, not whatever the test wanted.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createClipStreamFeeder,
  type ClipStreamAudioAsk,
  type ClipStreamDialAnswer,
  type ClipStreamHandlers,
  type ClipAudioReport,
  type ClipIncompleteReport,
} from '../clip-stream-feeder'
import { createFmp4StreamDemuxer, type Fmp4AudioCodec } from '../fmp4-stream-demux'
import type { FeederStateTransition } from '../recorded-feeder'
import type { ClipPlaybackHandle } from '../timeline-session'

const OPUS = readFileSync(join(__dirname, 'fixtures/clip-frag-opus.mp4'))
const PCMU = readFileSync(join(__dirname, 'fixtures/clip-frag-pcmu.mov'))
/** The same four seconds with no audio track at all. */
const SILENT = readFileSync(join(__dirname, 'fixtures/clip-frag.mp4'))

const HANDLE: ClipPlaybackHandle = {
  deviceId: 107,
  clipId: 'native:reolink:onboard:0:abc',
  provider: 'provider-reolink',
  profile: 'low',
}

interface PushedAudio {
  readonly ts: number
  readonly bytes: number
}
interface PushedVideo {
  readonly ts: number
}

interface HarnessOptions {
  readonly fixture?: Uint8Array
  /** What the session negotiated. Absent ⇒ no audio sender at all. */
  readonly audio?: Fmp4AudioCodec
  /** What the provider answers on the dial. Absent ⇒ it honours the ask. */
  readonly servedAudio?: string
  readonly audioReason?: string
  /** Wire the sink's push function for the codec. Default true. */
  readonly wireSink?: boolean
}

function harness(options: HarnessOptions = {}) {
  const fixture = options.fixture ?? OPUS
  const wireSink = options.wireSink ?? true
  let handlers: ClipStreamHandlers | null = null
  const connection = { pause: vi.fn(), resume: vi.fn(), destroy: vi.fn() }
  const video: PushedVideo[] = []
  const opus: PushedAudio[] = []
  const pcmu: PushedAudio[] = []
  const states: FeederStateTransition[] = []
  const logs: Array<{ msg: string; data: Record<string, unknown> }> = []
  const asks: ClipStreamAudioAsk[] = []
  const dial = vi.fn(async (_h: ClipPlaybackHandle, ask: ClipStreamAudioAsk) => {
    asks.push(ask)
    const answer: ClipStreamDialAnswer = {
      kind: 'dialed',
      url: 'http://127.0.0.1:1/tok',
      expiresAtMs: Date.now() + 30_000,
      servedAudio: options.servedAudio ?? ask,
      ...(options.audioReason !== undefined ? { audioReason: options.audioReason } : {}),
    }
    return answer
  })
  const feeder = createClipStreamFeeder({
    handle: HANDLE,
    dial,
    open: async (_url, h) => {
      handlers = h
      return { kind: 'open', connection }
    },
    ...(options.audio !== undefined ? { audio: options.audio } : {}),
    sink: {
      pushAccessUnit: (_data, ts) => video.push({ ts }),
      ...(wireSink && options.audio === 'opus'
        ? { pushAudioOpus: (data, ts) => opus.push({ ts, bytes: data.byteLength }) }
        : {}),
      ...(wireSink && options.audio === 'pcmu'
        ? { pushAudioPcmu: (data, ts) => pcmu.push({ ts, bytes: data.byteLength }) }
        : {}),
    },
    onState: (t) => states.push(t),
    onPosition: () => {},
    onLog: (msg, data) => logs.push({ msg, data }),
    now: () => Date.now(),
  })
  return {
    feeder,
    dial,
    asks,
    video,
    opus,
    pcmu,
    logs,
    states,
    connection,
    log: (msg: string) => logs.filter((l) => l.msg === msg),
    deliver: (from = 0, to = fixture.length): void => {
      if (handlers === null) throw new Error('the stream is not open')
      handlers.onData(fixture.subarray(from, to))
    },
    end: (report: ClipIncompleteReport | null = null): void => handlers?.onEnd(report),
  }
}

/** The source timestamps the demuxer really produces for a fixture. */
function demuxedPts(bytes: Uint8Array): { video: number[]; audio: number[] } {
  const audio: number[] = []
  const demuxer = createFmp4StreamDemuxer({ onAudio: (u) => audio.push(u.ptsMs) })
  const video = demuxer.push(bytes).map((u) => u.ptsMs)
  demuxer.end()
  return { video, audio }
}

/**
 * `outputMs - sourceMs` for each push, aligned from the END of both lists.
 *
 * A seek drops from the FRONT of a run, so the last N pushes are always the
 * last N source samples. Aligning from the tail therefore needs no bookkeeping
 * about what was dropped.
 */
function trailingOffsets(
  pushed: readonly { readonly ts: number }[],
  source: readonly number[],
  ticksPerMs: number,
): number[] {
  const n = Math.min(pushed.length, source.length)
  const out: number[] = []
  for (let i = 0; i < n; i++) {
    const p = pushed[pushed.length - n + i]
    const sourceMs = source[source.length - n + i]
    if (p === undefined || sourceMs === undefined) continue
    out.push(p.ts / ticksPerMs - sourceMs)
  }
  return out
}

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

/** Run the clip out at 1x on fake time. The fixture is four seconds long. */
function playOut(): void {
  vi.advanceTimersByTime(6_000)
}

describe('a clip stream carries sound', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('asks the provider for the codec THIS session negotiated, on the dial', async () => {
    const h = harness({ audio: 'opus' })
    void h.feeder.seek(0)
    await settle()
    expect(h.asks).toEqual(['opus'])
    expect(h.dial).toHaveBeenCalledWith(HANDLE, 'opus')
  })

  it('asks for `none` when the session negotiated no audio sender at all', async () => {
    const h = harness({ audio: 'opus', wireSink: false })
    void h.feeder.seek(0)
    await settle()
    expect(h.asks).toEqual(['none'])
    await expect(h.feeder.audio?.()).resolves.toEqual({
      carried: false,
      codec: null,
      reason: 'not-negotiated',
    })
  })

  it('pushes every Opus packet the stream carried, at the 48 kHz clock', async () => {
    const h = harness({ audio: 'opus' })
    void h.feeder.seek(0)
    await settle()
    h.deliver()
    h.end()
    playOut()
    expect(h.video.length).toBe(60)
    // The whole soundtrack, not a sample of it: four seconds of 20 ms packets.
    expect(h.opus.length).toBeGreaterThan(150)
    expect(h.opus.every((f) => f.bytes > 0)).toBe(true)
    // Monotonic, and spanning roughly the clip: 4 s at 48 kHz is 192 000 ticks.
    const first = h.opus[0]?.ts ?? 0
    const last = h.opus[h.opus.length - 1]?.ts ?? 0
    expect(last - first).toBeGreaterThan(48_000 * 3.5)
    expect(last - first).toBeLessThan(48_000 * 4.5)
    for (let i = 1; i < h.opus.length; i++) {
      expect(h.opus[i]?.ts).toBeGreaterThan(h.opus[i - 1]?.ts ?? 0)
    }
    await expect(h.feeder.audio?.()).resolves.toEqual({
      carried: true,
      codec: 'opus',
      reason: null,
    })
  })

  it('pushes fixed 160-byte µ-law frames at the 8 kHz clock, re-cut from the runs', async () => {
    const h = harness({ fixture: PCMU, audio: 'pcmu' })
    void h.feeder.seek(0)
    await settle()
    h.deliver()
    h.end()
    playOut()
    expect(h.pcmu.length).toBeGreaterThan(150)
    expect(h.pcmu.every((f) => f.bytes === 160)).toBe(true)
    // 20 ms at 8 kHz is exactly 160 ticks, every time.
    for (let i = 1; i < h.pcmu.length; i++) {
      expect((h.pcmu[i]?.ts ?? 0) - (h.pcmu[i - 1]?.ts ?? 0)).toBe(160)
    }
  })

  it('interleaves sound with picture on ONE schedule — neither is delivered in a burst', async () => {
    const h = harness({ audio: 'opus' })
    void h.feeder.seek(0)
    await settle()
    h.deliver()
    h.end()
    // A quarter of the clip in: roughly a quarter of BOTH tracks has gone out.
    vi.advanceTimersByTime(1_000)
    expect(h.video.length).toBeGreaterThan(10)
    expect(h.video.length).toBeLessThan(25)
    expect(h.opus.length).toBeGreaterThan(30)
    expect(h.opus.length).toBeLessThan(70)
    playOut()
    expect(h.video.length).toBe(60)
  })

  it('puts both tracks on ONE clock, and keeps them there across repeated seeks', async () => {
    // The invariant: `output instant - source instant` is the SAME constant
    // for sound and picture, at every moment of playback. A second clock for
    // audio re-bases on its OWN last output at each discontinuity, so the two
    // constants walk apart by roughly a frame per seek — invisible on a short
    // clip, audible on a long one, and impossible to attribute afterwards.
    const h = harness({ audio: 'opus' })
    const sources = demuxedPts(OPUS)
    void h.feeder.seek(0)
    await settle()
    h.deliver()
    h.end()
    vi.advanceTimersByTime(20)
    // Three forward seeks, each landing on a different GOP.
    for (const target of [1_000, 2_000, 3_000]) {
      await h.feeder.seek(target)
      vi.advanceTimersByTime(80)
    }
    playOut()
    // Zip the pushes back onto the source timestamps they came from: the
    // feeder pushes in demux order and drops only from the FRONT of a run,
    // so the tail of each list lines up with the tail of its source list.
    const videoOffset = trailingOffsets(h.video, sources.video, 90)
    const audioOffset = trailingOffsets(h.opus, sources.audio, 48)
    expect(videoOffset.length).toBeGreaterThan(5)
    expect(audioOffset.length).toBeGreaterThan(20)
    const lastVideo = videoOffset[videoOffset.length - 1] ?? 0
    const lastAudio = audioOffset[audioOffset.length - 1] ?? 0
    // One clock ⇒ the two constants are the same to within a rounding tick.
    // Two clocks ⇒ this is hundreds of milliseconds after three seeks.
    expect(Math.abs(lastAudio - lastVideo)).toBeLessThan(2)
  })

  it('names a recording with no audio track, and plays the picture anyway', async () => {
    const h = harness({ fixture: SILENT, audio: 'opus' })
    void h.feeder.seek(0)
    await settle()
    h.deliver()
    h.end()
    playOut()
    expect(h.video.length).toBeGreaterThan(0)
    expect(h.opus).toHaveLength(0)
    await expect(h.feeder.audio?.()).resolves.toEqual({
      carried: false,
      codec: null,
      reason: 'no-audio-track',
    })
    expect(h.log('clip-stream:audio-absent')).toHaveLength(1)
  })

  it('names a provider that did not offer the codec, before a byte arrives', async () => {
    const h = harness({ audio: 'opus', servedAudio: 'none', audioReason: 'not-requested' })
    void h.feeder.seek(0)
    await settle()
    const line = h.log('clip-stream:audio-not-offered')[0]
    expect(line?.data['asked']).toBe('opus')
    expect(line?.data['servedAudio']).toBe('none')
    await expect(h.feeder.audio?.()).resolves.toEqual({
      carried: false,
      codec: null,
      reason: 'not-offered',
      detail: 'not-requested',
    })
  })

  it('refuses a codec the session did not negotiate rather than re-encoding it', async () => {
    // A `pcmu` session handed the Opus stream: the provider and the broker
    // disagree, and this hop has no decoder. Named, never guessed at.
    const h = harness({ fixture: OPUS, audio: 'pcmu' })
    void h.feeder.seek(0)
    await settle()
    h.deliver()
    h.end()
    playOut()
    expect(h.pcmu).toHaveLength(0)
    expect(h.video.length).toBe(60)
    const line = h.log('clip-stream:audio-codec-mismatch')[0]
    expect(line?.data['asked']).toBe('pcmu')
    expect(line?.data['got']).toBe('opus')
    await expect(h.feeder.audio?.()).resolves.toEqual({
      carried: false,
      codec: null,
      reason: 'codec-mismatch',
    })
  })

  it('DROPS sound whose moment has passed rather than bursting it, and counts it', async () => {
    const h = harness({ audio: 'opus' })
    void h.feeder.seek(0)
    await settle()
    h.deliver()
    h.end()
    // The WALL clock jumps two seconds without a single timer running — a
    // stalled event loop, which is the shape that produces a burst. When the
    // loop resumes, two seconds of sound is already in the past.
    vi.setSystemTime(Date.now() + 2_000)
    vi.advanceTimersByTime(1)
    // Under a fifth of a second of sound went out, not the two seconds that
    // came due: the rest is dropped rather than fired off in one go.
    expect(h.opus.length).toBeLessThan(12)
    playOut()
    const line = h.log('clip-stream:played-out')[0]
    expect(Number(line?.data['audioDroppedLate'])).toBeGreaterThan(50)
    expect(Number(line?.data['audioPushed'])).toBe(h.opus.length)
    expect(line?.data['audioCarried']).toBe(true)
  })

  it('drops sound at any rate but 1x, counted apart from the late ones', async () => {
    const h = harness({ audio: 'opus' })
    void h.feeder.seek(0)
    await settle()
    h.feeder.setRate(2)
    h.deliver()
    h.end()
    playOut()
    expect(h.opus).toHaveLength(0)
    const line = h.log('clip-stream:played-out')[0]
    expect(Number(line?.data['audioDroppedRate'])).toBeGreaterThan(150)
    expect(Number(line?.data['audioDroppedLate'])).toBe(0)
  })

  describe('and SAYS that the rate is why (D391, D621)', () => {
    /** Every report the feeder has handed out, settle first. */
    function watched(h: ReturnType<typeof harness>): ClipAudioReport[] {
      const seen: ClipAudioReport[] = []
      h.feeder.watchAudio?.((report) => seen.push(report))
      return seen
    }

    it('turns a carried clip into a `rate` silence that NAMES the rate', async () => {
      // The defect being closed: this clip HAS sound — it is silent only
      // because the operator pressed 2× — and until now the viewer was told
      // nothing, so it looked exactly like a clip whose camera has no
      // microphone or whose stream broke.
      const h = harness({ audio: 'opus' })
      const seen = watched(h)
      void h.feeder.seek(0)
      await settle()
      h.deliver()
      h.end()
      playOut()
      expect(await h.feeder.audio?.()).toMatchObject({ carried: true, codec: 'opus' })
      expect(seen).toEqual([])

      h.feeder.setRate(2)
      expect(seen).toEqual([{ carried: false, codec: null, reason: 'rate', rate: 2 }])

      // And BACK: the sound returns, so the report does.
      h.feeder.setRate(1)
      expect(seen[1]).toMatchObject({ carried: true, codec: 'opus', reason: null })
      expect(seen).toHaveLength(2)
    })

    it('never says it TWICE for the same answer, and never says PAUSE is a rate', async () => {
      const h = harness({ audio: 'opus' })
      const seen = watched(h)
      void h.feeder.seek(0)
      await settle()
      h.deliver()
      h.end()
      playOut()
      h.feeder.setRate(2)
      expect(seen).toHaveLength(1)
      // 4 is still "not 1×", but it is a DIFFERENT rate, so the message that
      // names the rate has to be re-sent or it names the wrong one.
      h.feeder.setRate(4)
      expect(seen[1]).toMatchObject({ reason: 'rate', rate: 4 })
      // Pause is the absence of a rate, not a rate: nothing plays at all, and
      // a `clipAudio` claiming the SPEED is why would be false.
      h.feeder.setRate(0)
      expect(seen).toHaveLength(2)
      h.feeder.setRate(4)
      expect(seen).toHaveLength(2)
    })

    it('leaves a clip that never had sound alone — the rate is not the cause', async () => {
      // A camera with no microphone is silent at 1× too. Overwriting
      // `no-audio-track` with `rate` would replace the true cause with a
      // transient one and send the operator to the speed chip.
      const h = harness({ audio: 'opus', fixture: SILENT })
      const seen = watched(h)
      void h.feeder.seek(0)
      await settle()
      h.deliver()
      h.end()
      playOut()
      expect(await h.feeder.audio?.()).toMatchObject({ carried: false, reason: 'no-audio-track' })
      h.feeder.setRate(2)
      h.feeder.setRate(1)
      expect(seen).toEqual([])
    })
  })

  it('reports the first audio push with how late it was', async () => {
    const h = harness({ audio: 'opus' })
    void h.feeder.seek(0)
    await settle()
    h.deliver()
    h.end()
    playOut()
    const first = h.log('clip-stream:first-audio')
    expect(first).toHaveLength(1)
    expect(first[0]?.data['deviceId']).toBe(107)
    expect(Number(first[0]?.data['lateMs'])).toBeLessThan(120)
  })

  it('settles the audio answer when the stream is cut before its moov', async () => {
    const h = harness({ audio: 'opus' })
    void h.feeder.seek(0)
    await settle()
    h.deliver(0, 8)
    h.feeder.dispose()
    await expect(h.feeder.audio?.()).resolves.toEqual({
      carried: false,
      codec: null,
      reason: 'stream-failed',
    })
  })
})
