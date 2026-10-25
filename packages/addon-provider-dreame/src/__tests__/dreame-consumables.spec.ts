import { type ConsumableItem, consumablesCapability, DeviceRuntimeState } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CONSUMABLES_CAP_NAME,
  type ConsumablesSlice,
  DreameConsumablesRefresher,
  nextConsumablesSlice,
  resolveResettableKey,
  seedConsumablesColdStart,
} from '../devices/dreame-consumables.js'
import { fakeLogger } from './fixtures/fake-logger.js'

const item = (key: string, level: number | null): ConsumableItem => ({
  key,
  label: key,
  level,
  status: null,
  lastResetAt: null,
  resettable: true,
})

const slice = (items: ConsumableItem[], changed: number, fetched: number): ConsumablesSlice => ({
  items,
  lastChangedAt: changed,
  lastFetchedAt: fetched,
})

describe('nextConsumablesSlice — write only what changed', () => {
  it('a push that changed no item writes nothing (no lastChangedAt churn)', () => {
    const prev = slice([item('filter', 80)], 100, 100)
    expect(nextConsumablesSlice(prev, [item('filter', 80)], 999, false)).toBeNull()
  })

  it('a refresh that LANDED on unchanged items moves only lastFetchedAt', () => {
    const prev = slice([item('filter', 80)], 100, 100)
    expect(nextConsumablesSlice(prev, [item('filter', 80)], 999, true)).toEqual(
      slice([item('filter', 80)], 100, 999),
    )
  })

  it('a changed item moves lastChangedAt; a push keeps the last fetch time', () => {
    const prev = slice([item('filter', 80)], 100, 100)
    expect(nextConsumablesSlice(prev, [item('filter', 79)], 999, false)).toEqual(
      slice([item('filter', 79)], 999, 100),
    )
    expect(nextConsumablesSlice(prev, [item('filter', 79)], 999, true)).toEqual(
      slice([item('filter', 79)], 999, 999),
    )
  })

  it('a changed label, reset flag or item set counts as a change', () => {
    const prev = slice([item('sensor', 4)], 100, 100)
    expect(
      nextConsumablesSlice(prev, [{ ...item('sensor', 4), label: 'Sensor Dirty' }], 5, false),
    ).not.toBeNull()
    expect(
      nextConsumablesSlice(prev, [{ ...item('sensor', 4), resettable: false }], 5, false),
    ).not.toBeNull()
    expect(
      nextConsumablesSlice(prev, [item('sensor', 4), item('wheel', 4)], 5, false),
    ).not.toBeNull()
  })

  it('never writes an EMPTY list — unknown is not "no consumables"', () => {
    const prev = slice([item('blade', 60)], 100, 100)
    expect(nextConsumablesSlice(prev, [], 999, true)).toBeNull()
    expect(nextConsumablesSlice(undefined, [], 999, true)).toBeNull()
  })

  it('every slice it produces satisfies the RUNTIME schema (lastFetchedAt included)', () => {
    const fresh = nextConsumablesSlice(undefined, [item('filter', 80)], 5, false)
    expect(fresh).toEqual(slice([item('filter', 80)], 5, 0))
    expect(consumablesCapability.runtimeState.safeParse(fresh).success).toBe(true)
  })
})

describe('seedConsumablesColdStart — a restored slice survives boot', () => {
  it('keeps the restored items instead of writing the empty cold start', () => {
    const restored = slice([item('blade', 61.5)], 100, 100)
    const rs = DeviceRuntimeState.fromInitial({ [CONSUMABLES_CAP_NAME]: restored }, async () => {})
    rs.installCapSchema(CONSUMABLES_CAP_NAME, consumablesCapability.runtimeState)
    seedConsumablesColdStart(rs)
    expect(rs.getCapState<ConsumablesSlice>(CONSUMABLES_CAP_NAME)?.items).toEqual([
      item('blade', 61.5),
    ])
  })

  it('seeds the cold start when nothing was restored', () => {
    const rs = DeviceRuntimeState.fromInitial({}, async () => {})
    rs.installCapSchema(CONSUMABLES_CAP_NAME, consumablesCapability.runtimeState)
    seedConsumablesColdStart(rs)
    expect(rs.getCapState<ConsumablesSlice>(CONSUMABLES_CAP_NAME)).toEqual(slice([], 0, 0))
  })
})

describe('resolveResettableKey — reset only what this device has', () => {
  const present = [
    { key: 'main-brush', resettable: true },
    { key: 'dust-bag', resettable: false },
  ] as const

  it('accepts a present, resettable key', () => {
    expect(resolveResettableKey('main-brush', present)).toBe('main-brush')
  })

  it('refuses a key this device does not report (a real key of another model)', () => {
    expect(() => resolveResettableKey('mop-pad', present)).toThrow(/does not report "mop-pad"/)
  })

  it('refuses a present key that has no reset action', () => {
    expect(() => resolveResettableKey('dust-bag', present)).toThrow(/no reset action/)
  })
})

describe('DreameConsumablesRefresher', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('re-reads on the interval and stops when told', async () => {
    const read = vi.fn(async () => {})
    const r = new DreameConsumablesRefresher({
      deviceId: 7,
      logger: fakeLogger(),
      subject: 'dreame vacuum',
      read,
      intervalMs: 60_000,
    })
    r.start()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(read).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(read).toHaveBeenCalledTimes(2)
    r.stop()
    await vi.advanceTimersByTimeAsync(180_000)
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('never overlaps: triggers during a run coalesce into ONE more run', async () => {
    let inFlight = 0
    let maxInFlight = 0
    const read = vi.fn(async () => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 1_000))
      inFlight -= 1
    })
    const r = new DreameConsumablesRefresher({
      deviceId: 7,
      logger: fakeLogger(),
      subject: 'dreame vacuum',
      read,
    })
    const first = r.trigger('activate')
    void r.trigger('docked')
    void r.trigger('docked')
    void r.trigger('interval')
    await vi.advanceTimersByTimeAsync(5_000)
    await first
    expect(maxInFlight).toBe(1)
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('a failed read is logged with the device tag and reports nothing learned', async () => {
    const logger = fakeLogger()
    const r = new DreameConsumablesRefresher({
      deviceId: 4385,
      logger,
      subject: 'dreame vacuum',
      read: async () => {
        throw new Error('cloud 500')
      },
    })
    await expect(r.trigger('interval')).resolves.toBe(false)
    expect(logger.warn).toHaveBeenCalledTimes(1)
    const [, extras] = logger.warn.mock.calls[0] ?? []
    expect(extras).toMatchObject({
      tags: { deviceId: 4385 },
      meta: { reason: 'interval', error: 'cloud 500' },
    })
  })

  it('a follow-up runs once after its delay, and a second one replaces the first', async () => {
    const read = vi.fn(async () => {})
    const r = new DreameConsumablesRefresher({
      deviceId: 7,
      logger: fakeLogger(),
      subject: 'dreame vacuum',
      read,
      followUpMs: 30_000,
    })
    r.scheduleFollowUp('reset-follow-up')
    await vi.advanceTimersByTimeAsync(20_000)
    r.scheduleFollowUp('reset-follow-up')
    await vi.advanceTimersByTimeAsync(20_000)
    expect(read).toHaveBeenCalledTimes(0)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(read).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('a trigger or a follow-up after stop does nothing', async () => {
    const read = vi.fn(async () => {})
    const r = new DreameConsumablesRefresher({
      deviceId: 7,
      logger: fakeLogger(),
      subject: 'dreame vacuum',
      read,
      followUpMs: 30_000,
    })
    r.stop()
    await expect(r.trigger('docked')).resolves.toBe(false)
    r.scheduleFollowUp('reset-follow-up')
    expect(vi.getTimerCount()).toBe(0) // not even armed
    await vi.advanceTimersByTimeAsync(120_000)
    expect(read).not.toHaveBeenCalled()
  })

  it('hands the read a live() that turns false on stop, and a read failing after stop is not logged', async () => {
    const logger = fakeLogger()
    let seenLive = (): boolean => false
    let fail: (err: Error) => void = () => {}
    const r = new DreameConsumablesRefresher({
      deviceId: 7,
      logger,
      subject: 'dreame vacuum',
      read: (_reason, live) => {
        seenLive = live
        return new Promise<void>((_resolve, reject) => {
          fail = reject
        })
      },
    })
    const run = r.trigger('activate')
    expect(seenLive()).toBe(true)
    r.stop()
    expect(seenLive()).toBe(false)
    fail(new Error('late'))
    await expect(run).resolves.toBe(false)
    expect(logger.warn).not.toHaveBeenCalled()
    expect(logger.debug).not.toHaveBeenCalled()
  })

  it('stop() cancels a pending follow-up', async () => {
    const read = vi.fn(async () => {})
    const r = new DreameConsumablesRefresher({
      deviceId: 7,
      logger: fakeLogger(),
      subject: 'dreame vacuum',
      read,
      followUpMs: 30_000,
    })
    r.scheduleFollowUp('reset-follow-up')
    r.stop()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(read).not.toHaveBeenCalled()
  })
})
