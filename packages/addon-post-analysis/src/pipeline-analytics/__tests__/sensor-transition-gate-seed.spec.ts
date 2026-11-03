/**
 * Planning#406: after a restart the gate has no prior, so the first boolean
 * `false` of a cycle begun BEFORE the restart was dropped as
 * `baseline-seeded-inactive` and "appliance finished" never fired (dryer 5356,
 * 2026-11-03). The gate seeds its last boolean from device-history, off the
 * event path (D49); null is unknown and changes nothing.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  levelSeriesKey,
  SensorTransitionGate,
  type SensorLevelSeed,
} from '../services/sensor-transition-gate.js'

const DEV = 5356
const CAP = 'running-state'
const STARTED = 1_788_000_000_000
const NOW = STARTED + 60_000

const slice = (running: boolean | null): Record<string, unknown> => ({
  running,
  since: running === null ? null : STARTED - 3_600_000,
  lastChangedAt: STARTED + 1,
})

function gate(readSeed?: () => Promise<SensorLevelSeed | null>, onFail = vi.fn()) {
  return {
    g: new SensorTransitionGate({
      startedAtMs: STARTED,
      now: () => NOW,
      readSeed,
      onSeedFailed: onFail,
      seedWaitMs: 50,
    }),
    onFail,
  }
}
const persistedTrue = (): Promise<SensorLevelSeed | null> =>
  Promise.resolve({ value: true, since: STARTED - 3_600_000 })
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('SensorTransitionGate level seed', () => {
  it('pins the series key the history capture writes', () => {
    expect(levelSeriesKey(CAP)).toBe('cap:running-state.running')
    expect(levelSeriesKey('contact')).toBeNull()
  })

  it('persisted true, restart, null, false: exactly one cleared', async () => {
    const { g } = gate(persistedTrue)
    expect((await g.observeSettled(DEV, CAP, slice(null))).changed).toBe(false)
    await flush()
    expect((await g.observeSettled(DEV, CAP, slice(false))).changed).toBe(true)
    expect((await g.observeSettled(DEV, CAP, slice(false))).changed).toBe(false)
  })

  it('persisted true, restart, false straight away: the end waits for the seed', async () => {
    const { g } = gate(persistedTrue)
    expect((await g.observeSettled(DEV, CAP, slice(false))).changed).toBe(true)
  })

  it('persisted true, restart, true: no raise', async () => {
    const { g } = gate(persistedTrue)
    await g.observeSettled(DEV, CAP, slice(null))
    await flush()
    expect((await g.observeSettled(DEV, CAP, slice(true))).changed).toBe(false)
  })

  it('same process: true, null, false is one cleared; true, null, true nothing', async () => {
    const a = gate().g
    a.observe(DEV, CAP, { ...slice(true), since: NOW })
    a.observe(DEV, CAP, slice(null))
    expect(a.observe(DEV, CAP, slice(false)).changed).toBe(true)
    const b = gate().g
    b.observe(DEV, CAP, { ...slice(true), since: NOW })
    b.observe(DEV, CAP, slice(null))
    expect(b.observe(DEV, CAP, { ...slice(true), since: NOW }).changed).toBe(false)
  })

  it('a seed never overwrites a value the live stream already gave', async () => {
    let resolve: (s: SensorLevelSeed | null) => void = () => undefined
    const { g } = gate(() => new Promise((r) => (resolve = r)))
    g.observe(DEV, CAP, slice(null))
    // Live true lands first; the late persisted false must not replace it.
    g.observe(DEV, CAP, { ...slice(true), since: NOW })
    resolve({ value: false, since: 1 })
    await flush()
    expect(g.observe(DEV, CAP, slice(false)).changed).toBe(true)
  })

  it('a failed seed read: decided as today, and warned once', async () => {
    const { g, onFail } = gate(() => Promise.reject(new Error('history down')))
    await g.observeSettled(DEV, CAP, slice(null))
    await flush()
    const v = await g.observeSettled(DEV, CAP, slice(false))
    expect(v).toEqual({ changed: false, reason: 'baseline-seeded-inactive' })
    expect(onFail).toHaveBeenCalledTimes(1)
    expect(onFail.mock.calls[0]?.[0]).toBe(DEV)
  })

  it('a seed that never answers: the first false waits only the bound, then as today', async () => {
    const { g } = gate(() => new Promise(() => undefined))
    const v = await g.observeSettled(DEV, CAP, slice(false))
    expect(v).toEqual({ changed: false, reason: 'baseline-seeded-inactive' })
  })
})
