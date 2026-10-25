/**
 * `motion.lastDetectedAt` is the LAST RISE, and `null` means "never detected"
 * (`motion.cap.ts`). The HA binary sensor used to write `null` on every `off`,
 * so `motion.getStatus` on a PIR that fired a minute earlier read exactly like
 * a dead one — and it misled a diagnosis (porch PIR, 2026-09-29).
 */
import { describe, expect, it } from 'vitest'
import { makeMotionSensor } from './ha-binary-sensor-harness.js'

const T1 = Date.parse('2026-09-29T17:00:00.000Z')
const T2 = T1 + 45_000
const T3 = T1 + 600_000

describe('HaBinarySensorDevice motion — lastDetectedAt survives the fall', () => {
  it('keeps the rise across off, and moves it on the next rise', async () => {
    const h = makeMotionSensor()

    h.push('on', T1)
    expect(await h.getStatus()).toEqual({
      detected: true,
      lastDetectedAt: T1,
      autoClearAfterMs: null,
    })

    h.push('off', T2)
    expect(await h.getStatus()).toEqual({
      detected: false,
      lastDetectedAt: T1,
      autoClearAfterMs: null,
    })

    h.push('on', T3)
    expect(await h.getStatus()).toEqual({
      detected: true,
      lastDetectedAt: T3,
      autoClearAfterMs: null,
    })
  })

  it('stays null until the first rise — an off never supplies the time', async () => {
    const h = makeMotionSensor()
    expect(h.slice()).toEqual({ detected: false, lastDetectedAt: null, autoClearAfterMs: null })

    // HA's `last_changed` of an `off` is the FALL, not a rise.
    h.push('off', T2)
    expect(await h.getStatus()).toEqual({
      detected: false,
      lastDetectedAt: null,
      autoClearAfterMs: null,
    })
  })

  it('ignores unavailable / unknown without touching the kept rise', async () => {
    const h = makeMotionSensor()
    h.push('on', T1)
    h.push('off', T2)
    h.push('unavailable', T3)
    h.push('unknown', T3)
    expect(h.slice()).toEqual({ detected: false, lastDetectedAt: T1, autoClearAfterMs: null })
  })

  describe('restart', () => {
    const stored = { motion: { detected: false, lastDetectedAt: T1, autoClearAfterMs: null } }

    it('keeps the stored rise through the constructor seed', () => {
      const h = makeMotionSensor(stored)
      expect(h.slice()).toEqual({ detected: false, lastDetectedAt: T1, autoClearAfterMs: null })
    })

    it('a first push of off keeps the stored rise', () => {
      const h = makeMotionSensor(stored)
      h.push('off', T2)
      expect(h.slice()).toEqual({ detected: false, lastDetectedAt: T1, autoClearAfterMs: null })
    })

    it('a first push of on takes the rise from last_changed', () => {
      const h = makeMotionSensor(stored)
      h.push('on', T3)
      expect(h.slice()).toEqual({ detected: true, lastDetectedAt: T3, autoClearAfterMs: null })
    })

    it('keeps a stored active level through the constructor seed (no false fall)', () => {
      // Inventing `off` over a stored `on` re-armed composer `rose` on every
      // HA provider restart (synthetic doorbell). Keep the level; HA's first
      // push still corrects it if the entity closed while we were down.
      const h = makeMotionSensor({
        motion: { detected: true, lastDetectedAt: T1, autoClearAfterMs: null },
      })
      expect(h.slice()).toEqual({ detected: true, lastDetectedAt: T1, autoClearAfterMs: null })
    })

    it('no stored slice ⇒ null, never an invented time', () => {
      const h = makeMotionSensor({})
      expect(h.slice()).toEqual({ detected: false, lastDetectedAt: null, autoClearAfterMs: null })
    })
  })
})
