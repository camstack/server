import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import type { IScopedLogger } from '@dominevo/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FfmpegPushReader, redactFfmpegStderr } from '../rtsp/ffmpeg-push-reader.js'

function makeLogger(): IScopedLogger {
  const l: IScopedLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => l),
    withTags: vi.fn(() => l),
  }
  return l
}

function makeChild() {
  const stderr = new EventEmitter()
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr,
    stdin: { on: () => {}, end: vi.fn() },
    exitCode: null,
    signalCode: null,
    pid: 1,
    kill: vi.fn(),
  })
  return { stderr, child }
}

function setup() {
  const { stderr, child } = makeChild()
  const logger = makeLogger()
  // Test-only narrowing: the fake carries the subset the reader touches.
  const spawnFn = vi.fn(() => child as unknown as ChildProcess)
  const reader = new FfmpegPushReader(
    { ffmpegPath: 'ffmpeg', args: [], spawnFn, logger },
    { onEncodedPacket: () => {}, onAudioInfo: () => {} },
    'test-reader',
  )
  reader.connect()
  return { stderr, logger }
}

const loggedStderr = (logger: IScopedLogger): string[] =>
  vi
    .mocked(logger.warn)
    .mock.calls.filter(([msg]) => String(msg).includes('ffmpeg stderr'))
    .map(([, ctx]) => String(ctx?.meta?.['stderr']))

describe('FfmpegPushReader live stderr', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
  })
  afterEach(() => vi.useRealTimers())

  it('logs a chunk with the input URL redacted (no user, password or token)', () => {
    const { stderr, logger } = setup()
    stderr.emit('data', Buffer.from('Error opening input rtsp://user:pass@host/x?token=abc: 401\n'))
    const lines = loggedStderr(logger)
    expect(lines).toHaveLength(1)
    for (const secret of ['user', 'pass', 'abc']) expect(lines[0]).not.toContain(secret)
    expect(lines[0]).toContain('rtsp://<redacted>')
  })

  it('rate-limits: two chunks inside 10 s give one line, a later one logs again', () => {
    const { stderr, logger } = setup()
    stderr.emit('data', Buffer.from('first'))
    vi.advanceTimersByTime(5_000)
    stderr.emit('data', Buffer.from('second'))
    expect(loggedStderr(logger)).toEqual(['first'])
    vi.advanceTimersByTime(5_000)
    stderr.emit('data', Buffer.from('third'))
    expect(loggedStderr(logger)).toEqual(['first', 'third'])
  })

  it('caps a logged chunk at 1 KB, keeping the end', () => {
    const { stderr, logger } = setup()
    stderr.emit('data', Buffer.from(`${'a'.repeat(3000)}END`))
    const [line] = loggedStderr(logger)
    expect(line).toHaveLength(1024)
    expect(line?.endsWith('END')).toBe(true)
  })

  it('the exit error carries the redacted tail too', () => {
    const errors: Error[] = []
    const { stderr, child } = makeChild()
    const reader = new FfmpegPushReader(
      { ffmpegPath: 'ffmpeg', args: [], spawnFn: vi.fn(() => child as unknown as ChildProcess) },
      { onEncodedPacket: () => {}, onAudioInfo: () => {}, onError: (e) => errors.push(e) },
      'test-reader',
    )
    reader.connect()
    stderr.emit('data', Buffer.from('rtsp://user:pass@host/x?token=abc failed'))
    child.emit('exit', 1, null)
    expect(errors[0]?.message).not.toMatch(/user|pass@|abc/)
  })

  it('keeps non-URL text', () => {
    expect(redactFfmpegStderr('Connection refused')).toBe('Connection refused')
  })
})
