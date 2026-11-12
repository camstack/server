/**
 * A battery `connection-error` is an outage only when it lasts the sustained
 * window and the whole camera is down.
 *
 * Live 2026-11-11/12, notification history on the hub. All Reolink, all
 * reasons the intake already accepts:
 *
 *  - 3629 "porta retro", lazy `native:main`: `connection-error` then
 *    `recovered` 15 s later. A wake dial whose first attempt errors.
 *  - 3825 "stanza caldaia": `rtsp:sub` errors with `lastPacketAt` 0, then
 *    `flv:sub` of the same camera delivers. A source failover.
 *  - 3628 "lavanderia": `rtsp:sub` errors with `lastPacketAt` 0 and nothing
 *    takes over. That one is a real outage, once the window has elapsed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  EventFilter,
  IEventBus,
  IScopedLogger,
  StreamSource,
  SystemEvent,
} from '@camstack/types'
import { StreamBroker } from '../stream-broker/stream-broker.js'
import { StreamBrokerManager } from '../stream-broker/stream-broker-manager.js'
import {
  STREAM_STALE_TIMEOUT_MS,
  WAKE_DEMAND_BOUND_MS,
} from '../stream-broker/stream-health-policy.js'

interface Seen {
  readonly category: string
  readonly reason: unknown
  readonly camStreamId: unknown
}

function createLogger(): IScopedLogger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
    withTags: vi.fn().mockReturnThis(),
  }
}

function field(data: unknown, key: string): unknown {
  return typeof data === 'object' && data !== null ? Reflect.get(data, key) : undefined
}

interface Harness {
  readonly manager: StreamBrokerManager
  readonly logger: IScopedLogger
  readonly seen: Seen[]
  readonly sweep: (id: string, broker: StreamBroker) => void
  readonly awake: (deviceId: number) => void
  readonly sleep: (deviceId: number) => void
}

function harness(): Harness {
  const logger = createLogger()
  const seen: Seen[] = []
  const handlers: { category: string; fn: (e: SystemEvent) => void }[] = []
  const bus: IEventBus = {
    emit: (event: SystemEvent) => {
      seen.push({
        category: String(event.category),
        reason: field(event.data, 'reason'),
        camStreamId: field(event.data, 'camStreamId'),
      })
    },
    subscribe: (filter: EventFilter, fn: (event: SystemEvent) => void) => {
      handlers.push({ category: String(filter.category), fn })
      return () => {}
    },
    getRecent: () => [],
  }
  const manager = new StreamBrokerManager(logger)
  manager.setEventBus(bus)
  return {
    manager,
    logger,
    seen,
    sweep: (id, broker) => manager.runStreamHealthSweepForTest(id, broker),
    awake: (deviceId) => {
      postBattery(deviceId, false)
    },
    sleep: (deviceId) => {
      postBattery(deviceId, true)
    },
  }

  function postBattery(deviceId: number, sleeping: boolean): void {
    for (const h of handlers.filter((x) => x.category === 'battery.onStatusChanged')) {
      h.fn({
        id: 'battery',
        timestamp: new Date(),
        category: 'battery.onStatusChanged',
        source: { type: 'test', id: 'test' },
        data: { deviceId, status: { sleeping, lastContactAt: Date.now() } },
      })
    }
  }
}

function source(type: 'rfc4571' | 'rtsp' | 'flv' | 'push'): StreamSource {
  return { type, url: type === 'push' ? '' : `${type}://camera/live`, videoCodec: 'h264' }
}

describe('battery connection-error is a sustained whole-camera outage', () => {
  const clock = { now: 1_800_000_000_000 }
  const brokers: StreamBroker[] = []
  let h: Harness

  async function broker(
    id: string,
    type: 'rfc4571' | 'rtsp' | 'flv' | 'push',
  ): Promise<StreamBroker> {
    const created = new StreamBroker(id, createLogger())
    await created.start(source(type))
    vi.spyOn(created, 'redial').mockImplementation(() => {})
    brokers.push(created)
    return created
  }

  const advance = (ms: number): void => {
    clock.now += ms
  }

  beforeEach(() => {
    clock.now = 1_800_000_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => clock.now)
    h = harness()
  })

  afterEach(async () => {
    await h.manager.destroyAll().catch(() => {})
    await Promise.all(brokers.splice(0).map((b) => b.stop().catch(() => {})))
    vi.restoreAllMocks()
  })

  it('a wake dial that errors and recovers 15 s later notifies nothing (3629)', async () => {
    h.awake(3629)
    advance(WAKE_DEMAND_BOUND_MS + 1)
    const main = await broker('3629/native:main', 'rfc4571')
    expect(main.suspended).toBe(true)
    const lastPacket = clock.now - 15 * 60_000
    vi.spyOn(main, 'getLastPacketAt').mockImplementation(() => lastPacket)

    h.sweep('3629/native:main', main)
    expect(h.seen).toEqual([])

    vi.spyOn(main, 'suspended', 'get').mockReturnValue(false)
    h.sweep('3629/native:main', main)
    expect(h.seen).toEqual([])

    advance(15_000)
    vi.spyOn(main, 'getLastPacketAt').mockImplementation(() => clock.now)
    h.sweep('3629/native:main', main)
    expect(h.seen).toEqual([])
    expect(h.logger.info).toHaveBeenCalledWith(
      expect.stringContaining('recovered inside the sustained window'),
      expect.objectContaining({ tags: { deviceId: 3629 } }),
    )
  })

  it('a source that never delivered is not an outage when a fallback delivers (3825)', async () => {
    h.awake(3825)
    advance(WAKE_DEMAND_BOUND_MS + 1)
    const flv = await broker('3825/flv:sub', 'flv')
    vi.spyOn(flv, 'suspended', 'get').mockReturnValue(false)
    vi.spyOn(flv, 'getLastPacketAt').mockImplementation(() => clock.now)
    h.sweep('3825/flv:sub', flv)
    h.seen.length = 0

    const rtsp = await broker('3825/rtsp:sub', 'rtsp')
    vi.spyOn(rtsp, 'getLastPacketAt').mockReturnValue(0)
    h.sweep('3825/rtsp:sub', rtsp)
    h.seen.length = 0

    vi.spyOn(rtsp, 'suspended', 'get').mockReturnValue(false)
    h.sweep('3825/rtsp:sub', rtsp)
    advance(60_000)
    vi.spyOn(flv, 'getLastPacketAt').mockImplementation(() => clock.now)
    h.sweep('3825/flv:sub', flv)

    expect(h.seen).toEqual([])
    expect(h.logger.info).toHaveBeenCalledWith(
      expect.stringContaining('never delivered a packet'),
      expect.objectContaining({ tags: { deviceId: 3825 } }),
    )
  })

  it('a source that fails while another source of the camera delivers is not an outage', async () => {
    h.awake(3826)
    advance(WAKE_DEMAND_BOUND_MS + 1)
    const flv = await broker('3826/flv:main', 'flv')
    vi.spyOn(flv, 'suspended', 'get').mockReturnValue(false)
    vi.spyOn(flv, 'getLastPacketAt').mockImplementation(() => clock.now)
    h.sweep('3826/flv:main', flv)

    const rtsp = await broker('3826/rtsp:main', 'rtsp')
    const stalePacket = clock.now - 15 * 60_000
    vi.spyOn(rtsp, 'getLastPacketAt').mockReturnValue(stalePacket)
    h.sweep('3826/rtsp:main', rtsp)
    h.seen.length = 0

    vi.spyOn(rtsp, 'suspended', 'get').mockReturnValue(false)
    h.sweep('3826/rtsp:main', rtsp)
    expect(h.seen).toEqual([])
    expect(h.logger.info).toHaveBeenCalledWith(
      expect.stringContaining('another source of the camera delivers'),
      expect.objectContaining({ tags: { deviceId: 3826 } }),
    )
  })

  it('a connection-error nobody recovers is notified once, and the recovery once (3628)', async () => {
    h.awake(3628)
    advance(WAKE_DEMAND_BOUND_MS + 1)
    const sub = await broker('3628/rtsp:sub', 'rtsp')
    vi.spyOn(sub, 'getLastPacketAt').mockReturnValue(0)
    h.sweep('3628/rtsp:sub', sub)
    expect(h.seen).toEqual([])

    vi.spyOn(sub, 'suspended', 'get').mockReturnValue(false)
    h.sweep('3628/rtsp:sub', sub)
    expect(h.seen).toEqual([])

    advance(15_000)
    h.sweep('3628/rtsp:sub', sub)
    expect(h.seen).toEqual([])

    advance(STREAM_STALE_TIMEOUT_MS)
    h.sweep('3628/rtsp:sub', sub)
    expect(h.seen).toEqual([
      expect.objectContaining({
        category: 'stream.offline',
        reason: 'connection-error',
        camStreamId: 'rtsp:sub',
      }),
    ])

    h.seen.length = 0
    vi.spyOn(sub, 'getLastPacketAt').mockImplementation(() => clock.now)
    h.sweep('3628/rtsp:sub', sub)
    expect(h.seen).toEqual([
      expect.objectContaining({
        category: 'stream.online',
        reason: 'recovered',
        camStreamId: 'rtsp:sub',
      }),
    ])
  })

  it('a wake error then sleep during the hold notifies nothing at 120 s or after', async () => {
    h.awake(640)
    advance(WAKE_DEMAND_BOUND_MS + 1)
    const main = await broker('640/native:main', 'rfc4571')
    vi.spyOn(main, 'getLastPacketAt').mockReturnValue(0)
    h.sweep('640/native:main', main)
    expect(h.seen).toEqual([])

    vi.spyOn(main, 'suspended', 'get').mockReturnValue(false)
    h.sweep('640/native:main', main)
    expect(h.seen).toEqual([])
    expect(h.logger.info).toHaveBeenCalledWith(
      expect.stringContaining('held — not an outage until it lasts the sustained window'),
      expect.objectContaining({ tags: { deviceId: 640 } }),
    )

    h.sleep(640)
    advance(STREAM_STALE_TIMEOUT_MS)
    h.sweep('640/native:main', main)
    expect(h.seen).toEqual([])

    advance(STREAM_STALE_TIMEOUT_MS)
    h.sweep('640/native:main', main)
    expect(h.seen).toEqual([])
    expect(h.logger.info).toHaveBeenCalledWith(
      expect.stringContaining('went back to sleep'),
      expect.objectContaining({ tags: { deviceId: 640 } }),
    )
  })
})
