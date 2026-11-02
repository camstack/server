/**
 * Debug watch: the thunk, the window, the re-arm, the cap, and the mirror a
 * forked process holds.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IScopedLogger, LogExtras } from '../../interfaces/logging.js'
import {
  DEBUG_WATCH_HARD_CAP_MS,
  DEBUG_WATCH_REARM_EVERY_MS,
  DEBUG_WATCH_WINDOW_MS,
  DebugInterest,
  DebugWatchTable,
  __resetDebugInterestForTests,
  createDebugEmitter,
  getDebugInterest,
} from '../debug-watch.js'
import { createLogChannelsProvider } from '../log-channel-provider.js'
import { LogChannelDescriptorSchema } from '../log-channel.js'

interface Line {
  readonly message: string
  readonly extras: LogExtras | undefined
}

function fakeLogger(lines: Line[]): IScopedLogger {
  const logger: IScopedLogger = {
    debug: () => undefined,
    info: (message, extras) => lines.push({ message, extras }),
    warn: () => undefined,
    error: () => undefined,
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

afterEach(() => {
  __resetDebugInterestForTests()
})

describe('ctx.debug', () => {
  it('does not evaluate the thunk without interest', () => {
    const lines: Line[] = []
    const thunk = vi.fn(() => ({ message: 'dump' }))
    createDebugEmitter(fakeLogger(lines), new DebugInterest())('ptz', 7, thunk)
    expect(thunk).not.toHaveBeenCalled()
    expect(lines).toHaveLength(0)
  })

  it('evaluates it for the watched device only, and tags the line', () => {
    const interest = new DebugInterest()
    interest.apply([{ channel: 'debug.ptz', armedUntilMs: 10_000, deviceIds: [7] }], 0)
    const lines: Line[] = []
    const thunk = vi.fn(() => ({ message: 'dump', meta: { x: 1 } }))
    const emit = createDebugEmitter(fakeLogger(lines), interest)
    emit('ptz', 8, thunk)
    expect(thunk).not.toHaveBeenCalled()
    emit('ptz', 7, thunk)
    expect(thunk).toHaveBeenCalledTimes(1)
    expect(lines[0]?.extras?.tags).toEqual({ deviceId: 7, logChannel: 'debug.ptz' })
  })
})

describe('watch table', () => {
  const T0 = 1_000_000

  it('lapses after the window', () => {
    const table = new DebugWatchTable()
    table.start('debug.ptz', [1], T0)
    expect(table.windows(T0 + DEBUG_WATCH_WINDOW_MS - 1)).toHaveLength(1)
    expect(table.windows(T0 + DEBUG_WATCH_WINDOW_MS)).toHaveLength(0)
  })

  it('a re-arm extends it', () => {
    const table = new DebugWatchTable()
    table.start('debug.ptz', [1], T0)
    const at = T0 + DEBUG_WATCH_REARM_EVERY_MS
    expect(table.rearm('debug.ptz', at)).toBe('rearmed')
    expect(table.windows(T0 + DEBUG_WATCH_WINDOW_MS + 1)).toHaveLength(1)
    expect(table.states(at)[0]?.untilMs).toBe(at + DEBUG_WATCH_WINDOW_MS)
  })

  it('holds the 60 minute cap against any chain of re-arms, and Start', () => {
    const table = new DebugWatchTable()
    table.start('debug.ptz', [1], T0)
    let now = T0
    while (now + DEBUG_WATCH_REARM_EVERY_MS < T0 + DEBUG_WATCH_HARD_CAP_MS) {
      now += DEBUG_WATCH_REARM_EVERY_MS
      table.rearm('debug.ptz', now)
      table.start('debug.ptz', [1], now)
    }
    expect(table.windows(T0 + DEBUG_WATCH_HARD_CAP_MS - 1)).toHaveLength(1)
    expect(table.windows(T0 + DEBUG_WATCH_HARD_CAP_MS)).toHaveLength(0)
    // an open page that outlived the cap does not revive it
    expect(table.rearm('debug.ptz', T0 + DEBUG_WATCH_HARD_CAP_MS + 1)).toBe('lapsed')
  })
})

describe('interest reaches another process', () => {
  it('a forked runner applies the pushed windows and its ctx.debug follows', () => {
    // The hub pushes through the `log-channels` provider of the process; the
    // process here is a fresh mirror driven only by that provider's apply.
    let clock = 0
    const lines: Line[] = []
    const provider = createLogChannelsProvider(fakeLogger(lines), { now: () => clock, tickMs: 1 })
    const emit = createDebugEmitter(fakeLogger(lines))
    const thunk = vi.fn(() => ({ message: 'dump' }))
    emit('ptz', 7, thunk)
    expect(thunk).not.toHaveBeenCalled()
    provider.apply({ windows: [{ channel: 'debug.ptz', armedUntilMs: 5_000, deviceIds: [7] }] })
    emit('ptz', 7, thunk)
    expect(thunk).toHaveBeenCalledTimes(1)
    // the window lapses on the process's own timer, with no further push
    clock = 5_000
    getDebugInterest().tick(clock)
    emit('ptz', 7, thunk)
    expect(thunk).toHaveBeenCalledTimes(1)
    provider.stop()
  })
})

describe('descriptor kind', () => {
  it('defaults to diagnostic and refuses a debug channel that is not debug.<x> per-device', () => {
    const base = { name: 'a.b', description: 'd', defaultLevel: 'info', perDevice: true } as const
    expect(LogChannelDescriptorSchema.parse(base).kind).toBe('diagnostic')
    expect(() => LogChannelDescriptorSchema.parse({ ...base, kind: 'debug' })).toThrow()
    expect(LogChannelDescriptorSchema.parse({ ...base, name: 'debug.x', kind: 'debug' }).kind).toBe(
      'debug',
    )
  })
})
