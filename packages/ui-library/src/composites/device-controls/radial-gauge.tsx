import type { ReactNode } from 'react'
import { ArcKnob, KNOB_HALF_PX } from './atoms'

/**
 * Shared radial gauge for the Light (brightness) and Fan (speed) heroes.
 *
 * Renders a 270° SVG ring (track + fill) with an ArcKnob riding the rim at
 * `fraction` (0..1) and a centered label. The SVG is rotated 135° so the 90°
 * gap sits at the bottom — matching the thermostat gauge geometry.
 *
 * Display-only by default; pass `onDragFraction` to make the knob draggable.
 */

// ── SVG gauge constants ───────────────────────────────────────────────────────

/** Gauge dimensions — viewBox 150×150, radius 64, stroke-width 11. */
const GAUGE_SIZE = 150
const GAUGE_RADIUS = 64
const GAUGE_CENTER = GAUGE_SIZE / 2
const GAUGE_CIRCUMFERENCE = 2 * Math.PI * GAUGE_RADIUS
/** 270 / 360 of the full circumference — the visible arc length. */
const GAUGE_ARC_LENGTH = GAUGE_CIRCUMFERENCE * (270 / 360)

export interface RadialGaugeProps {
  /** Fill fraction 0..1 (brightness or speed level). */
  readonly fraction: number
  /** Hex/CSS colour for the fill arc + knob border. */
  readonly color: string
  /** Centered content (icon + value readout). */
  readonly children: ReactNode
  /**
   * When provided, the ArcKnob becomes draggable: dragging it reports the new
   * arc fraction (0..1) to the parent, which owns the value and re-renders the
   * gauge at the new `fraction`. When omitted the knob is display-only.
   */
  readonly onDragFraction?: (fraction: number) => void
}

/**
 * Circular gauge with an ArcKnob at `fraction` and centered children.
 * The knob wrapper carries `data-testid="arc-knob"` for test assertions.
 */
export function RadialGauge({
  fraction,
  color,
  children,
  onDragFraction,
}: RadialGaugeProps): ReactNode {
  const clamped = Math.min(1, Math.max(0, fraction))
  const cx = GAUGE_SIZE / 2
  const cy = GAUGE_SIZE / 2
  const gap = GAUGE_CIRCUMFERENCE - GAUGE_ARC_LENGTH
  const fillLength = clamped * GAUGE_ARC_LENGTH

  return (
    <div className="relative" style={{ width: GAUGE_SIZE, height: GAUGE_SIZE }}>
      <svg
        width={GAUGE_SIZE}
        height={GAUGE_SIZE}
        viewBox={`0 0 ${GAUGE_SIZE} ${GAUGE_SIZE}`}
        aria-hidden="true"
        className="absolute inset-0"
        style={{ transform: 'rotate(135deg)' }}
      >
        {/* Track */}
        <circle
          cx={cx}
          cy={cy}
          r={GAUGE_RADIUS}
          fill="none"
          stroke="var(--color-border)"
          strokeWidth={11}
          strokeDasharray={`${GAUGE_ARC_LENGTH} ${gap}`}
          strokeLinecap="round"
        />
        {/* Fill */}
        <circle
          cx={cx}
          cy={cy}
          r={GAUGE_RADIUS}
          fill="none"
          stroke={color}
          strokeWidth={11}
          strokeDasharray={`${fillLength} ${GAUGE_CIRCUMFERENCE - fillLength}`}
          strokeLinecap="round"
        />
      </svg>

      {/* Knob riding the rim. knobTopPx = containerCentre − ringRadius − knobHalf
          = 75 − 64 − 10 = 1, so the knob CENTRE sits on the ring centre radius. */}
      <div data-testid="arc-knob">
        <ArcKnob
          fraction={clamped}
          color={color}
          knobTopPx={GAUGE_CENTER - GAUGE_RADIUS - KNOB_HALF_PX}
          {...(onDragFraction !== undefined ? { onDragFraction } : {})}
        />
      </div>

      {/* Centered label */}
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-0.5 pointer-events-none">
        {children}
      </div>
    </div>
  )
}
