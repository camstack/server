import { describe, it, expect } from 'vitest'
import type { IncomingMessage } from 'node:http'
import type { IScopedLogger, LogExtras } from '@camstack/types'
import type {
  AudioDataStream,
  AudioDataCloseInfo,
  HikvisionTwoWayAudioChannel,
} from '../../hikvision-isapi-client.js'
import {
  HikvisionIntercomSession,
  AUDIO_DATA_CHUNK_BYTES,
  type HikvisionIntercomClient,
} from '../hikvision-intercom-session.js'

/**
 * Pacing model: encoded µ-law bytes are accumulated and flushed to the
 * audioData PUT body in FIXED 1024-byte chunks; the sub-1024 remainder
 * is held until the next flush, and the trailing remainder is flushed
 * on stop().
 */

interface LogCall {
  readonly level: 'debug' | 'info' | 'warn' | 'error'
  readonly message: string
  readonly extras?: LogExtras
}

function makeLogger(sink: LogCall[]): IScopedLogger {
  const logger: IScopedLogger = {
    debug: (m, e) => {
      sink.push({ level: 'debug', message: m, extras: e })
    },
    info: (m, e) => {
      sink.push({ level: 'info', message: m, extras: e })
    },
    warn: (m, e) => {
      sink.push({ level: 'warn', message: m, extras: e })
    },
    error: (m, e) => {
      sink.push({ level: 'error', message: m, extras: e })
    },
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

/** A fake AudioDataStream that records every write's byte length. */
function makeCapturingStream(): {
  stream: AudioDataStream
  writes: number[]
  fireClosed: (info: AudioDataCloseInfo) => void
} {
  const writes: number[] = []
  const listeners: Array<(info: AudioDataCloseInfo) => void> = []
  const responsePromise = new Promise<IncomingMessage>(() => {
    /* sticky */
  })
  const stream: AudioDataStream = {
    write: (buf) => {
      writes.push(buf.length)
      return true
    },
    end: () => undefined,
    onClosed: (cb) => {
      listeners.push(cb)
    },
    responsePromise,
  }
  return {
    stream,
    writes,
    fireClosed: (info) => {
      for (const cb of listeners) cb(info)
    },
  }
}

function makeClient(
  channels: readonly HikvisionTwoWayAudioChannel[],
  stream: AudioDataStream,
): HikvisionIntercomClient {
  return {
    listTwoWayAudioChannels: async () => channels,
    openTwoWayAudio: async () => undefined,
    closeTwoWayAudio: async () => undefined,
    openAudioDataStream: () => stream,
  }
}

const CHANNEL: HikvisionTwoWayAudioChannel = {
  id: '1',
  audioCompressionType: 'G.711ulaw',
  enabled: true,
}

/** PCM s16le → µ-law is 1 byte per 2 PCM bytes. N µ-law bytes ← 2N PCM. */
function pcmYieldingUlawBytes(ulawBytes: number): Buffer {
  // Arbitrary but deterministic sample values; encode size is what matters.
  return Buffer.alloc(ulawBytes * 2)
}

describe('HikvisionIntercomSession — fixed 1024-byte audioData chunking', () => {
  it('exposes the chunk size as a named const of 1024', () => {
    expect(AUDIO_DATA_CHUNK_BYTES).toBe(1024)
  })

  it('flushes 1024-byte chunks and the remainder on stop (2500 µ-law bytes)', async () => {
    const logs: LogCall[] = []
    const { stream, writes } = makeCapturingStream()
    const session = new HikvisionIntercomSession({
      client: makeClient([CHANNEL], stream),
      logger: makeLogger(logs),
      deviceTag: 'camera-1',
      // Generous backlog so the safety clamp never drops these 5000 PCM bytes.
      maxBacklogMs: 5_000,
    })
    await session.start()

    // 2500 µ-law bytes ← 5000 PCM bytes. Two full 1024 chunks flush
    // immediately; 452 bytes stay buffered until stop().
    session.feedPcm(pcmYieldingUlawBytes(2500))

    expect(writes).toEqual([AUDIO_DATA_CHUNK_BYTES, AUDIO_DATA_CHUNK_BYTES])

    await session.stop()

    expect(writes).toEqual([
      AUDIO_DATA_CHUNK_BYTES,
      AUDIO_DATA_CHUNK_BYTES,
      2500 - 2 * AUDIO_DATA_CHUNK_BYTES,
    ])
  })

  it('holds the remainder across feeds and never writes a partial chunk before stop', async () => {
    const logs: LogCall[] = []
    const { stream, writes } = makeCapturingStream()
    const session = new HikvisionIntercomSession({
      client: makeClient([CHANNEL], stream),
      logger: makeLogger(logs),
      deviceTag: 'camera-1',
      maxBacklogMs: 5_000,
    })
    await session.start()

    // 600 + 600 = 1200 µ-law bytes → one 1024 flush, 176 held.
    session.feedPcm(pcmYieldingUlawBytes(600))
    expect(writes).toEqual([])
    session.feedPcm(pcmYieldingUlawBytes(600))
    expect(writes).toEqual([AUDIO_DATA_CHUNK_BYTES])

    await session.stop()
    expect(writes).toEqual([AUDIO_DATA_CHUNK_BYTES, 1200 - AUDIO_DATA_CHUNK_BYTES])
  })

  it('does not flush a final write when nothing remains after a clean chunk boundary', async () => {
    const logs: LogCall[] = []
    const { stream, writes } = makeCapturingStream()
    const session = new HikvisionIntercomSession({
      client: makeClient([CHANNEL], stream),
      logger: makeLogger(logs),
      deviceTag: 'camera-1',
      maxBacklogMs: 5_000,
    })
    await session.start()

    // Exactly 2048 µ-law bytes → two clean 1024 chunks, zero remainder.
    session.feedPcm(pcmYieldingUlawBytes(2048))
    expect(writes).toEqual([AUDIO_DATA_CHUNK_BYTES, AUDIO_DATA_CHUNK_BYTES])

    await session.stop()
    // No trailing partial flush.
    expect(writes).toEqual([AUDIO_DATA_CHUNK_BYTES, AUDIO_DATA_CHUNK_BYTES])
  })

  it('the audioData stats reflect bytes flushed to the wire', async () => {
    const logs: LogCall[] = []
    const { stream } = makeCapturingStream()
    const session = new HikvisionIntercomSession({
      client: makeClient([CHANNEL], stream),
      logger: makeLogger(logs),
      deviceTag: 'camera-1',
      maxBacklogMs: 5_000,
    })
    await session.start()
    session.feedPcm(pcmYieldingUlawBytes(2500))
    await session.stop()

    const stopping = logs.find((l) => l.message === 'intercom talk session stopping')
    expect(stopping).toBeDefined()
    // All 2500 bytes ended up flushed (2x1024 + 452 on stop).
    expect(stopping?.extras?.meta?.ulawBytesWritten).toBe(2500)
  })
})
