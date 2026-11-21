import { type DisplayPreference, formatReading, type ReadingQuantity } from '@camstack/types'
import { formatChartNumber } from '../../charts/chart-uplot'
import type { SparklinePoint } from '../../charts/Sparkline'

/** The fewest answered samples a readout is drawn from: one point is not a trend. */
const MIN_SAMPLES = 2

export interface TrendReadoutInput {
  readonly points: readonly SparklinePoint[]
  /** The declared quantity of the series; its base-unit samples are converted for display. */
  readonly quantity?: ReadingQuantity | undefined
  /** The cap's declared unit when it names no known quantity; shown as is. */
  readonly unit?: string | null | undefined
  readonly preference?: DisplayPreference | undefined
  /**
   * The card's own display resolution for a base-unit sample (`resolveSensorDisplay`:
   * the device's unit override, the role default, precision). Wins over `quantity` and
   * `preference`, so the trend reads in the unit of the big value.
   */
  readonly format?: ((raw: number) => FormattedSample) | undefined
}

export interface FormattedSample {
  readonly text: string
  readonly unit: string
}

/** The words a trend's axes carry: Y min and max, the latest sample, and the unit. */
export interface TrendReadout {
  readonly min: string
  readonly max: string
  readonly current: string
  /** Empty when the series states no unit. */
  readonly unit: string
}

function answered(points: readonly SparklinePoint[]): readonly number[] {
  return points.flatMap((p) => (p.v !== null && Number.isFinite(p.v) ? [p.v] : []))
}

function sampleFormatter(input: TrendReadoutInput): ((raw: number) => FormattedSample) | undefined {
  if (input.format !== undefined) return input.format
  const { quantity, preference } = input
  if (quantity === undefined) return undefined
  return (value) =>
    formatReading({
      quantity,
      value,
      ...(preference === undefined ? {} : { preference }),
    })
}

/**
 * The axis words of a trend line. `null` when fewer than two samples answered: an
 * unanswered or empty series has no scale, and a made-up 0 would read as a measurement.
 */
export function trendReadout(input: TrendReadoutInput): TrendReadout | null {
  const values = answered(input.points)
  const last = values.at(-1)
  if (values.length < MIN_SAMPLES || last === undefined) return null
  const min = Math.min(...values)
  const max = Math.max(...values)
  const at = sampleFormatter(input)
  if (at !== undefined) {
    const shown = at(last)
    return {
      min: at(min).text,
      max: at(max).text,
      current: shown.text,
      unit: shown.unit,
    }
  }
  return {
    min: formatChartNumber(min),
    max: formatChartNumber(max),
    current: formatChartNumber(last),
    unit: input.unit ?? '',
  }
}
