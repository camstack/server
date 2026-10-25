import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { LogEntry } from '@camstack/types'
import { LokiDestination, type LokiConfig, type LokiFetch } from '../loki-destination.js'

const config = (over: Partial<LokiConfig> = {}): LokiConfig => ({
  enabled: true,
  url: 'http://loki:3100',
  job: 'camstack',
  node: 'hub',
  level: 'info',
  batchIntervalMs: 5_000,
  batchSize: 200,
  extraLabels: '',
  tenantId: '',
  username: '',
  password: '',
  timeoutMs: 10_000,
  ...over,
})

const entry = (over: Partial<LogEntry> = {}): LogEntry => ({
  timestamp: new Date('2026-07-26T10:00:00.000Z'),
  level: 'info',
  message: 'hello',
  ...over,
})

interface Captured {
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
  readonly body: string
}

/** A fetch double that records calls and can be made to fail. */
function makeFetch(behaviour: { ok?: boolean; status?: number; throws?: boolean } = {}) {
  const calls: Captured[] = []
  const fetchFn: LokiFetch = async (url, init) => {
    calls.push({ url, headers: init.headers, body: init.body ?? '' })
    if (behaviour.throws === true) throw new Error('ECONNREFUSED')
    return {
      ok: behaviour.ok ?? true,
      status: behaviour.status ?? 204,
      text: async () => 'stream limit exceeded',
    }
  }
  return { fetchFn, calls }
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('LokiDestination — inert unless opted in', () => {
  it('sends nothing when disabled', async () => {
    const { fetchFn, calls } = makeFetch()
    const dest = new LokiDestination({ fetchFn })
    await dest.initialize(config({ enabled: false }))
    dest.write(entry())
    await dest.flush()
    expect(calls).toHaveLength(0)
    expect(dest.getStatus().configured).toBe(false)
  })

  it('sends nothing when enabled but no URL is set', async () => {
    // This is the whole opt-in mechanism: enabled + a URL, or nothing happens.
    const { fetchFn, calls } = makeFetch()
    const dest = new LokiDestination({ fetchFn })
    await dest.initialize(config({ url: '   ' }))
    dest.write(entry())
    await dest.flush()
    expect(calls).toHaveLength(0)
    expect(dest.getStatus().configured).toBe(false)
  })

  it('does not queue when inactive, so a disabled destination cannot leak memory', async () => {
    const dest = new LokiDestination({ fetchFn: makeFetch().fetchFn })
    await dest.initialize(config({ enabled: false }))
    for (let i = 0; i < 100; i++) dest.write(entry())
    expect(dest.getStatus().queued).toBe(0)
  })
})

describe('LokiDestination — pushing', () => {
  it('posts to /loki/api/v1/push and counts the entries', async () => {
    const { fetchFn, calls } = makeFetch()
    const dest = new LokiDestination({ fetchFn })
    await dest.initialize(config())
    dest.write(entry())
    await dest.flush()

    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('http://loki:3100/loki/api/v1/push')
    expect(dest.getStatus().pushed).toBe(1)
    expect(dest.getStatus().queued).toBe(0)
  })

  it('does not double the slash when the URL has a trailing one', async () => {
    const { fetchFn, calls } = makeFetch()
    const dest = new LokiDestination({ fetchFn })
    await dest.initialize(config({ url: 'http://loki:3100/' }))
    dest.write(entry())
    await dest.flush()
    expect(calls[0]?.url).toBe('http://loki:3100/loki/api/v1/push')
  })

  it('drops entries below the configured level', async () => {
    const { fetchFn, calls } = makeFetch()
    const dest = new LokiDestination({ fetchFn })
    await dest.initialize(config({ level: 'warn' }))
    dest.write(entry({ level: 'debug' }))
    dest.write(entry({ level: 'info' }))
    dest.write(entry({ level: 'error' }))
    await dest.flush()

    const body = JSON.parse(calls[0]?.body ?? '{}')
    expect(body.streams).toHaveLength(1)
    expect(body.streams[0].stream.level).toBe('error')
  })

  it('sends the tenant header and basic auth only when configured', async () => {
    const plain = makeFetch()
    const bare = new LokiDestination({ fetchFn: plain.fetchFn })
    await bare.initialize(config())
    bare.write(entry())
    await bare.flush()
    expect(plain.calls[0]?.headers['X-Scope-OrgID']).toBeUndefined()
    expect(plain.calls[0]?.headers['authorization']).toBeUndefined()

    const authed = makeFetch()
    const dest = new LokiDestination({ fetchFn: authed.fetchFn })
    await dest.initialize(config({ tenantId: 'tenant-1', username: 'u', password: 'p' }))
    dest.write(entry())
    await dest.flush()
    expect(authed.calls[0]?.headers['X-Scope-OrgID']).toBe('tenant-1')
    expect(authed.calls[0]?.headers['authorization']).toBe(
      `Basic ${Buffer.from('u:p').toString('base64')}`,
    )
  })

  it('flushes early once batchSize is reached, without waiting for the timer', async () => {
    const { fetchFn, calls } = makeFetch()
    const dest = new LokiDestination({ fetchFn })
    await dest.initialize(config({ batchSize: 3 }))
    dest.write(entry())
    dest.write(entry())
    expect(calls).toHaveLength(0)
    dest.write(entry())
    await vi.waitFor(() => expect(calls).toHaveLength(1))
  })

  it('coalesces a batch into ONE request, not one per entry', async () => {
    const { fetchFn, calls } = makeFetch()
    const dest = new LokiDestination({ fetchFn })
    await dest.initialize(config())
    for (let i = 0; i < 50; i++) dest.write(entry({ message: `m${String(i)}` }))
    await dest.flush()
    expect(calls).toHaveLength(1)
    expect(JSON.parse(calls[0]?.body ?? '{}').streams[0].values).toHaveLength(50)
  })
})

describe('LokiDestination — failure behaviour', () => {
  it('never throws out of write(), so other destinations keep working', async () => {
    // LogManager fans one entry to every destination; throwing here would take
    // the rotated-file and console sinks down with it.
    const { fetchFn } = makeFetch({ throws: true })
    const dest = new LokiDestination({ fetchFn })
    await dest.initialize(config())
    expect(() => dest.write(entry())).not.toThrow()
    await expect(dest.flush()).resolves.toBeUndefined()
  })

  it('records a non-2xx with Loki’s own reason, and re-queues the batch', async () => {
    const { fetchFn } = makeFetch({ ok: false, status: 400 })
    const dest = new LokiDestination({ fetchFn })
    await dest.initialize(config())
    dest.write(entry())
    await dest.flush()

    const status = dest.getStatus()
    expect(status.failures).toBe(1)
    // The body is where Loki says WHY — a bad label, a stream limit, out-of-order.
    expect(status.lastError).toContain('400')
    expect(status.lastError).toContain('stream limit exceeded')
    // Not lost: a transient outage must not discard lines.
    expect(status.queued).toBe(1)
    expect(status.pushed).toBe(0)
  })

  it('retries the re-queued batch on the next flush and clears the error', async () => {
    let failing = true
    const calls: string[] = []
    const fetchFn: LokiFetch = async (_url, init) => {
      calls.push(init.body ?? '')
      if (failing) throw new Error('ECONNREFUSED')
      return { ok: true, status: 204, text: async () => '' }
    }
    const dest = new LokiDestination({ fetchFn })
    await dest.initialize(config())
    dest.write(entry({ message: 'during outage' }))
    await dest.flush()
    expect(dest.getStatus().queued).toBe(1)

    failing = false
    await dest.flush()
    expect(dest.getStatus().queued).toBe(0)
    expect(dest.getStatus().pushed).toBe(1)
    expect(dest.getStatus().lastError).toBeNull()
    expect(JSON.parse(calls[1] ?? '{}').streams[0].values).toHaveLength(1)
  })

  it('bounds the queue and drops OLDEST first', async () => {
    // A logger that OOMs the process it observes is worse than one that loses
    // lines. During an incident the newest lines are the ones being read.
    const { fetchFn } = makeFetch({ throws: true })
    const dest = new LokiDestination({ fetchFn })
    await dest.initialize(config({ batchSize: 100_000 }))
    for (let i = 0; i < 10_050; i++) dest.write(entry({ message: `m${String(i)}` }))

    const status = dest.getStatus()
    expect(status.queued).toBe(10_000)
    expect(status.dropped).toBe(50)
  })

  it('does not run two flushes concurrently', async () => {
    let inFlight = 0
    let maxInFlight = 0
    const fetchFn: LokiFetch = async () => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await Promise.resolve()
      inFlight -= 1
      return { ok: true, status: 204, text: async () => '' }
    }
    const dest = new LokiDestination({ fetchFn })
    await dest.initialize(config())
    dest.write(entry())
    dest.write(entry())
    await Promise.all([dest.flush(), dest.flush(), dest.flush()])
    expect(maxInFlight).toBe(1)
  })
})

describe('LokiDestination — lifecycle', () => {
  it('flushes the tail on shutdown', async () => {
    const { fetchFn, calls } = makeFetch()
    const dest = new LokiDestination({ fetchFn })
    await dest.initialize(config())
    dest.write(entry({ message: 'last words' }))
    await dest.shutdown()
    expect(calls).toHaveLength(1)
    expect(calls[0]?.body).toContain('last words')
  })

  it('stops the interval on shutdown', async () => {
    const clearIntervalFn = vi.fn()
    const dest = new LokiDestination({
      fetchFn: makeFetch().fetchFn,
      setIntervalFn: vi.fn(() => 42 as unknown as ReturnType<typeof setInterval>) as never,
      clearIntervalFn: clearIntervalFn as never,
    })
    await dest.initialize(config())
    await dest.shutdown()
    expect(clearIntervalFn).toHaveBeenCalledWith(42)
  })

  it('reads back once configured (D898) — the read itself is loki-read.spec.ts', async () => {
    const dest = new LokiDestination({ fetchFn: makeFetch().fetchFn })
    await dest.initialize(config())
    await expect(dest.describeRead()).resolves.toMatchObject({ readable: true })
  })
})

describe('LokiDestination — reconfigure (live settings change)', () => {
  it('starts pushing when toggled from disabled to enabled — the "enable without restart" contract', async () => {
    // The addon boots inert (enabled:false) and the operator flips it on. Before
    // the reconfigure() path existed, the live destination kept its boot config
    // and never pushed despite the setting reading enabled:true.
    const { fetchFn, calls } = makeFetch()
    const dest = new LokiDestination({ fetchFn })
    await dest.initialize(config({ enabled: false }))
    dest.write(entry())
    await dest.flush()
    expect(calls).toHaveLength(0)

    await dest.reconfigure(config({ enabled: true }))
    expect(dest.getStatus().configured).toBe(true)
    dest.write(entry({ message: 'now live' }))
    await dest.flush()
    expect(calls).toHaveLength(1)
    expect(calls[0]?.body).toContain('now live')
  })

  it('stops pushing and clears the timer when toggled off', async () => {
    const clearIntervalFn = vi.fn()
    let handle = 0
    const dest = new LokiDestination({
      fetchFn: makeFetch().fetchFn,
      setIntervalFn: vi.fn(() => ++handle as unknown as ReturnType<typeof setInterval>) as never,
      clearIntervalFn: clearIntervalFn as never,
    })
    await dest.initialize(config({ enabled: true }))
    await dest.reconfigure(config({ enabled: false }))
    expect(clearIntervalFn).toHaveBeenCalledWith(1)
    expect(dest.getStatus().configured).toBe(false)
  })

  it('clears the previous timer before arming a new one, so re-applying does not leak', async () => {
    const clearIntervalFn = vi.fn()
    let handle = 0
    const dest = new LokiDestination({
      fetchFn: makeFetch().fetchFn,
      setIntervalFn: vi.fn(() => ++handle as unknown as ReturnType<typeof setInterval>) as never,
      clearIntervalFn: clearIntervalFn as never,
    })
    await dest.initialize(config({ enabled: true }))
    await dest.reconfigure(config({ enabled: true, level: 'warn' }))
    // The first timer (handle 1) must be cleared when the second is armed.
    expect(clearIntervalFn).toHaveBeenCalledWith(1)
  })

  it('preserves the queued tail across a reconfigure', async () => {
    const { fetchFn, calls } = makeFetch({ throws: true })
    const dest = new LokiDestination({ fetchFn })
    await dest.initialize(config())
    dest.write(entry({ message: 'queued before change' }))
    await dest.flush() // fails → re-queued
    expect(dest.getStatus().queued).toBe(1)

    await dest.reconfigure(config({ batchSize: 50 }))
    expect(dest.getStatus().queued).toBe(1)
    void calls
  })
})

describe('LokiDestination — testConnection', () => {
  it('reports the failure reason rather than throwing', async () => {
    const { fetchFn } = makeFetch({ ok: false, status: 401 })
    const dest = new LokiDestination({ fetchFn })
    await expect(dest.testConnection(config())).resolves.toEqual({
      ok: false,
      error: expect.stringContaining('401'),
    })
  })

  it('refuses without a URL instead of pushing to nowhere', async () => {
    const dest = new LokiDestination({ fetchFn: makeFetch().fetchFn })
    const result = await dest.testConnection(config({ url: '' }))
    expect(result.ok).toBe(false)
    expect(result.error).toContain('No Loki URL')
  })

  it('sends a real push, so URL, auth, tenant AND labels are all validated', async () => {
    const { fetchFn, calls } = makeFetch()
    const dest = new LokiDestination({ fetchFn })
    const result = await dest.testConnection(config({ extraLabels: 'env=home' }))
    expect(result.ok).toBe(true)
    expect(calls[0]?.url).toBe('http://loki:3100/loki/api/v1/push')
    expect(JSON.parse(calls[0]?.body ?? '{}').streams[0].stream.env).toBe('home')
  })
})
