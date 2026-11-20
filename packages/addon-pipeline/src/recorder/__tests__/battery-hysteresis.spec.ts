import { describe, it, expect } from 'vitest'
import {
  BATTERY_BAND_DWELL_MS,
  BATTERY_HYSTERESIS_POINTS,
  BATTERY_LEVEL_STALE_MS,
  batteryLevelFromSlice,
  resolveBatteryLevel,
  type BatteryHold,
} from '../battery-hysteresis.js'
import type { RecordingBand } from '../config-types.js'

const band = (p: Partial<RecordingBand>): RecordingBand => ({
  days: [],
  start: '00:00',
  end: '00:00',
  mode: 'continuous',
  ...p,
})
const bands: readonly RecordingBand[] = [
  band({ battery: { min: 50 }, mode: 'continuous' }),
  band({ battery: { min: 20, max: 50 }, mode: 'events' }),
]
const at = new Date(2026, 5, 15, 12, 0)
const T0 = 1_000_000

function step(
  raw: number | null,
  hold: BatteryHold | null,
  nowMs: number,
): ReturnType<typeof resolveBatteryLevel> {
  return resolveBatteryLevel({ bands, at, raw, hold, nowMs })
}

describe('resolveBatteryLevel', () => {
  it('enters the band the raw level selects, with no history', () => {
    const r = step(60, null, T0)
    expect(r.level).toBe(60)
    expect(r.hold).toEqual({ bandIndex: 0, level: 60, sinceMs: T0 })
  })

  it('stays inside the held band while the level is within the margin of its bound', () => {
    const hold: BatteryHold = { bandIndex: 0, level: 52, sinceMs: T0 }
    const r = step(50 - BATTERY_HYSTERESIS_POINTS, hold, T0 + BATTERY_BAND_DWELL_MS * 2)
    expect(r.hold?.bandIndex).toBe(0)
    expect(r.level).toBe(52)
  })

  it('stays when the margin is crossed but the dwell has not elapsed', () => {
    const hold: BatteryHold = { bandIndex: 0, level: 52, sinceMs: T0 }
    const r = step(40, hold, T0 + BATTERY_BAND_DWELL_MS - 1)
    expect(r.hold?.bandIndex).toBe(0)
    expect(r.level).toBe(52)
  })

  it('leaves once the margin is crossed AND the dwell has elapsed', () => {
    const hold: BatteryHold = { bandIndex: 0, level: 52, sinceMs: T0 }
    const r = step(40, hold, T0 + BATTERY_BAND_DWELL_MS)
    expect(r.hold).toEqual({ bandIndex: 1, level: 40, sinceMs: T0 + BATTERY_BAND_DWELL_MS })
    expect(r.level).toBe(40)
  })

  it('an unknown level keeps the last resolved band and never becomes 0', () => {
    const hold: BatteryHold = { bandIndex: 1, level: 30, sinceMs: T0 }
    const r = step(null, hold, T0 + 1)
    expect(r.level).toBe(30)
    expect(r.hold).toBe(hold)
  })

  it('an unknown level with no history stays unknown', () => {
    const r = step(null, null, T0)
    expect(r.level).toBeNull()
    expect(r.hold).toBeNull()
  })

  it('leaving the last band into "no band" is held by the same margin', () => {
    const hold: BatteryHold = { bandIndex: 1, level: 21, sinceMs: T0 }
    expect(step(19, hold, T0 + BATTERY_BAND_DWELL_MS).hold?.bandIndex).toBe(1)
    const gone = step(16, hold, T0 + BATTERY_BAND_DWELL_MS)
    expect(gone.hold?.bandIndex).toBe(-1)
    expect(gone.level).toBe(16)
  })
})

describe('batteryLevelFromSlice', () => {
  const now = 10 * BATTERY_LEVEL_STALE_MS
  const slice = (level: number | null, lastUpdated: number) => ({
    level,
    lastUpdated,
    charging: 'none',
    sleeping: false,
  })

  it('reads a fresh level', () => {
    expect(batteryLevelFromSlice(slice(42, now - 1000), now)).toBe(42)
  })
  it('a level older than 12 h is unknown', () => {
    expect(batteryLevelFromSlice(slice(42, now - BATTERY_LEVEL_STALE_MS - 1), now)).toBeNull()
  })
  it('a null level, or an unparseable slice, is unknown', () => {
    expect(batteryLevelFromSlice(slice(null, now), now)).toBeNull()
    expect(batteryLevelFromSlice('garbage', now)).toBeNull()
    expect(batteryLevelFromSlice(null, now)).toBeNull()
  })
})
