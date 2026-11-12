import type { ReactElement } from 'react'
import { cn } from '../../../lib/cn'

export interface HeaterIllustrationProps {
  readonly on: boolean
  readonly className?: string
}

/** A free-standing heater: body, three coils and feet. The coils glow and pulse while it heats. */
export function HeaterIllustration({ on, className }: HeaterIllustrationProps): ReactElement {
  return (
    <svg
      viewBox="0 0 120 112"
      aria-hidden
      data-on={on}
      className={cn('dc-heater', on ? 'text-primary' : 'text-foreground-muted', className)}
    >
      <rect
        x={12}
        y={10}
        width={96}
        height={80}
        rx={14}
        strokeWidth={3}
        className={cn('fill-surface-hover', on ? 'stroke-primary' : 'stroke-border')}
      />
      <path
        d="M30 32h60M30 50h60M30 68h60"
        fill="none"
        stroke="currentColor"
        strokeWidth={5}
        strokeLinecap="round"
        className="dc-heater-coil"
      />
      <rect x={26} y={92} width={16} height={10} rx={3} className="fill-foreground-muted" />
      <rect x={78} y={92} width={16} height={10} rx={3} className="fill-foreground-muted" />
    </svg>
  )
}
