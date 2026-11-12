/**
 * An on-demand stream that ends because nobody is watching is not an outage.
 *
 * The broker knows the stop was an idle teardown (`suspended`). That fact is
 * not a `stream.offline`, and the dial that rebuilds it is not a
 * `stream.online`. A dial that fails while a consumer is still attached, and
 * an always-on source that goes quiet, stay outages.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IEventBus, IScopedLogger, StreamSource, SystemEvent } from '@camstack/types'
import { StreamBroker } from '../stream-broker/stream-broker.js'
import { StreamBrokerManager } from '../stream-broker/stream-broker-manager.js'

function createMockLogger(): IScopedLogger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
    withTags: vi.fn().mockReturnThis(),
  }
}

function reasonOf(data: unknown): unknown {
  return typeof data === 'object' && data !== null ? Reflect.get(data, 'reason') : undefined
}

function recordingBus(): { bus: IEventBus; events: { category: string; reason: unknown }[] } {
  const events: { category: string; reason: unknown }[] = []
  const bus: IEventBus = {
    emit: (event: SystemEvent) => {
      events.push({ category: String(event.category), reason: reasonOf(event.data) })
    },
    subscribe: () => () => {},
    getRecent: () => [],
  }
  return { bus, events }
}

function rtspSource(): StreamSource {
  return { type: 'rtsp', url: 'rtsp://camera/live', videoCodec: 'h264' }
}

function pushSource(): StreamSource {
  return { type: 'push', url: '', videoCodec: 'h264' }
}

describe('lazy idle teardown is not stream offline', () => {
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

  it('an idle lazy source emits no stream-offline, and the rebuild emits no stream-online', async () => {
    const broker = new StreamBroker('106/native:main', logger)
    await broker.start(rtspSource())
    expect(broker.suspended).toBe(true)

    manager.runStreamHealthSweepForTest('106/native:main', broker)
    expect(events).toEqual([])
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('idled out'),
      expect.objectContaining({ tags: { deviceId: 106 } }),
    )

    events.length = 0
    vi.spyOn(broker, 'suspended', 'get').mockReturnValue(false)
    vi.spyOn(broker, 'getLastPacketAt').mockReturnValue(Date.now())
    manager.runStreamHealthSweepForTest('106/native:main', broker)
    expect(events).toEqual([])
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('rebuilt after idle'),
      expect.objectContaining({ tags: { deviceId: 106 } }),
    )
  })

  it('a lazy source whose session dies while a consumer is attached still emits offline', async () => {
    const broker = new StreamBroker('106/native:main', logger)
    await broker.start(rtspSource())
    vi.spyOn(broker, 'suspended', 'get').mockReturnValue(false)
    vi.spyOn(broker, 'getLastPacketAt').mockReturnValue(Date.now())
    vi.spyOn(broker, 'redial').mockImplementation(() => {})
    manager.runStreamHealthSweepForTest('106/native:main', broker)
    events.length = 0

    const quietStats = broker.getStats()
    vi.spyOn(broker, 'getLastPacketAt').mockReturnValue(Date.now() - 180_000)
    vi.spyOn(broker, 'getStats').mockReturnValue({ ...quietStats, status: 'error' })
    manager.runStreamHealthSweepForTest('106/native:main', broker)
    expect(events).toEqual([{ category: 'stream.offline', reason: 'stale-timeout' }])
  })

  it('an always-on push source that goes quiet still emits offline', async () => {
    const broker = new StreamBroker('12/native:main', logger)
    await broker.start(pushSource())
    expect(broker.suspended).toBe(false)
    vi.spyOn(broker, 'getLastPacketAt').mockReturnValue(Date.now())
    vi.spyOn(broker, 'redial').mockImplementation(() => {})
    manager.runStreamHealthSweepForTest('12/native:main', broker)
    events.length = 0

    vi.spyOn(broker, 'getLastPacketAt').mockReturnValue(Date.now() - 180_000)
    manager.runStreamHealthSweepForTest('12/native:main', broker)
    expect(events).toEqual([{ category: 'stream.offline', reason: 'stale-timeout' }])
  })
})
