/**
 * Selection, placement and readout for the chart point tooltip.
 * Pure: no DOM. Every chart asks this, then the shared host draws one tooltip.
 *
 * A numeric sample is a base-unit reading (D944 §4): the quantity formatter
 * applies the display preference. A unit string is used only when it names
 * one quantity, so the tooltip never shows a bare number that has a unit.
 */
import {
  QUANTITY_BASE,
  formatReading,
  isReadingQuantity,
  type DisplayPreference,
  type ReadingQuantity,
} from '@camstack/types'
import { formatCursorTime, formatSpan, type StateSegment } from './chart-data'
import { formatChartValue } from './chart-uplot'

/** Movement below this is still a tap, not a scrub. */
export const CHART_TOUCH_SLOP_PX: number = 10

/** Gap between the selected point and the tooltip, in px. */
export const CHART_TOOLTIP_GAP_PX: number = 12

/** Inset that keeps the tooltip inside the chart. */
export const CHART_TOOLTIP_PAD_PX: number = 4

const UNKNOWN = '—'

const NO_INFERENCE: ReadonlySet<ReadingQuantity> = new Set([
  'information',
  'duration',
  'duration-ms',
  'none',
  'device',
  'count',
  'index',
  'ratio',
  'humidity',
  'percentage',
])

export type ChartPointerKind = 'mouse' | 'touch'

export interface ChartSelection {
  readonly visible: boolean
  readonly dataX: number | null
  readonly anchorX: number
  readonly anchorY: number
  readonly pinned: boolean
}

export interface ChartGesture {
  readonly kind: ChartPointerKind
  readonly originX: number
  readonly originY: number
  readonly axis: 'pending' | 'x' | 'y'
}

export interface ChartInteraction {
  readonly selection: ChartSelection
  readonly gesture: ChartGesture | null
  readonly lockHorizontalScroll: boolean
}

export const HIDDEN_SELECTION: ChartSelection = {
  visible: false,
  dataX: null,
  anchorX: 0,
  anchorY: 0,
  pinned: false,
}

export const HIDDEN_INTERACTION: ChartInteraction = {
  selection: HIDDEN_SELECTION,
  gesture: null,
  lockHorizontalScroll: false,
}

export interface ChartPointerEvent {
  readonly type: 'down' | 'move' | 'up'
  readonly kind: ChartPointerKind
  readonly x: number
  readonly y: number
  readonly dataX: number | null
}

export type ChartInteractionEvent =
  | {
      readonly type: 'hover'
      readonly dataX: number
      readonly anchorX: number
      readonly anchorY: number
    }
  | { readonly type: 'leave' }
  | { readonly type: 'outside' }
  | { readonly type: 'hide' }
  | {
      readonly type: 'key'
      readonly dataX: number
      readonly anchorX: number
      readonly anchorY: number
    }
  | ChartPointerEvent

export interface DataXFromPointerInput {
  readonly localX: number
  readonly plotLeft: number
  readonly plotWidth: number
  readonly xMin: number
  readonly xMax: number
  readonly clamp: boolean
}

export interface PlaceTooltipInput {
  readonly anchorX: number
  readonly anchorY: number
  readonly tooltipWidth: number
  readonly tooltipHeight: number
  readonly boundsWidth: number
  readonly boundsHeight: number
  readonly gap?: number
}

export interface TooltipPlacement {
  readonly left: number
  readonly top: number
  readonly placed: 'left' | 'right'
  readonly vertical: 'above' | 'below'
}

export interface TooltipValueInput {
  readonly value: number | null
  readonly quantity?: ReadingQuantity
  readonly preference?: DisplayPreference
  readonly precision?: number
  readonly unit?: string | null
  readonly unknownLabel?: string
}

export interface ChartTooltipLine {
  readonly id: string
  readonly label: string
  readonly value: string
}

export interface ChartTooltipBody {
  readonly heading: string
  readonly lines: readonly ChartTooltipLine[]
  readonly liveText: string
}

export interface LineTooltipSample {
  readonly id: string
  readonly label: string
  readonly value: number | null
  readonly quantity?: ReadingQuantity
  readonly unit?: string | null
  readonly precision?: number
  readonly visible?: boolean
}

export interface StateTooltipRow {
  readonly id: string
  readonly label: string
  readonly stateLabel: string | null
  readonly spanMs: number | null
}

export interface StateSpanHit {
  readonly state: string | null
  readonly spanMs: number
}

export interface BarTooltipLayer {
  readonly id: string
  readonly label: string
  readonly value: number | null
  readonly quantity?: ReadingQuantity
  readonly unit?: string | null
  readonly precision?: number
}

export interface BucketStart {
  readonly t: number
}

interface TooltipSide {
  readonly placed: 'left' | 'right'
  readonly vertical: 'above' | 'below'
}

const TOOLTIP_SIDES: readonly TooltipSide[] = [
  { placed: 'right', vertical: 'above' },
  { placed: 'left', vertical: 'above' },
  { placed: 'right', vertical: 'below' },
  { placed: 'left', vertical: 'below' },
]

/** Index of the sample closest to `x`. A tie keeps the earlier sample. */
export function nearestPointIndex(xs: readonly number[], x: number): number | null {
  if (xs.length === 0 || !Number.isFinite(x)) return null
  let lo = 0
  let hi = xs.length - 1
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2)
    if ((xs[mid] ?? 0) < x) lo = mid + 1
    else hi = mid
  }
  const right = lo
  const left = Math.max(0, right - 1)
  const leftDist = Math.abs((xs[left] ?? 0) - x)
  const rightDist = Math.abs((xs[right] ?? 0) - x)
  return leftDist <= rightDist ? left : right
}

/** Data x for a pointer inside the plot. `null` when it is outside and clamping is off. */
export function dataXFromPointer(input: DataXFromPointerInput): number | null {
  if (!(input.plotWidth > 0) || !Number.isFinite(input.localX)) return null
  const rel = input.localX - input.plotLeft
  if (!input.clamp && (rel < 0 || rel > input.plotWidth)) return null
  const clamped = Math.min(input.plotWidth, Math.max(0, rel))
  return input.xMin + (clamped / input.plotWidth) * (input.xMax - input.xMin)
}

/** Bucket that contains `dataX`, or the nearest one when `dataX` falls in a gap. */
export function bucketSelectionIndex(
  buckets: readonly BucketStart[],
  bucketMs: number,
  dataX: number,
): number | null {
  if (buckets.length === 0 || !Number.isFinite(dataX)) return null
  let best = 0
  let bestDist = Number.POSITIVE_INFINITY
  for (let i = 0; i < buckets.length; i++) {
    const start = buckets[i]?.t
    if (start === undefined) continue
    const end = start + bucketMs
    if (dataX >= start && dataX < end) return i
    const dist = dataX < start ? start - dataX : dataX - end
    if (dist < bestDist) {
      bestDist = dist
      best = i
    }
  }
  return best
}

/** Next keyboard stop. A null current starts at the first or last stop. */
export function stepStop(
  stops: readonly number[],
  current: number | null,
  direction: -1 | 1,
): number | null {
  if (stops.length === 0) return null
  const ordered = [...stops].sort((a, b) => a - b)
  if (current === null || !Number.isFinite(current)) {
    return direction > 0 ? (ordered[0] ?? null) : (ordered[ordered.length - 1] ?? null)
  }
  let idx = 0
  let best = Number.POSITIVE_INFINITY
  for (let i = 0; i < ordered.length; i++) {
    const dist = Math.abs((ordered[i] ?? 0) - current)
    if (dist < best) {
      best = dist
      idx = i
    }
  }
  const next = idx + direction
  if (next < 0 || next >= ordered.length) return ordered[idx] ?? null
  return ordered[next] ?? null
}

function shown(dataX: number, anchorX: number, anchorY: number, pinned: boolean): ChartSelection {
  return { visible: true, dataX, anchorX, anchorY, pinned }
}

function resting(
  selection: ChartSelection,
  gesture: ChartGesture | null,
  lock: boolean,
): ChartInteraction {
  return { selection, gesture, lockHorizontalScroll: lock }
}

function lockAxis(gesture: ChartGesture, x: number, y: number): 'pending' | 'x' | 'y' {
  if (gesture.axis !== 'pending') return gesture.axis
  const dx = Math.abs(x - gesture.originX)
  const dy = Math.abs(y - gesture.originY)
  if (dx < CHART_TOUCH_SLOP_PX && dy < CHART_TOUCH_SLOP_PX) return 'pending'
  return dx >= dy ? 'x' : 'y'
}

function onDown(state: ChartInteraction, event: ChartPointerEvent): ChartInteraction {
  if (event.kind === 'mouse') return state
  return resting(
    state.selection,
    {
      kind: event.kind,
      originX: event.x,
      originY: event.y,
      axis: 'pending',
    },
    false,
  )
}

function onMove(state: ChartInteraction, event: ChartPointerEvent): ChartInteraction {
  if (event.kind === 'mouse') {
    if (event.dataX === null) return state.selection.pinned ? state : HIDDEN_INTERACTION
    return resting(shown(event.dataX, event.x, event.y, false), null, false)
  }
  const gesture = state.gesture
  if (gesture === null) return state
  const axis = lockAxis(gesture, event.x, event.y)
  const nextGesture: ChartGesture = { ...gesture, axis }
  if (axis !== 'x' || event.dataX === null) {
    return resting(state.selection, nextGesture, false)
  }
  return resting(shown(event.dataX, event.x, event.y, true), nextGesture, true)
}

function onUp(state: ChartInteraction, event: ChartPointerEvent): ChartInteraction {
  if (event.kind === 'mouse' || state.gesture === null) return state
  if (state.gesture.axis === 'y' || state.gesture.axis === 'x') {
    return resting(state.selection, null, false)
  }
  if (state.selection.visible && state.selection.pinned) return HIDDEN_INTERACTION
  if (event.dataX === null) return HIDDEN_INTERACTION
  return resting(shown(event.dataX, event.x, event.y, true), null, false)
}

/** Pointer, keyboard and dismiss rules for one chart. */
export function reduceChartInteraction(
  state: ChartInteraction,
  event: ChartInteractionEvent,
): ChartInteraction {
  switch (event.type) {
    case 'hide':
    case 'outside':
      return HIDDEN_INTERACTION
    case 'leave':
      return state.selection.pinned ? resting(state.selection, null, false) : HIDDEN_INTERACTION
    case 'hover':
      return resting(shown(event.dataX, event.anchorX, event.anchorY, false), null, false)
    case 'key':
      return resting(shown(event.dataX, event.anchorX, event.anchorY, true), null, false)
    case 'down':
      return onDown(state, event)
    case 'move':
      return onMove(state, event)
    case 'up':
      return onUp(state, event)
    default: {
      const _never: never = event
      return _never
    }
  }
}

function quantityFromUnit(unit: string | null | undefined): ReadingQuantity | undefined {
  if (unit === null || unit === undefined || unit.length === 0) return undefined
  let found: ReadingQuantity | undefined
  for (const key of Object.keys(QUANTITY_BASE)) {
    if (!isReadingQuantity(key) || NO_INFERENCE.has(key)) continue
    if (QUANTITY_BASE[key] !== unit) continue
    if (found !== undefined) return undefined
    found = key
  }
  return found
}

function withUnit(text: string, unit: string, unknown: string): string {
  if (text.length === 0) return unknown
  if (unit.length === 0) return text
  if (unit === '%') return `${text}%`
  return `${text} ${unit}`
}

/** One sample, with its unit. Missing samples are an em dash, never zero. */
export function formatTooltipValue(input: TooltipValueInput): string {
  const unknown = input.unknownLabel ?? UNKNOWN
  if (input.value === null || !Number.isFinite(input.value)) return unknown
  const quantity =
    input.quantity === 'device' ? undefined : (input.quantity ?? quantityFromUnit(input.unit))
  if (quantity === undefined) return formatChartValue(input.value, input.unit ?? null)
  const rendered = formatReading({
    value: input.value,
    quantity,
    preference: input.preference,
    precision: input.precision,
  })
  return withUnit(rendered.text, rendered.unit, unknown)
}

function liveText(heading: string, lines: readonly ChartTooltipLine[]): string {
  if (lines.length === 0) return heading
  return `${heading}, ${lines.map((line) => `${line.label} ${line.value}`).join(', ')}`
}

function asBody(heading: string, lines: readonly ChartTooltipLine[]): ChartTooltipBody {
  return { heading, lines, liveText: liveText(heading, lines) }
}

export interface LineTooltipBodyInput {
  readonly timeLabel: string
  readonly series: readonly LineTooltipSample[]
  readonly preference?: DisplayPreference
}

/** Time plus one line per visible series. */
export function lineTooltipBody(input: LineTooltipBodyInput): ChartTooltipBody {
  const lines = input.series
    .filter((sample) => sample.visible !== false)
    .map((sample) => ({
      id: sample.id,
      label: sample.label,
      value: formatTooltipValue({
        value: sample.value,
        quantity: sample.quantity,
        unit: sample.unit,
        precision: sample.precision,
        preference: input.preference,
      }),
    }))
  return asBody(input.timeLabel, lines)
}

/** The state in force at `t`, and how long that span lasts. */
export function stateSpanAt(segments: readonly StateSegment[], t: number): StateSpanHit | null {
  for (const segment of segments) {
    if (t >= segment.from && t < segment.to) {
      return { state: segment.state, spanMs: Math.max(0, segment.to - segment.from) }
    }
  }
  return null
}

export function stateTooltipValue(stateLabel: string | null, spanMs: number | null): string {
  if (stateLabel === null || stateLabel.length === 0) return UNKNOWN
  if (spanMs === null || !(spanMs > 0)) return stateLabel
  return `${stateLabel} · ${formatSpan(spanMs)}`
}

export interface StateTooltipBodyInput {
  readonly timeLabel: string
  readonly rows: readonly StateTooltipRow[]
}

/** One row per state series: the label and the span under the pointer. */
export function stateTooltipBody(input: StateTooltipBodyInput): ChartTooltipBody {
  const lines = input.rows.map((row) => ({
    id: row.id,
    label: row.label,
    value: stateTooltipValue(row.stateLabel, row.spanMs),
  }))
  return asBody(input.timeLabel, lines)
}

/** `start – end` for one bar bucket, at the window's time precision. */
export function barRangeLabel(start: number, bucketMs: number, spanMs: number): string {
  return `${formatCursorTime(start, spanMs)} – ${formatCursorTime(start + bucketMs, spanMs)}`
}

export interface BarTooltipBodyInput {
  readonly rangeLabel: string
  readonly layers: readonly BarTooltipLayer[]
  readonly preference?: DisplayPreference
}

/** The bucket's range, and each layer's value with its unit. */
export function barTooltipBody(input: BarTooltipBodyInput): ChartTooltipBody {
  const lines = input.layers.map((layer) => ({
    id: layer.id,
    label: layer.label,
    value: formatTooltipValue({
      value: layer.value,
      quantity: layer.quantity,
      unit: layer.unit,
      precision: layer.precision,
      preference: input.preference,
    }),
  }))
  return asBody(input.rangeLabel, lines)
}

function sideOrigin(
  side: TooltipSide,
  input: PlaceTooltipInput,
  gap: number,
): { readonly left: number; readonly top: number } {
  const left =
    side.placed === 'right' ? input.anchorX + gap : input.anchorX - gap - input.tooltipWidth
  const top =
    side.vertical === 'above' ? input.anchorY - gap - input.tooltipHeight : input.anchorY + gap
  return { left, top }
}

function insideBounds(left: number, top: number, input: PlaceTooltipInput): boolean {
  const pad = CHART_TOOLTIP_PAD_PX
  return (
    left >= pad &&
    top >= pad &&
    left + input.tooltipWidth <= input.boundsWidth - pad &&
    top + input.tooltipHeight <= input.boundsHeight - pad
  )
}

function coversPoint(left: number, top: number, input: PlaceTooltipInput): boolean {
  return (
    input.anchorX >= left &&
    input.anchorX <= left + input.tooltipWidth &&
    input.anchorY >= top &&
    input.anchorY <= top + input.tooltipHeight
  )
}

function clampOrigin(
  left: number,
  top: number,
  input: PlaceTooltipInput,
): { readonly left: number; readonly top: number } {
  const pad = CHART_TOOLTIP_PAD_PX
  const maxLeft = Math.max(pad, input.boundsWidth - pad - input.tooltipWidth)
  const maxTop = Math.max(pad, input.boundsHeight - pad - input.tooltipHeight)
  return {
    left: Math.min(Math.max(left, pad), maxLeft),
    top: Math.min(Math.max(top, pad), maxTop),
  }
}

/**
 * Place the tooltip beside the point, inside the chart. The first side that
 * fits and does not cover the point wins; the edges flip before the corners.
 */
export function placeChartTooltip(input: PlaceTooltipInput): TooltipPlacement {
  const gap = input.gap ?? CHART_TOOLTIP_GAP_PX
  let fallback: TooltipPlacement | null = null
  for (const side of TOOLTIP_SIDES) {
    const origin = sideOrigin(side, input, gap)
    const clamped = clampOrigin(origin.left, origin.top, input)
    const placement: TooltipPlacement = { ...side, ...clamped }
    if (fallback === null && !coversPoint(clamped.left, clamped.top, input)) fallback = placement
    if (
      insideBounds(origin.left, origin.top, input) &&
      !coversPoint(origin.left, origin.top, input)
    ) {
      return { ...side, ...origin }
    }
  }
  if (fallback !== null) return fallback
  const first = TOOLTIP_SIDES[0] ?? { placed: 'right' as const, vertical: 'above' as const }
  const clamped = clampOrigin(
    sideOrigin(first, input, gap).left,
    sideOrigin(first, input, gap).top,
    input,
  )
  return { ...first, ...clamped }
}
