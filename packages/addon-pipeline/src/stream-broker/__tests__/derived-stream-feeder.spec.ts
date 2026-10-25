import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { EncodedPacket, PushAudioInfo } from '@camstack/types'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DerivedStreamFeeder,
  type DerivedStreamFeederCallbacks,
} from '../derived/derived-stream-feeder.js'

const FIXTURE_URL = new URL('./fixtures/mpegts-demux-fixture.mpegts', import.meta.url)
/**
 * The SAME source, muxed the way `-c:a copy` muxes a G.711 camera mic:
 * generated with ffmpeg 7.1 as `-c:v libx264 -c:a pcm_mulaw -f mpegts`, which
 * warns `codec pcm_mulaw ... is muxed as a private data stream and may not be
 * recognized upon reading` and writes stream_type `0x06`.
 */
const G711_COPY_FIXTURE_URL = new URL('./fixtures/mpegts-g711-copy-fixture.mpegts', import.meta.url)

interface FakeChild {
  readonly stdout: EventEmitter
  readonly stderr: EventEmitter
  readonly stdin: { on: () => void; end: ReturnType<typeof vi.fn> }
  exitCode: number | null
  signalCode: NodeJS.Signals | null
  readonly pid: number
  readonly kill: ReturnType<typeof vi.fn>
  emit(event: string, ...args: unknown[]): boolean
  on(event: string, listener: (...args: unknown[]) => void): unknown
}

function makeFakeChild(): FakeChild {
  const emitter = new EventEmitter()
  const child: FakeChild = Object.assign(emitter, {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    stdin: { on: () => {}, end: vi.fn() },
    exitCode: null,
    signalCode: null,
    pid: 4242,
    kill: vi.fn(),
  })
  return child
}

/** The feeder's `spawnFn` is typed `typeof spawn`; the fake is structurally
 *  compatible with the subset the feeder touches. Test-only narrowing. */
function asSpawn(fake: FakeChild): ChildProcess {
  return fake as unknown as ChildProcess
}

interface Collected {
  readonly videoCodecs: string[]
  readonly packets: EncodedPacket[]
  readonly audioInfos: PushAudioInfo[]
  readonly playing: number
  readonly errors: Error[]
  readonly teardowns: number
}

function makeCallbacks(sink: {
  videoCodecs: string[]
  packets: EncodedPacket[]
  audioInfos: PushAudioInfo[]
  counters: { playing: number; teardowns: number }
  errors: Error[]
}): DerivedStreamFeederCallbacks {
  return {
    onVideoCodec: (codec) => sink.videoCodecs.push(codec),
    onEncodedPacket: (packet) => sink.packets.push(packet),
    onAudioInfo: (info) => sink.audioInfos.push(info),
    onPlaying: () => {
      sink.counters.playing++
    },
    onError: (err) => sink.errors.push(err),
    onTeardown: () => {
      sink.counters.teardowns++
    },
  }
}

function runFixture(fixture: Buffer, chunkSizes?: readonly number[]): Collected {
  const videoCodecs: string[] = []
  const packets: EncodedPacket[] = []
  const audioInfos: PushAudioInfo[] = []
  const errors: Error[] = []
  const counters = { playing: 0, teardowns: 0 }

  const child = makeFakeChild()
  const spawnFn = vi.fn(() => asSpawn(child))
  const feeder = new DerivedStreamFeeder(
    {
      ffmpegPath: 'ffmpeg',
      args: ['-i', 'rtsp://x', '-c:v', 'libx264', '-c:a', 'aac', '-f', 'mpegts', 'pipe:1'],
      spawnFn,
    },
    makeCallbacks({ videoCodecs, packets, audioInfos, counters, errors }),
  )
  feeder.connect()

  if (chunkSizes === undefined) {
    child.stdout.emit('data', fixture)
  } else {
    let offset = 0
    let idx = 0
    while (offset < fixture.length) {
      const size = chunkSizes[idx % chunkSizes.length]!
      child.stdout.emit('data', fixture.subarray(offset, offset + size))
      offset += size
      idx++
    }
  }
  child.emit('exit', 0, null)

  return {
    videoCodecs,
    packets,
    audioInfos,
    playing: counters.playing,
    errors,
    teardowns: counters.teardowns,
  }
}

describe('DerivedStreamFeeder', () => {
  let fixture: Buffer

  beforeAll(() => {
    fixture = readFileSync(fileURLToPath(FIXTURE_URL))
    expect(fixture.length).toBeGreaterThan(0)
  })

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('demuxes the transcoded MPEG-TS into video + audio and reports codecs/audio-info', () => {
    const result = runFixture(fixture)

    expect(result.videoCodecs).toEqual(['h264'])

    const video = result.packets.filter((p) => p.type === 'video')
    const audio = result.packets.filter((p) => p.type === 'audio')
    expect(video.length).toBeGreaterThanOrEqual(1)
    expect(audio.length).toBeGreaterThanOrEqual(1)
    expect(video[0]?.keyframe).toBe(true)

    expect(result.audioInfos).toHaveLength(1)
    const info = result.audioInfos[0]!
    expect(info.codec).toBe('aac')
    expect(info.sampleRate).toBe(44100)
    expect(info.channels).toBe(1)
    expect(info.extraData).toHaveLength(2)

    expect(result.playing).toBe(1)
  })

  it('gets NOTHING from a COPIED G.711 track — the mute that cost camera 108 four days', () => {
    // This is the failure `-c:a copy` produced in production and the reason
    // `buildDerivedTranscodeArgs` re-encodes to AAC instead. ffmpeg accepts the
    // copy, so the feeder looks healthy — video flows, no error, no restart —
    // and the audio rides a private-data PID (`0x06`) that `MpegTsDemux` never
    // adopts. The broker is therefore never told it has audio, its probe reads
    // `audio: null`, and the audio analyser has nothing to subscribe to.
    const result = runFixture(readFileSync(fileURLToPath(G711_COPY_FIXTURE_URL)))

    expect(result.videoCodecs).toEqual(['h264'])
    expect(result.packets.filter((p) => p.type === 'video').length).toBeGreaterThanOrEqual(1)
    expect(result.packets.filter((p) => p.type === 'audio')).toHaveLength(0)
    expect(result.audioInfos).toHaveLength(0)
  })

  it('emits onAudioInfo before the first audio packet is forwarded', () => {
    const events: string[] = []
    const child = makeFakeChild()
    const feeder = new DerivedStreamFeeder(
      { ffmpegPath: 'ffmpeg', args: [], spawnFn: vi.fn(() => asSpawn(child)) },
      {
        onEncodedPacket: (packet) => events.push(`packet:${packet.type}`),
        onAudioInfo: () => events.push('audio-info'),
      },
    )
    feeder.connect()
    child.stdout.emit('data', fixture)
    child.emit('exit', 0, null)

    const firstAudioPacketIdx = events.indexOf('packet:audio')
    const audioInfoIdx = events.indexOf('audio-info')
    expect(audioInfoIdx).toBeGreaterThanOrEqual(0)
    expect(firstAudioPacketIdx).toBeGreaterThan(audioInfoIdx)
  })

  it('produces identical results when stdout is delivered in tiny chunks', () => {
    const whole = runFixture(fixture)
    const chunked = runFixture(fixture, [100, 7])

    expect(chunked.videoCodecs).toEqual(whole.videoCodecs)
    expect(chunked.packets.length).toBe(whole.packets.length)
    expect(chunked.audioInfos).toEqual(whole.audioInfos)
    expect(chunked.playing).toBe(whole.playing)
  })

  it('reports a terminal error and a single teardown on child exit', () => {
    const result = runFixture(fixture)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]?.message).toContain('exited')
    expect(result.teardowns).toBe(1)
  })

  it('destroy() kills the child, is idempotent, and SIGKILLs a lingering child', () => {
    const child = makeFakeChild()
    let teardowns = 0
    const feeder = new DerivedStreamFeeder(
      { ffmpegPath: 'ffmpeg', args: [], spawnFn: vi.fn(() => asSpawn(child)) },
      { onEncodedPacket: () => {}, onAudioInfo: () => {}, onTeardown: () => teardowns++ },
    )
    feeder.connect()

    feeder.destroy()
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    expect(child.stdin.end).toHaveBeenCalled()

    // Child never exited (exitCode/signalCode still null) → SIGKILL after grace.
    vi.advanceTimersByTime(1000)
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')

    // Idempotent: a second destroy() does not double-kill; teardown fired once
    // per call but no error surfaced.
    feeder.destroy()
    expect(child.kill).toHaveBeenCalledTimes(2)
    expect(teardowns).toBeGreaterThanOrEqual(1)
  })

  it('does NOT SIGKILL a child that already exited', () => {
    const child = makeFakeChild()
    const feeder = new DerivedStreamFeeder(
      { ffmpegPath: 'ffmpeg', args: [], spawnFn: vi.fn(() => asSpawn(child)) },
      { onEncodedPacket: () => {}, onAudioInfo: () => {} },
    )
    feeder.connect()
    feeder.destroy()

    // Simulate the child actually exiting during the grace window.
    child.exitCode = 0
    vi.advanceTimersByTime(1000)
    expect(child.kill).not.toHaveBeenCalledWith('SIGKILL')
  })
})
