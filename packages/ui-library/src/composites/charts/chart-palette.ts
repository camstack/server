/**
 * The chart family's colours — theme tokens only.
 *
 * Categorical identity comes from the eight `--color-chart-series-*` tokens in
 * `tailwind/camstack-theme.css`, in FIXED order (a blue, b magenta, c yellow,
 * d aqua, e orange, f violet, g green, h red). A series keeps its slot for as
 * long as it is on screen: the caller assigns the index, never the rank, so a
 * filter that hides one series does not repaint the others.
 *
 * Past eight, a slot is reused with a dash pattern (composite encoding) — a
 * generated ninth hue would be indistinguishable from one of the eight.
 *
 * Canvas cannot read `var(--…)`, so a token is resolved through
 * `getComputedStyle` at DRAW time: a theme switch (`.dark` / `.light` on
 * `<html>`) followed by a redraw picks the new value up with no re-creation.
 */

/** The categorical slots, in their fixed order. */
export const CHART_SERIES_TOKENS = [
  'chart-series-a',
  'chart-series-b',
  'chart-series-c',
  'chart-series-d',
  'chart-series-e',
  'chart-series-f',
  'chart-series-g',
  'chart-series-h',
] as const
export type ChartSeriesToken = (typeof CHART_SERIES_TOKENS)[number]

/** Dash patterns (canvas `setLineDash`, CSS px) for the 1st, 2nd and 3rd lap of the palette. */
const DASH_LAPS: readonly (readonly number[])[] = [[], [6, 4], [2, 3]]

export interface ChartSeriesStyle {
  readonly token: ChartSeriesToken
  /** Empty for a solid line. */
  readonly dash: readonly number[]
}

/** The style of the series at `index` (0-based, its stable identity slot). */
export function chartSeriesStyle(index: number): ChartSeriesStyle {
  const i = Math.max(0, Math.floor(index))
  const token = CHART_SERIES_TOKENS[i % CHART_SERIES_TOKENS.length] ?? 'chart-series-a'
  const lap = Math.floor(i / CHART_SERIES_TOKENS.length) % DASH_LAPS.length
  return { token, dash: DASH_LAPS[lap] ?? [] }
}

/** A token a DOM swatch can wear: a series slot, or the recessive "off" state. */
export type ChartSwatchToken = ChartSeriesToken | 'border'

/** Spelled out so Tailwind finds every class (a built class name emits no rule). */
const SWATCH_FILL: Readonly<Record<ChartSwatchToken, string>> = {
  'chart-series-a': 'bg-chart-series-a',
  'chart-series-b': 'bg-chart-series-b',
  'chart-series-c': 'bg-chart-series-c',
  'chart-series-d': 'bg-chart-series-d',
  'chart-series-e': 'bg-chart-series-e',
  'chart-series-f': 'bg-chart-series-f',
  'chart-series-g': 'bg-chart-series-g',
  'chart-series-h': 'bg-chart-series-h',
  border: 'bg-border',
}

const SWATCH_LINE: Readonly<Record<ChartSwatchToken, string>> = {
  'chart-series-a': 'border-chart-series-a',
  'chart-series-b': 'border-chart-series-b',
  'chart-series-c': 'border-chart-series-c',
  'chart-series-d': 'border-chart-series-d',
  'chart-series-e': 'border-chart-series-e',
  'chart-series-f': 'border-chart-series-f',
  'chart-series-g': 'border-chart-series-g',
  'chart-series-h': 'border-chart-series-h',
  border: 'border-border',
}

/** The utility that fills a swatch with `token`. */
export function swatchFillClass(token: ChartSwatchToken): string {
  return SWATCH_FILL[token]
}

/** The utility that colours a dashed swatch's line with `token`. */
export function swatchLineClass(token: ChartSwatchToken): string {
  return SWATCH_LINE[token]
}

/** Neutral roles the canvas draws with (axes, grid, gap shading). */
export type ChartChromeToken =
  | 'foreground-subtle'
  | 'foreground-muted'
  | 'border'
  | 'border-subtle'
  | 'surface'
  | 'primary'

/**
 * Resolve a theme token to the colour the canvas paints. Reads the computed
 * value of `--color-<token>` on the chart's own root (so a scoped theme block
 * wins); answers `transparent` when the document has no value (a test DOM).
 */
export function resolveChartColor(
  token: ChartSeriesToken | ChartChromeToken,
  el?: Element,
): string {
  if (typeof window === 'undefined' || typeof getComputedStyle !== 'function') return 'transparent'
  const root = el ?? document.documentElement
  const value = getComputedStyle(root).getPropertyValue(`--color-${token}`).trim()
  return value.length > 0 ? value : 'transparent'
}

const SIX_DIGIT_HEX = /^#[0-9a-f]{6}$/i

/**
 * `color` with `alpha` (0..1). A resolved token is a six-digit hex, which
 * becomes the eight-digit form every canvas accepts; anything else falls back
 * to `color-mix`.
 */
export function withAlpha(color: string, alpha: number): string {
  const a = Math.min(1, Math.max(0, alpha))
  if (SIX_DIGIT_HEX.test(color)) {
    return `${color}${Math.round(a * 255)
      .toString(16)
      .padStart(2, '0')}`
  }
  // i18n-ignore: a CSS colour expression
  return `color-mix(in srgb, ${color} ${String(Math.round(a * 100))}%, transparent)`
}
