import { describe, expect, it } from 'vitest'
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

  it('every admitted re-probe lands on a strictly later lastProbedAt, which the kernel shrink gate (D49) needs to confirm a prune', () => {
    const w = new AccessoryReprobeWindow()
    let probedAt = 1_000 // the adoption probe
    let now = probedAt
    const admitted: number[] = [probedAt]

    const wake = (): boolean => {
      if (!w.tryBegin(now, probedAt)) return false
      probedAt = now // the re-probe completes: lastProbedAt advances
      w.end()
      admitted.push(probedAt)
      return true
    }

    now += 7 * H
    expect(wake()).toBe(true)
    now += 1 * H
    expect(wake()).toBe(false) // inside the window: no probe
    now += 7 * H
    expect(wake()).toBe(true)
    expect(admitted.every((t, i) => i === 0 || t > admitted[i - 1]!)).toBe(true)
    expect(admitted).toHaveLength(3)
  })
})
