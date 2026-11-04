/**
 * Shaded bands over a chart's time axis: a span that means something (a
 * washing cycle, a maintenance window) drawn behind the lines. Pure model;
 * `TimeSeriesChart` paints it and states it in the point tooltip.
 */
import type { ChartChromeToken } from './chart-palette'

export type ChartBandTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger'

export interface ChartBand {
  readonly id: string
  readonly from: number
  readonly to: number
  /** Short name of the kind of span ("Run"); the tooltip row's label. */
  readonly title: string
  /** What the span was ("1h 40m · 1.32 kWh"); the tooltip row's value. */
  readonly label: string
  readonly tone: ChartBandTone
}

const TONE_TOKEN: Readonly<Record<ChartBandTone, ChartChromeToken>> = {
  neutral: 'foreground-subtle',
  info: 'info',
  success: 'success',
  warning: 'warning',
  danger: 'danger',
}

export function bandToken(tone: ChartBandTone): ChartChromeToken {
  return TONE_TOKEN[tone]
}

/** The bands that contain `x` (edges included), in input order. */
export function bandsAt(bands: readonly ChartBand[], x: number): readonly ChartBand[] {
  return bands.filter((b) => x >= b.from && x <= b.to)
}

/** Bands clipped to `[from, to]`; one that lies wholly outside, or is empty, is dropped. */
export function clipBands(
  bands: readonly ChartBand[],
  from: number,
  to: number,
): readonly ChartBand[] {
  const out: ChartBand[] = []
  for (const b of bands) {
    const lo = Math.max(b.from, from)
    const hi = Math.min(b.to, to)
    if (hi > lo) out.push({ ...b, from: lo, to: hi })
  }
  return out
}
