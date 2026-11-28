import { BatteryStatusSchema } from '@dominevo/types'
import { bandActiveAt } from './band-engine.js'
import type { RecordingBand } from './config-types.js'

/** How many points past a band's bound the charge must travel before the band is left. */
export const BATTERY_HYSTERESIS_POINTS = 3
/** How long a battery-conditioned band is held before it may be left at all. */
export const BATTERY_BAND_DWELL_MS = 5 * 60_000
/** A charge reading older than this is UNKNOWN, never trusted and never 0. */
export const BATTERY_LEVEL_STALE_MS = 12 * 60 * 60_000

/** A charge and the instant the owner published it (the slice's `lastUpdated`). */
export interface BatteryReading {
  readonly level: number
  readonly observedAtMs: number
}

/** `bandIndex` is -1 when no band covered the charge. */
export interface BatteryHold {
  readonly bandIndex: number
  /** The charge that selected the band — what the decision is made against. */
  readonly level: number
  /** When the owner published that charge; a hold bridges a failed read only while this is fresh. */
  readonly observedAtMs: number
  readonly sinceMs: number
}

export interface BatteryResolution {
  /** The charge to decide against; `null` = unknown, only unconditioned bands apply. */
  readonly level: number | null
  readonly hold: BatteryHold | null
  /** Set when a band flip is held back ONLY by the dwell: the instant it expires. */
  readonly dwellUntilMs?: number
}

export interface BatteryResolveInput {
  readonly bands: readonly RecordingBand[]
  readonly at: Date
  /** The freshly read charge, `null` when unknown. */
  readonly raw: BatteryReading | null
  readonly hold: BatteryHold | null
  readonly nowMs: number
}

function pastMargin(band: RecordingBand, level: number): boolean {
  const cond = band.battery
  if (cond === undefined) return true
  if (cond.min !== undefined && level < cond.min - BATTERY_HYSTERESIS_POINTS) return true
  if (cond.max !== undefined && level >= cond.max + BATTERY_HYSTERESIS_POINTS) return true
  return false
}

/**
 * The charge a decision is made against, with hysteresis. A battery-conditioned
 * band is left only when the charge crosses its bound by
 * {@link BATTERY_HYSTERESIS_POINTS} AND the band was held for
 * {@link BATTERY_BAND_DWELL_MS}; a charge that jitters around a bound therefore
 * cannot flap the camera between modes. A failed read bridges the held charge
 * only while that charge's own timestamp is within {@link BATTERY_LEVEL_STALE_MS};
 * past it the charge is UNKNOWN and conditioned bands stop matching.
 */
export function resolveBatteryLevel(input: BatteryResolveInput): BatteryResolution {
  const { bands, at, raw, hold, nowMs } = input
  if (raw === null) {
    if (hold !== null && nowMs - hold.observedAtMs <= BATTERY_LEVEL_STALE_MS) {
      return { level: hold.level, hold }
    }
    return { level: null, hold: null }
  }
  const candidate = bands.findIndex((b) => bandActiveAt(b, at, { level: raw.level }))
  if (hold !== null && hold.bandIndex === candidate) {
    return { level: raw.level, hold: { ...hold, level: raw.level, observedAtMs: raw.observedAtMs } }
  }
  const held = hold === null ? undefined : bands[hold.bandIndex]
  if (hold !== null && held !== undefined && held.battery !== undefined) {
    const stillCovers = bandActiveAt(held, at, { level: hold.level })
    const dwellDone = nowMs - hold.sinceMs >= BATTERY_BAND_DWELL_MS
    const mayLeave = dwellDone && pastMargin(held, raw.level)
    if (stillCovers && !mayLeave) {
      const kept = { ...hold, observedAtMs: raw.observedAtMs }
      const dwellOnly = !dwellDone && pastMargin(held, raw.level)
      return dwellOnly
        ? { level: hold.level, hold: kept, dwellUntilMs: hold.sinceMs + BATTERY_BAND_DWELL_MS }
        : { level: hold.level, hold: kept }
    }
  }
  return {
    level: raw.level,
    hold: {
      bandIndex: candidate,
      level: raw.level,
      observedAtMs: raw.observedAtMs,
      sinceMs: nowMs,
    },
  }
}

/**
 * The usable charge in a `battery` slice, or `null` (unknown): not parseable,
 * not yet reported, or older than {@link BATTERY_LEVEL_STALE_MS}.
 */
export function batteryLevelFromSlice(slice: unknown, nowMs: number): BatteryReading | null {
  const parsed = BatteryStatusSchema.safeParse(slice)
  if (!parsed.success) return null
  const { level, lastUpdated } = parsed.data
  if (level === null) return null
  if (nowMs - lastUpdated > BATTERY_LEVEL_STALE_MS) return null
  return { level, observedAtMs: lastUpdated }
}
