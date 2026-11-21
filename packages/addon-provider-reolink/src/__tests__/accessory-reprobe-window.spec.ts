import { describe, expect, it } from 'vitest'
import { AccessoryShrinkGate } from '../../../system/src/kernel/moleculer/accessory-prune-gate.js'
import {
  ACCESSORY_REPROBE_RETRY_MS,
  ACCESSORY_REPROBE_WINDOW_MS,
  AccessoryReprobeWindow,
  isFirstHandWake,
} from '../accessory-reprobe-window.js'

const H = 60 * 60_000

describe('AccessoryReprobeWindow', () => {
  it('a probe that ran (lastProbedAt advanced) consumes the window', () => {
    const w = new AccessoryReprobeWindow()
    const t0 = 1_000 + ACCESSORY_REPROBE_WINDOW_MS + 1
    expect(w.tryBegin(t0, 1_000)).toBe(true)
    w.end()
    expect(w.tryBegin(t0 + 2 * H, t0)).toBe(false)
  })

  it('a skipped or failed attempt (lastProbedAt unchanged) retries, but not within the retry gap', () => {
    const w = new AccessoryReprobeWindow()
    const t0 = 1_000 + ACCESSORY_REPROBE_WINDOW_MS + 1
    expect(w.tryBegin(t0, 1_000)).toBe(true)
    w.end()
    expect(w.tryBegin(t0 + ACCESSORY_REPROBE_RETRY_MS - 1, 1_000)).toBe(false)
    expect(w.tryBegin(t0 + ACCESSORY_REPROBE_RETRY_MS, 1_000)).toBe(true)
  })

  it('only a first-hand wake counts', () => {
    expect(isFirstHandWake('simple-event')).toBe(true)
    expect(isFirstHandWake('sleep-poll')).toBe(true)
    expect(isFirstHandWake('confirmed-wake')).toBe(true)
    expect(isFirstHandWake('hub-reconcile')).toBe(false)
    expect(isFirstHandWake('hub-summary')).toBe(false)
  })

  it('does not probe on a wake inside the window', () => {
    const w = new AccessoryReprobeWindow()
    expect(w.tryBegin(1_000 + 5 * H, 1_000)).toBe(false)
  })

  it('does not overlap an in-flight probe', () => {
    const w = new AccessoryReprobeWindow()
    expect(w.tryBegin(10 * H, 0)).toBe(true)
    expect(w.tryBegin(20 * H, 0)).toBe(false)
    w.end()
    expect(w.tryBegin(20 * H, 0)).toBe(true)
  })

  it('two wakes past the window prune a vanished accessory through the shrink gate', () => {
    const w = new AccessoryReprobeWindow()
    const gate = new AccessoryShrinkGate()
    const ghost = 99
    let probedAt = 1_000 // the adoption probe listed the ghost
    let now = probedAt

    const wake = (): readonly number[] | null => {
      if (!w.tryBegin(now, probedAt)) return null
      probedAt = now // the re-probe completes: lastProbedAt advances
      w.end()
      return gate.decide([ghost], probedAt).prune // the camera no longer reports it
    }

    now += 7 * H
    expect(wake()).toEqual([]) // first complete read lacking it: recorded only
    now += 1 * H
    expect(wake()).toBeNull() // inside the window: no probe
    now += 7 * H
    expect(wake()).toEqual([ghost]) // second read on a later probe: pruned
  })
})
