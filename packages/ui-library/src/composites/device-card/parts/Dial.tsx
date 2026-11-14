import {
  type KeyboardEvent,
  type PointerEvent,
  type ReactElement,
  type ReactNode,
  useCallback,
  useRef,
  useState,
} from 'react'
import { cn } from '../../../lib/cn'
import { useCardGating } from '../shell/gating'

export type DialTone = 'primary' | 'info' | 'warning' | 'muted' | 'off'

export interface DialProps {
  readonly value: number
  readonly min: number
  readonly max: number
  readonly step: number
  readonly tone: DialTone
  readonly ariaLabel: string
  /** False when the device is off: no thumb, no drag. */
  readonly enabled?: boolean
  /** Every value the thumb passes while dragged (the scene shows it live). */
  readonly onInput?: (value: number) => void
  /** The value to send: on release, and on each arrow key. */
  readonly onCommit: (value: number) => void
  /**
   * Gauge mode: a hollow marker at `marker` and, when `band` is set, a filled
   * arc between its two ends. The plain fill from the start of the arc is not
   * drawn. Absent: the dial fills from the start up to `value`.
   */
  readonly gauge?: DialGauge
  /** Centre content and the role glyph. */
  readonly children?: ReactNode
  readonly testId?: string
}

export interface DialGauge {
  readonly marker: number
  readonly band: { readonly from: number; readonly to: number } | null
}

const SIZE = 150
const CENTER = 75
const RADIUS = 58
/** 270 degrees of a circle of radius 58. */
const ARC = 273.3
const START_DEG = 135
const SWEEP_DEG = 270

/** The arc every round control of the card is drawn on. */
export const DIAL_GEOMETRY: {
  readonly size: number
  readonly center: number
  readonly radius: number
  readonly arc: number
  readonly startDeg: number
  readonly sweepDeg: number
} = {
  size: SIZE,
  center: CENTER,
  radius: RADIUS,
  arc: ARC,
  startDeg: START_DEG,
  sweepDeg: SWEEP_DEG,
}

/**
 * The box every round control is drawn in: it fills the scene's drawing (the
 * drawing is at least 70% of the card), square, between 104 px and 208 px. It
 * is a size container, so what sits inside can grow with it.
 */
export const DIAL_BOX_CLASS: string = '@container relative aspect-square w-full min-w-26 max-w-52'

export const DIAL_TONE_CLASS: Readonly<Record<DialTone, string>> = {
  primary: 'text-primary',
  info: 'text-info',
  warning: 'text-warning',
  muted: 'text-foreground-muted',
  off: 'text-border',
}

const TONE = DIAL_TONE_CLASS

/** A value as a 0..1 fraction of the arc. */
export function dialValueFraction(value: number, min: number, max: number): number {
  return max > min ? Math.min(1, Math.max(0, (value - min) / (max - min))) : 0
}

/** The dash offset and length (as arc fractions) of the band between two values. */
export function dialBandSpan(
  band: { readonly from: number; readonly to: number },
  min: number,
  max: number,
): { readonly start: number; readonly length: number } {
  const a = dialValueFraction(band.from, min, max)
  const b = dialValueFraction(band.to, min, max)
  return { start: Math.min(a, b), length: Math.abs(b - a) }
}

/** The value a pointer at (x, y) from the dial centre names, as a 0..1 fraction. */
export function dialFractionAt(x: number, y: number): number {
  const deg = (Math.atan2(y, x) * 180) / Math.PI
  const t = (deg - START_DEG + 720) % 360
  if (t > SWEEP_DEG) return t > 315 ? 0 : 1
  return t / SWEEP_DEG
}

export function dialSnap(fraction: number, min: number, max: number, step: number): number {
  const raw = min + fraction * (max - min)
  const snapped = Math.round(raw / step) * step
  return Math.min(max, Math.max(min, Number(snapped.toFixed(2))))
}

/** The card's ONE round setpoint control: a 270 degree arc with a draggable thumb. */
export function Dial({
  value,
  min,
  max,
  step,
  tone,
  ariaLabel,
  enabled = true,
  onInput,
  onCommit,
  gauge,
  children,
  testId,
}: DialProps): ReactElement {
  const gating = useCardGating()
  const active = enabled && !gating.blocked
  const [dragging, setDragging] = useState(false)
  const last = useRef(value)
  const fraction = dialValueFraction(value, min, max)
  const bandSpan = gauge?.band == null ? null : dialBandSpan(gauge.band, min, max)
  const markerAngle =
    gauge === undefined
      ? null
      : ((START_DEG + dialValueFraction(gauge.marker, min, max) * SWEEP_DEG) * Math.PI) / 180
  const angle = ((START_DEG + fraction * SWEEP_DEG) * Math.PI) / 180

  const valueAt = useCallback(
    (e: PointerEvent<SVGSVGElement>): number => {
      const box = e.currentTarget.getBoundingClientRect()
      const f = dialFractionAt(
        e.clientX - (box.left + box.width / 2),
        e.clientY - (box.top + box.height / 2),
      )
      return dialSnap(f, min, max, step)
    },
    [min, max, step],
  )
  const move = (e: PointerEvent<SVGSVGElement>): void => {
    const next = valueAt(e)
    last.current = next
    onInput?.(next)
  }
  const onDown = (e: PointerEvent<SVGSVGElement>): void => {
    if (!active) return
    e.currentTarget.setPointerCapture?.(e.pointerId)
    setDragging(true)
    move(e)
  }
  const onUp = (): void => {
    if (!dragging) return
    setDragging(false)
    onCommit(last.current)
  }
  const onKey = (e: KeyboardEvent<SVGSVGElement>): void => {
    if (!active) return
    const dir =
      e.key === 'ArrowUp' || e.key === 'ArrowRight'
        ? 1
        : e.key === 'ArrowDown' || e.key === 'ArrowLeft'
          ? -1
          : 0
    if (dir === 0) return
    e.preventDefault()
    onCommit(dialSnap((value + dir * step - min) / (max - min), min, max, step))
  }

  return (
    <div
      className={cn(DIAL_BOX_CLASS, gating.blocked && 'dc-gated')}
      title={gating.blocked ? (gating.reason ?? undefined) : undefined}
    >
      <svg
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        className={cn('dc-dial absolute inset-0 h-full w-full rounded-full', TONE[tone])}
        role="slider"
        tabIndex={active ? 0 : -1}
        aria-label={ariaLabel}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        aria-disabled={!active}
        data-testid={testId}
        onPointerDown={onDown}
        onPointerMove={dragging ? move : undefined}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onKeyDown={onKey}
      >
        <circle
          cx={CENTER}
          cy={CENTER}
          r={RADIUS}
          strokeWidth={10}
          className="text-border"
          stroke="currentColor"
          strokeDasharray={`${ARC} 400`}
          transform={`rotate(${START_DEG} ${CENTER} ${CENTER})`}
        />
        {gauge === undefined ? (
          <circle
            cx={CENTER}
            cy={CENTER}
            r={RADIUS}
            strokeWidth={10}
            className="dc-arc"
            stroke="currentColor"
            strokeDasharray={`${fraction * ARC} 400`}
            transform={`rotate(${START_DEG} ${CENTER} ${CENTER})`}
          />
        ) : null}
        {bandSpan === null ? null : (
          <circle
            cx={CENTER}
            cy={CENTER}
            r={RADIUS}
            strokeWidth={10}
            className="dc-arc"
            stroke="currentColor"
            strokeDasharray={`${bandSpan.length * ARC} 400`}
            strokeDashoffset={-bandSpan.start * ARC}
            transform={`rotate(${START_DEG} ${CENTER} ${CENTER})`}
            data-testid={testId === undefined ? undefined : `${testId}-band`}
          />
        )}
        {markerAngle === null ? null : (
          <circle
            cx={CENTER + RADIUS * Math.cos(markerAngle)}
            cy={CENTER + RADIUS * Math.sin(markerAngle)}
            r={5}
            strokeWidth={2.5}
            className="fill-transparent text-foreground"
            stroke="currentColor"
            data-testid={testId === undefined ? undefined : `${testId}-marker`}
          />
        )}
        {enabled ? (
          <circle
            cx={CENTER + RADIUS * Math.cos(angle)}
            cy={CENTER + RADIUS * Math.sin(angle)}
            r={dragging ? 11 : 9}
            strokeWidth={3}
            className="fill-surface text-foreground"
            stroke="currentColor"
          />
        ) : null}
      </svg>
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
        {children}
      </div>
    </div>
  )
}
