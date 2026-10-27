import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { IScopedLogger } from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { settingsToConnection } from '../config.js'
import type { FetchLike } from '../enpal-client.js'
import { EnpalIntegrationManager } from '../enpal-integration-manager.js'

const csv = readFileSync(join(__dirname, 'fixtures', 'influx-last-values.csv'), 'utf8')
const TOKEN = 'fixture-token-do-not-log-0123456789'

interface LogLine {
  readonly level: string
  readonly message: string
  readonly options: unknown
}

function recordingLogger(): { logger: IScopedLogger; lines: LogLine[] } {
  const lines: LogLine[] = []
  const at =
    (level: string) =>
    (message: string, options?: unknown): void => {
      lines.push({ level, message, options })
    }
  const logger: IScopedLogger = {
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    child: () => logger,
    withTags: () => logger,
  }
  return { logger, lines }
}

type BoxState = 'up' | 'down' | 'unauthorized'

function harness(initial: BoxState) {
  let state: BoxState = initial
  const fetchFake: FetchLike = async () => {
    if (state === 'down') throw new TypeError(`fetch failed (Authorization: Token ${TOKEN})`)
    if (state === 'unauthorized') return new Response('no', { status: 401 })
    return new Response(csv, { status: 200 })
  }
  const events: string[] = []
  const rec = recordingLogger()
  const manager = new EnpalIntegrationManager({
    id: 'enpal:192-0-2-10',
    name: 'Enpal',
    connection: settingsToConnection({ host: '192.0.2.10', token: TOKEN, pollIntervalMs: 10_000 }),
    tokenLocked: false,
    logger: rec.logger,
    fetch: fetchFake,
    now: () => 42,
    onConnected: () => events.push('connected'),
    onDisconnected: () => events.push('disconnected'),
    onPolled: () => events.push('polled'),
  })
  return {
    manager,
    events,
    lines: rec.lines,
    setState: (next: BoxState) => {
      state = next
    },
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('EnpalIntegrationManager', () => {
  it('a box that is off at start does not throw: status error, no snapshot, a typed reason', async () => {
    const h = harness('down')
    await h.manager.start()
    expect(h.manager.status).toBe('error')
    expect(h.manager.getSnapshot()).toBeNull()
    expect(h.manager.lastError?.kind).toBe('unreachable')
    expect(h.events).not.toContain('connected')
    await h.manager.stop()
  })

  it('a reachable box publishes a snapshot and fires connected + polled', async () => {
    const h = harness('up')
    await h.manager.start()
    expect(h.manager.status).toBe('connected')
    expect(h.manager.getSnapshot()?.readings.get('Power.DC.Total')?.value).toBe(4200)
    expect(h.events).toEqual(['connected', 'polled'])
    await h.manager.stop()
  })

  it('polls on the interval and recovers when the box comes back', async () => {
    vi.useFakeTimers()
    const h = harness('down')
    await h.manager.start()
    expect(h.manager.status).toBe('error')
    h.setState('up')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(h.manager.status).toBe('connected')
    expect(h.manager.getSnapshot()).not.toBeNull()
    expect(h.events).toContain('connected')
    await h.manager.stop()
  })

  it('a failing poll drops the snapshot: readings are never replayed as current', async () => {
    vi.useFakeTimers()
    const h = harness('up')
    await h.manager.start()
    h.setState('down')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(h.manager.status).toBe('error')
    expect(h.manager.getSnapshot()).toBeNull()
    expect(h.events).toContain('disconnected')
    await h.manager.stop()
  })

  it('a rejected token is reported as unauthorized', async () => {
    const h = harness('unauthorized')
    // auto falls back to the page, which this fake also refuses -> primary reason kept
    await h.manager.start()
    expect(h.manager.status).toBe('error')
    expect(h.manager.lastError?.kind).toBe('unauthorized')
    await h.manager.stop()
  })

  it('the token appears in no log line, even when the transport error echoes it', async () => {
    const h = harness('down')
    await h.manager.start()
    h.setState('unauthorized')
    await h.manager.poll()
    h.setState('up')
    await h.manager.poll()
    await h.manager.stop()
    expect(h.lines.length).toBeGreaterThan(0)
    expect(JSON.stringify(h.lines)).not.toContain(TOKEN)
  })

  it('stop() clears the timer and the snapshot', async () => {
    vi.useFakeTimers()
    const h = harness('up')
    await h.manager.start()
    await h.manager.stop()
    expect(h.manager.getSnapshot()).toBeNull()
    expect(h.manager.status).toBe('disconnected')
    const before = h.events.length
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.events.length).toBe(before)
  })
})
