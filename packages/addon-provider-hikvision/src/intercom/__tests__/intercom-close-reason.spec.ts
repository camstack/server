import type { IScopedLogger, LogExtras } from '@camstack/types'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  type IIntercomTalkSession,
  type IntercomAudioCodecApi,
  type IntercomCloseInfo,
  type IntercomCloseReason,
  IntercomOrchestrator,
  type IntercomWebrtcPeer,
} from '../intercom-orchestrator.js'

/**
 * Close-reason plumbing tests. The whole point of this work is that the
 * "intercom session closed" log MUST carry a `reason` so we can tell a
 * normal `user-stop` from a `remote-closed-put` / `ice-disconnected` /
 * `codec-error` failure. These tests pin that contract.
 */

interface LogCall {
  readonly level: 'debug' | 'info' | 'warn' | 'error'
  readonly message: string
  readonly extras?: LogExtras
}

function makeLogger(sink: LogCall[]): IScopedLogger {
  const logger: IScopedLogger = {
    debug: (message, extras) => {
      sink.push({ level: 'debug', message, extras })
    },
    info: (message, extras) => {
      sink.push({ level: 'info', message, extras })
    },
    warn: (message, extras) => {
      sink.push({ level: 'warn', message, extras })
    },
    error: (message, extras) => {
      sink.push({ level: 'error', message, extras })
    },
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

function makeAudioCodec(): IntercomAudioCodecApi {
  return {
    createDecodeSession: async () => ({ sessionId: 'codec-1', nodeId: 'node-1' }),
    pushEncodedFrame: async () => undefined,
    pullPcm: async () => [],
    closeSession: async () => undefined,
  }
}

function makePeer(): IntercomWebrtcPeer {
  return {
    createOffer: async () => ({ sdp: 'v=0' }),
    setAnswer: async () => undefined,
    onOpusFrame: () => undefined,
    close: async () => undefined,
  }
}

function makeTalkSession(): IIntercomTalkSession {
  let open = false
  return {
    get isOpen() {
      return open
    },
    sampleRate: 8_000,
    ability: { codecs: ['g711ulaw'], sampleRate: 8_000, duplex: 'half', maxBacklogMs: 200 },
    start: async () => {
      open = true
    },
    feedPcm: () => undefined,
    stop: async () => {
      open = false
    },
  }
}

describe('IntercomOrchestrator — close reason plumbing', () => {
  let logs: LogCall[]
  let orchestrator: IntercomOrchestrator

  beforeEach(() => {
    logs = []
    orchestrator = new IntercomOrchestrator({
      deviceTag: 'camera-test',
      logger: makeLogger(logs),
      audioCodec: makeAudioCodec(),
      peerFactory: () => makePeer(),
      talkSessionFactory: () => makeTalkSession(),
    })
  })

  it('defaults to user-stop when stop() is called with no reason', async () => {
    const { sessionId } = await orchestrator.start()
    await orchestrator.stop(sessionId)
    const closed = logs.find((l) => l.message === 'intercom session closed')
    expect(closed).toBeDefined()
    expect(closed?.extras?.meta?.reason).toBe<IntercomCloseReason>('user-stop')
  })

  it('threads an explicit reason into the closed log', async () => {
    const { sessionId } = await orchestrator.start()
    await orchestrator.stop(sessionId, { reason: 'ice-disconnected' })
    const closed = logs.find((l) => l.message === 'intercom session closed')
    expect(closed?.extras?.meta?.reason).toBe<IntercomCloseReason>('ice-disconnected')
  })

  it('includes the triggering error message when a reason carries one', async () => {
    const { sessionId } = await orchestrator.start()
    await orchestrator.stop(sessionId, {
      reason: 'put-error',
      error: new Error('camera dropped the audioData PUT'),
    })
    const closed = logs.find((l) => l.message === 'intercom session closed')
    expect(closed?.extras?.meta?.reason).toBe<IntercomCloseReason>('put-error')
    expect(closed?.extras?.meta?.error).toBe('camera dropped the audioData PUT')
  })

  it('surfaces the close info to an onClosed subscriber exactly once', async () => {
    const seen: IntercomCloseInfo[] = []
    orchestrator.onClosed((info) => {
      seen.push(info)
    })
    const { sessionId } = await orchestrator.start()
    await orchestrator.stop(sessionId, { reason: 'remote-closed-put' })
    // Double-stop must NOT re-emit.
    await orchestrator.stop(sessionId, { reason: 'user-stop' })
    expect(seen).toHaveLength(1)
    expect(seen[0]?.sessionId).toBe(sessionId)
    expect(seen[0]?.reason).toBe<IntercomCloseReason>('remote-closed-put')
  })
})
