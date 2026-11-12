import type { CSSProperties, ReactElement } from 'react'
import { cn } from '../../../lib/cn'
import { speedBand } from './AmbientFx'

/** One oscillation axis as drawn: sweeping between two angles, or held at one. */
export interface FanAxisDrawing {
  readonly oscillating: boolean
  readonly from: number
  readonly to: number
  readonly fixed: number
}

export interface FanIllustrationProps {
  readonly on: boolean
  /** 0..100; null for a fan without a speed (it spins at a middle pace). */
  readonly speed: number | null
  readonly reverse: boolean
  /** The whole head sways (a fan with one oscillation switch). */
  readonly sway: boolean
  /** Per-axis oscillation, for a fan that reports its axes; null when it does not. */
  readonly axes: { readonly horizontal: FanAxisDrawing; readonly vertical: FanAxisDrawing } | null
  readonly className?: string
}

const BLADE = 'M60 60c-6-16-2-38 12-42 12 2 8 24-12 42z'
const DEFAULT_SPEED = 60
/** Device degrees to drawn degrees: a full sweep would turn the drawing edge-on. */
const AXIS_DRAW_SCALE = 0.6

function FanSvg(): ReactElement {
  return (
    <svg viewBox="0 0 120 120" aria-hidden className="h-full w-full">
      <circle cx={60} cy={60} r={56} fill="none" strokeWidth={3} className="stroke-border" />
      <g className="dc-fan-blades fill-current">
        <path d={BLADE} />
        <path d={BLADE} transform="rotate(120 60 60)" />
        <path d={BLADE} transform="rotate(240 60 60)" />
      </g>
      <circle cx={60} cy={60} r={8} className="fill-foreground" />
    </svg>
  )
}

/** The axis' angles as the stylesheet's custom properties (vertical tilts the other way). */
type AxisVars = CSSProperties & Readonly<Record<'--dc-a0' | '--dc-a1' | '--dc-af', string>>

function axisVars(axis: FanAxisDrawing, sign: 1 | -1): AxisVars {
  const deg = (v: number): string => `${sign * v * AXIS_DRAW_SCALE}deg`
  return { '--dc-a0': deg(axis.from), '--dc-a1': deg(axis.to), '--dc-af': deg(axis.fixed) }
}

/**
 * A fan seen from the front: the blades spin with the speed and turn the other
 * way in reverse; the head sways while it oscillates, per axis when the fan
 * reports them. Still when off.
 */
export function FanIllustration({
  on,
  speed,
  reverse,
  sway,
  axes,
  className,
}: FanIllustrationProps): ReactElement {
  const pace = speed ?? DEFAULT_SPEED
  const spinning = on && pace > 0
  return (
    <div
      data-testid="dc-fan-img"
      data-spin={spinning}
      data-reverse={reverse}
      data-sway={on && sway && axes === null}
      data-speed={speedBand(pace)}
      className={cn('dc-fan', on ? 'text-info' : 'text-foreground-muted', className)}
    >
      {axes === null ? (
        <FanSvg />
      ) : (
        <div
          className="dc-fan-h h-full w-full"
          data-osc={on && axes.horizontal.oscillating}
          style={axisVars(axes.horizontal, 1)} // ui-check-ok: computed geometry, the head's turn per the device's angles
        >
          <div
            className="dc-fan-v h-full w-full"
            data-osc={on && axes.vertical.oscillating}
            style={axisVars(axes.vertical, -1)} // ui-check-ok: computed geometry, the head's tilt per the device's angles
          >
            <FanSvg />
          </div>
        </div>
      )}
    </div>
  )
}
