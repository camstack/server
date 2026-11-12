import type { ReactElement } from 'react'
import { cn } from '../../../lib/cn'
import { speedBand } from './AmbientFx'

export interface HeatPumpIllustrationProps {
  /** 0..100; null when the gateway does not report it (the fan stands still). */
  readonly compressorPct: number | null
  /** The fan's colour: heat (primary) or cold (info: cooling, defrost). */
  readonly cold: boolean
  readonly className?: string
}

const BLADE = 'M44 44c-3-10 0-22 8-24 7 1 4 14-8 24z'

/**
 * The outdoor unit: a casing, the fan grille and its three blades, two vents.
 * The fan turns with the compressor — faster as it works harder — and stands
 * still when the compressor is off or unreported.
 */
export function HeatPumpIllustration({
  compressorPct,
  cold,
  className,
}: HeatPumpIllustrationProps): ReactElement {
  const spinning = compressorPct !== null && compressorPct > 0
  return (
    <svg
      viewBox="0 0 120 92"
      aria-hidden
      data-spin={spinning}
      data-speed={spinning ? speedBand(compressorPct) : undefined}
      className={cn(
        'dc-hp',
        spinning ? (cold ? 'text-info' : 'text-primary') : 'text-foreground-muted',
        className,
      )}
    >
      <rect
        x={4}
        y={4}
        width={112}
        height={78}
        rx={10}
        strokeWidth={3}
        className="fill-surface-hover stroke-border"
      />
      <g fill="none" strokeWidth={2} className="stroke-foreground-muted">
        <circle cx={44} cy={44} r={30} />
        <circle cx={44} cy={44} r={20} />
        <rect x={86} y={18} width={20} height={8} rx={2} />
        <rect x={86} y={32} width={20} height={8} rx={2} />
        <path d="M20 82v6M100 82v6" />
      </g>
      <g className="dc-hp-fan" fill="currentColor">
        <path d={BLADE} />
        <path d={BLADE} transform="rotate(120 44 44)" />
        <path d={BLADE} transform="rotate(240 44 44)" />
      </g>
    </svg>
  )
}
