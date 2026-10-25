/**
 * The producer: what reaches the peer, what refuses, and what can no longer
 * cut a run that has answered.
 *
 * The replay and the mux are seams, but the ACCESS UNITS are the fixture's
 * real ones — the same six the depacketizer builds from 3833's own bytes — so
 * the probe window, the rate and the held-unit flush are exercised against
 * media, not against a shape invented here.
 *
 * The fake mux's pipes report BACK-PRESSURE on every write (`highWaterMark: 1`)
 * rather than swallowing it: a `PassThrough` answers `true` and would make the
 * D447 wiring inert in every one of these tests. The gate's own state machine
 * is proved apart, against a clock, in `clip-mux-and-rate.spec.ts` — including
 * the case that matters most, a gate armed at EOF that can never be disarmed.
 */
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'

import type { IScopedLogger } from '@camstack/types'

import type { HikvisionClipRow } from '../clip-catalog.js'
import { CLIP_STREAM_DRAIN_TIMEOUT_MS } from '../clip-stream-mux.js'
import {
  CLIP_STREAM_INIT_ONLY_BYTES,
  CLIP_STREAM_NO_MEDIA_ACCESS_UNITS,
  createClipStreamProducer,
  type ClipStreamSink,
} from '../clip-stream.js'
import {
  createRtpVideoDepacketizer,
  parseRtpPacket,
  type VideoAccessUnit,
} from '../rtsp/rtp-depacketize.js'
import { parseRtspSdp, type RtspVideoTrack } from '../rtsp/rtsp-sdp.js'
import { createRtspWireReader } from '../rtsp/rtsp-wire.js'
import type {
  RtspReplayEnd,
  RtspReplayHandlers,
  RtspReplaySession,
} from '../rtsp/rtsp-replay-session.js'

const FIXTURES = join(import.meta.dirname, 'fixtures')

const logger: IScopedLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: () => logger,
  withTags: () => logger,
}

const ROW: HikvisionClipRow = {
  clipKey: 'a'.repeat(40),
  trackId: 101,
  fileName: 'ch01_00000000447001',
  startMs: 1_790_000_000_000,
  endMs: 1_790_000_019_000,
  playbackPath: '/Streaming/tracks/101/?starttime=20260922T152742Z&endtime=20260922T152801Z',
  sizeBytes: 11_600_000,
  recordTypes: ['motion'],
}

const CAMERA = { deviceId: 3833, host: '203.0.113.1', username: 'u', password: 'p' }

/** The six real access units of the fixture replay, and its µ-law payloads. */
function fixtureMedia(): { units: readonly VideoAccessUnit[]; audio: readonly Buffer[] } {
  const video = parseRtspSdp(readFileSync(join(FIXTURES, 'replay-3833.sdp'), 'utf8')).tracks.find(
    (track): track is RtspVideoTrack => track.kind === 'video',
  )
  if (video === undefined) throw new Error('no video track in the fixture SDP')
  const depacketizer = createRtpVideoDepacketizer({
    codec: video.codec,
    parameterSets: video.parameterSets,
  })
  const units: VideoAccessUnit[] = []
  const audio: Buffer[] = []
  const reader = createRtspWireReader()
  for (const event of reader.push(readFileSync(join(FIXTURES, 'replay-3833-interleaved.bin')))) {
    if (event.kind !== 'interleaved') continue
    const packet = parseRtpPacket(event.payload)
    if (packet === null) continue
    if (event.channel === 0) {
      const unit = depacketizer.push(packet)
      if (unit !== null) units.push(unit)
      continue
    }
    audio.push(packet.payload)
  }
  const tail = depacketizer.flush()
  if (tail !== null) units.push(tail)
  return { units, audio }
}

const MEDIA = fixtureMedia()
const VIDEO_TRACK: RtspVideoTrack = {
  kind: 'video',
  codec: 'h265',
  payloadType: 96,
  clockRate: 90_000,
  control: 'trackID=1',
  parameterSets: [],
}

interface FakeReplay {
  readonly open: (
    target: unknown,
    handlers: RtspReplayHandlers,
    deps: unknown,
  ) => Promise<RtspReplaySession>
  /** The fixture's own six units, interleaved with its µ-law payloads. */
  deliver(): void
  deliverUnits(units: readonly VideoAccessUnit[]): void
  deliverAudio(payloads: readonly Buffer[]): void
  finish(end: RtspReplayEnd): void
  readonly closed: () => boolean
}

function fakeReplay(options: { hasAudio: boolean; failOpen?: string }): FakeReplay {
  let handlers: RtspReplayHandlers | null = null
  let settle: ((end: RtspReplayEnd) => void) | null = null
  let closed = false
  const ended = new Promise<RtspReplayEnd>((resolve) => {
    settle = resolve
  })
  return {
    closed: () => closed,
    open: async (_target, given) => {
      if (options.failOpen !== undefined) throw new Error(options.failOpen)
      handlers = given
      return {
        ended,
        video: VIDEO_TRACK,
        hasAudio: options.hasAudio,
        close: async () => {
          closed = true
        },
      }
    },
    deliver: () => {
      for (const [index, unit] of MEDIA.units.entries()) {
        handlers?.onVideo(unit)
        const payload = MEDIA.audio[index]
        if (payload !== undefined) handlers?.onAudio?.(payload, index * 160)
      }
    },
    deliverUnits: (units) => {
      for (const unit of units) handlers?.onVideo(unit)
    },
    deliverAudio: (payloads) => {
      for (const [index, payload] of payloads.entries()) handlers?.onAudio?.(payload, index * 160)
    },
    finish: (end) => settle?.(end),
  }
}

interface FakeMux {
  readonly spawn: (args: readonly string[]) => ChildProcess
  readonly args: () => readonly string[]
  emit(chunk: Buffer): void
  close(code: number): void
  readonly videoBytes: () => number
  readonly audioBytes: () => number
  readonly killed: () => boolean
  /** Whether the producer has applied back-pressure to ffmpeg's output. */
  readonly stdoutPaused: () => boolean
  stderrEmit(text: string): void
}

/**
 * An fd-3 stand-in that counts every byte AND reports back-pressure.
 *
 * `highWaterMark: 1` makes `write()` answer `false` on every call, so the
 * producer's drain gate is really fed a refusal rather than a `true` that
 * would make the D447 wiring inert here. The gate's own state machine is
 * proved apart, in `clip-mux-and-rate.spec.ts`, against a clock.
 */
function countingPipe(count: (bytes: number) => void): Writable {
  return new Writable({
    highWaterMark: 1,
    write(chunk: Buffer, _encoding, callback) {
      count(chunk.byteLength)
      callback()
    },
  })
}

/** An fd-3 that answers `false` and NEVER drains — ffmpeg ahead on audio. */
function deadPipe(count: (bytes: number) => void): Writable {
  return new Writable({
    highWaterMark: 1,
    write(chunk: Buffer) {
      // No callback, ever: `write()` answers false and Node emits no `drain`.
      count(chunk.byteLength)
    },
  })
}

interface FakeMuxOptions {
  readonly drains?: boolean
  /** `false` ⇒ fd 3 refuses every write and never drains again. */
  readonly audioDrains?: boolean
}

function fakeMux(options: FakeMuxOptions = {}): FakeMux {
  let seen: readonly string[] = []
  let videoBytes = 0
  let audioBytes = 0
  let killed = false
  const stdout = new PassThrough()
  const drains = options.drains ?? true
  const stdin = drains
    ? new PassThrough()
    : countingPipe((bytes) => {
        videoBytes += bytes
      })
  if (drains) {
    stdin.on('data', (chunk: Buffer) => {
      videoBytes += chunk.byteLength
    })
  }
  const audio = (options.audioDrains === false ? deadPipe : countingPipe)((bytes) => {
    audioBytes += bytes
  })
  const stderr = new PassThrough()
  const child = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr,
    stdio: [stdin, stdout, new PassThrough(), audio],
    kill: () => {
      killed = true
      return true
    },
  })
  return {
    spawn: (args) => {
      seen = args
      // A ChildProcess shape is structural here: the producer touches stdin,
      // stdout, stderr, stdio[3], `on` and `kill`, and nothing else.
      return child as unknown as ChildProcess
    },
    args: () => seen,
    stdoutPaused: () => stdout.isPaused(),
    emit: (chunk) => stdout.write(chunk),
    stderrEmit: (text) => stderr.write(Buffer.from(text)),
    close: (code) => child.emit('close', code),
    videoBytes: () => videoBytes,
    audioBytes: () => audioBytes,
    killed: () => killed,
  }
}

interface Recorded {
  readonly chunks: Buffer[]
  contentType: string | null
  ended: boolean
  destroyed: boolean
  drain: (() => void) | null
  close: (() => void) | null
}

function recordingSink(taken = true): { sink: ClipStreamSink; state: Recorded } {
  const state: Recorded = {
    chunks: [],
    contentType: null,
    ended: false,
    destroyed: false,
    drain: null,
    close: null,
  }
  return {
    state,
    sink: {
      begin: (contentType) => {
        state.contentType = contentType
      },
      write: (chunk) => {
        state.chunks.push(chunk)
        return taken
      },
      onceDrain: (listener) => {
        state.drain = listener
      },
      onceClose: (listener) => {
        state.close = listener
      },
      end: () => {
        state.ended = true
      },
      destroy: () => {
        state.destroyed = true
      },
    },
  }
}

describe('the clip stream producer', () => {
  it('REFUSES before dialling when the pinned ffmpeg cannot be had — and RECOVERS on the next stream (D540)', async () => {
    // The replay fails at SETUP once reached, so "the dial happened" is
    // observable without a real mux.
    const replay = fakeReplay({ hasAudio: true, failOpen: 'SETUP of the video track answered 500' })
    const open = vi.fn(replay.open)
    let calls = 0
    const producer = createClipStreamProducer({
      resolveFfmpeg: async () => {
        calls += 1
        if (calls === 1) throw new Error('download failed')
        return '/deps/ffmpeg-pinned'
      },
      logger,
      openReplay: open,
    })
    const first = recordingSink()
    const refused = await producer.stream({
      camera: CAMERA,
      row: ROW,
      audio: 'none',
      sink: first.sink,
    })
    expect(refused).toEqual({
      kind: 'refused',
      code: 'fetch-failed',
      detail: 'no pinned ffmpeg on this node: download failed',
    })
    expect(open).not.toHaveBeenCalled()
    expect(first.state.chunks).toEqual([])

    // Same producer, no restart: the resolver is asked again and the dial runs.
    const second = recordingSink()
    const dialled = await producer.stream({
      camera: CAMERA,
      row: ROW,
      audio: 'none',
      sink: second.sink,
    })
    expect(open).toHaveBeenCalledOnce()
    expect(dialled).toMatchObject({ kind: 'refused', code: 'camera-refused' })
  })

  it('refuses, with the camera’s own words, when the replay will not open', async () => {
    const replay = fakeReplay({ hasAudio: true, failOpen: 'SETUP of the video track answered 500' })
    const { sink, state } = recordingSink()
    // A pinned binary is present — the replay fails before it would be spawned.
    const producer = createClipStreamProducer({
      resolveFfmpeg: async () => '/deps/ffmpeg-pinned',
      logger,
      openReplay: replay.open,
    })
    const outcome = await producer.stream({ camera: CAMERA, row: ROW, audio: 'none', sink })
    expect(outcome).toEqual({
      kind: 'refused',
      code: 'camera-refused',
      detail: 'SETUP of the video track answered 500',
    })
    // Nothing reached the peer, so the status line is still the route's.
    expect(state.contentType).toBeNull()
    expect(state.chunks).toEqual([])
  })

  it('holds the probe window, measures the rate, and flushes what it held', async () => {
    const replay = fakeReplay({ hasAudio: false })
    const mux = fakeMux()
    const { sink, state } = recordingSink()
    const producer = createClipStreamProducer({
      resolveFfmpeg: async () => '/deps/ffmpeg-pinned',
      logger,
      openReplay: replay.open,
      spawnMux: mux.spawn,
      probeAccessUnits: 4,
    })
    const running = producer.stream({ camera: CAMERA, row: ROW, audio: 'none', sink })
    await Promise.resolve()
    replay.deliver()
    await Promise.resolve()
    // 12.5 fps, measured from the fixture's own 90 kHz stamps — not the 2.26
    // the camera declares and not ffmpeg's 25.
    expect(mux.args().join(' ')).toContain('-r 12.5')
    expect(mux.args().join(' ')).toContain('-f hevc -i pipe:0')
    // Every held unit was written, not dropped: the probe holds, it never eats.
    expect(mux.videoBytes()).toBe(MEDIA.units.reduce((sum, unit) => sum + unit.bytes.byteLength, 0))
    mux.emit(Buffer.from('ftyp'))
    expect(state.contentType).toBe('video/mp4')
    replay.finish({ kind: 'complete', deliveredMs: 480 })
    await Promise.resolve()
    mux.close(0)
    expect(await running).toEqual({ kind: 'served' })
    expect(state.ended).toBe(true)
    expect(Buffer.concat(state.chunks).toString()).toBe('ftyp')
  })

  it('stops probing the moment a metronomic clock has already said the rate', async () => {
    // The window is a BOUND, not a quota. This replay arrives at 1×, so the
    // twelve units the old code went on holding after the answer was in hand
    // measured 960 ms of the operator's wait for a number that could not
    // change (D616). The full window is left in place for a clock that varies.
    const replay = fakeReplay({ hasAudio: false })
    const mux = fakeMux()
    const { sink } = recordingSink()
    const producer = createClipStreamProducer({
      resolveFfmpeg: async () => '/deps/ffmpeg-pinned',
      logger,
      openReplay: replay.open,
      spawnMux: mux.spawn,
      probeAccessUnits: 16,
    })
    void producer.stream({ camera: CAMERA, row: ROW, audio: 'none', sink })
    await Promise.resolve()
    replay.deliverUnits(MEDIA.units.slice(0, 3))
    await Promise.resolve()
    // Three units is two spans: not yet enough to tell a metronome from a
    // coincidence of two equal integers.
    expect(mux.args()).toEqual([])
    replay.deliverUnits(MEDIA.units.slice(3, 4))
    await Promise.resolve()
    expect(mux.args().join(' ')).toContain('-r 12.5')
  })

  it('CUTS a mux that takes frames and produces only a header, with ffmpeg’s words', async () => {
    // Measured on 1436 from the operator's own attempt: 129 access units in,
    // 1 298 bytes out — ten bytes per frame of 4K HEVC — and the ONLY evidence
    // anywhere was `pushed: 0` on the broker and a peer that gave up 10.6 s
    // later. A branch that accepts work and produces nothing is the branch
    // D391 names, and this one said nothing at all.
    const replay = fakeReplay({ hasAudio: false })
    const mux = fakeMux()
    const { sink, state } = recordingSink()
    const producer = createClipStreamProducer({
      resolveFfmpeg: async () => '/deps/ffmpeg-pinned',
      logger,
      openReplay: replay.open,
      spawnMux: mux.spawn,
      probeAccessUnits: 4,
    })
    const running = producer.stream({ camera: CAMERA, row: ROW, audio: 'none', sink })
    await Promise.resolve()
    replay.deliverUnits(MEDIA.units.slice(0, 4))
    await Promise.resolve()
    // An init segment and nothing more, exactly as the live failure looked.
    mux.emit(Buffer.alloc(1_298))
    mux.stderrEmit('[mp4 @ 0x1] dimensions not set')
    expect(state.contentType).toBe('video/mp4')
    // Now feed it frames. Past the bound it must be cut, not left to the peer.
    for (let i = 0; i < CLIP_STREAM_NO_MEDIA_ACCESS_UNITS; i += 1) {
      replay.deliverUnits(MEDIA.units.slice(0, 1))
    }
    await Promise.resolve()
    expect(await running).toEqual({ kind: 'cut' })
    const line = logger.warn as unknown as ReturnType<typeof vi.fn>
    const cut = line.mock.calls.find((call) => call[0] === 'videoclips: a clip stream was cut')
    expect(cut?.[1]?.meta).toMatchObject({ branch: 'mux-no-media' })
    // ffmpeg's own words travel with it — the whole point.
    expect(String(cut?.[1]?.meta?.reason)).toContain('dimensions not set')
    expect(String(cut?.[1]?.meta?.muxStderr)).toContain('dimensions not set')
  })

  it('does NOT cut a healthy stream that has simply not filled a fragment yet', async () => {
    // The bound is one GOP and change (64 units = 5.1 s at 12.5 fps against a
    // 50-frame GOP), so a stream that is merely slow must survive it.
    const replay = fakeReplay({ hasAudio: false })
    const mux = fakeMux()
    const { sink } = recordingSink()
    const producer = createClipStreamProducer({
      resolveFfmpeg: async () => '/deps/ffmpeg-pinned',
      logger,
      openReplay: replay.open,
      spawnMux: mux.spawn,
      probeAccessUnits: 4,
    })
    void producer.stream({ camera: CAMERA, row: ROW, audio: 'none', sink })
    await Promise.resolve()
    replay.deliverUnits(MEDIA.units.slice(0, 4))
    await Promise.resolve()
    // A real fragment, over the floor.
    mux.emit(Buffer.alloc(CLIP_STREAM_INIT_ONLY_BYTES + 1))
    for (let i = 0; i < CLIP_STREAM_NO_MEDIA_ACCESS_UNITS * 2; i += 1) {
      replay.deliverUnits(MEDIA.units.slice(0, 1))
    }
    await Promise.resolve()
    expect(mux.killed()).toBe(false)
  })

  it('refuses by name when the rate cannot be measured inside the widened window', async () => {
    const replay = fakeReplay({ hasAudio: false })
    const mux = fakeMux()
    const { sink, state } = recordingSink()
    const producer = createClipStreamProducer({
      resolveFfmpeg: async () => '/deps/ffmpeg-pinned',
      logger,
      openReplay: replay.open,
      spawnMux: mux.spawn,
      probeAccessUnits: 2,
      maxProbeAccessUnits: 4,
    })
    const running = producer.stream({ camera: CAMERA, row: ROW, audio: 'none', sink })
    await Promise.resolve()
    // Real units, every one claiming the same instant: a span of zero says
    // nothing about a rate. The window WIDENS first — it is not a deadline —
    // and only past the bound is the stream refused.
    const frozen = MEDIA.units.map((unit) => ({ ...unit, timestamp: 90_000 }))
    replay.deliverUnits(frozen.slice(0, 3))
    expect(mux.args()).toEqual([])
    replay.deliverUnits(frozen.slice(3))
    const outcome = await running
    expect(outcome.kind).toBe('refused')
    if (outcome.kind !== 'refused') return
    expect(outcome.code).toBe('fetch-failed')
    expect(outcome.detail).toContain('rate-unmeasured')
    // Refused BEFORE a byte reached the peer, so the route still owns the
    // status line and the camera is not retried.
    expect(mux.args()).toEqual([])
    expect(state.contentType).toBeNull()
    expect(replay.closed()).toBe(true)
  })

  it('WIDENS the probe when the first window cannot measure, and then muxes', async () => {
    const replay = fakeReplay({ hasAudio: false })
    const mux = fakeMux()
    const { sink } = recordingSink()
    const producer = createClipStreamProducer({
      resolveFfmpeg: async () => '/deps/ffmpeg-pinned',
      logger,
      openReplay: replay.open,
      spawnMux: mux.spawn,
      probeAccessUnits: 2,
      maxProbeAccessUnits: 8,
    })
    void producer.stream({ camera: CAMERA, row: ROW, audio: 'none', sink })
    await Promise.resolve()
    // Two units at the same instant: the first window says nothing.
    replay.deliverUnits(MEDIA.units.slice(0, 2).map((unit) => ({ ...unit, timestamp: 90_000 })))
    expect(mux.args()).toEqual([])
    // The window is WIDENED rather than judged, and the units that follow
    // carry a span — so the clip is muxed at a rate it really measured.
    replay.deliverUnits(MEDIA.units.slice(2))
    expect(mux.args().length).toBeGreaterThan(0)
    expect(mux.args()).toContain('-r')
  })

  it('carries sound only when a payload is already held when the mux is spawned', async () => {
    const replay = fakeReplay({ hasAudio: true })
    const mux = fakeMux()
    const { sink } = recordingSink()
    const producer = createClipStreamProducer({
      resolveFfmpeg: async () => '/deps/ffmpeg-pinned',
      logger,
      openReplay: replay.open,
      spawnMux: mux.spawn,
      probeAccessUnits: 4,
    })
    void producer.stream({ camera: CAMERA, row: ROW, audio: 'pcmu', sink })
    await Promise.resolve()
    replay.deliver()
    await Promise.resolve()
    expect(mux.args().join(' ')).toContain('-f mulaw -ar 8000 -ac 1 -i pipe:3')
    expect(mux.args().join(' ')).toContain('-c:a copy')
    // Nothing is lost across the spawn: the payloads HELD during the probe and
    // the ones that arrived after it are both written, once each.
    expect(mux.audioBytes()).toBe(
      MEDIA.audio.slice(0, MEDIA.units.length).reduce((sum, p) => sum + p.byteLength, 0),
    )
  })

  it('does not cut a stream for an audio pipe that is quiet while ffmpeg is still producing', async () => {
    // MEASURED on 1436, 2026-09-23, from the operator's own session:
    // `branch: "mux-audio-stalled"`, `bytesOut: 9 993 026`, `accessUnits:
    // 251`, `elapsedMs: 24 941`. The µ-law pipe holds 64 KiB — EIGHT SECONDS
    // of 8 kHz sound — and once ffmpeg is that far ahead on audio it stops
    // reading fd 3 and Node emits no further `drain`. The gate then fires on
    // a mux that was healthy and delivering ten megabytes.
    //
    // The video gate cannot reach this state: one 4K access unit is half a
    // megabyte, so ffmpeg drains stdin constantly. Only the audio hop is
    // quiet by design, which is why only this one had to learn the
    // difference between "not hungry" and "dead".
    vi.useFakeTimers()
    try {
      const replay = fakeReplay({ hasAudio: true })
      const mux = fakeMux({ audioDrains: false })
      const { sink, state } = recordingSink()
      const producer = createClipStreamProducer({
        resolveFfmpeg: async () => '/deps/ffmpeg-pinned',
        logger,
        openReplay: replay.open,
        spawnMux: mux.spawn,
        probeAccessUnits: 4,
      })
      const run = producer.stream({ camera: CAMERA, row: ROW, audio: 'pcmu', sink })
      await Promise.resolve()
      replay.deliver()
      await Promise.resolve()
      // fd 3 refused every write and will never drain again. ffmpeg keeps
      // handing bytes to the peer the whole time.
      for (let i = 0; i < 6; i++) {
        mux.emit(Buffer.alloc(64 * 1024, i))
        vi.advanceTimersByTime(CLIP_STREAM_DRAIN_TIMEOUT_MS)
      }
      expect(state.destroyed).toBe(false)
      expect(state.chunks.length).toBe(6)
      // …and the re-arm SAYS SO, once. A gate that keeps re-arming on a
      // healthy run is invisible otherwise, and it is the only thing between a
      // quiet µ-law pipe and a severed stream — D391's own case. Deleting the
      // line left every assertion above green when this was disarmed, so it is
      // asserted here rather than only promised by a comment.
      const info = logger.info as unknown as ReturnType<typeof vi.fn>
      const rearm = info.mock.calls.filter(
        (call) => call[0] === 'videoclips: the mux is not taking audio but is still producing',
      )
      expect(rearm).toHaveLength(1)
      expect(rearm[0]?.[1]?.tags).toMatchObject({ deviceId: CAMERA.deviceId })
      expect(Number(rearm[0]?.[1]?.meta?.bytesOut)).toBeGreaterThan(0)
      replay.finish({ kind: 'complete', deliveredMs: 1_000 })
      mux.close(0)
      await expect(run).resolves.toEqual({ kind: 'served' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('DOES cut when the audio pipe is quiet and ffmpeg has stopped producing too', async () => {
    vi.useFakeTimers()
    try {
      const replay = fakeReplay({ hasAudio: true })
      const mux = fakeMux({ audioDrains: false })
      const { sink, state } = recordingSink()
      const producer = createClipStreamProducer({
        resolveFfmpeg: async () => '/deps/ffmpeg-pinned',
        logger,
        openReplay: replay.open,
        spawnMux: mux.spawn,
        probeAccessUnits: 4,
      })
      const run = producer.stream({ camera: CAMERA, row: ROW, audio: 'pcmu', sink })
      await Promise.resolve()
      replay.deliver()
      await Promise.resolve()
      // One byte out, and then nothing for two whole windows.
      mux.emit(Buffer.alloc(16))
      vi.advanceTimersByTime(CLIP_STREAM_DRAIN_TIMEOUT_MS * 3)
      expect(state.destroyed).toBe(true)
      await expect(run).resolves.toEqual({ kind: 'cut' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('muxes SILENT when the ask arrived and no audio did — the video is not held hostage', async () => {
    const replay = fakeReplay({ hasAudio: false })
    const mux = fakeMux()
    const { sink } = recordingSink()
    const producer = createClipStreamProducer({
      resolveFfmpeg: async () => '/deps/ffmpeg-pinned',
      logger,
      openReplay: replay.open,
      spawnMux: mux.spawn,
      probeAccessUnits: 4,
    })
    void producer.stream({ camera: CAMERA, row: ROW, audio: 'opus', sink })
    await Promise.resolve()
    replay.deliverUnits(MEDIA.units)
    await Promise.resolve()
    // ffmpeg probes every input before it writes output, so an input that
    // never delivers would hold the picture hostage (D600).
    expect(mux.args()).not.toContain('pipe:3')
    expect(mux.args().join(' ')).toContain('-f hevc -i pipe:0')
  })

  it('never follows the audio track at all when the ask is `none`', async () => {
    const replay = fakeReplay({ hasAudio: true })
    const mux = fakeMux()
    const { sink } = recordingSink()
    const producer = createClipStreamProducer({
      resolveFfmpeg: async () => '/deps/ffmpeg-pinned',
      logger,
      openReplay: replay.open,
      spawnMux: mux.spawn,
      probeAccessUnits: 4,
    })
    void producer.stream({ camera: CAMERA, row: ROW, audio: 'none', sink })
    await Promise.resolve()
    replay.deliver()
    await Promise.resolve()
    expect(mux.audioBytes()).toBe(0)
    expect(mux.args()).not.toContain('pipe:3')
  })

  it('CUTS, rather than refusing, once bytes have reached the peer', async () => {
    const replay = fakeReplay({ hasAudio: false })
    const mux = fakeMux()
    const { sink, state } = recordingSink()
    const producer = createClipStreamProducer({
      resolveFfmpeg: async () => '/deps/ffmpeg-pinned',
      logger,
      openReplay: replay.open,
      spawnMux: mux.spawn,
      probeAccessUnits: 4,
    })
    const running = producer.stream({ camera: CAMERA, row: ROW, audio: 'none', sink })
    await Promise.resolve()
    replay.deliver()
    await Promise.resolve()
    mux.emit(Buffer.from('ftyp'))
    // The peer walks away: holding the camera's replay open for a socket
    // nobody reads is the one thing a bounded producer must not do.
    state.close?.()
    expect(await running).toEqual({ kind: 'cut' })
    expect(state.destroyed).toBe(true)
    expect(replay.closed()).toBe(true)
  })

  it('cannot be cut after it has ANSWERED', async () => {
    const replay = fakeReplay({ hasAudio: false })
    const mux = fakeMux()
    const { sink, state } = recordingSink()
    const producer = createClipStreamProducer({
      resolveFfmpeg: async () => '/deps/ffmpeg-pinned',
      logger,
      openReplay: replay.open,
      spawnMux: mux.spawn,
      probeAccessUnits: 4,
    })
    const running = producer.stream({ camera: CAMERA, row: ROW, audio: 'none', sink })
    await Promise.resolve()
    replay.deliver()
    await Promise.resolve()
    mux.emit(Buffer.from('ftyp'))
    replay.finish({ kind: 'complete', deliveredMs: 480 })
    await Promise.resolve()
    mux.close(0)
    expect(await running).toEqual({ kind: 'served' })
    // A late sever would destroy a finished response and file a SERVED stream
    // as a defect — which is exactly what one operator log did (D604).
    state.close?.()
    expect(state.destroyed).toBe(false)
  })

  it('refuses when ffmpeg exits having produced nothing', async () => {
    const replay = fakeReplay({ hasAudio: false })
    const mux = fakeMux()
    const { sink, state } = recordingSink()
    const producer = createClipStreamProducer({
      resolveFfmpeg: async () => '/deps/ffmpeg-pinned',
      logger,
      openReplay: replay.open,
      spawnMux: mux.spawn,
      probeAccessUnits: 4,
    })
    const running = producer.stream({ camera: CAMERA, row: ROW, audio: 'none', sink })
    await Promise.resolve()
    replay.deliver()
    await Promise.resolve()
    // A branch that ACCEPTS work and produces nothing is the same branch as
    // one that drops it (D391): it is named, not quietly answered served.
    mux.close(1)
    const outcome = await running
    expect(outcome.kind).toBe('refused')
    expect(state.ended).toBe(false)
  })

  it('refuses when the replay ends before the probe could measure', async () => {
    const replay = fakeReplay({ hasAudio: false })
    const mux = fakeMux()
    const { sink } = recordingSink()
    const producer = createClipStreamProducer({
      resolveFfmpeg: async () => '/deps/ffmpeg-pinned',
      logger,
      openReplay: replay.open,
      spawnMux: mux.spawn,
      probeAccessUnits: 16,
    })
    const running = producer.stream({ camera: CAMERA, row: ROW, audio: 'none', sink })
    await Promise.resolve()
    replay.deliverUnits(MEDIA.units.slice(0, 2))
    replay.finish({ kind: 'complete', deliveredMs: 480 })
    const outcome = await running
    expect(outcome.kind).toBe('refused')
    if (outcome.kind !== 'refused') return
    expect(outcome.detail).toContain('before the frame rate could be measured')
  })

  it('refuses a replay that failed before the mux existed', async () => {
    const replay = fakeReplay({ hasAudio: false })
    const mux = fakeMux()
    const { sink } = recordingSink()
    const producer = createClipStreamProducer({
      resolveFfmpeg: async () => '/deps/ffmpeg-pinned',
      logger,
      openReplay: replay.open,
      spawnMux: mux.spawn,
      probeAccessUnits: 16,
    })
    const running = producer.stream({ camera: CAMERA, row: ROW, audio: 'none', sink })
    await Promise.resolve()
    replay.finish({ kind: 'failed', code: 'idle', detail: 'the camera delivered nothing' })
    expect(await running).toEqual({
      kind: 'refused',
      code: 'camera-refused',
      detail: 'the camera delivered nothing',
    })
  })

  it('survives a SECOND back-pressure episode — the peer’s drain is not one-shot', async () => {
    // Measured on 1436, 2026-09-23, on four consecutive attempts by the
    // operator: `peer-stalled` at elapsedMs 11 176 / 11 265 / 11 286 / 11 301
    // — a 125 ms spread across runs of different clips, which is a FIXED
    // timer, never content. 10 000 ms of gate plus ~1.2 s to the second time
    // the broker's paced reader filled the socket.
    //
    // The cause is not the timeout's length. `onceDrain` is `res.once`, and
    // the producer registered it ONCE, at spawn: the first drain consumed the
    // only listener, so the second refusal armed a gate that nothing left
    // alive could disarm. Bytes were still flowing — 4 679 321 of them, 137
    // access units — while the stream was cut for a peer that had stopped
    // taking bytes. Reolink re-registers per refusal and does not do this.
    //
    // The sink here fires drain by CONSUMING the listener, exactly as
    // `res.once` does. A fake that let the listener survive its own firing
    // would pass against the broken code — the shape this repo has been
    // caught by twice.
    vi.useFakeTimers()
    try {
      let accept = false
      let listener: (() => void) | null = null
      const chunks: Buffer[] = []
      const sink: ClipStreamSink = {
        begin: () => {},
        write: (chunk) => {
          chunks.push(chunk)
          return accept
        },
        onceDrain: (next) => {
          listener = next
        },
        onceClose: () => {},
        end: () => {},
        destroy: () => {},
      }
      /** `res.once`: firing removes the listener. Answers whether one existed. */
      const fireDrain = (): boolean => {
        const armed = listener
        listener = null
        armed?.()
        return armed !== null
      }

      const replay = fakeReplay({ hasAudio: false })
      const mux = fakeMux()
      const producer = createClipStreamProducer({
        resolveFfmpeg: async () => '/deps/ffmpeg-pinned',
        logger,
        openReplay: replay.open,
        spawnMux: mux.spawn,
        probeAccessUnits: 4,
      })
      // `logger` is one module-level mock shared by every test in this file,
      // and a sibling above cuts a stream on purpose. Only what THIS run
      // logged may be judged, or the assertion below reads someone else's.
      const line = logger.warn as unknown as ReturnType<typeof vi.fn>
      const before = line.mock.calls.length
      const running = producer.stream({ camera: CAMERA, row: ROW, audio: 'none', sink })
      await Promise.resolve()
      replay.deliverUnits(MEDIA.units.slice(0, 4))
      await Promise.resolve()

      // Episode one: the peer refuses, the gate arms, the drain disarms it —
      // and ffmpeg is held while the peer is behind rather than piling its
      // output into this process's heap.
      mux.emit(Buffer.alloc(64_000))
      expect(mux.stdoutPaused()).toBe(true)
      expect(fireDrain()).toBe(true)
      expect(mux.stdoutPaused()).toBe(false)

      // Episode two — the broker's reader fills again a second later. THIS is
      // the one that used to be unanswerable.
      mux.emit(Buffer.alloc(64_000))
      expect(mux.stdoutPaused()).toBe(true)
      expect(fireDrain()).toBe(true)

      // And the gate it disarmed really is disarmed: the peer is taking bytes.
      accept = true
      mux.emit(Buffer.alloc(64_000))
      await vi.advanceTimersByTimeAsync(CLIP_STREAM_DRAIN_TIMEOUT_MS + 1_000)
      replay.finish({ kind: 'complete', deliveredMs: 11_000 })
      await Promise.resolve()
      mux.close(0)
      expect(await running).toEqual({ kind: 'served' })
      expect(
        line.mock.calls
          .slice(before)
          .filter((call) => call[0] === 'videoclips: a clip stream was cut'),
      ).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })
})
