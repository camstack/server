import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IScopedLogger } from '@dominevo/types'
import {
  MatterSubscriptionSupervisor,
  SUBSCRIPTION_BACKOFF_INITIAL_MS,
  type MatterSubscribablePeer,
} from '../matter-subscription.js'

interface LogLine {
  readonly message: string
  readonly deviceId: unknown
}

function recordingLogger(lines: LogLine[]): IScopedLogger {
  const push = (message: string, extras?: { tags?: Record<string, unknown> }): void => {
    lines.push({ message, deviceId: extras?.tags?.['deviceId'] })
  }
  const logger: IScopedLogger = {
    debug: push,
    info: push,
    warn: push,
    error: push,
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

interface FakePeerOptions {
  readonly online: boolean
  readonly dialable: boolean
  readonly dial?: 'ok' | 'throw' | 'refuse'
}

function fakePeer(options: FakePeerOptions) {
  let online = options.online
  const counts = { subscribe: 0, connect: 0, close: 0, refresh: 0 }
  const onlineHandlers: Array<() => void> = []
  const offlineHandlers: Array<() => void> = []
  const peer: MatterSubscribablePeer = {
    nodeId: '7',
    online: () => online,
    subscribe: async () => {
      counts.subscribe += 1
      return {
        close: async () => {
          counts.close += 1
        },
      }
    },
    ...(options.dialable
      ? {
          connect: async (_signal: AbortSignal, skipped: (reason: string) => void) => {
            counts.connect += 1
            if (options.dial === 'throw') throw new Error('aborted')
            if (options.dial === 'refuse') {
              skipped('PeerSet has no such peer')
              return false
            }
            return true
          },
        }
      : {}),
    refresh: async () => {
      counts.refresh += 1
    },
    onOnline: (handler) => {
      onlineHandlers.push(handler)
      return () => undefined
    },
    onOffline: (handler) => {
      offlineHandlers.push(handler)
      return () => undefined
    },
  }
  return {
    peer,
    counts,
    setOnline: (value: boolean) => {
      online = value
      for (const handler of value ? onlineHandlers : offlineHandlers) handler()
    },
    setOnlineSilently: (value: boolean) => {
      online = value
    },
  }
}

function supervisorFor(lines: LogLine[]): MatterSubscriptionSupervisor {
  return new MatterSubscriptionSupervisor({
    brokerId: 'b',
    logger: recordingLogger(lines),
    resolveDeviceId: () => 42,
    onReport: () => undefined,
  })
}

describe('subscription retry dials an offline peer', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('a peer that goes offline and never re-announces gets an active connect on retry', async () => {
    vi.useFakeTimers()
    const lines: LogLine[] = []
    const fake = fakePeer({ online: true, dialable: true })
    const supervisor = supervisorFor(lines)
    await supervisor.sync([fake.peer])
    expect(supervisor.phase('7')).toBe('subscribed')
    fake.setOnline(false)
    await vi.advanceTimersByTimeAsync(SUBSCRIPTION_BACKOFF_INITIAL_MS + 1)
    expect(fake.counts.connect).toBe(1)
    expect(fake.counts.subscribe).toBe(1)
    const decision = lines.find((l) => l.message === 'retry: forced rediscovery + connect')
    expect(decision?.deviceId).toBe(42)
    await supervisor.stop()
  })

  it('a retry that cannot dial logs why it was skipped, with the device tag', async () => {
    vi.useFakeTimers()
    const lines: LogLine[] = []
    const fake = fakePeer({ online: true, dialable: false })
    const supervisor = supervisorFor(lines)
    await supervisor.sync([fake.peer])
    fake.setOnline(false)
    await vi.advanceTimersByTimeAsync(SUBSCRIPTION_BACKOFF_INITIAL_MS + 1)
    const skipped = lines.find((l) => l.message === 'retry: dial skipped (peer cannot be dialled)')
    expect(skipped?.deviceId).toBe(42)
    await supervisor.stop()
  })

  it('boot opens exactly one subscription per peer, even when it comes online late', async () => {
    vi.useFakeTimers()
    const fake = fakePeer({ online: false, dialable: true })
    const supervisor = supervisorFor([])
    await supervisor.sync([fake.peer])
    fake.setOnline(true)
    await vi.advanceTimersByTimeAsync(SUBSCRIPTION_BACKOFF_INITIAL_MS * 3)
    await supervisor.sync([fake.peer])
    expect(fake.counts.subscribe).toBe(1)
    expect(fake.counts.close).toBe(0)
    expect(supervisor.phase('7')).toBe('subscribed')
    await supervisor.stop()
  })

  it('a failed connect re-arms the backoff', async () => {
    vi.useFakeTimers()
    const fake = fakePeer({ online: true, dialable: true, dial: 'throw' })
    const supervisor = supervisorFor([])
    await supervisor.sync([fake.peer])
    fake.setOnline(false)
    await vi.advanceTimersByTimeAsync(SUBSCRIPTION_BACKOFF_INITIAL_MS + 1)
    expect(fake.counts.connect).toBe(1)
    await vi.advanceTimersByTimeAsync(SUBSCRIPTION_BACKOFF_INITIAL_MS * 2 + 1)
    expect(fake.counts.connect).toBe(2)
    expect(fake.counts.subscribe).toBe(1)
    await supervisor.stop()
  })

  it('a dial that was skipped names the lookup and falls back to reopening', async () => {
    vi.useFakeTimers()
    const lines: LogLine[] = []
    const fake = fakePeer({ online: true, dialable: true, dial: 'refuse' })
    const supervisor = supervisorFor(lines)
    await supervisor.sync([fake.peer])
    fake.setOnline(false)
    await vi.advanceTimersByTimeAsync(SUBSCRIPTION_BACKOFF_INITIAL_MS + 1)
    const skipped = lines.find(
      (l) => l.message === 'retry: dial skipped (PeerSet has no such peer)',
    )
    expect(skipped?.deviceId).toBe(42)
    expect(lines.some((l) => l.message === 'retry: connect succeeded')).toBe(false)
    expect(fake.counts.subscribe).toBe(2)
    await supervisor.stop()
  })

  it('coming back online keeps the one subscription and reads the state once', async () => {
    vi.useFakeTimers()
    const fake = fakePeer({ online: true, dialable: true })
    const supervisor = supervisorFor([])
    await supervisor.sync([fake.peer])
    fake.setOnline(false)
    fake.setOnline(true)
    await vi.advanceTimersByTimeAsync(1)
    expect(fake.counts.refresh).toBe(1)
    expect(fake.counts.subscribe).toBe(1)
    await supervisor.stop()
  })

  it('the sync path on return also reads once, without a second subscribe', async () => {
    vi.useFakeTimers()
    const fake = fakePeer({ online: true, dialable: true })
    const supervisor = supervisorFor([])
    await supervisor.sync([fake.peer])
    fake.setOnline(false)
    fake.setOnlineSilently(true)
    await supervisor.sync([fake.peer])
    expect(fake.counts.refresh).toBe(1)
    expect(fake.counts.subscribe).toBe(1)
    await supervisor.stop()
  })
})
