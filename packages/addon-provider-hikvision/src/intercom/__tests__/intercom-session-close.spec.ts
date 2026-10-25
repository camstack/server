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
  type HikvisionIntercomClient,
  type HikvisionIntercomCloseInfo,
} from '../hikvision-intercom-session.js'
import type { IntercomCloseReason } from '../intercom-orchestrator.js'

/**
 * Session-level close-reason classification: a camera-side close of the
 * sticky audioData PUT must surface as `remote-closed-put`, a socket
 * error as `put-error`. This is the prime "deactivates immediately"
 * signal — pin the mapping.
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

/** A controllable fake AudioDataStream — the test fires `onClosed`. */
function makeFakeStream(): {
  stream: AudioDataStream
  fireClosed: (info: AudioDataCloseInfo) => void
} {
  const listeners: Array<(info: AudioDataCloseInfo) => void> = []
  // The session only awaits this inside a 250ms race in stop(); a
  // never-resolving promise mirrors the real sticky PUT (stays open
  // until end() or a camera close), so no cast is needed.
  const responsePromise = new Promise<IncomingMessage>(() => {
    /* sticky */
  })
  const stream: AudioDataStream = {
    write: () => true,
    end: () => undefined,
    onClosed: (cb) => {
      listeners.push(cb)
    },
    responsePromise,
  }
  return {
    stream,
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

describe('HikvisionIntercomSession — camera-initiated close classification', () => {
  it('maps a camera-response close to remote-closed-put', async () => {
    const logs: LogCall[] = []
    const { stream, fireClosed } = makeFakeStream()
    const session = new HikvisionIntercomSession({
      client: makeClient([CHANNEL], stream),
      logger: makeLogger(logs),
      deviceTag: 'camera-1',
    })
    const seen: HikvisionIntercomCloseInfo[] = []
    session.onClose((info) => {
      seen.push(info)
    })
    await session.start()

    fireClosed({ cause: 'camera-response', statusCode: 200 })
    await Promise.resolve()

    expect(seen).toHaveLength(1)
    expect(seen[0]?.reason).toBe<IntercomCloseReason>('remote-closed-put')
  })

  it('maps a socket-error close to put-error and carries the error', async () => {
    const logs: LogCall[] = []
    const { stream, fireClosed } = makeFakeStream()
    const session = new HikvisionIntercomSession({
      client: makeClient([CHANNEL], stream),
      logger: makeLogger(logs),
      deviceTag: 'camera-1',
    })
    const seen: HikvisionIntercomCloseInfo[] = []
    session.onClose((info) => {
      seen.push(info)
    })
    await session.start()

    const boom = new Error('ECONNRESET')
    fireClosed({ cause: 'socket-error', statusCode: null, error: boom })
    await Promise.resolve()

    expect(seen[0]?.reason).toBe<IntercomCloseReason>('put-error')
    expect(seen[0]?.error).toBe(boom)
  })

  it('a local-end close does NOT trigger a teardown notification', async () => {
    const logs: LogCall[] = []
    const { stream, fireClosed } = makeFakeStream()
    const session = new HikvisionIntercomSession({
      client: makeClient([CHANNEL], stream),
      logger: makeLogger(logs),
      deviceTag: 'camera-1',
    })
    const seen: HikvisionIntercomCloseInfo[] = []
    session.onClose((info) => {
      seen.push(info)
    })
    await session.start()

    fireClosed({ cause: 'local-end', statusCode: 200 })
    await Promise.resolve()

    expect(seen).toHaveLength(0)
  })

  it('logs the channel spec at open including the enabled flag', async () => {
    const logs: LogCall[] = []
    const { stream } = makeFakeStream()
    const disabledChannel: HikvisionTwoWayAudioChannel = {
      id: '1',
      audioCompressionType: 'G.711ulaw',
      enabled: false,
    }
    const session = new HikvisionIntercomSession({
      client: makeClient([disabledChannel], stream),
      logger: makeLogger(logs),
      deviceTag: 'camera-1',
    })
    await session.start()

    const spec = logs.find((l) => l.message === 'intercom: TwoWayAudio channel spec')
    expect(spec).toBeDefined()
    expect(spec?.level).toBe('warn') // enabled:false → warn
    expect(spec?.extras?.meta?.enabled).toBe(false)
    expect(spec?.extras?.meta?.channelCount).toBe(1)
    expect(spec?.extras?.meta?.audioCompressionType).toBe('G.711ulaw')
  })
})
