/** Every unit a duration field can show, largest first. */
export type DurationUnit = 'hours' | 'minutes' | 'seconds' | 'millis'

export const DURATION_UNITS: readonly DurationUnit[] = ['hours', 'minutes', 'seconds', 'millis']

/** The unit a duration is STORED in. */
export type DurationStorageUnit = 'ms' | 's' | 'min'

const MS_PER_UNIT: Readonly<Record<DurationUnit, number>> = {
  hours: 3_600_000,
  minutes: 60_000,
  seconds: 1_000,
  millis: 1,
}

const MS_PER_STORAGE: Readonly<Record<DurationStorageUnit, number>> = {
  ms: 1,
  s: 1_000,
  min: 60_000,
}

/** The visible units in canonical (largest first) order, whatever order the caller named them. */
export function orderDurationUnits(units: readonly DurationUnit[]): readonly DurationUnit[] {
  const ordered = DURATION_UNITS.filter((unit) => units.includes(unit))
  return ordered.length > 0 ? ordered : ['seconds']
}

export type DurationUnitValues = Readonly<Partial<Record<DurationUnit, number>>>

/**
 * A stored duration as one number per visible unit. A larger unit takes what
 * fits whole; the smallest takes the rest, so what is shown always sums back.
 */
export function splitDuration(
  value: number,
  storage: DurationStorageUnit,
  units: readonly DurationUnit[],
): DurationUnitValues {
  const visible = orderDurationUnits(units)
  let rest = Number.isFinite(value) && value > 0 ? Math.round(value * MS_PER_STORAGE[storage]) : 0
  const out: Partial<Record<DurationUnit, number>> = {}
  visible.forEach((unit, index) => {
    const size = MS_PER_UNIT[unit]
    if (index === visible.length - 1) {
      out[unit] = Math.round((rest / size) * 1_000) / 1_000
      return
    }
    const whole = Math.floor(rest / size)
    out[unit] = whole
    rest -= whole * size
  })
  return out
}

/** The stored duration of the per-unit numbers, rounded to the millisecond. */
export function joinDuration(values: DurationUnitValues, storage: DurationStorageUnit): number {
  let totalMs = 0
  for (const unit of DURATION_UNITS) totalMs += (values[unit] ?? 0) * MS_PER_UNIT[unit]
  return Math.round(totalMs) / MS_PER_STORAGE[storage]
}
