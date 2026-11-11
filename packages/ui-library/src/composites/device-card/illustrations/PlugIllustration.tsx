import type { ReactElement } from 'react'
import { cn } from '../../../lib/cn'

export interface PlugIllustrationProps {
  readonly on: boolean
  readonly className?: string
}

/** A wall socket: frame, two holes and a status led. Grey when off. */
export function PlugIllustration({ on, className }: PlugIllustrationProps): ReactElement {
  return (
    <svg
      viewBox="0 0 96 96"
      aria-hidden
      data-on={on}
      className={cn(on ? 'text-primary' : 'text-foreground-muted', className)}
    >
      <rect
        x={6}
        y={6}
        width={84}
        height={84}
        rx={22}
        fill="none"
        stroke="currentColor"
        strokeWidth={5}
      />
      <circle cx={34} cy={44} r={5} fill="currentColor" />
      <circle cx={62} cy={44} r={5} fill="currentColor" />
      <rect
        x={38}
        y={62}
        width={20}
        height={6}
        rx={3}
        className={on ? 'fill-success' : 'fill-border'}
      />
    </svg>
  )
}
