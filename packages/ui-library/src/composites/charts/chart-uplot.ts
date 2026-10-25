/**
 * uPlot option builders shared by the family: the wall-time x axis, a value
 * axis per unit, recessive chrome in theme tokens, the synced cursor and the
 * hole shading. Every colour is a FUNCTION so a theme switch is a redraw.
 */
import type uPlot from 'uplot'
import { formatTimeLabel, type GapSpan } from './chart-data'
import { resolveChartColor, withAlpha } from './chart-palette'
import { axisTicks, niceMax, niceRange, type AxisScale } from './chart-scale'

const AXIS_FONT_PX = 10

function axisFont(): string {
  const family =
    typeof document !== 'undefined' && document.body
      ? getComputedStyle(document.body).fontFamily
      : 'sans-serif'
  // i18n-ignore: a canvas font shorthand
  return `${String(AXIS_FONT_PX)}px ${family}`
}

/** The x axis: wall-clock time under the plot, at the window's precision. */
export function timeAxis(spanMs: () => number, show = true): uPlot.Axis {
  return {
    show,
    scale: 'x',
    side: 2,
    size: show ? 22 : 0,
    gap: 4,
    font: axisFont(),
    stroke: () => resolveChartColor('foreground-subtle'),
    grid: { show: false },
    ticks: { show: show, stroke: () => resolveChartColor('border'), width: 1, size: 3 },
    space: 70,
    values: (_u, splits) => splits.map((t) => formatTimeLabel(t, spanMs())),
  }
}

/** How a value axis is laid out. */
export interface ValueAxisSpec {
  /** `bytes` rounds the top on powers of two. Default `linear`. */
  readonly scale?: AxisScale
  /** Start at zero (default) — false for a level that lives far from it (°C, dBFS). */
  readonly zeroBased?: boolean
  /** The axis top never goes below this (an idle 0.4 % must not fill the plot). */
  readonly floor?: number
  /** Fixed range, e.g. `[0, 100]` for a percentage. */
  readonly fixed?: readonly [number, number]
}

/** A y scale's range from the values it carries, per the axis spec. */
export function valueRange(
  values: readonly (number | null | undefined)[],
  spec: ValueAxisSpec,
): readonly [number, number] {
  if (spec.fixed) return spec.fixed
  const defined = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
  const zeroBased = spec.zeroBased ?? true
  if (zeroBased && defined.every((v) => v >= 0)) {
    return [0, niceMax(defined, spec.floor ?? 0, spec.scale ?? 'linear') || 1]
  }
  return niceRange(defined) ?? [0, 1]
}

/** Steps a reader adds up without arithmetic, as mantissas over a power of ten. */
const READABLE_STEPS: readonly number[] = [1, 2, 2.5, 5]

/** Tick positions for a value axis over `range`: readable steps, 3–6 intervals. */
export function valueSplits(range: readonly [number, number], spec: ValueAxisSpec): number[] {
  const [lo, hi] = range
  // Zero is the baseline, not a labelled tick.
  if (lo === 0 && hi > 0) return [...axisTicks(hi, spec.scale ?? 'linear')]
  const span = hi - lo
  if (!(span > 0)) return [lo]
  const magnitude = 10 ** Math.floor(Math.log10(span / 4))
  const step =
    [...READABLE_STEPS, 10].map((m) => m * magnitude).find((st) => span / st <= 6) ?? span / 4
  const out: number[] = []
  for (let v = Math.ceil(lo / step - 1e-9) * step; v <= hi + 1e-9; v += step) {
    out.push(Math.round(v / step) * step)
  }
  return out
}

/** One value axis. `side` 3 = left, 1 = right. */
export function valueAxis(
  scaleKey: string,
  side: 1 | 3,
  format: (v: number) => string,
  showGrid: boolean,
): uPlot.Axis {
  return {
    scale: scaleKey,
    side,
    font: axisFont(),
    size: (_u, values) => {
      const longest = (values ?? []).reduce((m, v) => Math.max(m, String(v).length), 0)
      return Math.max(28, Math.min(72, longest * 6 + 10))
    },
    gap: 4,
    stroke: () => resolveChartColor('foreground-subtle'),
    grid: {
      show: showGrid,
      stroke: () => withAlpha(resolveChartColor('foreground-subtle'), 0.18),
      width: 1,
    },
    ticks: { show: false },
    values: (_u, splits) => splits.map((v) => format(v)),
  }
}

/** The cursor: a vertical crosshair, synced across every chart with the same key. */
export function chartCursor(syncKey: string | undefined): uPlot.Cursor {
  return {
    y: false,
    drag: { x: false, y: false, setScale: false },
    points: { size: 6, width: 1.5 },
    focus: { prox: 16 },
    ...(syncKey !== undefined ? { sync: { key: syncKey, setSeries: false } } : {}),
  }
}

/**
 * Shade every hole nobody measured, UNDER the series, so an outage reads as
 * missing ground and never as a quiet period.
 */
export function gapShadeHook(spans: () => readonly GapSpan[]): (u: uPlot) => void {
  return (u) => {
    const list = spans()
    if (list.length === 0) return
    const ctx = u.ctx
    ctx.save()
    ctx.fillStyle = withAlpha(resolveChartColor('foreground-subtle'), 0.12)
    for (const s of list) {
      const x0 = u.valToPos(s.from, 'x', true)
      const x1 = u.valToPos(s.to, 'x', true)
      ctx.fillRect(x0, u.bbox.top, Math.max(1, x1 - x0), u.bbox.height)
    }
    ctx.restore()
  }
}

// ── Values ──────────────────────────────────────────────────────────────

const BYTE_UNITS = new Set(['B', 'bytes', 'byte'])

/** Is this unit a byte count (binary axis and formatter)? */
export function isByteUnit(unit: string | null | undefined): boolean {
  return unit !== null && unit !== undefined && BYTE_UNITS.has(unit)
}

/** Units that live far from zero: their axis is padded around the data instead. */
const FLOATING_UNITS = new Set(['°C', '°F', 'K', 'dBFS', 'dB', 'dBm', 'hPa', 'mbar', 'inHg'])

/** The default axis spec for a unit. */
export function defaultAxisSpec(unit: string | null | undefined): ValueAxisSpec {
  if (isByteUnit(unit)) return { scale: 'bytes' }
  if (unit === '%') return { floor: 10 }
  if (unit !== null && unit !== undefined && FLOATING_UNITS.has(unit)) return { zeroBased: false }
  return {}
}

/** Binary byte count: `512 B`, `3.4 MB`, `1.2 GB`. */
export function formatChartBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return '—'
  const abs = Math.abs(bytes)
  if (abs < 1024) return `${String(Math.round(bytes))} B`
  const units = ['KB', 'MB', 'GB', 'TB', 'PB'] as const
  let value = bytes / 1024
  let unit: (typeof units)[number] = 'KB'
  for (const u of units) {
    unit = u
    if (Math.abs(value) < 1024) break
    value /= 1024
  }
  return `${Math.abs(value) < 100 ? value.toFixed(1) : value.toFixed(0)} ${unit}`
}

/** A number at a precision its magnitude justifies. */
export function formatChartNumber(v: number): string {
  if (!Number.isFinite(v)) return '—'
  const abs = Math.abs(v)
  if (abs >= 1000) return Math.round(v).toLocaleString()
  if (abs >= 100) return v.toFixed(0)
  if (abs >= 10) return trimZeros(v.toFixed(1))
  if (abs >= 1) return trimZeros(v.toFixed(2))
  if (abs === 0) return '0'
  return trimZeros(v.toFixed(3))
}

function trimZeros(s: string): string {
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s
}

/** The default value formatter: bytes binary, `%` glued, any other unit after a space. */
export function formatChartValue(v: number, unit: string | null | undefined): string {
  if (isByteUnit(unit)) return formatChartBytes(v)
  const n = formatChartNumber(v)
  if (unit === null || unit === undefined || unit === '' || unit === 'count') return n
  if (unit === '%') return `${n}%`
  return `${n} ${unit}`
}
