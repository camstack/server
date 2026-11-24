import type { ReactElement } from 'react'
import { cn } from '../../../lib/cn'

export interface PoePortIllustrationProps {
  readonly on: boolean
  readonly className?: string
}

const PIN_XS: readonly number[] = [26, 32, 38, 44, 50, 56, 62, 68]

/**
 * An RJ45 / LAN port seen from the front: the socket with its contact pins and the two link
 * LEDs above it. The LEDs blink while the port is on and stay dark when it is off; reduced
 * motion keeps them lit and still.
 */
export function PoePortIllustration({ on, className }: PoePortIllustrationProps): ReactElement {
  return (
    <svg
      viewBox="0 0 96 96"
      aria-hidden
      data-on={on}
      data-testid="dc-poe-port-art"
      className={cn('dc-poe', on ? 'text-primary' : 'text-foreground-muted', className)}
    >
      <rect
        x={6}
        y={22}
        width={84}
        height={68}
        rx={10}
        fill="none"
        stroke="currentColor"
        strokeWidth={5}
      />
      <path
        d="M24 88 V60 H34 V48 H62 V60 H72 V88"
        fill="none"
        stroke="currentColor"
        strokeWidth={4}
        strokeLinejoin="round"
      />
      {PIN_XS.map((x) => (
        <rect key={x} x={x - 1.5} y={70} width={3} height={14} rx={1.5} fill="currentColor" />
      ))}
      <circle
        cx={22}
        cy={36}
        r={5}
        className={cn('dc-poe-led', on ? 'fill-success' : 'fill-border')}
      />
      <circle
        cx={74}
        cy={36}
        r={5}
        className={cn('dc-poe-led dc-poe-led-b', on ? 'fill-warning' : 'fill-border')}
      />
    </svg>
  )
}
