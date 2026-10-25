import {
  type MowerConsumableKey,
  type MowerConsumableReading,
  MowerChargingStatus,
  MowerStatus,
} from '@apocaliss92/nodedreame'
import { consumablesCapability, DeviceRuntimeState } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CONSUMABLES_CAP_NAME, type ConsumablesSlice } from '../devices/dreame-consumables.js'
import {
  DreameMowerConsumables,
  MowerChargingEdge,
  type MowerConsumablesHandle,
} from '../devices/dreame-mower-consumables.js'
import { allLogCalls, fakeLogger } from './fixtures/fake-logger.js'

const READINGS: readonly MowerConsumableReading[] = [
  { key: 'blade', usedMinutes: 1842, totalMinutes: 6000, remainingPercent: 69.3 },
  { key: 'brush', usedMinutes: 10950, totalMinutes: 30000, remainingPercent: 63.5 },
  { key: 'maintenance', usedMinutes: 1840, totalMinutes: 3600, remainingPercent: 48.9 },
]

class FakeMower implements MowerConsumablesHandle {
  /** `'asleep'` throws like the cloud's 80001; `null` is "no reading". */
  answer: readonly MowerConsumableReading[] | null | 'asleep' = READINGS
  readonly getConsumables = vi.fn(async () => {
    if (this.answer === 'asleep') throw new Error('80001 device offline')
    return this.answer
  })
  readonly resetConsumable = vi.fn(async (_key: MowerConsumableKey): Promise<void> => {})
}

const RESTORED: ConsumablesSlice = {
  items: [
    {
      key: 'blade',
      label: 'Blade',
      level: 55,
      status: null,
      lastResetAt: null,
      resettable: true,
    },
  ],
  lastChangedAt: 10,
  lastFetchedAt: 10,
}

function setup(initial: Record<string, unknown> = {}) {
  const mower = new FakeMower()
  const logger = fakeLogger()
  const store = DeviceRuntimeState.fromInitial(initial, async () => {})
  store.installCapSchema(CONSUMABLES_CAP_NAME, consumablesCapability.runtimeState)
  const writes = vi.spyOn(store, 'setCapState')
  let clock = 1_000
  const consumables = new DreameMowerConsumables({
    now: () => clock,
    deviceId: 503,
    logger,
    store,
    resolveMower: () => mower,
    retries: 1,
    retryDelayMs: 10,
  })
  const slice = () => store.getCapState<ConsumablesSlice>(CONSUMABLES_CAP_NAME)
  return {
    mower,
    logger,
    store,
    writes,
    consumables,
    slice,
    tick: (ms: number) => {
      clock += ms
    },
  }
}

describe('DreameMowerConsumables', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('an asleep mower at boot leaves the RESTORED reading in place', async () => {
    const { mower, consumables, slice, logger } = setup({ [CONSUMABLES_CAP_NAME]: RESTORED })
    mower.answer = 'asleep'
    consumables.seed()
    const run = consumables.refresh('activate')
    await vi.advanceTimersByTimeAsync(100)
    await expect(run).resolves.toBe(false)
    expect(slice()).toEqual(RESTORED)
    expect(logger.warn).toHaveBeenCalled()
  })

  it('an empty or missing CMS answer is "nothing learned", never an empty list', async () => {
    const { mower, consumables, slice } = setup({ [CONSUMABLES_CAP_NAME]: RESTORED })
    mower.answer = []
    const a = consumables.refresh('charging')
    await vi.advanceTimersByTimeAsync(100)
    await expect(a).resolves.toBe(false)
    mower.answer = null
    const b = consumables.refresh('charging')
    await vi.advanceTimersByTimeAsync(100)
    await expect(b).resolves.toBe(false)
    expect(slice()).toEqual(RESTORED)
  })

  it('a real read replaces the restored value; a repeat read that changed nothing does not churn', async () => {
    const { consumables, slice, tick } = setup({ [CONSUMABLES_CAP_NAME]: RESTORED })
    await consumables.refresh('charging')
    const first = slice()
    expect(first?.items.map((i) => i.level)).toEqual([69.3, 63.5, 48.9])
    expect(first?.lastChangedAt).toBe(1_000)
    tick(60_000)
    await consumables.refresh('charging')
    expect(slice()?.lastChangedAt).toBe(1_000)
    expect(slice()?.lastFetchedAt).toBe(61_000)
  })

  it('stop ends the wake-window retries: no more CMS calls, and a late answer writes nothing', async () => {
    const { mower, consumables, writes } = setup()
    let land: (r: readonly MowerConsumableReading[]) => void = () => {}
    mower.getConsumables.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          land = resolve
        }),
    )
    const run = consumables.refresh('charging')
    await vi.advanceTimersByTimeAsync(0)
    consumables.stop()
    land(READINGS)
    await vi.advanceTimersByTimeAsync(1_000)
    await expect(run).resolves.toBe(false)
    expect(writes).not.toHaveBeenCalled()
    expect(mower.getConsumables).toHaveBeenCalledTimes(1)
  })

  it('stop between retries: the loop sleeps no more and asks no more', async () => {
    const { mower, consumables } = setup()
    mower.answer = 'asleep'
    const run = consumables.refresh('charging')
    await vi.advanceTimersByTimeAsync(0)
    expect(mower.getConsumables).toHaveBeenCalledTimes(1)
    consumables.stop()
    await vi.advanceTimersByTimeAsync(1_000)
    await run
    expect(mower.getConsumables).toHaveBeenCalledTimes(1)
  })

  it('reset refuses a key the mower does not have', async () => {
    const { mower, consumables } = setup()
    await expect(consumables.reset('filter')).rejects.toThrow(/does not report "filter"/)
    expect(mower.resetConsumable).not.toHaveBeenCalled()
  })

  it('reset re-reads; a failed re-read is a WARN with the device tag, not silence', async () => {
    const { mower, consumables, logger } = setup()
    mower.answer = null
    const run = consumables.reset('blade')
    await vi.advanceTimersByTimeAsync(100)
    await run
    expect(mower.resetConsumable).toHaveBeenCalledWith('blade')
    expect(logger.warn).toHaveBeenCalled()
    for (const [, extras] of allLogCalls(logger)) expect(extras?.tags?.deviceId).toBe(503)
  })
})

describe('MowerChargingEdge', () => {
  it('the first observation after boot is not an edge — activation already reads', () => {
    const edge = new MowerChargingEdge()
    expect(edge.observe(MowerStatus.Charging, MowerChargingStatus.Charging)).toBe(false)
  })

  it('an edge INTO charging (either field) counts once', () => {
    const edge = new MowerChargingEdge()
    edge.observe(MowerStatus.Mowing, MowerChargingStatus.NotCharging)
    expect(edge.observe(MowerStatus.Charging, MowerChargingStatus.NotCharging)).toBe(true)
    expect(edge.observe(MowerStatus.Charging, MowerChargingStatus.Charging)).toBe(true)
    expect(edge.observe(MowerStatus.Charging, MowerChargingStatus.Charging)).toBe(false)
  })
})
