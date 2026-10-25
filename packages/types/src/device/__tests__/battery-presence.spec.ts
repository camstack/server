import { describe, expect, it } from 'vitest'
import {
  BATTERY_UNREACHABLE_AFTER_MS,
  deriveBatteryPresence,
  isBatteryPresenceFault,
} from '../battery-presence.js'

/**
 * "Asleep" and "gone" are two different facts (D173). This is the ONE place
 * either is decided, so these are the assertions every surface inherits.
 */

const NOW = 1_800_000_000_000

describe('deriveBatteryPresence', () => {
  it('is awake whenever the slice says it is not sleeping — contact age is irrelevant then', () => {
    expect(
      deriveBatteryPresence({
        status: { sleeping: false, lastContactAt: NOW - 10 * BATTERY_UNREACHABLE_AFTER_MS },
        nowMs: NOW,
      }),
    ).toBe('awake')
  })

  it('is sleeping inside the silence budget', () => {
    expect(
      deriveBatteryPresence({
        status: { sleeping: true, lastContactAt: NOW - (BATTERY_UNREACHABLE_AFTER_MS - 1) },
        nowMs: NOW,
      }),
    ).toBe('sleeping')
  })

  it('is unreachable past the silence budget — a fault, and it says so', () => {
    const presence = deriveBatteryPresence({
      status: { sleeping: true, lastContactAt: NOW - (BATTERY_UNREACHABLE_AFTER_MS + 1) },
      nowMs: NOW,
    })
    expect(presence).toBe('unreachable')
    expect(isBatteryPresenceFault(presence)).toBe(true)
  })

  it('the boundary itself is still sleeping — the fault needs strictly more silence', () => {
    expect(
      deriveBatteryPresence({
        status: { sleeping: true, lastContactAt: NOW - BATTERY_UNREACHABLE_AFTER_MS },
        nowMs: NOW,
      }),
    ).toBe('sleeping')
  })

  it('NEVER answers unreachable for a device that has reported no contact at all', () => {
    // Freshly adopted, or a slice that predates the field. We have seen no
    // silence — only an absence of evidence, which must not light a fault.
    for (const status of [
      { sleeping: true },
      { sleeping: true, lastContactAt: 0 },
      { sleeping: true, lastContactAt: Number.NaN },
    ]) {
      expect(deriveBatteryPresence({ status, nowMs: NOW })).toBe('sleeping')
    }
  })

  it('a missing slice is sleeping, never a fault', () => {
    expect(deriveBatteryPresence({ status: undefined, nowMs: NOW })).toBe('sleeping')
    expect(deriveBatteryPresence({ status: null, nowMs: NOW })).toBe('sleeping')
  })

  it('a clock that ran backwards is not evidence of silence', () => {
    expect(
      deriveBatteryPresence({
        status: { sleeping: true, lastContactAt: NOW + 60_000 },
        nowMs: NOW,
      }),
    ).toBe('sleeping')
  })

  it('sleeping is NOT a fault — this is the whole point of the third state', () => {
    expect(isBatteryPresenceFault('sleeping')).toBe(false)
    expect(isBatteryPresenceFault('awake')).toBe(false)
  })

  it('honours an explicit budget override', () => {
    expect(
      deriveBatteryPresence({
        status: { sleeping: true, lastContactAt: NOW - 2_000 },
        nowMs: NOW,
        unreachableAfterMs: 1_000,
      }),
    ).toBe('unreachable')
  })
})
