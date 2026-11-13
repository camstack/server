import { type ReactElement, useId } from 'react'
import { cn } from '../../../lib/cn'

export interface PetFeederIllustrationProps {
  /** 0..1 food left in the hopper; null when not reported. */
  readonly food: number | null
  /** Food is in the bowl. */
  readonly bowlFull: boolean
  /** Low food: the kibble is drawn in the warning colour. */
  readonly low: boolean
  /** Kibble falls while it dispenses. */
  readonly feeding: boolean
  readonly className?: string
}

const HOPPER = { x: 26, y: 6, width: 68, height: 72, rx: 12 } as const

/** A feeder: the hopper emptying to its food level over a bowl; kibble falls while it feeds. */
export function PetFeederIllustration({
  food,
  bowlFull,
  low,
  feeding,
  className,
}: PetFeederIllustrationProps): ReactElement {
  const clip = `${useId()}-c`
  const level = HOPPER.height * Math.max(0, Math.min(1, food ?? 0))
  const kibble = low ? 'fill-warning' : 'fill-primary'
  return (
    <svg viewBox="0 0 120 120" aria-hidden data-feeding={feeding} className={className}>
      <defs>
        <clipPath id={clip}>
          <rect {...HOPPER} />
        </clipPath>
      </defs>
      <rect {...HOPPER} className="fill-surface-hover" />
      <rect
        data-testid="dc-feeder-food"
        clipPath={`url(#${clip})`}
        x={HOPPER.x}
        y={HOPPER.y + HOPPER.height - level}
        width={HOPPER.width}
        height={level}
        className={cn(kibble, 'opacity-70')}
      />
      <rect {...HOPPER} fill="none" strokeWidth={3} className="stroke-border" />
      <path d="M52 78 H68 V88 H52 Z" className="fill-surface-hover stroke-border" strokeWidth={2} />
      {feeding ? (
        <g className={kibble}>
          <circle className="dc-wave" cx={58} cy={94} r={3} />
          <circle className="dc-wave" cx={63} cy={99} r={3} />
        </g>
      ) : null}
      <path
        d="M24 100 H96 L88 116 H32 Z"
        strokeWidth={3}
        strokeLinejoin="round"
        className="fill-surface-hover stroke-border"
      />
      {bowlFull ? <ellipse cx={60} cy={101} rx={28} ry={4} className={kibble} /> : null}
    </svg>
  )
}
