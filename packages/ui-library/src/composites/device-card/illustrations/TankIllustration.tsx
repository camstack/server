import { type ReactElement, useId } from 'react'
import { cn } from '../../../lib/cn'

export interface TankIllustrationProps {
  /** 0..1: how much of the tank the water's temperature fills. */
  readonly fill: number
  /** Bubbles rise while it heats. */
  readonly heating: boolean
  /** Off: the water is drawn grey. */
  readonly off: boolean
  readonly className?: string
}

const TANK = { x: 18, y: 8, width: 64, height: 112, rx: 28 } as const

/**
 * A hot-water tank: the shell and two feet, filled to the water's temperature
 * with a cold-to-hot gradient, bubbles rising while it heats.
 */
export function TankIllustration({
  fill,
  heating,
  off,
  className,
}: TankIllustrationProps): ReactElement {
  const id = useId()
  const gradient = `${id}-g`
  const clip = `${id}-c`
  const level = TANK.height * Math.max(0, Math.min(1, fill))
  return (
    <svg viewBox="0 0 100 130" aria-hidden data-heat={heating} className={cn('dc-tank', className)}>
      <defs>
        <linearGradient id={gradient} x1="0" y1="1" x2="0" y2="0">
          <stop
            offset="0"
            stopColor="currentColor"
            className={off ? 'text-foreground-muted' : 'text-info'}
          />
          <stop
            offset="1"
            stopColor="currentColor"
            className={off ? 'text-foreground-muted' : 'text-primary'}
          />
        </linearGradient>
        <clipPath id={clip}>
          <rect {...TANK} />
        </clipPath>
      </defs>
      <g clipPath={`url(#${clip})`}>
        <rect
          data-testid="dc-tank-water"
          x={TANK.x}
          y={TANK.y + TANK.height - level}
          width={TANK.width}
          height={level}
          fill={`url(#${gradient})`}
          opacity={off ? 0.35 : 0.85}
        />
        <g className="fill-background-elevated">
          <circle className="dc-tank-bubble" cx={38} cy={112} r={3} />
          <circle className="dc-tank-bubble" cx={58} cy={114} r={2.5} />
          <circle className="dc-tank-bubble" cx={48} cy={110} r={2} />
        </g>
      </g>
      <g fill="none" strokeWidth={3} className="stroke-border">
        <rect {...TANK} />
        <path d="M40 120v6M60 120v6" strokeLinecap="round" />
      </g>
    </svg>
  )
}
