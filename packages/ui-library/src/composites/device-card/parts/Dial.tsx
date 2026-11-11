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
  /** Centre content and the role glyph. */
  readonly children?: ReactNode
  readonly testId?: string
}

const SIZE = 150
const CENTER = 75
const RADIUS = 58
/** 270 degrees of a circle of radius 58. */
const ARC = 273.3
const START_DEG = 135
const SWEEP_DEG = 270

const TONE: Readonly<Record<DialTone, string>> = {
  primary: 'text-primary',
  info: 'text-info',
  warning: 'text-warning',
  muted: 'text-foreground-muted',
  off: 'text-border',
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
  children,
  testId,
}: DialProps): ReactElement {
  const gating = useCardGating()
  const active = enabled && !gating.blocked
  const [dragging, setDragging] = useState(false)
  const last = useRef(value)
  const fraction = max > min ? Math.min(1, Math.max(0, (value - min) / (max - min))) : 0
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
      className={cn('relative h-26 w-26', gating.blocked && 'dc-gated')}
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
