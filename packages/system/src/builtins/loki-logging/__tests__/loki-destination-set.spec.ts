/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- AddonContext stub crosses typed boundaries. */
import type { AddonContext, IScopedLogger, LogEntry } from '@camstack/types'
import { makeInMemoryRecords, RecordSecretUnavailableError } from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LokiConfig } from '../loki-destination.js'
import { LokiDestination } from '../loki-destination.js'
import { LokiDestinationSet } from '../loki-destination-set.js'
import { LokiLoggingAddon } from '../loki-logging.addon.js'
import { lokiDestinationsKind } from '../loki-record-kinds.js'

const entry: LogEntry = {
  timestamp: new Date(0),
  level: 'info',
  scope: 't',
  message: 'hello',
}

function config(url: string): LokiConfig {
  return {
    enabled: true,
    url,
    job: 'camstack',
    node: 'hub',
    level: 'info',
    batchIntervalMs: 60_000,
    batchSize: 1,
    extraLabels: '',
    tenantId: '',
    username: '',
    password: '',
    timeoutMs: 1000,
  }
}

describe('LokiDestinationSet', () => {
  it('fans a write out to every instance, disabling one stops only it, removing one closes it', async () => {
    const urls: string[] = []
    const set = new LokiDestinationSet({
      fetchFn: async (url) => {
        urls.push(url)
        return { ok: true, status: 204, text: async () => '' }
      },
    })
    await set.apply(
      new Map([
        ['a', config('http://a:3100')],
        ['b', config('http://b:3100')],
      ]),
    )
    set.write(entry)
    await set.flush()
    expect(urls.filter((u) => u.startsWith('http://a:')).length).toBe(1)
    expect(urls.filter((u) => u.startsWith('http://b:')).length).toBe(1)

    urls.length = 0
    await set.apply(
      new Map([
        ['a', { ...config('http://a:3100'), enabled: false }],
        ['b', config('http://b:3100')],
      ]),
    )
    set.write(entry)
    await set.flush()
    expect(urls.map((u) => new URL(u).hostname)).toEqual(['b'])

    const shutdown = vi.spyOn(LokiDestination.prototype, 'shutdown')
    await set.apply(new Map([['b', config('http://b:3100')]]))
    expect(shutdown).toHaveBeenCalledTimes(1)
    expect(set.ids()).toEqual(['b'])
    shutdown.mockRestore()
    await set.shutdown()
  })

  it('reads the named instance, else the first readable one', async () => {
    const seen: string[] = []
    const set = new LokiDestinationSet({
      fetchFn: async (url) => {
        seen.push(new URL(url).hostname)
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ data: { result: [] } }),
        }
      },
    })
    await set.apply(
      new Map([
        ['a', { ...config('http://a:3100'), enabled: false }],
        ['b', config('http://b:3100')],
        ['c', config('http://c:3100')],
      ]),
    )
    await set.read({ limit: 5 })
    expect(new Set(seen)).toEqual(new Set(['b']))
    seen.length = 0
    await set.read({ limit: 5, instanceId: 'c' })
    expect(new Set(seen)).toEqual(new Set(['c']))
    expect((await set.describeRead({ instanceId: 'zz' })).readable).toBe(false)
    await set.shutdown()
  })
})

function logger(): IScopedLogger {
  return {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
    withTags: vi.fn().mockReturnThis(),
  } as unknown as IScopedLogger
}

function body(url: string) {
  return {
    name: url,
    url,
    level: 'info' as const,
    job: 'cam',
    extraLabels: '',
    tenantId: '',
    username: '',
    batchIntervalMs: 5000,
    batchSize: 200,
    timeoutMs: 10000,
  }
}

describe('LokiLoggingAddon — several records', () => {
  const addons: LokiLoggingAddon[] = []
  afterEach(async () => {
    await new Promise((resolve) => setTimeout(resolve, 25))
    for (const a of addons.splice(0)) await a.shutdown()
  })

  async function boot() {
    const world = makeInMemoryRecords('loki-logging')
    await world.records.declare({ destinations: lokiDestinationsKind })
    const real = world.records.kind(lokiDestinationsKind)
    for (const [id, url] of [
      ['int_0001', 'http://a:3100'],
      ['int_0002', 'http://b:3100'],
    ] as const) {
      await real.put({ id, data: body(url) }, { ifRev: 0 })
    }
    const locked = new Set<string>()
    const records = {
      ...world.records,
      kind: () =>
        Object.create(real, {
          getResolved: {
            value: async (id: string) => {
              if (locked.has(id)) throw new RecordSecretUnavailableError('locked')
              return real.getResolved(id)
            },
          },
        }),
    }
    const log = logger()
    const ctx = {
      id: 'loki-logging',
      logger: log,
      records,
      settings: {
        readAddonStore: vi.fn(async () => ({})),
        readAddonStoreResult: vi.fn(async () => ({ kind: 'value' as const, value: {} })),
        writeAddonStore: vi.fn(async () => undefined),
        readDeviceStore: vi.fn(async () => ({})),
        writeDeviceStore: vi.fn(async () => undefined),
        getSection: vi.fn(async () => ({})),
        setSection: vi.fn(async () => undefined),
      },
      eventBus: { emit: vi.fn(), subscribe: vi.fn(() => () => undefined) },
      kernel: { localNodeId: 'agent-1' },
      api: {},
    } as unknown as AddonContext
    const addon = new LokiLoggingAddon()
    await addon.initialize(ctx)
    addons.push(addon)
    return { addon, real, locked, log }
  }

  it('one destination per record, same ids as the record; a delete closes only that one', async () => {
    const { addon, real } = await boot()
    expect(addon.getDestination().ids()).toEqual(['int_0001', 'int_0002'])
    await real.delete('int_0002')
    // The agent re-reads on its refresh timer; drive the same path.
    await Reflect.apply(Reflect.get(addon, 'refreshFromRecord'), addon, [])
    expect(addon.getDestination().ids()).toEqual(['int_0001'])
  })

  it('an unresolved secret keeps that instance as it was and does not touch the others', async () => {
    const { addon, locked, log } = await boot()
    locked.add('int_0001')
    const before = addon.getDestination().getStatus('int_0001')
    await Reflect.apply(Reflect.get(addon, 'refreshFromRecord'), addon, [])
    expect(addon.getDestination().ids()).toEqual(['int_0001', 'int_0002'])
    expect(addon.getDestination().getStatus('int_0001')).toEqual(before)
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('int_0001'))
  })
})
