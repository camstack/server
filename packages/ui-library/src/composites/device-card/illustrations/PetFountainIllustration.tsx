import { type ReactElement, useId } from 'react'
import { cn } from '../../../lib/cn'

export interface PetFountainIllustrationProps {
  /** 0..1 water in the tank; null when not reported. */
  readonly water: number | null
  /** The jet runs while the pump does. */
  readonly pumping: boolean
  readonly className?: string
}

const BASIN = 'M14 56 H106 L96 108 H24 Z'
const TOP = 56
const BOTTOM = 108

/** A drinking fountain: the basin filled to the tank's level, a jet while the pump runs. */
export function PetFountainIllustration({
  water,
  pumping,
  className,
}: PetFountainIllustrationProps): ReactElement {
  const clip = `${useId()}-c`
  const level = (BOTTOM - TOP) * Math.max(0, Math.min(1, water ?? 0))
  return (
    <svg viewBox="0 0 120 116" aria-hidden data-pumping={pumping} className={className}>
      <defs>
        <clipPath id={clip}>
          <path d={BASIN} />
        </clipPath>
      </defs>
      <path d={BASIN} className="fill-surface-hover" />
      <rect
        data-testid="dc-fountain-water"
        clipPath={`url(#${clip})`}
        x={0}
        y={BOTTOM - level}
        width={120}
        height={level}
        className="fill-info opacity-60"
      />
      <path
        d={BASIN}
        fill="none"
        strokeWidth={3}
        strokeLinejoin="round"
        className="stroke-border"
      />
      <rect
        x={54}
        y={36}
        width={12}
        height={22}
        rx={3}
        className="fill-surface stroke-border"
        strokeWidth={2}
      />
      {pumping ? (
        <path
          d="M60 36 C60 18 74 14 80 30 M60 36 C60 18 46 14 40 30"
          fill="none"
          strokeWidth={4}
          strokeLinecap="round"
          className={cn('dc-jet stroke-info')}
        />
      ) : null}
    </svg>
  )
}
