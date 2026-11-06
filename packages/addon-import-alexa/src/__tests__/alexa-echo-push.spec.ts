import { EventEmitter } from 'node:events'
import { DeviceType, type IScopedLogger } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { alexaEchoSessions, type EchoSession } from '../alexa-echo-sessions.js'
import { AlexaEchoDevice } from '../devices/alexa-echo-device.js'
import { BrokerEcho } from '../speak/broker-echo.js'
import {
  ECHO_POLL_MS,
  ECHO_POLL_PUSH_HEALTHY_MS,
  ECHO_PUSH_READ_GAP_MS,
} from '../speak/constants.js'
import type { EchoPushSink } from '../speak/echo-push.js'
import { startAlexaWorker, type AlexaWorker, type WorkerChild } from '../speak/worker-client.js'
import type { PlayerInfo, WorkerPush } from '../speak/worker-protocol.js'
import { makeCtx, type LogLine } from './fake-ctx.js'

function fakeChild(): { child: WorkerChild; say: (line: unknown) => void; exit: () => void } {
  const stdout = new EventEmitter()
  const life = new EventEmitter()
  const child: WorkerChild = {
    stdin: { write: () => undefined },
    stdout: { on: (_e, listener) => void stdout.on('data', listener) },
    stderr: { on: () => undefined },
    on: (event, listener) => void life.on(event, listener),
    kill: () => void life.emit('close', null),
  }
  return {
    child,
    say: (line) => void stdout.emit('data', Buffer.from(`${JSON.stringify(line)}\n`)),
    exit: () => void life.emit('close', 1),
  }
}

describe('worker client: push lines', () => {
  function start() {
    const fake = fakeChild()
    const warns: string[] = []
    const logger = {
      debug: () => undefined,
      info: () => undefined,
      warn: (m: string) => void warns.push(m),
      error: () => undefined,
    } as unknown as IScopedLogger
    const worker = startAlexaWorker({
      pythonPath: 'p',
      scriptPath: 's',
      spawnChild: () => fake.child,
      logger,
      schedule: () => undefined,
    })
    const seen: WorkerPush[] = []
    worker.onPush((push) => void seen.push(push))
    void worker.request({ op: 'session_status' }).catch(() => undefined)
    return { fake, seen, warns }
  }

  it('delivers channel and event lines, validated, and never as a reply', () => {
    const { fake, seen, warns } = start()
    fake.say({ push: 'channel', state: 'up', reason: 'connected', retryInMs: 0 })
    fake.say({ push: 'event', command: 'PUSH_VOLUME_CHANGE', serial: 'S1' })
    expect(seen).toEqual([
      { push: 'channel', state: 'up', reason: 'connected', retryInMs: 0 },
      { push: 'event', command: 'PUSH_VOLUME_CHANGE', serial: 'S1' },
    ])
    expect(warns).toEqual([])
  })

  it('a malformed push line is warned and dropped', () => {
    const { fake, seen, warns } = start()
    fake.say({ push: 'event', command: 42, serial: 'S1' })
    expect(seen).toEqual([])
    expect(warns).toContain('alexa worker push line failed schema')
  })

  it('a worker that exits reports its channel down', () => {
    const { fake, seen } = start()
    fake.say({ push: 'channel', state: 'up' })
    fake.exit()
    expect(seen.at(-1)).toMatchObject({ push: 'channel', state: 'down', reason: 'worker exited' })
  })
})

describe('BrokerEcho: push lines', () => {
  function setup() {
    let listener: (push: WorkerPush) => void = () => undefined
    const logs: Array<{ level: string; message: string }> = []
    const at =
      (level: string) =>
      (message: string): void => {
        logs.push({ level, message })
      }
    const logger = {
      debug: at('debug'),
      info: at('info'),
      warn: at('warn'),
      error: at('error'),
    } as unknown as IScopedLogger
    const worker = {
      request: vi.fn(),
      noteSecrets: vi.fn(),
      onPush: (fn: (push: WorkerPush) => void) => void (listener = fn),
      stop: vi.fn(),
      failed: false,
    } as unknown as AlexaWorker
    const sink = { channel: vi.fn(), event: vi.fn() } satisfies EchoPushSink
    const echo = new BrokerEcho({
      brokerId: 'b',
      brokerName: 'Home',
      domain: 'amazon.it',
      worker,
      readSeed: async () => null,
      sessions: { get: async () => '', put: async () => {}, delete: async () => {} },
      logger,
      push: sink,
    })
    return { echo, sink, logs, push: (p: WorkerPush) => listener(p) }
  }

  it('reports the channel on change only, and logs connect, disconnect and reconnect', () => {
    const { echo, sink, logs, push } = setup()
    expect(echo.pushChannel).toBe('down')
    push({ push: 'channel', state: 'up', reason: 'connected', retryInMs: 0 })
    push({ push: 'channel', state: 'up', reason: 'connected', retryInMs: 0 })
    push({ push: 'channel', state: 'down', reason: 'stream ended', retryInMs: 5000 })
    push({ push: 'channel', state: 'down', reason: 'open timeout', retryInMs: 10000 })
    push({ push: 'channel', state: 'up', reason: 'connected', retryInMs: 0 })
    expect(sink.channel.mock.calls).toEqual([['b', 'up'], ['b', 'down'], ['b', 'up']])
    expect(echo.pushChannel).toBe('up')
    const messages = logs.filter((l) => l.level !== 'debug').map((l) => l.message)
    expect(messages).toEqual([
      'alexa echo: push channel connected, polling slows down',
      'alexa echo: push channel down, polling at the normal pace',
      'alexa echo: push channel reconnected, polling slows down',
    ])
  })

  it('a reading event reaches the sink; an ignored one does not; an unknown one is logged once', () => {
    const { sink, logs, push } = setup()
    push({ push: 'event', command: 'PUSH_VOLUME_CHANGE', serial: 'S1' })
    push({ push: 'event', command: 'PUSH_MEDIA_PROGRESS_CHANGE', serial: 'S1' })
    push({ push: 'event', command: 'PUSH_BRAND_NEW', serial: 'S1' })
    push({ push: 'event', command: 'PUSH_BRAND_NEW', serial: 'S2' })
    expect(sink.event.mock.calls).toEqual([['b', 'S1']])
    expect(logs.filter((l) => l.message.includes('unknown push event'))).toHaveLength(1)
  })
})

describe('AlexaEchoDevice: push', () => {
  interface Fake extends EchoSession {
    playerState: ReturnType<typeof vi.fn>
    setVolume: ReturnType<typeof vi.fn>
  }
  function session(volume: () => number | Promise<number>): Fake {
    return {
      state: 'ready',
      rateLimitedUntil: null,
      devices: [
        {
          id: 'S1',
          name: 'K',
          family: 'ECHO',
          online: true,
          kind: 'device',
          dnd: false,
          deviceType: 'T1',
        },
      ],
      playerState: vi.fn(
        async (): Promise<PlayerInfo> => ({
          state: 'PLAYING',
          volume: { volume: await volume(), muted: false },
        }),
      ),
      npCommand: vi.fn(async () => undefined),
      setVolume: vi.fn(async () => undefined),
      dndState: vi.fn(async () => new Map([['S1', false]])),
      deviceVolumes: vi.fn(async () => new Map()),
      setDnd: vi.fn(async () => undefined),
    }
  }

  async function build(): Promise<{ device: AlexaEchoDevice; logs: LogLine[]; providers: Map<string, unknown> }> {
    const logs: LogLine[] = []
    const { ctx, providers } = makeCtx(
      { brokerId: 'b', serial: 'S1', deviceType: 'T1', system: 'alexa' },
      { type: DeviceType.MediaPlayer, logs },
    )
    const device = new AlexaEchoDevice(ctx)
    await device.onActivate()
    await vi.advanceTimersByTimeAsync(0)
    return { device, logs, providers }
  }
  const volumeOf = (device: AlexaEchoDevice): unknown =>
    device.runtimeState.getCapState<{ volumeLevel: number | null }>('media-player')?.volumeLevel

  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    alexaEchoSessions.clear()
  })

  it('a push event for this Echo updates the slice well before the next poll', async () => {
    let level = 40
    const s = session(() => level)
    alexaEchoSessions.setResolver(() => s)
    const { device } = await build()
    expect(volumeOf(device)).toBe(40)
    level = 65
    alexaEchoSessions.event('b', 'S1')
    await vi.advanceTimersByTimeAsync(ECHO_PUSH_READ_GAP_MS)
    expect(volumeOf(device)).toBe(65)
    await device.removeDevice()
  })

  it('an event for another Echo does not read this one', async () => {
    const s = session(() => 40)
    alexaEchoSessions.setResolver(() => s)
    const { device } = await build()
    s.playerState.mockClear()
    alexaEchoSessions.event('b', 'OTHER')
    await vi.advanceTimersByTimeAsync(ECHO_PUSH_READ_GAP_MS * 2)
    expect(s.playerState).not.toHaveBeenCalled()
    await device.removeDevice()
  })

  it('a burst of events is one read', async () => {
    const s = session(() => 40)
    alexaEchoSessions.setResolver(() => s)
    const { device } = await build()
    s.playerState.mockClear()
    for (let i = 0; i < 5; i++) alexaEchoSessions.event('b', 'S1')
    await vi.advanceTimersByTimeAsync(ECHO_PUSH_READ_GAP_MS)
    expect(s.playerState).toHaveBeenCalledTimes(1)
    await device.removeDevice()
  })

  it('a read that began before an optimistic set does not undo it, whatever the event said', async () => {
    let release: (level: number) => void = () => undefined
    let first = true
    const s = session(() => {
      if (first) {
        first = false
        return 40
      }
      return new Promise<number>((resolve) => void (release = resolve))
    })
    alexaEchoSessions.setResolver(() => s)
    const { device, providers } = await build()
    alexaEchoSessions.event('b', 'S1')
    await vi.advanceTimersByTimeAsync(ECHO_PUSH_READ_GAP_MS)
    const player = providers.get('media-player') as {
      setVolume(i: { deviceId: number; volumeLevel: number }): Promise<void>
    }
    await player.setVolume({ deviceId: 7, volumeLevel: 80 })
    release(40) // the stale reading, begun before the set
    await vi.advanceTimersByTimeAsync(0)
    expect(volumeOf(device)).toBe(80)
    await device.removeDevice()
  })

  it('an event during a read is read again after it', async () => {
    let release: (level: number) => void = () => undefined
    let calls = 0
    const s = session(() => {
      calls += 1
      if (calls === 1) return 40
      if (calls === 2) return new Promise<number>((resolve) => void (release = resolve))
      return 90
    })
    alexaEchoSessions.setResolver(() => s)
    const { device } = await build()
    alexaEchoSessions.event('b', 'S1')
    await vi.advanceTimersByTimeAsync(ECHO_PUSH_READ_GAP_MS) // read 2 starts, stays open
    alexaEchoSessions.event('b', 'S1')
    await vi.advanceTimersByTimeAsync(ECHO_PUSH_READ_GAP_MS) // lands while read 2 is open
    release(50)
    await vi.advanceTimersByTimeAsync(0)
    expect(volumeOf(device)).toBe(90)
    await device.removeDevice()
  })

  it('polls every 30 s while the channel is down, slows while it is up, and returns to 30 s', async () => {
    const s = session(() => 40)
    alexaEchoSessions.setResolver(() => s)
    const { device, logs } = await build()
    expect(device.pollIntervalMs).toBe(ECHO_POLL_MS)

    alexaEchoSessions.channel('b', 'up')
    await vi.advanceTimersByTimeAsync(0) // the change itself reads once
    expect(device.pollIntervalMs).toBe(ECHO_POLL_PUSH_HEALTHY_MS)
    s.playerState.mockClear()
    await vi.advanceTimersByTimeAsync(ECHO_POLL_MS * 3)
    expect(s.playerState).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(ECHO_POLL_PUSH_HEALTHY_MS)
    expect(s.playerState).toHaveBeenCalledTimes(1)

    alexaEchoSessions.channel('b', 'down')
    await vi.advanceTimersByTimeAsync(0)
    s.playerState.mockClear()
    await vi.advanceTimersByTimeAsync(ECHO_POLL_MS)
    expect(s.playerState).toHaveBeenCalledTimes(1)
    expect(logs.some((l) => l.message.includes('push channel changed'))).toBe(true)
    await device.removeDevice()
  })

  it('a removed device stops listening', async () => {
    const s = session(() => 40)
    alexaEchoSessions.setResolver(() => s)
    const { device } = await build()
    await device.removeDevice()
    s.playerState.mockClear()
    alexaEchoSessions.event('b', 'S1')
    await vi.advanceTimersByTimeAsync(ECHO_PUSH_READ_GAP_MS * 2)
    expect(s.playerState).not.toHaveBeenCalled()
  })
})
