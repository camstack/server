import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IScopedLogger } from '@camstack/types'
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

function fakePeer(options: { online: boolean; dialable: boolean }) {
  let online = options.online
  const counts = { subscribe: 0, connect: 0, close: 0 }
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
          connect: async () => {
            counts.connect += 1
          },
        }
      : {}),
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
    const skipped = lines.find((l) => l.message.startsWith('retry: skipped'))
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
})
