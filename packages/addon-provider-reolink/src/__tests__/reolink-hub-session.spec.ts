/**
 * D985 — the Reolink NVR / Home Hub session is per INTEGRATION, no longer a device. It owns the
 * one Baichuan socket, its backoff, the 60 s reconcile, the channel map and the event routing;
 * a camera reaches it through the registry, never through a parent device.
 */
import type { ReolinkSimpleEvent } from '@apocaliss92/nodelink-js'
import { DeviceType, type IScopedLogger } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReolinkHubConnection } from '../hub-connection.js'
import {
  HUB_CHILD_SLEEP_RECONCILE_MS,
  HUB_MISSING_OFFLINE_MS,
  HUB_RECONNECT_BASE_MS,
  HUB_RECONNECT_MAX_MS,
  type HubApiPort,
  type HubChildHandle,
  ReolinkHubSession,
  ReolinkHubSessions,
} from '../reolink-hub-session.js'

const CONNECTION: ReolinkHubConnection = {
  host: '192.168.1.10',
  port: 9000,
  rtspPort: 554,
  username: 'admin',
  password: 'hub-secret',
  transport: 'tcp',
  debugGeneral: false,
  debugSocketLogs: [],
}

function silentLogger(): IScopedLogger {
  const logger: IScopedLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

interface ChannelRow {
  readonly channel: number
  readonly uid?: string
  readonly name?: string
  readonly online?: boolean
  readonly sleeping?: boolean
  readonly isBattery?: boolean
}

type Listener = (...args: unknown[]) => void

/** A fake hub socket: every method the session drives, as a spy. */
function fakeApi(channels: readonly ChannelRow[] = []) {
  const listeners = new Map<string, Listener[]>()
  let simpleEventHandler: ((event: ReolinkSimpleEvent) => void) | null = null
  const api = {
    login: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    getNvrChannelsSummary: vi.fn(async () => ({
      devices: channels,
      channels: [],
    })),
    getAllChannelsBatteryInfo: vi.fn(async () => ({ batteryInfoData: {} })),
    onSimpleEvent: vi.fn(async (handler: (event: ReolinkSimpleEvent) => void) => {
      simpleEventHandler = handler
    }),
    offSimpleEvent: vi.fn(async () => undefined),
    client: {
      isSocketConnected: vi.fn(() => true),
      loggedIn: true,
      on: vi.fn((event: string, listener: Listener) => {
        listeners.set(event, [...(listeners.get(event) ?? []), listener])
      }),
      off: vi.fn(),
      prependListener: vi.fn(),
    },
  }
  return {
    api,
    emit: (event: string, ...args: unknown[]) => {
      for (const l of listeners.get(event) ?? []) l(...args)
    },
    push: (event: ReolinkSimpleEvent) => simpleEventHandler?.(event),
  }
}

interface FakeChild extends HubChildHandle {
  readonly events: ReolinkSimpleEvent[]
  readonly sleepStates: boolean[]
  readonly repaired: number[]
  channelValue: number | undefined
  onlineValue: boolean
}

function fakeChild(
  id: number,
  channel: number | undefined,
  stableId = `int-1-cam-UID${id}`,
): FakeChild {
  const child: FakeChild = {
    id,
    stableId,
    name: `cam ${id}`,
    type: DeviceType.Camera,
    get channel() {
      return child.channelValue
    },
    get online() {
      return child.onlineValue
    },
    debugGeneral: false,
    debugSocketFlags: [],
    events: [],
    sleepStates: [],
    repaired: [],
    channelValue: channel,
    onlineValue: true,
    markOnline: (online) => {
      child.onlineValue = online
    },
    repairChannel: async (to) => {
      child.repaired.push(to)
      child.channelValue = to
    },
    handleSimpleEvent: (event) => {
      child.events.push(event)
    },
    applyHubSleepState: (sleeping) => {
      child.sleepStates.push(sleeping)
    },
    applyHubBatteryInfo: vi.fn(),
  }
  return child
}

function makeSession(
  api: HubApiPort,
  children: () => readonly HubChildHandle[],
  now: () => number = Date.now,
) {
  const connect = vi.fn(async () => api)
  const onConnectionChange = vi.fn()
  const session = new ReolinkHubSession<HubApiPort>({
    integrationId: 'int-1',
    name: 'Home Hub',
    logger: silentLogger(),
    connection: CONNECTION,
    connect,
    children,
    onConnectionChange,
    now,
  })
  return { session, connect, onConnectionChange }
}

function simple(channel: number, type: ReolinkSimpleEvent['type'] = 'motion'): ReolinkSimpleEvent {
  return { type, channel, timestamp: 1 } as ReolinkSimpleEvent
}

describe('ReolinkHubSession routing', () => {
  it('hands a push to the attached child on that channel and to nobody else', async () => {
    const fake = fakeApi()
    const a = fakeChild(1, 0)
    const b = fakeChild(2, 1)
    const { session } = makeSession(fake.api, () => [a, b])
    await session.getApi()
    fake.push(simple(1))
    expect(b.events).toHaveLength(1)
    expect(a.events).toHaveLength(0)
  })

  it('drops (and names) a push for a channel nobody adopted', async () => {
    const fake = fakeApi()
    const logger = silentLogger()
    const session = new ReolinkHubSession<HubApiPort>({
      integrationId: 'int-1',
      name: 'Home Hub',
      logger,
      connection: CONNECTION,
      connect: async () => fake.api,
      children: () => [],
    })
    await session.getApi()
    fake.push(simple(5))
    expect(logger.warn).toHaveBeenCalledWith(
      'Reolink hub: simpleEvent for an unmapped channel dropped',
      expect.anything(),
    )
  })

  it('a child that attaches AFTER the session started is routable at once (no registry race)', async () => {
    const fake = fakeApi()
    const live: HubChildHandle[] = []
    const { session } = makeSession(fake.api, () => live)
    await session.getApi()
    const late = fakeChild(7, 2)
    live.push(late)
    fake.push(simple(2))
    expect(late.events).toHaveLength(1)
  })
})

describe('ReolinkHubSession connection', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('shares ONE socket across concurrent callers', async () => {
    const fake = fakeApi()
    const { session, connect } = makeSession(fake.api, () => [])
    await Promise.all([session.getApi(), session.getApi(), session.getApi()])
    expect(connect).toHaveBeenCalledTimes(1)
  })

  it('re-dials a closed socket after the base backoff, not before', async () => {
    const fake = fakeApi()
    const { session, connect } = makeSession(fake.api, () => [])
    await session.getApi()
    fake.emit('close')
    expect(connect).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(HUB_RECONNECT_BASE_MS - 1)
    expect(connect).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(connect).toHaveBeenCalledTimes(2)
    expect(HUB_RECONNECT_MAX_MS).toBe(30_000)
  })

  it('a closed session never reconnects', async () => {
    const fake = fakeApi()
    const { session, connect } = makeSession(fake.api, () => [])
    await session.getApi()
    await session.close()
    fake.emit('close')
    await vi.advanceTimersByTimeAsync(HUB_RECONNECT_MAX_MS)
    expect(connect).toHaveBeenCalledTimes(1)
  })

  it('reports the socket up and down to its owner', async () => {
    const fake = fakeApi()
    const { session, onConnectionChange } = makeSession(fake.api, () => [])
    await session.getApi()
    expect(onConnectionChange).toHaveBeenLastCalledWith(true)
    fake.emit('close')
    expect(onConnectionChange).toHaveBeenLastCalledWith(false)
  })

  it('re-dials when the credentials change and keeps the socket when they do not', async () => {
    const fake = fakeApi()
    const { session, connect } = makeSession(fake.api, () => [])
    await session.getApi()
    await session.reconfigure({ ...CONNECTION })
    expect(connect).toHaveBeenCalledTimes(1)
    await session.reconfigure({ ...CONNECTION, password: 'rotated' })
    expect(fake.api.close).toHaveBeenCalledWith({ reason: 'settings-changed' })
    await vi.advanceTimersByTimeAsync(0)
    expect(connect).toHaveBeenCalledTimes(2)
    expect(session.connection.password).toBe('rotated')
  })

  it('the relay endpoint carries the RTSP port, never the Baichuan one', () => {
    const fake = fakeApi()
    const { session } = makeSession(fake.api, () => [])
    expect(session.relayEndpoint().port).toBe(554)
    expect(session.relayEndpoint().port).not.toBe(CONNECTION.port)
  })

  it('publishes the relay endpoint of ITS connection (rtsp port)', () => {
    const fake = fakeApi()
    const { session } = makeSession(fake.api, () => [])
    expect(session.relayEndpoint()).toEqual({
      host: '192.168.1.10',
      username: 'admin',
      password: 'hub-secret',
      port: 554,
    })
  })
})

describe('ReolinkHubSession reconcile', () => {
  it('pushes the hub-reported sleep state into the child on that channel', async () => {
    const fake = fakeApi([
      { channel: 0, uid: 'UID1', online: true, sleeping: true },
      { channel: 1, uid: 'UID2', online: true, sleeping: false },
    ])
    const a = fakeChild(1, 0)
    const b = fakeChild(2, 1)
    const { session } = makeSession(fake.api, () => [a, b])
    await session.refresh()
    expect(a.sleepStates).toEqual([true])
    expect(b.sleepStates).toEqual([false])
  })

  it('a failed summary read keeps the last list and flags nobody offline', async () => {
    const fake = fakeApi([{ channel: 0, uid: 'UID1', online: true }])
    const a = fakeChild(1, 0)
    const { session } = makeSession(fake.api, () => [a])
    await session.refresh()
    fake.api.getNvrChannelsSummary.mockRejectedValue(new Error('cgi down'))
    await session.refresh()
    expect(session.channelSnapshot().channels).toHaveLength(1)
    expect(session.channelSnapshot().lastError).toBe('cgi down')
    expect(a.onlineValue).toBe(true)
  })

  it('marks a child offline only after it was missing for the grace window', async () => {
    let t = 1_000_000
    const fake = fakeApi([{ channel: 0, uid: 'UID1', online: true }])
    const a = fakeChild(1, 0)
    const { session } = makeSession(
      fake.api,
      () => [a],
      () => t,
    )
    await session.refresh()
    fake.api.getNvrChannelsSummary.mockResolvedValue({
      devices: [],
      channels: [],
    })
    t += HUB_MISSING_OFFLINE_MS - 1
    await session.refresh()
    expect(a.onlineValue).toBe(true)
    t += 2
    await session.refresh()
    expect(a.onlineValue).toBe(false)
  })

  it('repairs a child whose channel vanished, by its camera identity', async () => {
    const fake = fakeApi([{ channel: 3, uid: 'UID9', online: true }])
    const lost = fakeChild(9, undefined, 'int-1-cam-UID9')
    const { session } = makeSession(fake.api, () => [lost])
    await session.refresh()
    expect(lost.repaired).toEqual([3])
  })

  it('re-reads on a timer every minute', () => {
    expect(HUB_CHILD_SLEEP_RECONCILE_MS).toBe(60_000)
  })
})

describe('ReolinkHubSessions registry', () => {
  it('keeps two integrations apart', () => {
    const sessions = new ReolinkHubSessions()
    const a = fakeChild(1, 0)
    const b = fakeChild(2, 0)
    sessions.attach('int-a', a)
    sessions.attach('int-b', b)
    expect(sessions.childrenOf('int-a')).toEqual([a])
    expect(sessions.childrenOf('int-b')).toEqual([b])
  })

  it('a rebuilt device keeps its slot when the old object detaches late', () => {
    const sessions = new ReolinkHubSessions()
    const oldOne = fakeChild(1, 0)
    const rebuilt = fakeChild(1, 0)
    sessions.attach('int-a', oldOne)
    sessions.attach('int-a', rebuilt)
    sessions.detach('int-a', oldOne)
    expect(sessions.childrenOf('int-a')).toEqual([rebuilt])
  })
})
