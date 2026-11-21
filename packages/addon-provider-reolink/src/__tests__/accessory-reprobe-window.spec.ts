import { describe, expect, it } from 'vitest'
import { AccessoryShrinkGate } from '../../../system/src/kernel/moleculer/accessory-prune-gate.js'
import { ACCESSORY_REPROBE_WINDOW_MS, AccessoryReprobeWindow } from '../accessory-reprobe-window.js'

const H = 60 * 60_000

describe('AccessoryReprobeWindow', () => {
  it('probes on a wake after the window, and only once per window', () => {
    const w = new AccessoryReprobeWindow()
    const probedAt = 1_000
    expect(w.tryBegin(probedAt + ACCESSORY_REPROBE_WINDOW_MS + 1, probedAt)).toBe(true)
    w.end()
    // the probe did not advance lastProbedAt: the attempt itself still counts
    expect(w.tryBegin(probedAt + ACCESSORY_REPROBE_WINDOW_MS + 2 * H, probedAt)).toBe(false)
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
