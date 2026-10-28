/**
 * D883 — what a quiet stream means is decided at the emitter.
 *
 * Live 2026-10-18, device 106 (Reolink battery): every sleep and wake of the
 * camera produced `stream.offline` / `stream.online` per profile and the
 * operator's system-event rule pushed all of them. A sleep is not an outage; a
 * real failure is one event per DEVICE, not per profile; and the verdict is
 * LEVEL state — a camera that sleeps and then dies must still be reported.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BATTERY_UNREACHABLE_AFTER_MS } from '@camstack/types'
import type { AddonApi, EventFilter, IEventBus, IScopedLogger, SystemEvent } from '@camstack/types'
import { StreamBroker } from '../stream-broker/stream-broker.js'
import { StreamBrokerManager } from '../stream-broker/stream-broker-manager.js'
import { WAKE_DEMAND_BOUND_MS } from '../stream-broker/stream-health-policy.js'

interface Seen {
  readonly category: string
  readonly reason: unknown
  readonly camStreamId: unknown
  readonly camStreamIds: unknown
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
  readonly batteryStatus: (status: { sleeping: boolean; lastContactAt?: number }) => void
}

function harness(deviceId: number): Harness {
  const logger = createLogger()
  const seen: Seen[] = []
  const handlers: { category: string; fn: (e: SystemEvent) => void }[] = []
  const bus: IEventBus = {
    emit: (event: SystemEvent) => {
      seen.push({
        category: String(event.category),
        reason: field(event.data, 'reason'),
        camStreamId: field(event.data, 'camStreamId'),
        camStreamIds: field(event.data, 'camStreamIds'),
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
    batteryStatus: (status) => {
      for (const h of handlers.filter((x) => x.category === 'battery.onStatusChanged')) {
        h.fn({
          id: 'x',
          timestamp: new Date(),
          category: 'battery.onStatusChanged',
          source: { type: 'test', id: 'test' },
          data: { deviceId, status },
        })
      }
    },
  }
}

/** What the hub's registry / slice would answer — the reads a restart relies on. */
function fakeApi(answers: {
  readonly features: readonly string[] | 'throw'
  readonly slice: unknown
}): AddonApi {
  const api = {
    deviceManager: {
      getDevice: {
        query: async () => {
          if (answers.features === 'throw') throw new Error('registry down')
          return { features: answers.features }
        },
      },
    },
    deviceState: { getCapSlice: { query: async () => answers.slice } },
  }
  return Reflect.construct(Object, [api]) as AddonApi
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

describe('stream health — battery sleep is not an outage, a failure is one device event (D883)', () => {
  let h: Harness
  const lastPacket = { value: 1 }
  const clock = { now: 1_800_000_000_000 }
  const brokers: StreamBroker[] = []

  async function liveBroker(id: string): Promise<StreamBroker> {
    const broker = new StreamBroker(id, createLogger())
    await broker.start({ type: 'push', url: '', videoCodec: 'h264' })
    vi.spyOn(broker, 'getLastPacketAt').mockImplementation(() => lastPacket.value)
    vi.spyOn(broker, 'hasLiveDemand').mockReturnValue(false)
    brokers.push(broker)
    return broker
  }

  async function twoProfiles(deviceId: number): Promise<{ main: StreamBroker; sub: StreamBroker }> {
    const main = await liveBroker(`${deviceId}/native:main`)
    const sub = await liveBroker(`${deviceId}/native:sub`)
    lastPacket.value = clock.now
    h.sweep(`${deviceId}/native:main`, main)
    h.sweep(`${deviceId}/native:sub`, sub)
    h.seen.length = 0
    lastPacket.value = 1 // well past the stale window
    return { main, sub }
  }

  const advance = (ms: number): void => {
    clock.now += ms
  }

  beforeEach(() => {
    clock.now = 1_800_000_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => clock.now)
    h = harness(106)
  })

  afterEach(async () => {
    await h.manager.destroyAll().catch(() => {})
    await Promise.all(brokers.splice(0).map((b) => b.stop().catch(() => {})))
    vi.restoreAllMocks()
    lastPacket.value = 1
  })

  it('a battery camera falling asleep and waking again emits nothing and says why', async () => {
    h.batteryStatus({ sleeping: true, lastContactAt: clock.now })
    const { main } = await twoProfiles(106)

    h.sweep('106/native:main', main)
    expect(h.seen).toEqual([])
    expect(h.logger.info).toHaveBeenCalledWith(
      expect.stringContaining('sleeping battery camera'),
      expect.objectContaining({ tags: { deviceId: 106 } }),
    )

    lastPacket.value = clock.now // the camera woke and delivers
    h.sweep('106/native:main', main)
    expect(h.seen).toEqual([])
  })

  it('a camera that sleeps and then DIES is reported once its contact goes silent (level, not edge)', async () => {
    h.batteryStatus({ sleeping: true, lastContactAt: clock.now })
    const { main } = await twoProfiles(106)
    h.sweep('106/native:main', main)
    expect(h.seen).toEqual([])

    advance(BATTERY_UNREACHABLE_AFTER_MS + 1)
    h.sweep('106/native:main', main)
    expect(h.seen).toEqual([
      expect.objectContaining({
        category: 'stream.offline',
        reason: 'battery-unreachable',
        camStreamIds: ['native:main', 'native:sub'],
      }),
    ])
  })

  it('a wake demanded while the camera sleeps is a wake-timeout only after the wake bound', async () => {
    h.batteryStatus({ sleeping: true, lastContactAt: clock.now })
    const { main, sub } = await twoProfiles(106)
    h.sweep('106/native:main', main) // quiet, nobody asked: suppressed
    vi.spyOn(main, 'hasLiveDemand').mockReturnValue(true)
    vi.spyOn(sub, 'hasLiveDemand').mockReturnValue(true)

    h.sweep('106/native:main', main) // demand just arrived: has not failed yet
    expect(h.seen).toEqual([])

    advance(WAKE_DEMAND_BOUND_MS + 1)
    h.sweep('106/native:main', main)
    expect(h.seen).toEqual([
      expect.objectContaining({
        category: 'stream.offline',
        reason: 'wake-timeout',
        camStreamIds: ['native:main', 'native:sub'],
      }),
    ])
    h.seen.length = 0

    lastPacket.value = clock.now
    h.sweep('106/native:main', main)
    expect(h.seen.map((e) => [e.category, e.reason])).toEqual([['stream.online', 'recovered']])
  })

  it('a camera that just woke is not reported offline; the outage is raised after the wake bound if no stream came', async () => {
    h.batteryStatus({ sleeping: false, lastContactAt: clock.now })
    const { main } = await twoProfiles(106)
    advance(500)
    h.sweep('106/native:main', main) // wake window: first keyframe not yet here
    expect(h.seen).toEqual([])
    expect(h.logger.info).toHaveBeenCalledWith(
      expect.stringContaining('just woke'),
      expect.objectContaining({ tags: { deviceId: 106 } }),
    )

    advance(WAKE_DEMAND_BOUND_MS)
    h.sweep('106/native:main', main) // rejudged: still nothing after the bound
    expect(h.seen.map((e) => [e.category, e.reason])).toEqual([
      ['stream.offline', 'connection-error'],
    ])
  })

  it('a camera that wakes and delivers inside the bound emits no offline and no online', async () => {
    h.batteryStatus({ sleeping: false, lastContactAt: clock.now })
    const { main } = await twoProfiles(106)
    advance(500)
    h.sweep('106/native:main', main)
    lastPacket.value = clock.now
    h.sweep('106/native:main', main)
    expect(h.seen).toEqual([])
  })

  it('a stream lost while the camera is reported awake is a connection-error', async () => {
    h.batteryStatus({ sleeping: false, lastContactAt: clock.now })
    const { main } = await twoProfiles(106)
    advance(WAKE_DEMAND_BOUND_MS + 1)
    h.sweep('106/native:main', main)
    expect(h.seen.map((e) => [e.category, e.reason])).toEqual([
      ['stream.offline', 'connection-error'],
    ])
  })

  describe('after a restart the mirror is EMPTY — the registry and the slice are asked (M3/H1)', () => {
    const sleepingSlice = {
      level: 50,
      charging: 'none',
      sleeping: true,
      lastUpdated: 1_799_999_999_000,
      lastContactAt: 1_799_999_999_000,
    }

    it('a battery camera the registry names, asleep per its slice, is suppressed — not judged a mains one', async () => {
      h.manager.setApiAccess(fakeApi({ features: ['battery-operated'], slice: sleepingSlice }))
      const { main } = await twoProfiles(106)
      h.sweep('106/native:main', main) // class not known yet: the edge waits
      expect(h.seen).toEqual([])
      await flush()
      h.sweep('106/native:main', main)
      expect(h.seen).toEqual([])
      expect(h.logger.info).toHaveBeenCalledWith(
        expect.stringContaining('sleeping battery camera'),
        expect.anything(),
      )
    })

    it('a battery camera whose slice cannot be read is NOT suppressed (unknown excludes nothing)', async () => {
      h.manager.setApiAccess(fakeApi({ features: ['battery-operated'], slice: null }))
      const { main } = await twoProfiles(106)
      h.sweep('106/native:main', main)
      await flush()
      h.sweep('106/native:main', main)
      expect(h.seen.map((e) => [e.category, e.reason])).toEqual([
        ['stream.offline', 'stale-timeout'],
      ])
    })

    it('a registry that cannot answer judges the stream as it always was', async () => {
      h.manager.setApiAccess(fakeApi({ features: 'throw', slice: sleepingSlice }))
      const { main } = await twoProfiles(106)
      h.sweep('106/native:main', main)
      await flush()
      h.sweep('106/native:main', main)
      expect(h.seen.map((e) => [e.category, e.reason])).toEqual([
        ['stream.offline', 'stale-timeout'],
      ])
    })
  })

  it('a failed wake-on-play announces once, names no invented stream, and ends with the demand', async () => {
    h.manager.announceBatteryWakeFailure(106, undefined, 'wake-timeout')
    h.manager.announceBatteryWakeFailure(106, 'native:main', 'wake-timeout')
    expect(h.seen).toEqual([
      expect.objectContaining({
        category: 'stream.offline',
        reason: 'wake-timeout',
        camStreamId: undefined,
        camStreamIds: [],
      }),
    ])
    h.seen.length = 0

    // The failures stop (nobody retries): the sweep closes it with one online.
    advance(6 * 60_000)
    const healthy = await liveBroker('642/native:main')
    vi.spyOn(healthy, 'getLastPacketAt').mockImplementation(() => clock.now)
    h.sweep('642/native:main', healthy)
    expect(h.seen.map((e) => [e.category, e.reason])).toContainEqual(['stream.online', 'suspended'])
  })

  it('a failed wake-on-play ends on the next healthy flip of the device', async () => {
    h.manager.announceBatteryWakeFailure(106, undefined, 'wake-timeout')
    h.seen.length = 0
    const main = await liveBroker('106/native:main')
    lastPacket.value = clock.now
    h.sweep('106/native:main', main)
    expect(h.seen.map((e) => [e.category, e.reason])).toEqual([['stream.online', 'recovered']])
  })

  it('an announced outage whose last stream is RELEASED is closed with an online (no row stays open)', async () => {
    const { main } = await twoProfiles(641)
    h.sweep('641/native:main', main)
    expect(h.seen.map((e) => e.category)).toEqual(['stream.offline'])
    h.seen.length = 0

    await Reflect.apply(Reflect.get(h.manager, 'releaseBroker'), h.manager, [641, 'native:main'])
    await Reflect.apply(Reflect.get(h.manager, 'releaseBroker'), h.manager, [641, 'native:sub'])
    expect(h.seen.map((e) => [e.category, e.reason])).toEqual([
      ['stream.online', 'broker-destroyed'],
    ])
  })

  it('an outage stream that went idle (last consumer left) closes the outage cleanly', async () => {
    const { main, sub } = await twoProfiles(641)
    h.sweep('641/native:main', main)
    expect(h.seen.map((e) => e.category)).toEqual(['stream.offline'])
    h.seen.length = 0

    vi.spyOn(main, 'suspended', 'get').mockReturnValue(true)
    vi.spyOn(sub, 'suspended', 'get').mockReturnValue(true)
    h.sweep('641/native:main', main)
    expect(h.seen.map((e) => [e.category, e.reason])).toEqual([['stream.online', 'suspended']])
  })

  it('a mains camera keeps today: main + sub dropping together is ONE stale-timeout', async () => {
    const { main } = await twoProfiles(641)
    h.sweep('641/native:main', main)
    expect(h.seen).toEqual([
      expect.objectContaining({
        category: 'stream.offline',
        reason: 'stale-timeout',
        camStreamIds: ['native:main', 'native:sub'],
      }),
    ])
    h.seen.length = 0
    lastPacket.value = clock.now
    h.sweep('641/native:main', main)
    expect(h.seen.map((e) => [e.category, e.reason])).toEqual([['stream.online', 'recovered']])
  })
})
