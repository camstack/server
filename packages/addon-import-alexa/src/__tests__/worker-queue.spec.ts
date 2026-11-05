import { EventEmitter } from 'node:events'
import type { IScopedLogger } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startAlexaWorker, type WorkerChild } from '../speak/worker-client.js'

interface Pipe {
  readonly child: WorkerChild
  readonly sent: () => Array<Record<string, unknown>>
  readonly reply: (line: unknown) => void
}

function pipe(): Pipe {
  const stdout = new EventEmitter()
  const written: string[] = []
  const child: WorkerChild = {
    stdin: { write: (chunk: string) => void written.push(chunk) },
    stdout: { on: (_e, listener) => void stdout.on('data', listener) },
    stderr: { on: () => undefined },
    on: () => undefined,
    kill: () => undefined,
  }
  return {
    child,
    sent: () => written.map((line) => JSON.parse(line) as Record<string, unknown>),
    reply: (line) => void stdout.emit('data', Buffer.from(`${JSON.stringify(line)}\n`)),
  }
}

interface LogLine {
  readonly level: 'debug' | 'warn'
  readonly message: string
  readonly extras: {
    tags?: { deviceId?: number }
    meta?: Record<string, unknown>
  }
}

function capture(): { logger: IScopedLogger; lines: LogLine[] } {
  const lines: LogLine[] = []
  const logger: IScopedLogger = {
    debug: (message, extras) => void lines.push({ level: 'debug', message, extras: extras ?? {} }),
    info() {},
    warn: (message, extras) => void lines.push({ level: 'warn', message, extras: extras ?? {} }),
    error() {},
    child: () => logger,
    withTags: () => logger,
  }
  return { logger, lines }
}

function boot(): {
  p: Pipe
  worker: ReturnType<typeof startAlexaWorker>
  lines: LogLine[]
} {
  const p = pipe()
  const { logger, lines } = capture()
  const worker = startAlexaWorker({
    pythonPath: 'py',
    scriptPath: 'w.py',
    env: {},
    logger,
    spawnChild: () => p.child,
  })
  return { p, worker, lines }
}

const flush = async (): Promise<void> => {
  await Promise.resolve()
}

describe('Echo worker queue', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('rejects a queued call that was not started by its deadline and never sends it', async () => {
    const { p, worker } = boot()
    const first = worker.request({ op: 'dnd_state' }, { deadlineMs: 60_000 })
    const late = worker.request({ op: 'set_volume', serial: 's', level: 40 }, { deadlineMs: 5_000 })
    const lateResult = late.then(
      () => 'ok',
      (err: Error) => err.message,
    )
    await vi.advanceTimersByTimeAsync(5_001)
    await expect(lateResult).resolves.toMatch(/not started within 5000 ms/)
    p.reply({ id: '1', ok: true, result: {} })
    await first
    await flush()
    expect(p.sent().map((line) => line['op'])).toEqual(['dnd_state'])
  })

  it('a started call that overruns rejects its caller and its late reply is not given to the next call', async () => {
    const { p, worker } = boot()
    const slow = worker.request(
      { op: 'np_command', serial: 's', command: 'play' },
      { deadlineMs: 1_000 },
    )
    const slowResult = slow.then(
      () => 'ok',
      (err: Error) => err.message,
    )
    const next = worker.request(
      { op: 'player_state', serial: 's', deviceType: 'T' },
      { deadlineMs: 60_000 },
    )
    await vi.advanceTimersByTimeAsync(1_001)
    await expect(slowResult).resolves.toMatch(/timed out after 1000 ms/)
    // The lane is still held by the abandoned line: the next call has not been sent.
    expect(p.sent().map((line) => line['id'])).toEqual(['1'])
    p.reply({ id: '1', ok: true, result: { stale: true } })
    await flush()
    expect(p.sent().map((line) => line['id'])).toEqual(['1', '2'])
    p.reply({
      id: '2',
      ok: true,
      result: { playerInfo: { state: 'PLAYING' } },
    })
    await expect(next).resolves.toEqual({ playerInfo: { state: 'PLAYING' } })
  })

  it('replaces a queued set_volume for the same serial with the newer one, both callers get its outcome', async () => {
    const { p, worker } = boot()
    const blocker = worker.request({ op: 'dnd_state' })
    const a = worker.request({ op: 'set_volume', serial: 's', level: 10 })
    const b = worker.request({ op: 'set_volume', serial: 's', level: 55 })
    const other = worker.request({ op: 'set_volume', serial: 't', level: 20 })
    p.reply({ id: '1', ok: true, result: {} })
    await blocker
    await flush()
    const sent = p.sent().filter((line) => line['op'] === 'set_volume')
    expect(sent.map((line) => line['level'])).toEqual([55])
    p.reply({ id: p.sent()[1]?.['id'], ok: true, result: { done: 1 } })
    await expect(a).resolves.toEqual({ done: 1 })
    await expect(b).resolves.toEqual({ done: 1 })
    await flush()
    p.reply({ id: p.sent()[2]?.['id'], ok: true, result: {} })
    await other
    expect(
      p
        .sent()
        .filter((line) => line['op'] === 'set_volume')
        .map((l) => l['level']),
    ).toEqual([55, 20])
  })

  it('does not enqueue an identical queued read twice', async () => {
    const { p, worker } = boot()
    const blocker = worker.request({ op: 'dnd_state' })
    const r1 = worker.request({
      op: 'player_state',
      serial: 's',
      deviceType: 'T',
    })
    const r2 = worker.request({
      op: 'player_state',
      serial: 's',
      deviceType: 'T',
    })
    p.reply({ id: '1', ok: true, result: {} })
    await blocker
    await flush()
    p.reply({ id: p.sent()[1]?.['id'], ok: true, result: { playerInfo: {} } })
    await expect(r1).resolves.toEqual({ playerInfo: {} })
    await expect(r2).resolves.toEqual({ playerInfo: {} })
    expect(p.sent().filter((line) => line['op'] === 'player_state')).toHaveLength(1)
  })

  it('sends a command ahead of queued poll reads', async () => {
    const { p, worker } = boot()
    const blocker = worker.request({ op: 'dnd_state' })
    void worker.request({ op: 'player_state', serial: 's', deviceType: 'T' })
    void worker.request({ op: 'device_volumes' })
    void worker.request({ op: 'np_command', serial: 's', command: 'play' })
    p.reply({ id: '1', ok: true, result: {} })
    await blocker
    await flush()
    expect(p.sent().map((line) => line['op'])).toEqual(['dnd_state', 'np_command'])
  })

  it('logs enqueued-to-done timing with the device id, at warn above 5 s', async () => {
    const { p, worker, lines } = boot()
    const fast = worker.request({ op: 'set_volume', serial: 's', level: 5 }, { deviceId: 42 })
    p.reply({ id: '1', ok: true, result: {} })
    await fast
    const ok = lines.find((l) => l.message === 'alexa worker request')
    expect(ok?.level).toBe('debug')
    expect(ok?.extras.tags).toEqual({ deviceId: 42 })
    expect(ok?.extras.meta).toMatchObject({ op: 'set_volume', outcome: 'ok' })

    const slow = worker.request(
      { op: 'set_volume', serial: 's', level: 6 },
      { deviceId: 42, deadlineMs: 60_000 },
    )
    await vi.advanceTimersByTimeAsync(6_000)
    p.reply({ id: '2', ok: true, result: {} })
    await slow
    const warn = lines.find(
      (l) => l.level === 'warn' && l.message === 'alexa worker request was slow',
    )
    expect(warn?.extras.tags).toEqual({ deviceId: 42 })
    expect(Number(warn?.extras.meta?.['totalMs'])).toBeGreaterThanOrEqual(6_000)
  })
})
