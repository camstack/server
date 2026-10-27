import type {
  ConsumableReading,
  ConsumableRefreshSource,
  ConsumableResetResult,
  DreameConsumableKey,
  MiotProp,
  PropertyResult,
} from '@apocaliss92/nodedreame'
import { consumablesCapability, DeviceRuntimeState } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CONSUMABLES_CAP_NAME, type ConsumablesSlice } from '../devices/dreame-consumables.js'
import {
  CONSUMABLES_REFRESH_MS,
  DreameVacuumConsumables,
  RESET_FOLLOW_UP_MS,
  TANK_REREAD_MS,
  TANK_TRANSITION_MIN_GAP_MS,
  type VacuumConsumablesHandle,
} from '../devices/dreame-vacuum-consumables.js'
import { VACUUM_TANK_PROPS } from '../dreame-vacuum-decode.js'
import { allLogCalls, fakeLogger } from './fixtures/fake-logger.js'

/** A vacuum whose consumable table a reset rewrites the way the robot does. */
class FakeVacuum implements VacuumConsumablesHandle {
  readings: ConsumableReading[] = [
    { key: 'main-brush', label: 'Main Brush', leftPct: 90, resettable: true },
    { key: 'sensor', label: 'Sensor Dirty', leftPct: 4, resettable: true },
    { key: 'dust-bag', label: 'Dust Bag', leftPct: 50, resettable: false },
  ]
  /** What the post-reset re-read answered from. */
  resetSource: ConsumableRefreshSource | null = 'device'
  refreshFails = false
  readonly refreshConsumables = vi.fn(async (): Promise<void> => {
    if (this.refreshFails) throw new Error('shadow unavailable')
  })
  tankLiveFails = false
  readonly refreshProperties = vi.fn(async (_props: MiotProp[]): Promise<PropertyResult[]> => {
    if (this.tankLiveFails) throw new Error('robot asleep')
    return []
  })
  readonly refreshCachedProperties = vi.fn(
    async (_props: MiotProp[]): Promise<PropertyResult[]> => [],
  )
  readonly resetConsumable = vi.fn(async (key: DreameConsumableKey) => {
    // A live re-read sees the reset; a stale shadow still holds the old value.
    if (this.resetSource === 'device') {
      this.readings = this.readings.map((r) => (r.key === key ? { ...r, leftPct: 100 } : r))
    }
    const hit = this.readings.find((r) => r.key === key)
    const result: ConsumableResetResult = {
      key,
      actionResult: null,
      refreshedFrom: this.resetSource,
      leftPct: this.resetSource === null ? null : (hit?.leftPct ?? null),
      timeLeft: null,
      refreshError: this.resetSource === 'device' ? null : new Error('robot asleep'),
    }
    return result
  })
  get supportedConsumables(): readonly ConsumableReading[] {
    return this.readings
  }
}

function setup() {
  const vacuum = new FakeVacuum()
  const logger = fakeLogger()
  const store = DeviceRuntimeState.fromInitial({}, async () => {})
  store.installCapSchema(CONSUMABLES_CAP_NAME, consumablesCapability.runtimeState)
  const writes = vi.spyOn(store, 'setCapState')
  let clock = 1_000
  const consumables = new DreameVacuumConsumables({
    deviceId: 4385,
    logger,
    store,
    resolveVacuum: () => vacuum,
    now: () => clock,
  })
  const levels = (): Record<string, number | null> =>
    Object.fromEntries(
      (store.getCapState<ConsumablesSlice>(CONSUMABLES_CAP_NAME)?.items ?? []).map((i) => [
        i.key,
        i.level,
      ]),
    )
  return {
    vacuum,
    logger,
    store,
    writes,
    consumables,
    levels,
    tick: (ms: number) => {
      clock += ms
    },
  }
}

describe('DreameVacuumConsumables', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('reads on start and again every hour — not once per boot', async () => {
    const { vacuum, consumables, levels } = setup()
    consumables.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(vacuum.refreshConsumables).toHaveBeenCalledTimes(1)
    expect(levels()).toEqual({ 'main-brush': 90, sensor: 4, 'dust-bag': 50 })

    vacuum.readings = vacuum.readings.map((r) => (r.key === 'sensor' ? { ...r, leftPct: 3 } : r))
    await vi.advanceTimersByTimeAsync(CONSUMABLES_REFRESH_MS)
    expect(vacuum.refreshConsumables).toHaveBeenCalledTimes(2)
    expect(levels().sensor).toBe(3)
    consumables.stop()
  })

  it('the refresh also re-reads the tank-status props (dirty water 27/2, dust bag 27/3)', async () => {
    const { vacuum, consumables } = setup()
    consumables.start()
    await vi.advanceTimersByTimeAsync(0)
    const props = vacuum.refreshCachedProperties.mock.calls[0]?.[0] ?? []
    expect(props).toEqual(
      expect.arrayContaining([
        { siid: 27, piid: 2 },
        { siid: 27, piid: 3 },
      ]),
    )
    consumables.stop()
  })

  it('a push that changed nothing writes nothing', async () => {
    const { consumables, writes } = setup()
    consumables.start()
    await vi.advanceTimersByTimeAsync(0)
    const before = writes.mock.calls.length
    consumables.onPush('cleaning', [])
    consumables.onPush('cleaning', [])
    expect(writes.mock.calls.length).toBe(before)
    consumables.stop()
  })

  it('refreshes on the edge INTO docked, once, and not on the first observation', async () => {
    const { vacuum, consumables } = setup()
    consumables.onPush('docked', []) // first sight after boot: activation already reads
    await vi.advanceTimersByTimeAsync(0)
    expect(vacuum.refreshConsumables).toHaveBeenCalledTimes(0)
    consumables.onPush('cleaning', [])
    consumables.onPush('returning', [])
    consumables.onPush('docked', [])
    await vi.advanceTimersByTimeAsync(0)
    expect(vacuum.refreshConsumables).toHaveBeenCalledTimes(1)
    consumables.onPush('docked', [])
    await vi.advanceTimersByTimeAsync(0)
    expect(vacuum.refreshConsumables).toHaveBeenCalledTimes(1)
  })

  it('a drying → docked hop on the dock is not an edge; cleaning, returning or paused → docked is', async () => {
    const { vacuum, consumables } = setup()
    consumables.onPush('docked', [])
    consumables.onPush('drying', [])
    consumables.onPush('docked', [])
    await vi.advanceTimersByTimeAsync(0)
    expect(vacuum.refreshConsumables).toHaveBeenCalledTimes(0)
    consumables.onPush('paused', [])
    consumables.onPush('docked', [])
    await vi.advanceTimersByTimeAsync(0)
    expect(vacuum.refreshConsumables).toHaveBeenCalledTimes(1)
  })

  it('a read resolving after stop writes nothing and reads no tanks', async () => {
    const { vacuum, consumables, writes, logger } = setup()
    let land: () => void = () => {}
    vacuum.refreshConsumables.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          land = resolve
        }),
    )
    consumables.start()
    await vi.advanceTimersByTimeAsync(0)
    consumables.stop()
    land()
    await vi.advanceTimersByTimeAsync(0)
    expect(writes).not.toHaveBeenCalled()
    expect(vacuum.refreshCachedProperties).not.toHaveBeenCalled()
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('a push replayed after stop writes nothing', async () => {
    const { consumables, writes } = setup()
    consumables.stop()
    consumables.onPush('cleaning', [])
    expect(writes).not.toHaveBeenCalled()
  })

  it('a reset resolving after stop writes nothing and arms no follow-up', async () => {
    const { vacuum, consumables, writes } = setup()
    vacuum.resetSource = 'cloud-shadow'
    let land: () => void = () => {}
    const real = vacuum.resetConsumable.getMockImplementation()
    vacuum.resetConsumable.mockImplementationOnce(async (key) => {
      await new Promise<void>((resolve) => {
        land = resolve
      })
      if (real === undefined) throw new Error('no impl')
      return real(key)
    })
    const run = consumables.reset('sensor')
    await vi.advanceTimersByTimeAsync(0)
    consumables.stop()
    land()
    await run
    expect(writes).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a failed refresh keeps the last good values and says so with the device tag', async () => {
    const { vacuum, consumables, levels, logger } = setup()
    consumables.start()
    await vi.advanceTimersByTimeAsync(0)
    vacuum.refreshFails = true
    vacuum.readings = [] // what a half-seeded cache could look like
    await vi.advanceTimersByTimeAsync(CONSUMABLES_REFRESH_MS)
    expect(levels()).toEqual({ 'main-brush': 90, sensor: 4, 'dust-bag': 50 })
    expect(logger.warn).toHaveBeenCalled()
    consumables.stop()
  })

  it('a shadow read that answered with NO consumable is a failure, not a landing', async () => {
    const { vacuum, consumables, levels, logger } = setup()
    consumables.start()
    await vi.advanceTimersByTimeAsync(0)
    vacuum.readings = []
    await vi.advanceTimersByTimeAsync(CONSUMABLES_REFRESH_MS)
    expect(levels()).toEqual({ 'main-brush': 90, sensor: 4, 'dust-bag': 50 })
    expect(logger.warn).toHaveBeenCalledTimes(1)
    consumables.stop()
  })

  it('reset refuses a key this robot does not report, before touching the robot', async () => {
    const { vacuum, consumables } = setup()
    await expect(consumables.reset('mop-pad')).rejects.toThrow(/does not report "mop-pad"/)
    await expect(consumables.reset('dust-bag')).rejects.toThrow(/no reset action/)
    await expect(consumables.reset('bogus')).rejects.toThrow(/does not report "bogus"/)
    expect(vacuum.resetConsumable).not.toHaveBeenCalled()
  })

  it('a reset re-read live shows 100 % at once and needs no follow-up', async () => {
    const { vacuum, consumables, levels } = setup()
    await consumables.reset('sensor')
    expect(levels().sensor).toBe(100)
    await vi.advanceTimersByTimeAsync(RESET_FOLLOW_UP_MS * 2)
    expect(vacuum.refreshConsumables).not.toHaveBeenCalled()
  })

  it('a reset re-read from the (maybe stale) shadow schedules ONE follow-up refresh', async () => {
    const { vacuum, consumables, levels } = setup()
    vacuum.resetSource = 'cloud-shadow'
    await consumables.reset('sensor')
    expect(levels().sensor).toBe(4) // what the shadow said — honest, not invented
    // The robot reports; the follow-up picks it up.
    vacuum.readings = vacuum.readings.map((r) => (r.key === 'sensor' ? { ...r, leftPct: 100 } : r))
    await vi.advanceTimersByTimeAsync(RESET_FOLLOW_UP_MS)
    expect(vacuum.refreshConsumables).toHaveBeenCalledTimes(1)
    expect(levels().sensor).toBe(100)
    await vi.advanceTimersByTimeAsync(RESET_FOLLOW_UP_MS * 3)
    expect(vacuum.refreshConsumables).toHaveBeenCalledTimes(1)
  })

  it('a reset whose re-read failed warns and still follows up', async () => {
    const { vacuum, consumables, logger } = setup()
    vacuum.resetSource = null
    await consumables.reset('sensor')
    expect(logger.warn).toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(RESET_FOLLOW_UP_MS)
    expect(vacuum.refreshConsumables).toHaveBeenCalledTimes(1)
  })

  it('every log line carries tags.deviceId', async () => {
    const { vacuum, consumables, logger } = setup()
    consumables.start()
    await vi.advanceTimersByTimeAsync(0)
    vacuum.resetSource = null
    await consumables.reset('sensor')
    vacuum.refreshFails = true
    await vi.advanceTimersByTimeAsync(RESET_FOLLOW_UP_MS)
    const calls = allLogCalls(logger)
    expect(calls.length).toBeGreaterThan(0)
    for (const [, extras] of calls) expect(extras?.tags?.deviceId).toBe(4385)
    consumables.stop()
  })

  describe('the tanks ride the same slice (D915)', () => {
    const TANK = {
      key: 'dustBin',
      label: 'Dust bin',
      level: null,
      status: 'full',
      kind: 'waste',
      lastResetAt: null,
      resettable: false,
    } as const

    const keys = (store: ReturnType<typeof setup>['store']): string[] =>
      (store.getCapState<ConsumablesSlice>(CONSUMABLES_CAP_NAME)?.items ?? []).map((i) => i.key)

    it('appends the pushed tanks after the wear items', async () => {
      const { consumables, store } = setup()
      consumables.start()
      await vi.advanceTimersByTimeAsync(0)
      consumables.onPush('docked', [TANK])
      expect(keys(store)).toEqual(['main-brush', 'sensor', 'dust-bag', 'dustBin'])
      consumables.stop()
    })

    it('a tank change alone is written', async () => {
      const { consumables, store } = setup()
      consumables.start()
      await vi.advanceTimersByTimeAsync(0)
      consumables.onPush('docked', [TANK])
      consumables.onPush('docked', [{ ...TANK, status: 'ok' }])
      const items = store.getCapState<ConsumablesSlice>(CONSUMABLES_CAP_NAME)?.items ?? []
      expect(items.find((i) => i.key === 'dustBin')?.status).toBe('ok')
      consumables.stop()
    })

    it('tanks pushed before the shadow answered keep the RESTORED wear items', () => {
      const { vacuum, consumables, store } = setup()
      store.setCapState(CONSUMABLES_CAP_NAME, {
        items: [
          {
            key: 'main-brush',
            label: 'Main Brush',
            level: 70,
            status: null,
            lastResetAt: null,
            resettable: true,
          },
        ],
        lastChangedAt: 1,
        lastFetchedAt: 1,
      })
      vacuum.readings = []
      consumables.start()
      consumables.onPush('docked', [TANK])
      expect(keys(store)).toEqual(['main-brush', 'dustBin'])
      consumables.stop()
    })

    it('a refresh that lands before the first push keeps the RESTORED tanks', async () => {
      const { consumables, store } = setup()
      store.setCapState(CONSUMABLES_CAP_NAME, {
        items: [TANK],
        lastChangedAt: 1,
        lastFetchedAt: 1,
      })
      consumables.start()
      await vi.advanceTimersByTimeAsync(0)
      expect(keys(store)).toEqual(['main-brush', 'sensor', 'dust-bag', 'dustBin'])
      consumables.stop()
    })
  })

  describe('tank-status re-read', () => {
    it('re-reads only the tank props, live, every few minutes — not a full poll', async () => {
      const { vacuum, consumables } = setup()
      consumables.start()
      await vi.advanceTimersByTimeAsync(0)
      expect(vacuum.refreshProperties).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(TANK_REREAD_MS)
      expect(vacuum.refreshProperties).toHaveBeenCalledTimes(1)
      const props = vacuum.refreshProperties.mock.calls[0]?.[0] ?? []
      expect(props).toHaveLength(Object.keys(VACUUM_TANK_PROPS).length)
      expect(props).toContainEqual({ siid: 27, piid: 1 })
      // the consumables shadow read is still the hourly one
      expect(vacuum.refreshConsumables).toHaveBeenCalledTimes(1)
      consumables.stop()
    })

    it('falls back to the cloud shadow when the robot does not answer, and says so', async () => {
      const { vacuum, logger, consumables } = setup()
      vacuum.tankLiveFails = true
      consumables.start()
      await vi.advanceTimersByTimeAsync(TANK_REREAD_MS)
      expect(vacuum.refreshCachedProperties).toHaveBeenCalledTimes(2) // activate + tank fallback
      expect(JSON.stringify(allLogCalls(logger))).toContain('tank-status live read failed')
      consumables.stop()
    })

    it('re-reads at once on a state transition, but not on the first push or inside the gap', async () => {
      const { vacuum, consumables } = setup()
      consumables.start()
      await vi.advanceTimersByTimeAsync(0)
      consumables.onPush('cleaning', [])
      await vi.advanceTimersByTimeAsync(0)
      expect(vacuum.refreshProperties).not.toHaveBeenCalled()

      consumables.onPush('docked', [])
      await vi.advanceTimersByTimeAsync(0)
      expect(vacuum.refreshProperties).toHaveBeenCalledTimes(1)

      consumables.onPush('drying', [])
      await vi.advanceTimersByTimeAsync(0)
      expect(vacuum.refreshProperties).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(TANK_TRANSITION_MIN_GAP_MS)
      consumables.onPush('docked', [])
      await vi.advanceTimersByTimeAsync(0)
      expect(vacuum.refreshProperties).toHaveBeenCalledTimes(2)
      consumables.stop()
    })

    it('stops re-reading when the device is gone', async () => {
      const { vacuum, consumables } = setup()
      consumables.start()
      consumables.stop()
      await vi.advanceTimersByTimeAsync(TANK_REREAD_MS * 3)
      expect(vacuum.refreshProperties).not.toHaveBeenCalled()
    })
  })
})
