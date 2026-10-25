import type { ComponentPropsWithoutRef, PointerEvent, ReactNode } from 'react'
import { useRef, useState } from 'react'
import { cn } from '../../lib/cn'
import { useUiText } from '../../contexts/ui-text'

export const FILL = 'fill' as const
export const RIGHT = 'right' as const
export const CENTER = 'center' as const
export const FIT = 'fit' as const
export type ControlAlign = typeof FILL | typeof RIGHT | typeof CENTER | typeof FIT

interface ControlColumnProps extends ComponentPropsWithoutRef<'div'> {
  readonly align: ControlAlign
  readonly children: ReactNode
}

/** The one control column every device-row/hero control sits in.
 *  FILL → the child stretches to the full fixed column width (steppers, selects, buttons, cover triad).
 *  RIGHT → the child keeps its natural width, flush to the right edge of the fixed column (readouts, toggles — card view).
 *  CENTER → the child keeps its natural width, centered in the fixed column (readouts, toggles).
 *  FIT → the column DROPS its fixed width and sizes to its content (table view). The control takes
 *        its natural width and lays out in sequence with the trailing trash + status dot, so a wide
 *        control (climate stepper + mode select, cover triad + %) never overflows a fixed box and
 *        collides with the neighbours. FILL has no effect under FIT — a stretchy child in a
 *        content-width wrapper simply takes its natural width.
 *  FILL, RIGHT and CENTER share the fixed `w-[140px]` box (card / minimal / hero views). */
export function ControlColumn({
  align,
  children,
  className,
  ...rest
}: ControlColumnProps): ReactNode {
  if (align === FIT) {
    return (
      <div {...rest} className={cn('inline-flex items-center', className)}>
        {children}
      </div>
    )
  }
  const justify = align === CENTER ? 'justify-center' : 'justify-end'
  return (
    <div
      {...rest}
      className={cn(
        'w-[140px] shrink-0 flex items-center gap-1.5',
        justify,
        // Only the PRIMARY control (last child) fills the column — a leading
        // affordance (e.g. the motion-trigger toggle, rendered before the
        // control) keeps its natural width and sits flush against it.
        align === FILL ? '[&>*:last-child]:w-full' : '',
        className,
      )}
    >
      {children}
    </div>
  )
}

interface ValueReadoutProps {
  readonly value: string
  readonly unit?: string
}

/** A value + inline unit suffix (no separator). E.g. `60s`, `22%`. */
export function ValueReadout({ value, unit }: ValueReadoutProps): ReactNode {
  return (
    <span className="text-sm text-foreground">
      {value}
      {unit ? (
        <span data-unit className="ml-0.5 text-[11px] text-foreground-subtle">
          {unit}
        </span>
      ) : null}
    </span>
  )
}

interface StepperProps {
  readonly value: number | string
  readonly unit?: string
  readonly onDelta: (d: 1 | -1) => void
}

/** Increment/decrement control with value + unit display. */
export function Stepper({ value, unit, onDelta }: StepperProps): ReactNode {
  const t = useUiText()
  return (
    <div className="flex h-8 w-full overflow-hidden rounded-lg border border-border bg-surface">
      <button
        type="button"
        aria-label={t('uiLibrary.deviceControlAtoms.decrement', 'Decrement')}
        className="w-9 shrink-0 bg-surface-hover text-base text-foreground"
        onClick={() => onDelta(-1)}
      >
        {'−'}
      </button>
      <span className="flex flex-1 items-center justify-center gap-0.5 border-x border-border/60 text-sm">
        {value}
        {unit ? (
          <span data-unit className="text-[11px] text-foreground-subtle">
            {unit}
          </span>
        ) : null}
      </span>
      <button
        type="button"
        aria-label={t('uiLibrary.deviceControlAtoms.increment', 'Increment')}
        className="w-9 shrink-0 bg-surface-hover text-base text-foreground"
        onClick={() => onDelta(1)}
      >
        +
      </button>
    </div>
  )
}

interface SlideToggleProps {
  readonly on: boolean
  readonly targetLabel: string
  readonly onConfirm: () => void
}

/** Safety slide: onConfirm fires only after the thumb is dragged past threshold, never on a plain tap. */
export function SlideToggle({ on, targetLabel, onConfirm }: SlideToggleProps): ReactNode {
  const startX = useRef<number | null>(null)
  const draggedRef = useRef(false)
  return (
    <div
      className={cn(
        'relative h-12 w-full rounded-full border flex items-center',
        on
          ? 'bg-emerald-50 border-emerald-200 pl-4'
          : 'bg-amber-50 border-amber-200 justify-end pr-4',
      )}
    >
      <span className="text-xs font-semibold opacity-60">{targetLabel}</span>
      <span
        data-testid="slide-thumb"
        className="absolute top-1 left-1 h-10 w-14 rounded-[19px] bg-surface shadow flex items-center justify-center"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture?.(e.pointerId)
          startX.current = e.clientX
          draggedRef.current = false
        }}
        onPointerMove={(e) => {
          if (startX.current !== null && Math.abs(e.clientX - startX.current) > 40) {
            draggedRef.current = true
          }
        }}
        onPointerUp={() => {
          if (draggedRef.current) onConfirm()
          draggedRef.current = false
          startX.current = null
        }}
        onPointerCancel={() => {
          draggedRef.current = false
          startX.current = null
        }}
      />
    </div>
  )
}

interface ArcKnobProps {
  readonly fraction: number
  readonly color: string
  /**
   * Distance in px from the rotating container's top edge to the knob's top
   * edge. The knob is 20px tall, so its CENTER sits at `knobTopPx + 10` px
   * from the top. For the knob center to ride the ring's centre radius the
   * caller passes `(containerCenter − ringRadius) − 10`. Defaults to the
   * thermostat gauge value (176px container, radius 76 → 88 − 76 − 10 = 2).
   */
  readonly knobTopPx?: number
  /**
   * When provided, the knob becomes interactive: dragging it reports the new
   * arc fraction (0..1) to the parent, which owns the value and re-renders the
   * knob at the new `fraction`. When omitted the knob is a display-only
   * indicator (no grab cursor, no pointer handlers).
   */
  readonly onDragFraction?: (fraction: number) => void
}

/** Half the ArcKnob's 20px (h-5) height. Callers seat the knob centre on a
 *  ring by computing `(containerCentre − ringRadius) − KNOB_HALF_PX`. */
export const KNOB_HALF_PX = 10

/** Distance from the rotating container's top edge to the knob's top edge
 *  for the 176px thermostat gauge (centre 88, ring radius 76, knob half 10). */
const DEFAULT_KNOB_TOP_PX = 2

/** Degrees from the arc start (SW) to the end (SE), going clockwise through N. */
const ARC_SWEEP_DEG = 270
/** Midpoint of the 90° bottom gap, measured from the arc start (SW). A pointer
 *  in the gap snaps to whichever arc end is nearer: < midpoint → SW end (0),
 *  ≥ midpoint → SE end (1). */
const ARC_GAP_MIDPOINT_DEG = 315

/**
 * Map a screen-space pointer angle (degrees, atan2 convention: 0°=east,
 * +y is downward / clockwise) to a fraction along the 270° arc that starts at
 * SW (135°) and runs clockwise through N to SE (45°). A pointer landing in the
 * 90° bottom gap snaps to the NEAREST arc end (split at the gap midpoint).
 */
function pointerAngleToFraction(angleDeg: number): number {
  const fromStart = (angleDeg - 135 + 360) % 360
  if (fromStart > ARC_SWEEP_DEG) return fromStart <= ARC_GAP_MIDPOINT_DEG ? 1 : 0
  return fromStart / ARC_SWEEP_DEG
}

/**
 * White knob riding a circular arc at `fraction` (0..1). For thermostat/light/fan.
 *
 * Display-only by default. Pass `onDragFraction` to make the knob draggable:
 * pointer capture is taken on the knob, and pointer moves are mapped to a new
 * arc fraction reported back to the parent (the parent owns the value).
 */
export function ArcKnob({ fraction, color, knobTopPx, onDragFraction }: ArcKnobProps): ReactNode {
  const deg = -135 + fraction * 270
  const rootRef = useRef<HTMLDivElement | null>(null)
  const [dragging, setDragging] = useState(false)
  const interactive = onDragFraction !== undefined
  const top = knobTopPx ?? DEFAULT_KNOB_TOP_PX

  const handlePointerDown = (e: PointerEvent<HTMLDivElement>): void => {
    if (onDragFraction === undefined) return
    e.preventDefault()
    e.stopPropagation()
    e.currentTarget.setPointerCapture?.(e.pointerId)
    setDragging(true)
  }

  const handlePointerMove = (e: PointerEvent<HTMLDivElement>): void => {
    if (onDragFraction === undefined || !dragging) return
    const root = rootRef.current
    if (root === null) return
    const rect = root.getBoundingClientRect()
    const cx = rect.left + rect.width / 2
    const cy = rect.top + rect.height / 2
    const angle = (Math.atan2(e.clientY - cy, e.clientX - cx) * 180) / Math.PI
    onDragFraction(pointerAngleToFraction(angle))
  }

  const endDrag = (e: PointerEvent<HTMLDivElement>): void => {
    if (onDragFraction === undefined) return
    e.currentTarget.releasePointerCapture?.(e.pointerId)
    setDragging(false)
  }

  return (
    <div ref={rootRef} className="absolute inset-0" style={{ transform: `rotate(${deg}deg)` }}>
      <div
        className={cn(
          'absolute left-1/2 h-5 w-5 -translate-x-1/2 rounded-full bg-white shadow',
          interactive && (dragging ? 'cursor-grabbing' : 'cursor-grab'),
        )}
        style={{ top, border: `3px solid ${color}` }}
        {...(interactive
          ? {
              onPointerDown: handlePointerDown,
              onPointerMove: handlePointerMove,
              onPointerUp: endDrag,
              onPointerCancel: endDrag,
            }
          : {})}
      />
    </div>
  )
}

interface GripTrackProps {
  readonly fraction: number
  readonly color?: string
}

/**
 * Horizontal track with a white grip thumb at `fraction` (0..1). For seek/volume/brightness.
 * @remarks display-only indicator; interactive drag is deferred to a later task.
 */
export function GripTrack({ fraction, color }: GripTrackProps): ReactNode {
  return (
    <div className="relative h-2 w-full rounded-full bg-border">
      <div
        className="absolute left-0 top-0 h-2 rounded-full"
        style={{ width: `${fraction * 100}%`, background: color ?? 'var(--color-primary)' }}
      />
      <div
        className="absolute -top-1 h-4 w-4 rounded-full bg-white shadow"
        style={{ left: `calc(${fraction * 100}% - 8px)` }}
      />
    </div>
  )
}
