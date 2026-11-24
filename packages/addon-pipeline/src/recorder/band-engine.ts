import { hostTimeZone, isWithinClockRange, zoneOnlySite } from '@camstack/types'
import type { RecordingBand } from './config-types.js'

const MINUTES_PER_DAY = 1440
const LAST_MINUTE_OF_DAY = MINUTES_PER_DAY - 1

function toMin(hhmm: string): number {
  const [h, m] = hhmm.split(':')
  return Number(h) * 60 + Number(m)
}

/**
 * A band's END as an exclusive minute. `23:59` is how the admin UI authors "to
 * the end of the day" (`00:00–23:59`), so it means 1440: with a literal 1439 the
 * last minute of every day fell outside an all-day band.
 */
function endMin(hhmm: string): number {
  const m = toMin(hhmm)
  return m === LAST_MINUTE_OF_DAY ? MINUTES_PER_DAY : m
}

/**
 * The battery state a decision is made against. `level` is `null` when the
 * charge is UNKNOWN (never read, stale, unparseable) — never `0`.
 */
export interface BatteryContext {
  readonly level: number | null
}

/**
 * Whether `battery` admits the charge: half-open `min <= level < max`, a
 * missing bound unbounded. A band WITH a condition is not met while the charge
 * is unknown; a band without one never asks.
 */
export function batteryAdmits(band: RecordingBand, battery: BatteryContext | undefined): boolean {
  const cond = band.battery
  if (cond === undefined) return true
  const level = battery?.level ?? null
  if (level === null) return false
  if (cond.min !== undefined && level < cond.min) return false
  if (cond.max !== undefined && level >= cond.max) return false
  return true
}

export function bandActiveAt(band: RecordingBand, date: Date, battery?: BatteryContext): boolean {
  if (!batteryAdmits(band, battery)) return false
  const days = band.days.length === 0 ? undefined : band.days
  const site = zoneOnlySite(hostTimeZone())
  return isWithinClockRange(days, toMin(band.start), endMin(band.end), date.getTime(), site)
}

/**
 * The band covering `date`, or null. GENERIC over the band type so the caller
 * gets back exactly what it put in: the recorder decides on `EffectiveBand`s
 * (`band-decision.ts`), which carry the one non-authored fact — that the DEVICE
 * decides — and a return type widened to `RecordingBand` would erase it right
 * where the gates read it.
 */
export function activeBandAt<B extends RecordingBand>(
  config: { readonly bands: readonly B[] },
  date: Date,
  battery?: BatteryContext,
): B | null {
  return config.bands.find((b) => bandActiveAt(b, date, battery)) ?? null
}
