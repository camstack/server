import type { HomeConnectEntityDef } from './home-connect-device-description.js'

/**
 * Units are a property of the ENTITY, fixed for its whole series. A value is never
 * re-labelled by its magnitude (`n >= 10_000` ⇒ "it must be ml" turned one sensor's
 * history into two incompatible series).
 *
 * The unit comes from, in order:
 *  1. the unit the appliance's own description declares for the entity;
 *  2. the few features whose unit is part of the Home Connect interface itself
 *     (durations are seconds, a forecast and a progress are percent);
 *  3. nothing — the series is then published without a unit, never with a guess.
 */
const SECONDS_FEATURES: ReadonlySet<string> = new Set([
  'RemainingProgramTime',
  'StartInRelative',
  'FinishInRelative',
  'ElapsedProgramTime',
  'EstimatedTotalProgramTime',
])
const PERCENT_FEATURES: ReadonlySet<string> = new Set([
  'ProgramProgress',
  'EnergyForecast',
  'WaterForecast',
])

/** Last dotted segment of a feature name (`BSH.Common.Option.StartInRelative` -> `StartInRelative`). */
export function featureShortName(featureName: string): string {
  return featureName.split('.').pop() ?? featureName
}

/** The unit of an entity's series, or `null` when neither the description nor the interface fixes one. */
export function resolveUnit(entity: Pick<HomeConnectEntityDef, 'name' | 'unit'>): string | null {
  if (entity.unit !== undefined) return entity.unit
  const short = featureShortName(entity.name)
  if (SECONDS_FEATURES.has(short)) return 's'
  if (PERCENT_FEATURES.has(short)) return '%'
  return null
}

const KWH_PER_UNIT: Readonly<Record<string, number>> = {
  kWh: 1,
  Wh: 1 / 1000,
  MWh: 1000,
  kJ: 1 / 3600,
  MJ: 1 / 3.6,
  J: 1 / 3_600_000,
}

/** Whether a unit is an energy unit this addon can express in kWh. */
export function isEnergyUnit(unit: string | null): boolean {
  return unit !== null && Object.hasOwn(KWH_PER_UNIT, unit)
}

/**
 * Convert an energy reading to kWh using the unit the description declared.
 * `null` for an undeclared or unknown unit — a counter in the wrong unit is worse than no counter.
 */
export function energyToKwh(value: number, unit: string | null): number | null {
  if (unit === null) return null
  const factor = KWH_PER_UNIT[unit]
  return factor === undefined ? null : value * factor
}

/** A whole number of seconds from a raw reading; `null` when it is not a usable duration. */
export function secondsFrom(raw: unknown): number | null {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : Number.NaN
  if (!Number.isFinite(n) || n < 0) return null
  return Math.round(n)
}
