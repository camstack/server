/**
 * Rate shaping and reconcile of proactive reports (D869): a numeric sensor's
 * deadband and one-per-minute floor, an actuator's final-value debounce, the
 * 15 min reconcile that pushes only a difference, and the gateway push cap.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConcurrencyLimiter } from '../state-reports/concurrency-limiter.js'
import type { StateReport } from '../state-reports/state-change-map.js'
import { StateChangeReporter } from '../state-reports/state-change-reporter.js'
import { StateReconciler } from '../state-reports/state-reconciler.js'
import { quietLogger } from './helpers/fake-device-api.js'

const EXPORTED = { 5: ['5__dev'], 9: ['9__dev'] }

function setup() {
  const posted: StateReport[] = []
  const reporter = new StateChangeReporter({
    eventBus: { subscribe: () => () => {} } as never,
    getExportedEndpoints: () => EXPORTED,
    reportConnectivity: async () => {},
    postStateChange: async (r) => {
      posted.push(r)
    },
    postHeldMotion: async () => {},
    logger: quietLogger,
  })
  return { reporter, posted }
}

const temp = (celsius: number) => ({
  deviceId: 5,
  capName: 'temperature-sensor',
  slice: { celsius, lastChangedAt: 1 },
})
const cover = (position: number) => ({
  deviceId: 9,
  capName: 'cover',
  slice: { state: 'opening', position, tiltPosition: null, lastChangedAt: 1 },
})
const valuesOf = (posted: readonly StateReport[]) => posted.map((r) => r.properties[0]?.value)

describe('numeric sensor shaping', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-17T10:00:00Z'))
  })
  afterEach(() => vi.useRealTimers())

  it('the first reading goes out at once; a change under 0.5 C is not a change', async () => {
    const { reporter, posted } = setup()
    await reporter.onChange(temp(21.0))
    await reporter.onChange(temp(21.2))
    await vi.advanceTimersByTimeAsync(120_000)
    expect(valuesOf(posted)).toEqual([{ value: 21, scale: 'CELSIUS' }])
  })

  it('a real change inside the minute waits, and only the LAST value is sent', async () => {
    const { reporter, posted } = setup()
    await reporter.onChange(temp(21.0))
    await vi.advanceTimersByTimeAsync(5_000)
    await reporter.onChange(temp(22.0))
    await reporter.onChange(temp(23.0))
    expect(posted).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(55_000)
    expect(valuesOf(posted)).toEqual([
      { value: 21, scale: 'CELSIUS' },
      { value: 23, scale: 'CELSIUS' },
    ])
  })

  it('a change after the minute goes out immediately', async () => {
    const { reporter, posted } = setup()
    await reporter.onChange(temp(21.0))
    await vi.advanceTimersByTimeAsync(61_000)
    await reporter.onChange(temp(21.6))
    expect(posted).toHaveLength(2)
  })

  it('humidity needs a 2 point move', async () => {
    const { reporter, posted } = setup()
    const humidity = (percent: number) => ({
      deviceId: 5,
      capName: 'humidity-sensor',
      slice: { percent, lastChangedAt: 1 },
    })
    await reporter.onChange(humidity(50))
    await vi.advanceTimersByTimeAsync(61_000)
    await reporter.onChange(humidity(51))
    await reporter.onChange(humidity(52))
    expect(valuesOf(posted)).toEqual([{ value: 50 }, { value: 52 }])
  })
})

describe('actuator coalescing', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-17T10:00:00Z'))
  })
  afterEach(() => vi.useRealTimers())

  it('a blind in motion reports its FINAL position once, after a second of quiet', async () => {
    const { reporter, posted } = setup()
    for (const position of [10, 20, 35, 50, 80]) {
      await reporter.onChange(cover(position))
      await vi.advanceTimersByTimeAsync(300)
    }
    expect(posted).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(valuesOf(posted)).toEqual([80])
    expect(posted[0]?.instance).toBe('Blind.Position')
  })

  it('stop() drops a pending report', async () => {
    const { reporter, posted } = setup()
    await reporter.onChange(cover(40))
    reporter.stop()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(posted).toHaveLength(0)
  })
})

describe('state reconcile', () => {
  function reconcilerFor(
    reporter: StateChangeReporter,
    slices: Record<string, unknown>,
    failures: ReadonlySet<string> = new Set(),
  ) {
    return new StateReconciler({
      reporter,
      getExportedEndpoints: () => EXPORTED,
      readSlice: async (deviceId, capName) => {
        const key = `${deviceId}|${capName}`
        if (failures.has(key)) throw new Error('read failed')
        return slices[key] ?? null
      },
      logger: quietLogger,
    })
  }
  const lock = (state: string) => ({ state, lastChangedAt: 1 })

  it('the first pass records a baseline and pushes nothing; the next pushes only the difference', async () => {
    const { reporter, posted } = setup()
    const slices: Record<string, unknown> = {
      '5|temperature-sensor': { celsius: 20, lastChangedAt: 1 },
    }
    const reconciler = reconcilerFor(reporter, slices)
    expect((await reconciler.runOnce()).pushed).toBe(0)
    expect(posted).toHaveLength(0)

    expect((await reconciler.runOnce()).pushed).toBe(0)
    slices['5|temperature-sensor'] = { celsius: 24, lastChangedAt: 2 }
    const third = await reconciler.runOnce()
    expect(third.pushed).toBe(1)
    expect(valuesOf(posted)).toEqual([{ value: 24, scale: 'CELSIUS' }])
    // Nothing changed since: nothing is pushed again.
    expect((await reconciler.runOnce()).pushed).toBe(0)
    expect(posted).toHaveLength(1)
  })

  it('a dropped event is healed: the event never arrived, the reconcile sees the drift', async () => {
    const posted: StateReport[] = []
    const exported = { 7: ['7__dev'] }
    const r = new StateChangeReporter({
      eventBus: { subscribe: () => () => {} } as never,
      getExportedEndpoints: () => exported,
      reportConnectivity: async () => {},
      postStateChange: async (x) => {
        posted.push(x)
      },
      postHeldMotion: async () => {},
      logger: quietLogger,
    })
    await r.onChange({ deviceId: 7, capName: 'lock-control', slice: lock('locked') })
    const reconciler = new StateReconciler({
      reporter: r,
      getExportedEndpoints: () => exported,
      readSlice: async (_d, capName) => (capName === 'lock-control' ? lock('unlocked') : null),
      logger: quietLogger,
    })
    expect((await reconciler.runOnce()).pushed).toBe(1)
    expect(valuesOf(posted)).toEqual(['LOCKED', 'UNLOCKED'])
    // Healed: the same slice again is not a difference.
    expect((await reconciler.runOnce()).pushed).toBe(0)
    expect(valuesOf(posted)).toEqual(['LOCKED', 'UNLOCKED'])
  })

  it('a failed read changes nothing (D49): no push, and the last reported value is kept', async () => {
    const { reporter, posted } = setup()
    await reporter.onChange(temp(20))
    const reconciler = reconcilerFor(reporter, {}, new Set(['5|temperature-sensor']))
    const summary = await reconciler.runOnce()
    expect(summary.pushed).toBe(0)
    expect(summary.failedReads).toBeGreaterThan(0)
    // The value the failed read could not contradict still stands.
    const healthy = reconcilerFor(reporter, {
      '5|temperature-sensor': { celsius: 20, lastChangedAt: 3 },
    })
    expect((await healthy.runOnce()).pushed).toBe(0)
    expect(posted).toHaveLength(1)
  })

  it('a sub-deadband drift is not pushed', async () => {
    const { reporter, posted } = setup()
    await reporter.onChange(temp(20))
    const reconciler = reconcilerFor(reporter, {
      '5|temperature-sensor': { celsius: 20.3, lastChangedAt: 2 },
    })
    expect((await reconciler.runOnce()).pushed).toBe(0)
    expect(posted).toHaveLength(1)
  })

  it('a value still waiting in the shaper is left to its own event', async () => {
    vi.useFakeTimers()
    try {
      const { reporter, posted } = setup()
      await reporter.onChange(cover(10))
      await reporter.onChange(cover(60))
      const reconciler = reconcilerFor(reporter, {
        '9|cover': { state: 'open', position: 60, tiltPosition: null, lastChangedAt: 1 },
      })
      expect((await reconciler.runOnce()).pushed).toBe(0)
      await vi.advanceTimersByTimeAsync(1_500)
      expect(valuesOf(posted)).toEqual([60])
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('gateway push concurrency cap', () => {
  it('never runs more than the cap at once and drops nothing', async () => {
    const limiter = new ConcurrencyLimiter(2)
    let peak = 0
    let done = 0
    const task = async (): Promise<void> => {
      peak = Math.max(peak, limiter.inFlight)
      await new Promise((resolve) => setTimeout(resolve, 5))
      done += 1
    }
    await Promise.all(Array.from({ length: 9 }, () => limiter.run(task)))
    expect(peak).toBe(2)
    expect(done).toBe(9)
  })
})
