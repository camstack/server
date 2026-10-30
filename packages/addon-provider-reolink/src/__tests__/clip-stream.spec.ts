/**
 * A clip's bytes reach the peer as they arrive from the camera.
 *
 * The producer is proved without a camera, without ffmpeg and without a
 * socket: the decoder, the mux and the peer are all injected, and every
 * assertion is about the ORDER things happen in and the line that names the
 * branch when they do not — because the file path's seven bugs in three days
 * were all a decision written where nothing executed it.
 */
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { PassThrough, Writable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveCameraUid } from '../clips/clip-addressing.js'
import type { ReolinkClipRow } from '../clips/clip-catalog.js'
import { CLIP_FETCH_MAX_ATTEMPTS } from '../clips/clip-mux.js'
import {
  type ClipStreamAccessUnit,
  type ClipStreamDecoderFactory,
  type ClipStreamInput,
  type ClipStreamMuxProcess,
  type ClipStreamSink,
  createClipStreamProducer,
} from '../clips/clip-stream.js'
import {
  CLIP_STREAM_RATE_PROBE_ACCESS_UNITS,
  CLIP_STREAM_RATE_PROBE_MAX_ACCESS_UNITS,
} from '../clips/clip-stream-mux.js'
import { CLIP_IDLE_WINDOW_MS } from '../clips/clip-truncation.js'
import type { ClipDeviceRef, ReolinkClipApi } from '../clips/reolink-videoclips-provider.js'
import { createRecordingLogger } from './clip-test-logger.js'

// ── fakes ─────────────────────────────────────────────────────────────────

/** 15 fps, the rate every sub file on this fleet delivers. */
const FRAME_US = 66_667
const AUDIO_TAG = 0x41 // 'A'

/** A chunk is one access unit, or one audio frame when it starts with 'A'. */
const video = (i: number): Buffer => Buffer.from(`V${String(i).padStart(4, '0')}`)
const audio = (): Buffer => Buffer.from('A-aac')

/**
 * The decoder as the producer sees it: one chunk in, one unit out, with a
 * timestamp the probe can measure. Audio frames reach `onAudioFrame` and
 * nothing else — exactly what the library's decoder does with them.
 */
type StampFor = (n: number) => number

/** 15 fps from the first unit — what a transfer nobody interrupted delivers. */
const inOrder: StampFor = (n) => n * FRAME_US

function fakeDecoder(stampFor: StampFor = inOrder): {
  factory: ClipStreamDecoderFactory
  units: () => number
} {
  let n = 0
  const factory: ClipStreamDecoderFactory = (handlers) => ({
    push(chunk) {
      if (chunk[0] === AUDIO_TAG) {
        handlers.onAudioFrame({
          audioType: chunk.includes('adpcm') ? 'Adpcm' : 'Aac',
          data: chunk,
        })
        return
      }
      const unit: ClipStreamAccessUnit = {
        videoType: 'H264',
        annexB: chunk,
        microseconds: stampFor(n),
        isKeyframe: n === 0,
      }
      n += 1
      handlers.onVideoAccessUnit(unit)
    },
  })
  return { factory, units: () => n }
}

interface FakeMux extends ClipStreamMuxProcess {
  readonly stdin: PassThrough
  readonly stdout: PassThrough
  readonly stderr: PassThrough
  /** fd 3 — `pipe:3`, the ADTS input (D600). Never piped to stdout: this
   *  fake is `cat` for VIDEO, and audio only has to be taken. */
  readonly audioIn: Writable
  /** Every byte written to fd 3, taken or not. */
  readonly audioWritten: () => string
  readonly killed: () => boolean
}

/**
 * The mux's `pipe:3`, in the two states a real one has.
 *
 * `takesBytes` is an ffmpeg keeping up. The other is an ffmpeg reading the
 * OTHER input: it accepts the byte and never reports taking it, so `write()`
 * returns false and no `drain` follows — measured on a real four-pipe mux,
 * where a 42 s clip delivered at 18× leaves fd 3 armed at EOF every time,
 * and where Node then emits no `drain` at all after `end()`.
 */
function audioPipe(takesBytes: boolean): { stream: Writable; written: () => string } {
  const chunks: Buffer[] = []
  if (!takesBytes) {
    const stalled = new Writable({
      highWaterMark: 1,
      write: (chunk: Buffer) => {
        chunks.push(chunk)
      },
    })
    return { stream: stalled, written: () => Buffer.concat(chunks).toString() }
  }
  const taking = new PassThrough()
  taking.on('data', (chunk: Buffer) => chunks.push(chunk))
  return { stream: taking, written: () => Buffer.concat(chunks).toString() }
}

/**
 * ffmpeg as `cat`: what goes in comes out, and it exits 0 when its input
 * ends — or `exitCode` when told to fail, with nothing on stdout.
 */
function fakeMuxProcess(exitCode = 0, audioTakesBytes = true, closeDelayMs = 0): FakeMux {
  const emitter = new EventEmitter()
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const fd3 = audioPipe(audioTakesBytes)
  const audioIn = fd3.stream
  let killed = false
  if (exitCode === 0) {
    // `end: false` so the flush after the input ends can be made to TAKE
    // time, the way a real ffmpeg's does.
    stdin.pipe(stdout, { end: false })
    stdin.on('end', () => {
      if (closeDelayMs > 0) setTimeout(() => stdout.end(), closeDelayMs)
      else stdout.end()
    })
    stdout.on('end', () => emitter.emit('close', 0))
  } else {
    stdin.on('data', () => {})
    stdin.on('end', () => {
      stderr.write('Invalid data found when processing input')
      stdout.end()
      emitter.emit('close', exitCode)
    })
  }
  const mux: FakeMux = {
    stdin,
    stdout,
    stderr,
    audioIn,
    audioWritten: fd3.written,
    stdio: [stdin, stdout, stderr, audioIn],
    killed: () => killed,
    kill: () => {
      killed = true
      stdin.destroy()
      stdout.destroy()
      emitter.emit('close', null)
      return true
    },
    on(
      event: 'close' | 'error',
      listener: ((code: number | null) => void) | ((err: Error) => void),
    ) {
      emitter.on(event, listener)
      return mux
    },
  }
  return mux
}

interface FakeSink extends ClipStreamSink {
  readonly begun: () => number
  readonly received: () => Buffer
  readonly ended: () => boolean
  readonly destroyed: () => boolean
  /** The peer takes the next writes, or refuses them. */
  accept(value: boolean): void
  drain(): void
  close(): void
  /** What happened, in order, so ORDER can be asserted. */
  readonly journal: string[]
}

function fakeSink(): FakeSink {
  const chunks: Buffer[] = []
  const journal: string[] = []
  let begun = 0
  let ended = false
  let destroyed = false
  let accepting = true
  let drainListener: (() => void) | null = null
  // The real sink is `res.once('close', …)` — an EMITTER. A fake that holds
  // one listener is more forgiving than production and would hide a second
  // registration displacing the first.
  const closeListeners: (() => void)[] = []
  return {
    journal,
    begun: () => begun,
    received: () => Buffer.concat(chunks),
    ended: () => ended,
    destroyed: () => destroyed,
    accept: (value) => {
      accepting = value
    },
    drain: () => {
      const listener = drainListener
      drainListener = null
      listener?.()
    },
    close: () => {
      for (const listener of [...closeListeners]) listener()
    },
    begin: () => {
      begun += 1
      journal.push('begin')
    },
    write: (chunk) => {
      chunks.push(chunk)
      journal.push(`write:${chunk.toString()}`)
      return accepting
    },
    onceDrain: (listener) => {
      drainListener = listener
    },
    onceClose: (listener) => {
      closeListeners.push(listener)
    },
    end: () => {
      ended = true
      journal.push('end')
    },
    destroy: () => {
      destroyed = true
      journal.push('destroy')
    },
  }
}

interface DownloadCall {
  readonly fileName: string
  readonly idleTimeoutMs?: number
  readonly uid?: string
  readonly onChunk?: (chunk: Buffer) => void
}

type DownloadScript = (call: DownloadCall) => Promise<void>

/** Feed `chunks` through `onChunk`, yielding between them like a socket. */
const feed =
  (chunks: readonly Buffer[]): DownloadScript =>
  async ({ onChunk }) => {
    for (const chunk of chunks) {
      onChunk?.(chunk)
      await Promise.resolve()
    }
  }

/** Only the stream seam answers; every other read is a defect here. */
const notHere = async (): Promise<never> => {
  throw new Error('not exercised by the stream producer')
}

function device(overrides: Partial<ClipDeviceRef> = {}, script: DownloadScript = feed([])) {
  const download = vi.fn(async (call: DownloadCall) => {
    await script(call)
    return Buffer.alloc(0)
  })
  const api: ReolinkClipApi = {
    getHddInfoList: notHere,
    getDayRecords: notHere,
    getVideoclips: notHere,
    searchAlarmVideos: notHere,
    getVideoclipThumbnailJpeg: notHere,
    downloadRecordingDemuxed: notHere,
    fileInfoListReplayBinaryDownload: download,
  }
  const ref: ClipDeviceRef = {
    deviceId: 107,
    channel: 0,
    uid: undefined,
    isHubChild: false,
    isBattery: false,
    sleeping: false,
    timeZone: 'Europe/Rome',
    hostKey: '192.168.60.226',
    getApi: async () => api,
    ...overrides,
  }
  return { ref, download }
}

/** A row whose window matches `units` access units at 15 fps, to the second. */
function rowFor(units: number, overrides: Partial<ReolinkClipRow> = {}): ReolinkClipRow {
  const spanMs = Math.round(((units - 1) * FRAME_US) / 1_000)
  return {
    clipKey: 'k'.repeat(40),
    channel: 0,
    startMs: 1_790_000_000_000,
    endMs: 1_790_000_000_000 + Math.ceil(spanMs / 1_000) * 1_000,
    subFileName: '/mnt/sda/Mp4Record/2026-09-22/RecS03_a.mp4',
    supportSub: true,
    nativeTypes: ['md'],
    ...overrides,
  }
}

function harness(
  options: {
    exitCode?: number
    drainTimeoutMs?: number
    /** The mux's `pipe:3` refuses every byte and never drains. */
    audioStalls?: boolean
    stampFor?: StampFor
    flushTimeoutMs?: number
    /** How long the mux takes to exit after its inputs ended. */
    closeDelayMs?: number
    /** Silence after a cut before the held lane is named. */
    cutGraceMs?: number
  } = {},
) {
  const logger = createRecordingLogger()
  const decoder = fakeDecoder(options.stampFor ?? inOrder)
  const muxes: FakeMux[] = []
  const spawnArgs: (readonly string[])[] = []
  const spawnedAfterUnits: number[] = []
  const sleeps: number[] = []
  const producer = createClipStreamProducer({
    logger,
    createDecoder: decoder.factory,
    spawnMux: (args) => {
      spawnArgs.push(args)
      spawnedAfterUnits.push(decoder.units())
      const mux = fakeMuxProcess(
        options.exitCode ?? 0,
        options.audioStalls !== true,
        options.closeDelayMs ?? 0,
      )
      muxes.push(mux)
      return mux
    },
    sleep: async (ms) => {
      sleeps.push(ms)
    },
    drainTimeoutMs: options.drainTimeoutMs ?? 1_000,
    flushTimeoutMs: options.flushTimeoutMs ?? 1_000,
    ...(options.cutGraceMs !== undefined ? { cutGraceMs: options.cutGraceMs } : {}),
  })
  return { logger, producer, muxes, spawnArgs, spawnedAfterUnits, sleeps }
}

function input(
  ref: ClipDeviceRef,
  row: ReolinkClipRow,
  sink: ClipStreamSink,
  audioAsk: ClipStreamInput['audio'] = 'none',
): ClipStreamInput {
  return { device: ref, row, fileName: row.subFileName, twin: 'sub', audio: audioAsk, sink }
}

const units = (n: number): Buffer[] => Array.from({ length: n }, (_, i) => video(i))

afterEach(() => {
  vi.useRealTimers()
})

// ── the pinned binary (D540) ──────────────────────────────────────────────

describe('the mux runs the node’s pinned ffmpeg, asked per stream', () => {
  it('REFUSES before dialling when it cannot be had, and RECOVERS on the next stream', async () => {
    const logger = createRecordingLogger()
    const decoder = fakeDecoder()
    const spawned: string[] = []
    let calls = 0
    const producer = createClipStreamProducer({
      logger,
      createDecoder: decoder.factory,
      resolveMuxSpawner: async () => {
        calls += 1
        if (calls === 1) return { kind: 'refused', detail: 'no pinned ffmpeg on this node (D540)' }
        return {
          kind: 'ready',
          spawn: (args) => {
            spawned.push(args.join(' '))
            return fakeMuxProcess()
          },
        }
      },
      sleep: async () => {},
      drainTimeoutMs: 1_000,
      flushTimeoutMs: 1_000,
    })
    const first = device({}, feed(units(20)))
    const refused = await producer.stream(input(first.ref, rowFor(20), fakeSink()))
    expect(refused).toEqual({
      kind: 'refused',
      code: 'fetch-failed',
      detail: 'no pinned ffmpeg on this node (D540)',
      attempts: 0,
    })
    // The cheap question first: the camera was never asked.
    expect(first.download).not.toHaveBeenCalled()

    const second = device({}, feed(units(20)))
    const served = await producer.stream(input(second.ref, rowFor(20), fakeSink()))
    expect(served.kind).toBe('served')
    expect(spawned).toHaveLength(1)
  })
})

// ── the happy path ────────────────────────────────────────────────────────

describe('a clip stream is served as it arrives', () => {
  it('hands every access unit to the mux and the muxed bytes to the peer, in order', async () => {
    const h = harness()
    const { ref, download } = device({}, feed(units(20)))
    const sink = fakeSink()
    const outcome = await h.producer.stream(input(ref, rowFor(20), sink))

    expect(outcome.kind).toBe('served')
    if (outcome.kind !== 'served') throw new Error('unreachable')
    expect(outcome.accessUnits).toBe(20)
    expect(outcome.attempts).toBe(1)
    expect(sink.received().toString()).toBe(units(20).map(String).join(''))
    expect(sink.begun()).toBe(1)
    expect(sink.ended()).toBe(true)
    expect(sink.destroyed()).toBe(false)
    // The status line is written before the first byte, and only once.
    expect(sink.journal[0]).toBe('begin')
    expect(sink.journal.at(-1)).toBe('end')
    // The camera was asked on D568's window, by the seam that exposes chunks.
    expect(download).toHaveBeenCalledTimes(1)
    expect(download.mock.calls[0]?.[0]?.idleTimeoutMs).toBe(CLIP_IDLE_WINDOW_MS)
  })

  it('spawns the mux after the probe, with the rate the probe MEASURED', async () => {
    const h = harness()
    const { ref } = device({}, feed(units(40)))
    await h.producer.stream(input(ref, rowFor(40), fakeSink()))

    expect(h.spawnedAfterUnits).toEqual([CLIP_STREAM_RATE_PROBE_ACCESS_UNITS])
    const args = h.spawnArgs[0] ?? []
    expect(args.slice(args.indexOf('-r'), args.indexOf('-r') + 2)).toEqual(['-r', '15'])
    expect(args).toContain('h264')
    expect(args).toContain('pipe:0')
    expect(args).toContain('pipe:1')
  })

  it('muxes a clip SHORTER than the probe at the end, measured over all of it', async () => {
    const h = harness()
    const { ref } = device({}, feed(units(5)))
    const sink = fakeSink()
    const outcome = await h.producer.stream(input(ref, rowFor(5), sink))

    expect(outcome.kind).toBe('served')
    expect(h.spawnedAfterUnits).toEqual([5])
    expect(h.spawnArgs[0]).toContain('15')
    expect(sink.received().toString()).toBe(units(5).map(String).join(''))
  })

  it('judges the stream against the row after the last byte and says it landed whole', async () => {
    const h = harness()
    const { ref } = device({}, feed(units(20)))
    const outcome = await h.producer.stream(input(ref, rowFor(20), fakeSink()))
    if (outcome.kind !== 'served') throw new Error('unreachable')
    expect(outcome.verdict.kind).toBe('complete')
    expect(outcome.durationSeconds).toBeCloseTo((19 * FRAME_US) / 1_000_000, 3)
    const line = h.logger.infos.find((l) => l.message.includes('landed whole'))
    expect(line?.extras.tags).toEqual({ deviceId: 107 })
    expect(line?.extras.meta?.['branch']).toBe('stream-served')
  })

  it('serves a SHORT stream and names it — there is no buffer to retry into', async () => {
    const h = harness()
    const { ref, download } = device({}, feed(units(20)))
    // The row says 30 s; twenty units at 15 fps are 1.27 s.
    const row = rowFor(20, { endMs: 1_790_000_000_000 + 30_000 })
    const outcome = await h.producer.stream(input(ref, row, fakeSink()))
    if (outcome.kind !== 'served') throw new Error('unreachable')
    expect(outcome.verdict.kind).toBe('short')
    expect(download).toHaveBeenCalledTimes(1)
    const warn = h.logger.warns.find((l) => l.message.includes('came up short'))
    expect(warn?.extras.tags).toEqual({ deviceId: 107 })
    expect(warn?.extras.meta?.['branch']).toBe('stream-short')
    expect(warn?.extras.meta?.['retried']).toBe(false)
  })

  it('counts the audio it drops when NOBODY asked, and says so once per stream', async () => {
    const h = harness()
    const script = feed([video(0), audio(), video(1), audio(), ...units(20).slice(2), audio()])
    const { ref } = device({}, script)
    const sink = fakeSink()
    const outcome = await h.producer.stream(input(ref, rowFor(20), sink, 'none'))
    if (outcome.kind !== 'served') throw new Error('unreachable')
    expect(outcome.audio).toEqual({
      asked: 'none',
      muxed: null,
      reason: 'not-requested',
      framesIn: 3,
      framesDropped: 3,
      framesAfterMux: 0,
    })
    expect(sink.received().toString()).not.toContain('aac')
    // No `pipe:3` in the args at all: ffmpeg probes every input it is given
    // before writing a byte, so a declared-and-unfed input stalls the video.
    expect(h.spawnArgs[0]).not.toContain('pipe:3')
    const lines = h.logger.infos.filter((l) => l.message.includes('without sound'))
    expect(lines).toHaveLength(1)
    expect(lines[0]?.extras.tags).toEqual({ deviceId: 107 })
    expect(lines[0]?.extras.meta?.['branch']).toBe('stream-video-only')
    expect(lines[0]?.extras.meta?.['audioFramesDropped']).toBe(3)
  })

  it('muxes the ADTS on `pipe:3` when a codec was asked for, held probe first', async () => {
    const h = harness()
    // Audio arrives from the first chunk, as the camera interleaves it, so it
    // is in hand when the rate probe fills and the mux is spawned.
    const script = feed([audio(), video(0), audio(), ...units(20).slice(1), audio()])
    const { ref } = device({}, script)
    const sink = fakeSink()
    const outcome = await h.producer.stream(input(ref, rowFor(20), sink, 'opus'))
    if (outcome.kind !== 'served') throw new Error('unreachable')
    expect(outcome.audio.muxed).toBe('opus')
    expect(outcome.audio.reason).toBeNull()
    expect(outcome.audio.framesIn).toBe(3)
    expect(outcome.audio.framesDropped).toBe(0)
    expect(h.spawnArgs[0]).toContain('pipe:3')
    // Every frame reached fd 3, the two held for the probe included.
    expect(h.muxes[0]?.audioWritten()).toBe('A-aacA-aacA-aac')
    const line = h.logger.infos.find((l) => l.message.includes('carried sound'))
    expect(line?.extras.tags).toEqual({ deviceId: 107 })
    expect(line?.extras.meta?.['branch']).toBe('stream-with-audio')
  })

  it('names a recording that was ASKED for sound and had none, and keeps the video', async () => {
    const h = harness()
    const { ref } = device({}, feed(units(20)))
    const sink = fakeSink()
    const outcome = await h.producer.stream(input(ref, rowFor(20), sink, 'opus'))
    if (outcome.kind !== 'served') throw new Error('unreachable')
    expect(outcome.accessUnits).toBe(20)
    expect(outcome.audio.muxed).toBeNull()
    expect(outcome.audio.reason).toBe('no-audio-track')
    expect(h.spawnArgs[0]).not.toContain('pipe:3')
    const warn = h.logger.warns.find((l) => l.message.includes('asked for sound and had none'))
    expect(warn?.extras.meta?.['branch']).toBe('stream-silent:no-audio-track')
  })

  it('names ADPCM apart from silence — a codec we will not carry is not an absent one', async () => {
    const h = harness()
    const adpcm = (): Buffer => Buffer.from('A-adpcm')
    const { ref } = device({}, feed([adpcm(), video(0), ...units(20).slice(1)]))
    const outcome = await h.producer.stream(input(ref, rowFor(20), fakeSink(), 'pcmu'))
    if (outcome.kind !== 'served') throw new Error('unreachable')
    expect(outcome.audio.reason).toBe('audio-not-copyable')
    expect(outcome.audio.framesDropped).toBe(1)
    const warn = h.logger.warns.find((l) => l.message.includes('asked for sound and had none'))
    expect(warn?.extras.meta?.['branch']).toBe('stream-silent:audio-not-copyable')
  })

  it('names sound that arrived AFTER the mux was spawned silent — the loudest branch', async () => {
    const h = harness()
    // Twenty video units fill the probe and spawn the mux before any audio.
    const script = feed([...units(20), audio(), audio()])
    const { ref } = device({}, script)
    const outcome = await h.producer.stream(input(ref, rowFor(20), fakeSink(), 'opus'))
    if (outcome.kind !== 'served') throw new Error('unreachable')
    expect(outcome.audio.muxed).toBeNull()
    expect(outcome.audio.framesAfterMux).toBe(2)
    expect(outcome.audio.framesDropped).toBe(2)
    const warn = h.logger.warns.find((l) => l.message.includes('arrived too late'))
    expect(warn?.extras.tags).toEqual({ deviceId: 107 })
    expect(warn?.extras.meta?.['branch']).toBe('stream-audio-after-mux')
  })

  it('REFUSES a rate it could not measure — an omitted `-r` is ffmpeg\u2019s guess, not no rate', async () => {
    const h = harness()
    // One unit: nothing to measure a rate over, and nothing more coming.
    const { ref, download } = device({}, feed(units(1)))
    const sink = fakeSink()
    const outcome = await h.producer.stream(input(ref, rowFor(1), sink))
    expect(outcome.kind).toBe('refused')
    if (outcome.kind !== 'refused') throw new Error('unreachable')
    expect(outcome.code).toBe('fetch-failed')
    expect(outcome.detail).toContain('rate-unmeasured')
    // Nothing was spawned and nothing reached the peer: the route still owns
    // the status line, and the mux was never asked to invent a timeline.
    expect(h.spawnArgs).toHaveLength(0)
    expect(sink.begun()).toBe(0)
    expect(sink.destroyed()).toBe(false)
    // A mux that cannot be spawned honestly is not a camera flake.
    expect(download).toHaveBeenCalledTimes(1)
    const warn = h.logger.warns.find((l) => l.message.includes('no measured frame rate'))
    expect(warn?.extras.tags).toEqual({ deviceId: 107 })
    expect(warn?.extras.meta?.['branch']).toBe('fps-unmeasured')
    const cut = h.logger.warns.find((l) => l.message.includes('was cut'))
    expect(cut?.extras.meta?.['branch']).toBe('rate-unmeasured')
  })

  it('WIDENS the probe before refusing, and refuses at the bound, not at the window', async () => {
    // Every unit at the same instant: the window can never measure a span.
    const h = harness({ stampFor: () => 7_000 })
    const { ref } = device({}, feed(units(CLIP_STREAM_RATE_PROBE_MAX_ACCESS_UNITS + 40)))
    const sink = fakeSink()
    const outcome = await h.producer.stream(
      input(ref, rowFor(CLIP_STREAM_RATE_PROBE_MAX_ACCESS_UNITS + 40), sink),
    )
    expect(outcome.kind).toBe('refused')
    expect(h.spawnArgs).toHaveLength(0)
    expect(sink.begun()).toBe(0)
    const warn = h.logger.warns.find((l) => l.message.includes('no measured frame rate'))
    // Held to the BOUND, not judged on the first window.
    expect(warn?.extras.meta?.['probeAccessUnits']).toBe(CLIP_STREAM_RATE_PROBE_MAX_ACCESS_UNITS)
  })

  it('addresses a hub child by its uid', async () => {
    const h = harness()
    const { ref, download } = device(
      {
        deviceId: 3628,
        isHubChild: true,
        uid: resolveCameraUid({ metadataUid: '9527000HXOHJ142G', configUid: undefined }),
        hostKey: '192.168.10.161',
      },
      feed(units(20)),
    )
    await h.producer.stream(input(ref, rowFor(20), fakeSink()))
    expect(download.mock.calls[0]?.[0]?.uid).toBe('9527000HXOHJ142G')
  })
})

// ── before the first byte ─────────────────────────────────────────────────

describe('a stream that never produced media', () => {
  it('is retried under the bound and refused by name, every attempt logged', async () => {
    const h = harness()
    const { ref, download } = device({}, feed([]))
    const sink = fakeSink()
    const outcome = await h.producer.stream(input(ref, rowFor(20), sink))

    expect(outcome).toEqual({
      kind: 'refused',
      code: 'camera-refused',
      detail: expect.stringContaining(`after ${CLIP_FETCH_MAX_ATTEMPTS} attempts`),
      attempts: CLIP_FETCH_MAX_ATTEMPTS,
    })
    expect(download).toHaveBeenCalledTimes(CLIP_FETCH_MAX_ATTEMPTS)
    expect(h.sleeps).toEqual([500, 1_000])
    expect(sink.begun()).toBe(0)
    expect(sink.destroyed()).toBe(false)
    const retries = h.logger.warns.filter((l) => l.extras.meta?.['branch'] === 'stream-no-media')
    expect(retries).toHaveLength(CLIP_FETCH_MAX_ATTEMPTS)
    for (const line of retries) expect(line.extras.tags).toEqual({ deviceId: 107 })
    const final = h.logger.warns.find((l) => l.message.includes('never delivered'))
    expect(final?.extras.meta?.['branch']).toBe('camera-refused')
  })

  it('retries a camera that failed before any media and serves the second attempt', async () => {
    const h = harness()
    let call = 0
    const script: DownloadScript = async (c) => {
      call += 1
      if (call === 1) throw new Error('socket reset')
      await feed(units(20))(c)
    }
    const { ref, download } = device({}, script)
    const outcome = await h.producer.stream(input(ref, rowFor(20), fakeSink()))
    expect(outcome.kind).toBe('served')
    if (outcome.kind !== 'served') throw new Error('unreachable')
    expect(outcome.attempts).toBe(2)
    expect(download).toHaveBeenCalledTimes(2)
  })

  it('does NOT retry a mux that failed — it is not a camera flake — and still owns the status line', async () => {
    const h = harness({ exitCode: 1 })
    const { ref, download } = device({}, feed(units(20)))
    const sink = fakeSink()
    const outcome = await h.producer.stream(input(ref, rowFor(20), sink))
    expect(outcome.kind).toBe('refused')
    if (outcome.kind !== 'refused') throw new Error('unreachable')
    expect(outcome.code).toBe('fetch-failed')
    expect(outcome.detail).toContain('mux-failed')
    expect(download).toHaveBeenCalledTimes(1)
    expect(sink.begun()).toBe(0)
    expect(sink.destroyed()).toBe(false)
    const warn = h.logger.warns.find((l) => l.message.includes('was cut'))
    expect(warn?.extras.meta?.['branch']).toBe('mux-failed')
    expect(warn?.extras.tags).toEqual({ deviceId: 107 })
  })
})

// ── after the first byte ──────────────────────────────────────────────────

describe('a stream that had started is CUT, never ended', () => {
  it('severs the peer when the camera fails mid-transfer', async () => {
    const h = harness()
    const script: DownloadScript = async (c) => {
      await feed(units(20))(c)
      throw new Error('camera went away')
    }
    const { ref, download } = device({}, script)
    const sink = fakeSink()
    const outcome = await h.producer.stream(input(ref, rowFor(20), sink))
    expect(outcome.kind).toBe('cut')
    if (outcome.kind !== 'cut') throw new Error('unreachable')
    expect(outcome.reason).toBe('camera-failed')
    expect(outcome.bytesOut).toBeGreaterThan(0)
    expect(sink.destroyed()).toBe(true)
    expect(sink.ended()).toBe(false)
    expect(download).toHaveBeenCalledTimes(1)
    expect(h.muxes[0]?.killed()).toBe(true)
  })

  it('cuts a peer that never drains and refuses the camera’s next chunk', async () => {
    vi.useFakeTimers()
    const h = harness({ drainTimeoutMs: 1_000 })
    const sink = fakeSink()
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let refusedChunk: Error | null = null
    const script: DownloadScript = async ({ onChunk }) => {
      for (const chunk of units(20)) onChunk?.(chunk)
      await gate
      try {
        onChunk?.(video(20))
      } catch (err: unknown) {
        refusedChunk = err instanceof Error ? err : new Error(String(err))
        throw err
      }
    }
    const { ref } = device({}, script)
    // The peer refuses every write from the first byte on.
    sink.accept(false)
    const pending = h.producer.stream(input(ref, rowFor(21), sink))
    await vi.advanceTimersByTimeAsync(10)
    expect(sink.begun()).toBe(1)
    expect(sink.destroyed()).toBe(false)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(sink.destroyed()).toBe(true)
    release()
    const outcome = await pending
    expect(outcome.kind).toBe('cut')
    if (outcome.kind !== 'cut') throw new Error('unreachable')
    expect(outcome.reason).toBe('peer-stalled')
    expect(refusedChunk).not.toBeNull()
    expect(String(refusedChunk)).toContain('peer-stalled')
    const warn = h.logger.warns.find((l) => l.message.includes('was cut'))
    expect(warn?.extras.tags).toEqual({ deviceId: 107 })
    expect(warn?.extras.meta?.['branch']).toBe('peer-stalled')
    expect(h.muxes[0]?.killed()).toBe(true)
  })

  it('a peer that drains in time is not cut', async () => {
    vi.useFakeTimers()
    const h = harness({ drainTimeoutMs: 1_000 })
    const sink = fakeSink()
    sink.accept(false)
    const { ref } = device({}, feed(units(20)))
    const pending = h.producer.stream(input(ref, rowFor(20), sink))
    await vi.advanceTimersByTimeAsync(500)
    sink.accept(true)
    sink.drain()
    await vi.advanceTimersByTimeAsync(2_000)
    const outcome = await pending
    expect(outcome.kind).toBe('served')
    expect(sink.destroyed()).toBe(false)
  })

  it('severs the mux when the peer closes early', async () => {
    const h = harness()
    const sink = fakeSink()
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const script: DownloadScript = async ({ onChunk }) => {
      for (const chunk of units(20)) onChunk?.(chunk)
      await gate
      onChunk?.(video(20))
    }
    const { ref } = device({}, script)
    const pending = h.producer.stream(input(ref, rowFor(21), sink))
    await new Promise((resolve) => setTimeout(resolve, 5))
    sink.close()
    release()
    const outcome = await pending
    expect(outcome.kind).toBe('cut')
    if (outcome.kind !== 'cut') throw new Error('unreachable')
    expect(outcome.reason).toBe('peer-closed')
    expect(h.muxes[0]?.killed()).toBe(true)
  })
})

// ── one transfer's frames, and one transfer only (D604) ───────────────────

/** A chunk of the transfer BEFORE this one, still arriving from the camera. */
const residue = (i: number): Buffer => Buffer.from(`R${String(i).padStart(4, '0')}`)

/** 55 access units in, where the cut stream of 2026-09-22 16:41:22 stopped. */
const RESIDUE_BASE_US = 55 * FRAME_US

describe('a cut transfer\u2019s frames are not part of the next stream', () => {
  it('drops what was held when the timestamps go BACK, and probes again', async () => {
    const h = harness({
      stampFor: (n) => (n < 5 ? RESIDUE_BASE_US + n * FRAME_US : (n - 5) * FRAME_US),
    })
    const script = feed([
      ...Array.from({ length: 5 }, (_, i) => residue(i)),
      audio(),
      audio(),
      ...units(20),
    ])
    const { ref } = device({}, script)
    const sink = fakeSink()
    const outcome = await h.producer.stream(input(ref, rowFor(20), sink, 'opus'))

    expect(outcome.kind).toBe('served')
    if (outcome.kind !== 'served') throw new Error('unreachable')
    // The peer got THIS recording, from its own first frame.
    expect(sink.received().toString()).toBe(units(20).map(String).join(''))
    expect(sink.received().toString()).not.toContain('R000')
    expect(outcome.accessUnits).toBe(20)
    // And the rate is the one the restarted probe measured, not a refusal.
    expect(h.spawnArgs[0]).toContain('-r')
    expect(h.spawnArgs[0]).toContain('15')
    // The duration is this recording's, so the row's verdict is honest.
    expect(outcome.durationSeconds).toBeCloseTo((19 * FRAME_US) / 1_000_000, 3)
    expect(outcome.verdict.kind).toBe('complete')
    // The sound held for the probe went with them, and is counted (D391).
    expect(outcome.audio.framesIn).toBe(2)
    expect(outcome.audio.framesDropped).toBe(2)
    const warn = h.logger.warns.find((l) => l.message.includes('previous transfer'))
    expect(warn?.extras.tags).toEqual({ deviceId: 107 })
    expect(warn?.extras.meta?.['branch']).toBe('stream-transfer-residue')
    expect(warn?.extras.meta?.['residueAccessUnits']).toBe(5)
    expect(warn?.extras.meta?.['residueAudioFrames']).toBe(2)
  })

  it('names a jump the mux had already passed, and refuses to call the pass SHORT', async () => {
    // Twenty units, the mux spawned at sixteen, then the file starts again.
    const h = harness({ stampFor: (n) => (n < 20 ? n * FRAME_US : (n - 20) * FRAME_US) })
    const { ref } = device({}, feed(units(40)))
    const outcome = await h.producer.stream(input(ref, rowFor(40), fakeSink()))

    expect(outcome.kind).toBe('served')
    if (outcome.kind !== 'served') throw new Error('unreachable')
    // Measured across two transfers is not a measurement (D393).
    expect(outcome.durationSeconds).toBeNull()
    expect(outcome.verdict.kind).toBe('unknown')
    if (outcome.verdict.kind !== 'unknown') throw new Error('unreachable')
    expect(outcome.verdict.reason).toBe('duration-unmeasured')
    const jump = h.logger.warns.find((l) => l.message.includes('went backwards'))
    expect(jump?.extras.tags).toEqual({ deviceId: 107 })
    expect(jump?.extras.meta?.['branch']).toBe('stream-timestamp-jump')
    const unverified = h.logger.warns.find((l) => l.message.includes('could not be checked'))
    expect(unverified?.extras.meta?.['branch']).toBe('completeness-unverified')
    expect(h.logger.warns.find((l) => l.message.includes('came up short'))).toBeUndefined()
  })
})

// ── a gate dies with its run (D604) ───────────────────────────────────────

describe('nothing a run armed outlives it', () => {
  it('never cuts a stream it has already SERVED, whatever is armed at EOF', async () => {
    vi.useFakeTimers()
    // `pipe:3` takes nothing and never drains — what a real ffmpeg does at
    // the end of a fast transfer, and what Node guarantees after `end()`.
    const h = harness({ drainTimeoutMs: 1_000, audioStalls: true })
    const { ref } = device({}, feed([audio(), ...units(20), audio(), audio()]))
    const sink = fakeSink()
    const pending = h.producer.stream(input(ref, rowFor(20), sink, 'opus'))
    await vi.advanceTimersByTimeAsync(10)
    const outcome = await pending
    expect(outcome.kind).toBe('served')
    expect(sink.ended()).toBe(true)

    await vi.advanceTimersByTimeAsync(10_000)
    expect(sink.destroyed()).toBe(false)
    expect(h.logger.warns.filter((l) => l.message.includes('was cut'))).toHaveLength(0)
  })

  it('does not cut a mux that is FLUSHING — the flush window outlasts the drain one', async () => {
    vi.useFakeTimers()
    // The real numbers' shape: the flush grace (15 s) is longer than the
    // drain window (10 s), so a gate armed on the last write fires INSIDE
    // the run unless an ended input disarms it.
    const h = harness({
      drainTimeoutMs: 1_000,
      flushTimeoutMs: 9_000,
      closeDelayMs: 4_000,
      audioStalls: true,
    })
    const { ref } = device({}, feed([audio(), ...units(20), audio()]))
    const sink = fakeSink()
    const pending = h.producer.stream(input(ref, rowFor(20), sink, 'opus'))
    await vi.advanceTimersByTimeAsync(10)
    await vi.advanceTimersByTimeAsync(4_000)
    const outcome = await pending

    expect(outcome.kind).toBe('served')
    expect(sink.destroyed()).toBe(false)
    expect(h.logger.warns.filter((l) => l.message.includes('was cut'))).toHaveLength(0)
  })

  it('is silent when the peer closes a response the run already finished with', async () => {
    const h = harness()
    const { ref } = device({}, feed([]))
    const sink = fakeSink()
    const outcome = await h.producer.stream(input(ref, rowFor(20), sink))
    expect(outcome.kind).toBe('refused')

    sink.close()
    expect(sink.destroyed()).toBe(false)
    expect(h.logger.warns.filter((l) => l.message.includes('was cut'))).toHaveLength(0)
  })
})

// ── the one session ───────────────────────────────────────────────────────

describe('streams on one host take turns', () => {
  it('runs the second only after the first has ended, and says it waited', async () => {
    const h = harness()
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const order: string[] = []
    const first = device({}, async (c) => {
      order.push('first-start')
      await feed(units(20))(c)
      await gate
      order.push('first-end')
    })
    const second = device({}, async (c) => {
      order.push('second-start')
      await feed(units(20))(c)
    })
    const a = h.producer.stream(input(first.ref, rowFor(20), fakeSink()))
    const b = h.producer.stream(input(second.ref, rowFor(20), fakeSink()))
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(h.producer.active('192.168.60.226')).toBe(2)
    expect(second.download).not.toHaveBeenCalled()
    release()
    await Promise.all([a, b])
    expect(order).toEqual(['first-start', 'first-end', 'second-start'])
    expect(h.producer.active('192.168.60.226')).toBe(0)
    const queued = h.logger.infos.find((l) => l.message.includes('queued behind'))
    expect(queued?.extras.tags).toEqual({ deviceId: 107 })
    expect(queued?.extras.meta?.['ahead']).toBe(1)
  })
  it('drops a queued stream whose peer left, and never fetches for it', async () => {
    // Measured on 3628 (battery Reolink) 2026-09-23: the depth climbed
    // 5, 6, 7, 8 and never came back. The lane had no cancellation, so an
    // abandoned tap still ran its full retry budget against a sleeping
    // camera while every later tap waited behind it. Nothing played.
    const h = harness()
    let release = (): void => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const first = device({}, async (c) => {
      await feed(units(20))(c)
      await gate
    })
    const second = device({}, async (c) => {
      await feed(units(20))(c)
    })
    const secondSink = fakeSink()
    const a = h.producer.stream(input(first.ref, rowFor(20), fakeSink()))
    const b = h.producer.stream(input(second.ref, rowFor(20), secondSink))
    await new Promise((resolve) => setTimeout(resolve, 5))
    // The peer gives up WHILE IT WAITS — the case the lane could not see.
    secondSink.close()
    release()
    const [, outcome] = await Promise.all([a, b])

    expect(second.download).not.toHaveBeenCalled()
    expect(outcome.kind).toBe('refused')
    if (outcome.kind === 'refused') {
      expect(outcome.code).toBe('fetch-failed')
      expect(outcome.attempts).toBe(0)
      expect(outcome.detail).toContain('in the queue')
    }
    // And it must not hold the lane: the host is free afterwards.
    expect(h.producer.active('192.168.60.226')).toBe(0)
    const dropped = h.logger.infos.find((l) => l.extras.meta?.['branch'] === 'queued-peer-gone')
    expect(dropped?.extras.tags).toEqual({ deviceId: 107 })
  })
})

// ── what the stream must not touch ────────────────────────────────────────

describe('the streaming path writes nothing', () => {
  it('imports no filesystem and no artifact store', () => {
    const source = readFileSync(new URL('../clips/clip-stream.ts', import.meta.url), 'utf8')
    expect(source).not.toMatch(/from 'node:fs/)
    expect(source).not.toContain('ClipArtifactStore')
    expect(source).not.toContain('mkdtemp')
  })
})

/**
 * The lane a severed run keeps holding.
 *
 * Measured on the hub 2026-09-23 (592, clipKey 3177ccc9…): a transfer began
 * at 18:17:40.446, received ZERO of its own access units — the camera was
 * still delivering an earlier, abandoned handle, which the library rejects by
 * channel id — and was severed `peer-closed` at 18:18:10.444. The lane did
 * not move until 18:19:40.753: **120.3 s**, the library's own `timeoutMs`,
 * because the only lever a consumer has over a cmd 5 replay is to throw from
 * `onChunk`, and `onChunk` never fired. Every tap the operator made in that
 * window queued behind it and drained unserved.
 *
 * The stop belongs in the library (an `AbortSignal` on
 * `fileInfoListReplayBinaryDownload`, and an idle timer that FAILS a
 * zero-chunk transfer instead of returning). What belongs here is that the
 * hold is never again silent: a branch that accepted work and is producing
 * nothing has to say so, per camera (D391).
 */
describe('a severed run that the camera never answers', () => {
  it('names the lane it is still holding, with the device and the elapsed time', async () => {
    vi.useFakeTimers()
    const h = harness({ cutGraceMs: 5_000 })
    // A camera that takes the request and then says nothing at all — no
    // chunk, ever, so the run's only stop lever never exists.
    const { ref } = device({}, () => new Promise<void>(() => undefined))
    const sink = fakeSink()
    void h.producer.stream(input(ref, rowFor(20), sink))
    await vi.advanceTimersByTimeAsync(10)
    sink.close()
    await vi.advanceTimersByTimeAsync(10)
    expect(h.logger.warns.some((l) => l.message.includes('was cut'))).toBe(true)
    expect(h.logger.warns.some((l) => l.message.includes('still holding'))).toBe(false)
    await vi.advanceTimersByTimeAsync(5_000)
    const held = h.logger.warns.find((l) => l.message.includes('still holding'))
    expect(held).toBeDefined()
    expect(held?.extras.tags).toMatchObject({ deviceId: 107 })
    expect(held?.extras.meta).toMatchObject({
      branch: 'cut-not-honoured',
      reason: 'peer-closed',
      accessUnits: 0,
    })
    expect(Number(held?.extras.meta?.['heldSinceCutMs'])).toBeGreaterThanOrEqual(5_000)
    // The lane is STILL held — this line is the only evidence that it is.
    expect(h.producer.active('192.168.60.226')).toBe(1)
  })
})
