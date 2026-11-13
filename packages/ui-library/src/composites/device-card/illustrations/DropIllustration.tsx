import { type ReactElement, useId } from 'react'
import { cn } from '../../../lib/cn'

export interface DropIllustrationProps {
  /** 0..1: the room's humidity the drop fills to; null draws it empty. */
  readonly fill: number | null
  /** Off: the water is drawn grey. */
  readonly off: boolean
  readonly className?: string
}

const DROP = 'M50 6 C50 6 14 50 14 76 A36 36 0 0 0 86 76 C86 50 50 6 50 6 Z'
const TOP = 6
const BOTTOM = 112

/** A humidifier: a drop filled to the room's humidity. */
export function DropIllustration({ fill, off, className }: DropIllustrationProps): ReactElement {
  const clip = `${useId()}-c`
  const level = (BOTTOM - TOP) * Math.max(0, Math.min(1, fill ?? 0))
  return (
    <svg viewBox="0 0 100 116" aria-hidden data-off={off} className={className}>
      <defs>
        <clipPath id={clip}>
          <path d={DROP} />
        </clipPath>
      </defs>
      <path d={DROP} className="fill-surface-hover" />
      <rect
        data-testid="dc-drop-water"
        clipPath={`url(#${clip})`}
        x={0}
        y={BOTTOM - level}
        width={100}
        height={level}
        className={cn(off ? 'fill-foreground-muted opacity-35' : 'fill-info opacity-70')}
      />
      <path d={DROP} fill="none" strokeWidth={3} className="stroke-border" />
    </svg>
  )
}
