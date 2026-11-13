import type { ReactElement } from 'react'
import { cn } from '../../../lib/cn'

export interface ValveIllustrationProps {
  /** 0 closed .. 1 open; null when the position is not known. */
  readonly openness: number | null
  /** Water runs through the pipe. */
  readonly flowing: boolean
  readonly className?: string
}

/**
 * A pipe with a lever valve: the lever lies along the pipe when open and
 * across it when closed (in between for a partial position); water runs
 * while it is open.
 */
export function ValveIllustration({
  openness,
  flowing,
  className,
}: ValveIllustrationProps): ReactElement {
  const angle = openness === null ? 45 : Math.round(90 * (1 - Math.max(0, Math.min(1, openness))))
  return (
    <svg viewBox="0 0 120 100" aria-hidden data-flowing={flowing} className={className}>
      <rect
        x={4}
        y={56}
        width={112}
        height={22}
        rx={6}
        className="fill-surface-hover stroke-border"
        strokeWidth={3}
      />
      {flowing ? (
        <path
          d="M8 67 H112"
          fill="none"
          strokeWidth={8}
          strokeLinecap="round"
          strokeDasharray="10 12"
          className="dc-wave stroke-info opacity-70"
        />
      ) : null}
      <rect
        x={44}
        y={48}
        width={32}
        height={38}
        rx={6}
        className="fill-surface stroke-border"
        strokeWidth={3}
      />
      <path
        d="M60 48 V34"
        strokeWidth={6}
        strokeLinecap="round"
        className="stroke-foreground-muted"
      />
      <g transform={`rotate(${-angle} 60 32)`}>
        <rect
          data-testid="dc-valve-lever"
          x={30}
          y={26}
          width={60}
          height={12}
          rx={6}
          className={cn(flowing ? 'fill-info' : 'fill-danger')}
        />
      </g>
      <circle cx={60} cy={32} r={5} className="fill-surface" />
    </svg>
  )
}
