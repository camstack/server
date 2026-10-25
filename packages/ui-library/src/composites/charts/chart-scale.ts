/**
 * Value-axis arithmetic for the chart family — pure, unit-tested, because the
 * ways a chart LIES are arithmetic (a truncated baseline, an axis that tops
 * out on `4.7 GB`, a gap threshold that either shatters every line or bridges
 * an outage). Moved from the admin-ui load charts, which proved these rules.
 */

/** `bytes` rounds on powers of two (what `formatBytes` prints); `linear` on 1/2/5×10ⁿ. */
export type AxisScale = 'linear' | 'bytes'

const LINEAR_MAX_MANTISSAS: readonly number[] = [1, 2, 5, 10]
const BYTE_MAX_MANTISSAS: readonly number[] = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024]
/** Steps a reader adds up without arithmetic; 1.25 / 1.66 are what an equal split of anything gives. */
const READABLE_STEP_MANTISSAS: readonly number[] = [1, 1.5, 2, 2.5, 3, 4, 5]
/** Interval counts to try, in preference order: four is as many gridlines as a short plot keeps legible. */
const AXIS_INTERVAL_CANDIDATES: readonly number[] = [4, 3, 5, 2]
const MANTISSA_EPSILON = 1e-9

function isReadableStep(step: number, scale: AxisScale): boolean {
  if (!Number.isFinite(step) || step <= 0) return false
  if (scale === 'bytes') {
    if (!Number.isInteger(step)) return false
    const magnitude = 1024 ** Math.floor(Math.log(step) / Math.log(1024))
    const mantissa = step / magnitude
    return READABLE_STEP_MANTISSAS.some((m) => Math.abs(mantissa - m) < MANTISSA_EPSILON)
  }
  const magnitude = 10 ** Math.floor(Math.log10(step))
  const mantissa = step / magnitude
  return READABLE_STEP_MANTISSAS.some((m) => Math.abs(mantissa - m) < MANTISSA_EPSILON)
}

/**
 * Nice upper bound of a value axis that starts at zero. `floor` is returned
 * VERBATIM when nothing exceeds it, so an idle series keeps the scale the
 * caller chose instead of a 0–0.3 axis on which noise looks like load.
 */
export function niceMax(
  values: readonly (number | null)[],
  floor: number,
  scale: AxisScale = 'linear',
): number {
  let max = 0
  for (const v of values) {
    if (v !== null && Number.isFinite(v) && v > max) max = v
  }
  if (max <= floor) return floor
  if (scale === 'bytes') {
    const magnitude = 1024 ** Math.floor(Math.log(max) / Math.log(1024))
    for (const mantissa of BYTE_MAX_MANTISSAS) {
      const candidate = mantissa * magnitude
      if (candidate >= max) return candidate
    }
    return 1024 * magnitude
  }
  const magnitude = 10 ** Math.floor(Math.log10(max))
  for (const mantissa of LINEAR_MAX_MANTISSAS) {
    const candidate = mantissa * magnitude
    if (candidate >= max) return candidate
  }
  return 10 * magnitude
}

/** Gridline values for an axis topping out at `max`, ascending, `max` last; zero is the baseline, not a tick. */
export function axisTicks(max: number, scale: AxisScale = 'linear'): readonly number[] {
  if (!Number.isFinite(max) || max <= 0) return []
  const intervals =
    AXIS_INTERVAL_CANDIDATES.find((d) => isReadableStep(max / d, scale)) ??
    AXIS_INTERVAL_CANDIDATES[AXIS_INTERVAL_CANDIDATES.length - 1] ??
    2
  const step = max / intervals
  const ticks: number[] = []
  for (let i = 1; i <= intervals; i++) ticks.push(step * i)
  return ticks
}

/**
 * Nice [min, max] for a series that need NOT start at zero (a temperature, a
 * dBFS level): the data range padded by a tenth and rounded outward to a
 * readable step. A flat series gets a ±1 window so it is not a degenerate axis.
 */
export function niceRange(values: readonly (number | null)[]): readonly [number, number] | null {
  let lo = Number.POSITIVE_INFINITY
  let hi = Number.NEGATIVE_INFINITY
  for (const v of values) {
    if (v === null || !Number.isFinite(v)) continue
    if (v < lo) lo = v
    if (v > hi) hi = v
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null
  if (hi - lo < 1e-9) return [lo - 1, hi + 1]
  const pad = (hi - lo) * 0.1
  const span = hi - lo + 2 * pad
  const magnitude = 10 ** Math.floor(Math.log10(span / 4))
  const step =
    [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((st) => span / st <= 6) ?? magnitude * 10
  return [Math.floor((lo - pad) / step) * step, Math.ceil((hi + pad) / step) * step]
}

/**
 * How many sampling intervals of silence make a HOLE rather than a late tick:
 * past any plausible delivery jitter, well inside the shortest outage worth seeing.
 */
export const GAP_INTERVAL_FACTOR = 2.5

/** The gap threshold for a series sampled every `intervalMs` — derived, never a literal. */
export function gapThresholdMs(intervalMs: number): number {
  return intervalMs * GAP_INTERVAL_FACTOR
}
