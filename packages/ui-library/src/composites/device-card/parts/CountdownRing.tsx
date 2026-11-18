import type { ReactElement, ReactNode } from 'react'
import { cn } from '../../../lib/cn'
import { DIAL_BOX_CLASS, DIAL_GEOMETRY, DIAL_TONE_CLASS } from './Dial'

export type CountdownRingTone = 'danger' | 'muted'

export interface CountdownRingProps {
  /**
   * Share of the run still to go, 0..1, drawn as the arc's fill. `null` with
   * `busy`: the run has no known length — the whole arc pulses, no fill is
   * invented.
   */
  readonly fraction: number | null
  /** Something runs with no known end: a pulsing ring. */
  readonly busy: boolean
  readonly tone: CountdownRingTone
  /** The control at the centre (a round button). */
  readonly children: ReactNode
  readonly testId?: string
}

const { size, center, radius, arc, startDeg } = DIAL_GEOMETRY

const TONE: Readonly<Record<CountdownRingTone, string>> = {
  danger: 'text-danger',
  muted: DIAL_TONE_CLASS.muted,
}

/**
 * A control inside the card's arc that counts down: the same 270 degree track
 * as the {@link Dial}, filled with what is left of a timed run, pulsing when
 * the run has no known end, empty when nothing runs. Read-only — the control
 * is the child at its centre.
 */
export function CountdownRing({
  fraction,
  busy,
  tone,
  children,
  testId,
}: CountdownRingProps): ReactElement {
  const fill = fraction === null ? null : Math.min(1, Math.max(0, fraction))
  const state = fill !== null ? 'timed' : busy ? 'busy' : 'idle'
  return (
    <div className={DIAL_BOX_CLASS} data-testid={testId} data-ring={state}>
      <svg
        viewBox={`0 0 ${size} ${size}`}
        className={cn('pointer-events-none absolute inset-0 h-full w-full', TONE[tone])}
        aria-hidden="true"
      >
        <circle
          cx={center}
          cy={center}
          r={radius}
          strokeWidth={10}
          fill="none"
          className="text-border"
          stroke="currentColor"
          strokeLinecap="round"
          strokeDasharray={`${arc} 400`}
          transform={`rotate(${startDeg} ${center} ${center})`}
        />
        {state === 'idle' || fill === 0 ? null : (
          <circle
            cx={center}
            cy={center}
            r={radius}
            strokeWidth={10}
            fill="none"
            className={cn(
              'transition-[stroke-dasharray] duration-1000 ease-linear',
              state === 'busy' && 'animate-pulse',
            )}
            stroke="currentColor"
            strokeLinecap="round"
            strokeDasharray={`${(fill ?? 1) * arc} 400`}
            transform={`rotate(${startDeg} ${center} ${center})`}
            data-testid={testId === undefined ? undefined : `${testId}-fill`}
          />
        )}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5">
        {children}
      </div>
    </div>
  )
}
