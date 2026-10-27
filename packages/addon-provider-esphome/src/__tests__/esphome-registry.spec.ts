import { describe, expect, it } from 'vitest'
import type { IScopedLogger } from '@camstack/types'
import { EspBrokerRegistry, type EspScheduler } from '../esphome-registry.js'
import { EspLinkHub } from '../esphome-link-hub.js'
import { EspLinkError } from '../esphome-link.js'
import { reconnectDelayMs } from '../esphome-backoff.js'
import { FakeFactory, FakeLink, entity } from './fake-link.js'

const PSK = 'c2VjcmV0LWtleS1mb3ItdGVzdHMtb25seS0wMDAwMDA='

interface LogLine {
  readonly level: string
  readonly message: string
  readonly extras: unknown
}

function captureLogger(lines: LogLine[]): IScopedLogger {
  const at =
    (level: string) =>
    (message: string, extras?: unknown): void => {
      lines.push({ level, message, extras })
    }
  const logger: IScopedLogger = {
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

interface Scheduled {
  readonly ms: number
  readonly run: () => void
  cancelled: boolean
}

function manualScheduler(): { scheduler: EspScheduler; queue: Scheduled[] } {
  const queue: Scheduled[] = []
  const scheduler: EspScheduler = (run, ms) => {
    const item: Scheduled = { ms, run, cancelled: false }
    queue.push(item)
    return () => {
      item.cancelled = true
    }
  }
  return { scheduler, queue }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

function setup(factory: FakeFactory) {
  const lines: LogLine[] = []
  const { scheduler, queue } = manualScheduler()
  const hub = new EspLinkHub()
  const events: string[] = []
  const registry = new EspBrokerRegistry({
    factory,
    hub,
    logger: captureLogger(lines),
    schedule: scheduler,
    random: () => 0.5,
    onConnected: (id) => events.push(`up:${id}`),
    onDisconnected: (id) => events.push(`down:${id}`),
  })
  return { registry, hub, lines, queue, events }
}

const connection = { host: 'board-a.local', port: 6053, noisePsk: PSK, password: '' }

describe('board session', () => {
  it('connects, attaches the link and reports connected', async () => {
    const link = new FakeLink([entity({ id: 'switch-r', type: 'switch' })])
    const { registry, hub, events } = setup(new FakeFactory(link))
    const entry = await registry.createEntry('Board A', connection)
    await flush()
    expect(registry.get(entry.id)?.status).toBe('connected')
    expect(hub.link(entry.id)).toBe(link)
    expect(events).toEqual([`up:${entry.id}`])
  })

  it('a dropped session goes offline, then reconnects on the bounded schedule', async () => {
    const first = new FakeLink([])
    const second = new FakeLink([])
    const { registry, hub, queue, events } = setup(new FakeFactory(first, second))
    const entry = await registry.createEntry('Board A', connection)
    await flush()

    first.drop(new EspLinkError('unreachable', 'heartbeat stalled'))
    await flush()
    expect(registry.get(entry.id)?.status).toBe('unreachable')
    expect(hub.link(entry.id)).toBeNull()
    expect(events).toEqual([`up:${entry.id}`, `down:${entry.id}`])

    const retry = queue.filter((q) => !q.cancelled).at(-1)
    expect(retry?.ms).toBe(reconnectDelayMs(0, 0.5))
    retry?.run()
    await flush()
    expect(registry.get(entry.id)?.status).toBe('connected')
    expect(hub.link(entry.id)).toBe(second)
  })

  it('failed attempts back off further each time and never beyond the cap', async () => {
    const refused = new EspLinkError('refused', 'connection refused')
    const { registry, queue } = setup(new FakeFactory(refused))
    await registry.createEntry('Board A', connection)
    await flush()
    const delays: number[] = []
    for (let i = 0; i < 12; i++) {
      const next = queue.filter((q) => !q.cancelled).at(-1)
      if (next === undefined) break
      delays.push(next.ms)
      next.cancelled = true
      next.run()
      await flush()
    }
    expect(delays[1]).toBeGreaterThan(delays[0] ?? 0)
    expect(Math.max(...delays)).toBeLessThanOrEqual(reconnectDelayMs(1_000, 0.5))
    expect(delays.length).toBe(12)
  })

  it('a wrong key is permanent: auth-failed, no retry is scheduled', async () => {
    const bad = new EspLinkError('encryption-key-invalid', 'the encryption key was rejected')
    const { registry, queue } = setup(new FakeFactory(bad))
    const entry = await registry.createEntry('Board A', connection)
    await flush()
    expect(registry.get(entry.id)?.status).toBe('auth-failed')
    expect(queue.filter((q) => !q.cancelled)).toHaveLength(0)
  })

  it('changing the connection after a permanent failure tries again', async () => {
    const bad = new EspLinkError('encryption-key-invalid', 'rejected')
    const good = new FakeLink([])
    const factory = new FakeFactory(bad, good)
    const { registry } = setup(factory)
    const entry = await registry.createEntry('Board A', connection)
    await flush()
    await registry.updateEntry(entry.id, { ...connection, noisePsk: 'bmV3LWtleQ==' })
    await flush()
    expect(registry.get(entry.id)?.status).toBe('connected')
    expect(factory.opened.at(-1)?.noisePsk).toBe('bmV3LWtleQ==')
  })

  it('removing a board closes its session and cancels the retry', async () => {
    const link = new FakeLink([])
    const { registry, hub, queue } = setup(new FakeFactory(link))
    const entry = await registry.createEntry('Board A', connection)
    await flush()
    await registry.removeEntry(entry.id)
    expect(link.closed).toBe(true)
    expect(hub.link(entry.id)).toBeNull()
    expect(registry.get(entry.id)).toBeNull()
    expect(queue.filter((q) => !q.cancelled)).toHaveLength(0)
  })
})

describe('the encryption key stays secret', () => {
  it('never reaches a log line, the broker info or the reported error', async () => {
    const leaky = new EspLinkError('error', `handshake failed with key ${PSK} on board-a.local`)
    const { registry, lines } = setup(new FakeFactory(leaky))
    const entry = await registry.createEntry('Board A', connection)
    await flush()
    const info = registry.get(entry.id)
    const everything = JSON.stringify({ lines, info, list: registry.list() })
    expect(everything).not.toContain(PSK)
    expect(info?.error).toContain('board-a.local')
  })

  it('a log line about a board names it by brokerId, not by connection object', async () => {
    const { registry, lines } = setup(new FakeFactory(new EspLinkError('timeout', 'timed out')))
    await registry.createEntry('Board A', connection)
    await flush()
    expect(lines.length).toBeGreaterThan(0)
    expect(JSON.stringify(lines)).not.toContain('noisePsk')
  })
})
