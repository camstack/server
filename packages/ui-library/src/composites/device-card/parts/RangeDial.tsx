import {
  type KeyboardEvent,
  type PointerEvent,
  type ReactElement,
  type ReactNode,
  useRef,
  useState,
} from 'react'
import { cn } from '../../../lib/cn'
import { useCardGating } from '../shell/gating'
import { DIAL_GEOMETRY, DIAL_TONE_CLASS, type DialTone, dialFractionAt, dialSnap } from './Dial'

export interface DialRange {
  readonly low: number
  readonly high: number
}

export type RangeHandle = 'low' | 'high'

export interface RangeDialProps {
  readonly low: number
  readonly high: number
  readonly min: number
  readonly max: number
  readonly step: number
  readonly tone: DialTone
  /** Names of the two handles, for assistive technology. */
  readonly lowLabel: string
  readonly highLabel: string
  /** False when the device is off or cannot set a range: no handles, no drag. */
  readonly enabled?: boolean
  /** Every range the dragged handle passes (the scene shows it live). */
  readonly onInput?: (range: DialRange) => void
  /** The range to send: on release, and on each arrow key. */
  readonly onCommit: (range: DialRange) => void
  readonly children?: ReactNode
  readonly testId?: string
}

/** The handle a value is nearer to; a tie goes to the side the value lies on. */
export function nearestRangeHandle(value: number, range: DialRange): RangeHandle {
  const toLow = Math.abs(value - range.low)
  const toHigh = Math.abs(value - range.high)
  if (toLow === toHigh) return value > range.high ? 'high' : 'low'
  return toLow < toHigh ? 'low' : 'high'
}

/** Moves one handle; the low one never passes the high one, nor the reverse. */
export function moveRangeHandle(range: DialRange, handle: RangeHandle, value: number): DialRange {
  return handle === 'low'
    ? { low: Math.min(value, range.high), high: range.high }
    : { low: range.low, high: Math.max(value, range.low) }
}

const { size, center, radius, arc, startDeg, sweepDeg } = DIAL_GEOMETRY

/** The dial of a device that holds a band: a low and a high setpoint on one arc. */
export function RangeDial({
  low,
  high,
  min,
  max,
  step,
  tone,
  lowLabel,
  highLabel,
  enabled = true,
  onInput,
  onCommit,
  children,
  testId,
}: RangeDialProps): ReactElement {
  const gating = useCardGating()
  const active = enabled && !gating.blocked
  const [dragging, setDragging] = useState<RangeHandle | null>(null)
  const last = useRef<DialRange>({ low, high })
  const span = max > min ? max - min : 1
  const fractionOf = (value: number): number => Math.min(1, Math.max(0, (value - min) / span))
  const lowFraction = fractionOf(low)
  const highFraction = fractionOf(high)

  const valueAt = (e: PointerEvent<SVGSVGElement>): number => {
    const box = e.currentTarget.getBoundingClientRect()
    const f = dialFractionAt(
      e.clientX - (box.left + box.width / 2),
      e.clientY - (box.top + box.height / 2),
    )
    return dialSnap(f, min, max, step)
  }
  const moveTo = (handle: RangeHandle, value: number): void => {
    const next = moveRangeHandle({ low, high }, handle, value)
    last.current = next
    onInput?.(next)
  }
  const onDown = (e: PointerEvent<SVGSVGElement>): void => {
    if (!active) return
    e.currentTarget.setPointerCapture?.(e.pointerId)
    const value = valueAt(e)
    const handle = nearestRangeHandle(value, { low, high })
    setDragging(handle)
    moveTo(handle, value)
  }
  const onMove = (e: PointerEvent<SVGSVGElement>): void => {
    if (dragging !== null) moveTo(dragging, valueAt(e))
  }
  const onUp = (): void => {
    if (dragging === null) return
    setDragging(null)
    onCommit(last.current)
  }
  const onKey =
    (handle: RangeHandle) =>
    (e: KeyboardEvent<SVGCircleElement>): void => {
      if (!active) return
      const dir =
        e.key === 'ArrowUp' || e.key === 'ArrowRight'
          ? 1
          : e.key === 'ArrowDown' || e.key === 'ArrowLeft'
            ? -1
            : 0
      if (dir === 0) return
      e.preventDefault()
      const from = handle === 'low' ? low : high
      const value = dialSnap((from + dir * step - min) / span, min, max, step)
      onCommit(moveRangeHandle({ low, high }, handle, value))
    }
  const thumb = (handle: RangeHandle, value: number, fraction: number): ReactElement => {
    const angle = ((startDeg + fraction * sweepDeg) * Math.PI) / 180
    return (
      <circle
        cx={center + radius * Math.cos(angle)}
        cy={center + radius * Math.sin(angle)}
        r={dragging === handle ? 11 : 9}
        strokeWidth={3}
        className="fill-surface text-foreground"
        stroke="currentColor"
        role="slider"
        tabIndex={active ? 0 : -1}
        aria-label={handle === 'low' ? lowLabel : highLabel}
        aria-valuemin={handle === 'low' ? min : low}
        aria-valuemax={handle === 'low' ? high : max}
        aria-valuenow={value}
        aria-disabled={!active}
        data-testid={testId === undefined ? undefined : `${testId}-${handle}`}
        onKeyDown={onKey(handle)}
      />
    )
  }

  return (
    <div
      className={cn('relative h-26 w-26', gating.blocked && 'dc-gated')}
      title={gating.blocked ? (gating.reason ?? undefined) : undefined}
    >
      <svg
        viewBox={`0 0 ${size} ${size}`}
        className={cn('dc-dial absolute inset-0 h-full w-full rounded-full', DIAL_TONE_CLASS[tone])}
        role="group"
        data-testid={testId}
        onPointerDown={onDown}
        onPointerMove={dragging === null ? undefined : onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
      >
        <circle
          cx={center}
          cy={center}
          r={radius}
          strokeWidth={10}
          className="text-border"
          stroke="currentColor"
          strokeDasharray={`${arc} 400`}
          transform={`rotate(${startDeg} ${center} ${center})`}
        />
        <circle
          cx={center}
          cy={center}
          r={radius}
          strokeWidth={10}
          className="dc-arc"
          stroke="currentColor"
          strokeDasharray={`${(highFraction - lowFraction) * arc} 400`}
          strokeDashoffset={-lowFraction * arc}
          transform={`rotate(${startDeg} ${center} ${center})`}
        />
        {enabled ? (
          <>
            {thumb('low', low, lowFraction)}
            {thumb('high', high, highFraction)}
          </>
        ) : null}
      </svg>
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
        {children}
      </div>
    </div>
  )
}
