import type { ReactElement } from 'react'
import { cn } from '../../../lib/cn'

export interface SirenIllustrationProps {
  readonly sounding: boolean
  readonly className?: string
}

/** A siren horn; sound waves pulse out of it while it sounds. */
export function SirenIllustration({ sounding, className }: SirenIllustrationProps): ReactElement {
  return (
    <svg viewBox="0 0 120 100" aria-hidden data-sounding={sounding} className={className}>
      <path
        d="M14 38 H34 L66 16 V84 L34 62 H14 Z"
        strokeWidth={3}
        strokeLinejoin="round"
        className={cn(sounding ? 'fill-danger stroke-danger' : 'fill-surface-hover stroke-border')}
      />
      {sounding ? (
        <g fill="none" strokeWidth={5} strokeLinecap="round" className="stroke-danger">
          <path className="dc-wave" d="M78 36 Q86 50 78 64" />
          <path className="dc-wave" d="M90 26 Q104 50 90 74" />
          <path className="dc-wave" d="M102 16 Q122 50 102 84" />
        </g>
      ) : null}
    </svg>
  )
}
