import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { EncodedPacket, PushAudioInfo } from '@camstack/types'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  FfmpegSourceReader,
  type FfmpegSourceReaderCallbacks,
  parseAdtsAudioParams,
} from '../rtsp/ffmpeg-source-reader.js'

const FIXTURE_URL = new URL('./fixtures/mpegts-demux-fixture.mpegts', import.meta.url)

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

/** The reader's `spawnFn` is typed `typeof spawn`; the fake is structurally
 *  compatible with the subset the reader touches. Test-only narrowing. */
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
}): FfmpegSourceReaderCallbacks {
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
  const reader = new FfmpegSourceReader(
    { ffmpegPath: 'ffmpeg', args: ['-i', 'rtsp://x', '-f', 'mpegts', 'pipe:1'], spawnFn },
    makeCallbacks({ videoCodecs, packets, audioInfos, counters, errors }),
  )
  reader.connect()

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

describe('parseAdtsAudioParams', () => {
  it('parses a 48kHz stereo ADTS header', () => {
    // 7-byte ADTS: sync 0xFFF1, profile AAC-LC, freqIdx=3 (48k), channelConfig=2.
    // byte2 = profile(01) freqIdx(0011) private(0) chanHi(0) = 0b01001100 = 0x4C
    // byte3 = chanLo(10) ...                                  = 0b10000000 = 0x80
    const header = Buffer.from([0xff, 0xf1, 0x4c, 0x80, 0x00, 0x1f, 0xfc])
    const parsed = parseAdtsAudioParams(header)
    expect(parsed).not.toBeNull()
    expect(parsed?.sampleRate).toBe(48000)
    expect(parsed?.channels).toBe(2)
    // ASC = (2<<11)|(3<<7)|(2<<3) = 0x1190
    expect(parsed?.extraData).toEqual(new Uint8Array([0x11, 0x90]))
  })

  it('returns null on a missing syncword', () => {
    expect(parseAdtsAudioParams(Buffer.from([0x00, 0x00, 0x4c, 0x80, 0x00, 0x1f, 0xfc]))).toBeNull()
  })

  it('returns null on a too-short buffer', () => {
    expect(parseAdtsAudioParams(Buffer.from([0xff, 0xf1, 0x4c]))).toBeNull()
  })
})

describe('FfmpegSourceReader', () => {
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

  it('demuxes the fixture into video + audio and reports codecs/audio-info', () => {
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
    expect(info.channels).toBeGreaterThanOrEqual(1)
    expect(info.extraData).toHaveLength(2)

    expect(result.playing).toBe(1)
  })

  it('emits onAudioInfo before the first audio packet is forwarded', () => {
    const events: string[] = []
    const child = makeFakeChild()
    const reader = new FfmpegSourceReader(
      { ffmpegPath: 'ffmpeg', args: [], spawnFn: vi.fn(() => asSpawn(child)) },
      {
        onEncodedPacket: (packet) => events.push(`packet:${packet.type}`),
        onAudioInfo: () => events.push('audio-info'),
      },
    )
    reader.connect()
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
    const reader = new FfmpegSourceReader(
      { ffmpegPath: 'ffmpeg', args: [], spawnFn: vi.fn(() => asSpawn(child)) },
      { onEncodedPacket: () => {}, onAudioInfo: () => {}, onTeardown: () => teardowns++ },
    )
    reader.connect()

    reader.destroy()
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    expect(child.stdin.end).toHaveBeenCalled()

    // Child never exited (exitCode/signalCode still null) → SIGKILL after grace.
    vi.advanceTimersByTime(1000)
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')

    // Idempotent: a second destroy() does not double-kill; teardown fired once
    // per call but no error surfaced.
    reader.destroy()
    expect(child.kill).toHaveBeenCalledTimes(2)
    expect(teardowns).toBeGreaterThanOrEqual(1)
  })

  it('does NOT SIGKILL a child that already exited', () => {
    const child = makeFakeChild()
    const reader = new FfmpegSourceReader(
      { ffmpegPath: 'ffmpeg', args: [], spawnFn: vi.fn(() => asSpawn(child)) },
      { onEncodedPacket: () => {}, onAudioInfo: () => {} },
    )
    reader.connect()
    reader.destroy()

    // Simulate the child actually exiting during the grace window.
    child.exitCode = 0
    vi.advanceTimersByTime(1000)
    expect(child.kill).not.toHaveBeenCalledWith('SIGKILL')
  })
})
