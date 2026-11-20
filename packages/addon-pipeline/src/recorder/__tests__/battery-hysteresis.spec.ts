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

/** A fresh reading, published at `nowMs`. */
function step(
  level: number | null,
  hold: BatteryHold | null,
  nowMs: number,
): ReturnType<typeof resolveBatteryLevel> {
  const raw = level === null ? null : { level, observedAtMs: nowMs }
  return resolveBatteryLevel({ bands, at, raw, hold, nowMs })
}

describe('resolveBatteryLevel', () => {
  it('enters the band the raw level selects, with no history', () => {
    const r = step(60, null, T0)
    expect(r.level).toBe(60)
    expect(r.hold).toEqual({ bandIndex: 0, level: 60, observedAtMs: T0, sinceMs: T0 })
  })

  it('stays inside the held band while the level is within the margin of its bound', () => {
    const hold: BatteryHold = { bandIndex: 0, level: 52, observedAtMs: T0, sinceMs: T0 }
    const r = step(50 - BATTERY_HYSTERESIS_POINTS, hold, T0 + BATTERY_BAND_DWELL_MS * 2)
    expect(r.hold?.bandIndex).toBe(0)
    expect(r.level).toBe(52)
    expect(r.dwellUntilMs).toBeUndefined()
  })

  it('stays when the margin is crossed but the dwell has not elapsed, and names the expiry', () => {
    const hold: BatteryHold = { bandIndex: 0, level: 52, observedAtMs: T0, sinceMs: T0 }
    const r = step(40, hold, T0 + BATTERY_BAND_DWELL_MS - 1)
    expect(r.hold?.bandIndex).toBe(0)
    expect(r.level).toBe(52)
    expect(r.dwellUntilMs).toBe(T0 + BATTERY_BAND_DWELL_MS)
  })

  it('leaves once the margin is crossed AND the dwell has elapsed', () => {
    const hold: BatteryHold = { bandIndex: 0, level: 52, observedAtMs: T0, sinceMs: T0 }
    const nowMs = T0 + BATTERY_BAND_DWELL_MS
    const r = step(40, hold, nowMs)
    expect(r.hold).toEqual({ bandIndex: 1, level: 40, observedAtMs: nowMs, sinceMs: nowMs })
    expect(r.level).toBe(40)
  })

  it('a transient failed read within the staleness bound keeps the held band', () => {
    const hold: BatteryHold = { bandIndex: 1, level: 30, observedAtMs: T0, sinceMs: T0 }
    const r = step(null, hold, T0 + BATTERY_LEVEL_STALE_MS)
    expect(r.level).toBe(30)
    expect(r.hold).toBe(hold)
  })

  it('a held level past its own staleness bound is UNKNOWN: it never bridges forever, never 0', () => {
    const hold: BatteryHold = { bandIndex: 0, level: 60, observedAtMs: T0, sinceMs: T0 }
    const r = step(null, hold, T0 + BATTERY_LEVEL_STALE_MS + 1)
    expect(r.level).toBeNull()
    expect(r.hold).toBeNull()
  })

  it('an unknown level with no history stays unknown', () => {
    const r = step(null, null, T0)
    expect(r.level).toBeNull()
    expect(r.hold).toBeNull()
  })

  it('leaving the last band into "no band" is held by the same margin', () => {
    const hold: BatteryHold = { bandIndex: 1, level: 21, observedAtMs: T0, sinceMs: T0 }
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

  it('reads a fresh level with the instant it was published', () => {
    expect(batteryLevelFromSlice(slice(42, now - 1000), now)).toEqual({
      level: 42,
      observedAtMs: now - 1000,
    })
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
