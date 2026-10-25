import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import * as yaml from 'js-yaml'
import { LogRingBuffer } from './log-ring-buffer'
import { ScopedLogger } from './scoped-logger'
import { LoggingService } from './logging.service'
import { ConfigService } from '../config/config.service'
import type { ISettingsStore } from '@camstack/system'
import type { LogEntry, ILogDestination } from '@camstack/types'

/**
 * In-memory settings store used by the test to drive `ConfigService.get`
 * for the `eventBus.ringBufferSize` key. The bootstrap YAML schema does not
 * declare `eventBus`, so writing it to the YAML file would be discarded by
 * `bootstrapSchema.parse`. Wiring an ISettingsStore is the clean path to
 * feed runtime values into `ConfigService` without casts.
 */
class InMemorySettingsStore implements ISettingsStore {
  private readonly system: Record<string, unknown>

  constructor(seed: Record<string, unknown>) {
    this.system = { ...seed }
  }

  getSystem(key: string): unknown {
    return this.system[key]
  }
  setSystem(key: string, value: unknown): void {
    this.system[key] = value
  }
  getAllSystem(): Record<string, unknown> {
    return { ...this.system }
  }

  getAllAddon(_addonId: string): Record<string, unknown> {
    return {}
  }
  setAllAddon(_addonId: string, _config: Record<string, unknown>): void {
    /* no-op */
  }
  getDeviceRuntimeState(_deviceId: string): Record<string, unknown> {
    return {}
  }
  setDeviceRuntimeState(_deviceId: string, _blob: Record<string, unknown>): void {
    /* no-op */
  }
  clearDeviceRuntimeState(_deviceId: string): void {
    /* no-op */
  }
}

describe('ScopedLogger', () => {
  it('emits entries with a single scope string', () => {
    const entries: LogEntry[] = []
    const writeFn = (entry: LogEntry) => entries.push(entry)
    const logger = new ScopedLogger('config', writeFn)

    logger.info('loaded config')

    expect(entries).toHaveLength(1)
    expect(entries[0]!.scope).toBe('config')
    expect(entries[0]!.level).toBe('info')
    expect(entries[0]!.message).toBe('loaded config')
    expect(entries[0]!.timestamp).toBeInstanceOf(Date)
  })

  it('child() replaces the scope (no hierarchy)', () => {
    const entries: LogEntry[] = []
    const writeFn = (entry: LogEntry) => entries.push(entry)
    const logger = new ScopedLogger('core', writeFn)
    const child = logger.child('http')

    child.warn('timeout', { meta: { ms: 3000 } })

    expect(entries).toHaveLength(1)
    expect(entries[0]!.scope).toBe('http')
    expect(entries[0]!.level).toBe('warn')
    expect(entries[0]!.meta).toEqual({ ms: 3000 })
  })

  it('creates entries for all log levels', () => {
    const entries: LogEntry[] = []
    const writeFn = (entry: LogEntry) => entries.push(entry)
    const logger = new ScopedLogger('test', writeFn)

    logger.debug('d')
    logger.info('i')
    logger.warn('w')
    logger.error('e')

    expect(entries.map((e) => e.level)).toEqual(['debug', 'info', 'warn', 'error'])
  })

  it('omits the scope field when the logger was created without one', () => {
    const entries: LogEntry[] = []
    const writeFn = (entry: LogEntry) => entries.push(entry)
    const logger = new ScopedLogger(undefined, writeFn)

    logger.info('no scope')

    expect(entries).toHaveLength(1)
    expect(entries[0]!.scope).toBeUndefined()
  })
})

describe('LogRingBuffer', () => {
  it('stores up to capacity and evicts oldest', () => {
    const buffer = new LogRingBuffer(3)

    const makeEntry = (msg: string): LogEntry => ({
      timestamp: new Date(),
      level: 'info',
      scope: 'test',
      message: msg,
    })

    buffer.push(makeEntry('a'))
    buffer.push(makeEntry('b'))
    buffer.push(makeEntry('c'))
    buffer.push(makeEntry('d'))

    const all = buffer.getAll()
    expect(all).toHaveLength(3)
    // newest first
    expect(all[0]!.message).toBe('d')
    expect(all[1]!.message).toBe('c')
    expect(all[2]!.message).toBe('b')
  })

  it('filters by level', () => {
    const buffer = new LogRingBuffer(100)

    buffer.push({ timestamp: new Date(), level: 'debug', scope: 'test', message: 'a' })
    buffer.push({ timestamp: new Date(), level: 'error', scope: 'test', message: 'b' })
    buffer.push({ timestamp: new Date(), level: 'error', scope: 'test', message: 'c' })

    const result = buffer.query({ level: 'error' })
    expect(result).toHaveLength(2)
  })

  it('filters by since/until', () => {
    const buffer = new LogRingBuffer(100)
    const t1 = new Date('2025-01-01T00:00:00Z')
    const t2 = new Date('2025-01-02T00:00:00Z')
    const t3 = new Date('2025-01-03T00:00:00Z')

    buffer.push({ timestamp: t1, level: 'info', scope: 'test', message: 'a' })
    buffer.push({ timestamp: t2, level: 'info', scope: 'test', message: 'b' })
    buffer.push({ timestamp: t3, level: 'info', scope: 'test', message: 'c' })

    const result = buffer.query({ since: t2 })
    expect(result).toHaveLength(2)
    expect(result.map((e) => e.message)).toEqual(['c', 'b'])
  })

  it('filters by tags (addonId exact match)', () => {
    const buffer = new LogRingBuffer(100)

    buffer.push({
      timestamp: new Date(),
      level: 'info',
      message: 'a',
      tags: { addonId: 'stream-broker' },
    })
    buffer.push({
      timestamp: new Date(),
      level: 'info',
      message: 'b',
      tags: { addonId: 'provider-rtsp' },
    })
    buffer.push({
      timestamp: new Date(),
      level: 'info',
      message: 'c',
      tags: { addonId: 'stream-broker' },
    })

    const result = buffer.query({ tags: { addonId: 'stream-broker' } })
    expect(result).toHaveLength(2)
    expect(result.map((e) => e.message).toSorted()).toEqual(['a', 'c'])
  })

  it('respects limit', () => {
    const buffer = new LogRingBuffer(100)

    for (let i = 0; i < 10; i++) {
      buffer.push({ timestamp: new Date(), level: 'info', scope: 'test', message: `msg-${i}` })
    }

    const result = buffer.query({ limit: 3 })
    expect(result).toHaveLength(3)
  })
})

describe('LoggingService', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'camstack-logging-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  const createService = (bufferSize = 100): LoggingService => {
    const configPath = path.join(tmpDir, 'config.yaml')
    fs.writeFileSync(
      configPath,
      yaml.dump({
        server: { port: 4443 },
        auth: { adminPassword: 'secret123' },
      }),
      'utf-8',
    )
    const configService = new ConfigService(configPath)
    configService.setSettingsStore(
      new InMemorySettingsStore({
        'eventBus.ringBufferSize': bufferSize,
      }),
    )
    return new LoggingService(configService)
  }

  it('the SHIPPED hub buffer is bounded in aggregate with no operator config', () => {
    // hub-main ingests from every local runner AND every agent, so the buffer's
    // only historical bound (per-addon ring x buckets) grew with the roster.
    // An operator who has configured nothing must still get a bound.
    const service = createService()
    for (let a = 0; a < 60; a += 1) {
      const logger = service.createLogger('bulk')
      for (let i = 0; i < 5000; i += 1) {
        logger.debug(`m${String(i)}`, { tags: { addonId: `addon-${String(a)}` } })
      }
    }
    expect(service.bufferSize()).toBeLessThan(60 * 5000)
  })

  it('routes entries to all destinations', () => {
    const service = createService()
    const written: LogEntry[] = []
    const dest: ILogDestination = {
      initialize: async () => {},
      shutdown: async () => {},
      write: (entry) => written.push(entry),
    }

    service.addDestination(dest)
    const logger = service.createLogger('test')
    logger.info('hello')

    expect(written).toHaveLength(1)
    expect(written[0]!.message).toBe('hello')
    expect(written[0]!.scope).toBe('test')
  })

  it('creates scoped loggers that push to ring buffer', () => {
    const service = createService()
    const logger = service.createLogger('myScope')
    logger.error('boom')

    const entries = service.query({})
    expect(entries).toHaveLength(1)
    expect(entries[0]!.message).toBe('boom')
    expect(entries[0]!.scope).toBe('myScope')
  })

  it('removes destinations', () => {
    const service = createService()
    const written: LogEntry[] = []
    const dest: ILogDestination = {
      initialize: async () => {},
      shutdown: async () => {},
      write: (entry) => written.push(entry),
    }

    service.addDestination(dest)
    service.removeDestination(dest)

    const logger = service.createLogger('test')
    logger.info('should not reach dest')

    expect(written).toHaveLength(0)
    // but still in ring buffer
    expect(service.query({})).toHaveLength(1)
  })
})
