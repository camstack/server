/**
 * A derived LOW must not notify stream-offline/online on restart.
 *
 * Two paths:
 *  1. Idle (no demand): `start()` registers `_suspended` so the health sweep
 *     labels `suspended` (discarded by NC), not `stale-timeout`.
 *  2. Demanded before first packet (motion wakes derived while its source
 *     is still unpublished): the sweep seeds unhealthy without emitting;
 *     the first packet is `first-packet` (discarded), never a
 *     `stale-timeout`/`recovered` pair.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IEventBus, IScopedLogger, StreamSource, SystemEvent } from '@camstack/types'
import { StreamBroker } from '../stream-broker/stream-broker.js'
import { StreamBrokerManager } from '../stream-broker/stream-broker-manager.js'

function createMockLogger(): IScopedLogger {
  const logger: IScopedLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
    withTags: vi.fn().mockReturnThis(),
  }
  return logger
}

/** `data.reason` when the payload carries one. */
function reasonOf(data: unknown): unknown {
  return typeof data === 'object' && data !== null ? Reflect.get(data, 'reason') : undefined
}

function recordingBus(): { bus: IEventBus; events: { category: string; reason: unknown }[] } {
  const events: { category: string; reason: unknown }[] = []
  const bus: IEventBus = {
    emit: (event: SystemEvent) => {
      events.push({
        category: String(event.category),
        reason: reasonOf(event.data),
      })
    },
    subscribe: () => () => {},
    getRecent: () => [],
  }
  return { bus, events }
}

function derivedPushSource(): StreamSource {
  return {
    type: 'push',
    url: '',
    videoCodec: 'h264',
    metadata: { kind: 'derived', label: 'low' },
  }
}

describe('derived idle health — no false stream-offline', () => {
  let manager: StreamBrokerManager
  let logger: IScopedLogger
  let events: { category: string; reason: unknown }[]
  let bus: IEventBus

  beforeEach(() => {
    logger = createMockLogger()
    ;({ bus, events } = recordingBus())
    manager = new StreamBrokerManager(logger)
    manager.setEventBus(bus)
  })

  afterEach(async () => {
    await manager.destroyAll().catch(() => {})
  })

  it('start() with no demand registers idle + suspended', async () => {
    const broker = new StreamBroker('102/derived:low', logger)
    await broker.start(derivedPushSource())
    expect(broker.suspended).toBe(true)
    expect(broker.getStats().status).toBe('idle')
    expect(broker.getLastPacketAt()).toBe(0)
  })

  it('health sweep labels an idle derived suspended, never stale-timeout', async () => {
    const broker = new StreamBroker('102/derived:low', logger)
    await broker.start(derivedPushSource())
    manager.runStreamHealthSweepForTest('102/derived:low', broker)

    expect(events).toEqual([{ category: 'stream.offline', reason: 'suspended' }])
    // Phantom redial must not fire on an intentionally idle derived.
    const redial = vi.spyOn(broker, 'redial')
    manager.runStreamHealthSweepForTest('102/derived:low', broker)
    expect(redial).not.toHaveBeenCalled()
  })

  it('a camera-provider push still latches streaming (unchanged)', async () => {
    const broker = new StreamBroker('102/native:sub', logger)
    await broker.start({ type: 'push', url: '', videoCodec: 'h264' })
    expect(broker.suspended).toBe(false)
    expect(broker.getStats().status).toBe('streaming')
  })

  it('demanded derived waiting for first packet does not emit stale-timeout', async () => {
    // Motion (or any consumer) can create demand before the feeder's source
    // is published — the live restart path for dispensa's derived:mid-to-low.
    const broker = new StreamBroker('1438/derived:mid-to-low', logger)
    broker.setPreBufferEnabled(true)
    await broker.start(derivedPushSource())
    expect(broker.suspended).toBe(false)
    expect(broker.getLastPacketAt()).toBe(0)

    manager.runStreamHealthSweepForTest('1438/derived:mid-to-low', broker)
    expect(events).toEqual([])

    vi.spyOn(broker, 'getLastPacketAt').mockReturnValue(Date.now())
    manager.runStreamHealthSweepForTest('1438/derived:mid-to-low', broker)
    expect(events).toEqual([{ category: 'stream.online', reason: 'first-packet' }])
  })
})
