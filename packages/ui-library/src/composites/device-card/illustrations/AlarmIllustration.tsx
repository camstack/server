import type { ReactElement } from 'react'
import { cn } from '../../../lib/cn'

export type AlarmLook = 'disarmed' | 'armed' | 'arming' | 'triggered'

export interface AlarmIllustrationProps {
  readonly look: AlarmLook
  readonly className?: string
}

const SHIELD = 'M52 8 L90 22 V52 C90 78 74 96 52 104 C30 96 14 78 14 52 V22 Z'

const BODY: Readonly<Record<AlarmLook, string>> = {
  disarmed: 'fill-surface-hover stroke-border',
  armed: 'fill-success stroke-success',
  arming: 'fill-warning stroke-warning',
  triggered: 'fill-danger stroke-danger',
}

/**
 * An alarm panel's shield: grey disarmed, green with a check armed, amber
 * with a widening ring while it arms (or counts down), red with "!" when it
 * has gone off.
 */
export function AlarmIllustration({ look, className }: AlarmIllustrationProps): ReactElement {
  return (
    <svg
      viewBox="0 0 104 112"
      aria-hidden
      data-look={look}
      className={cn('overflow-visible', className)}
    >
      {look === 'arming' ? (
        <path d={SHIELD} fill="none" strokeWidth={3} className="dc-ring-pulse stroke-warning" />
      ) : null}
      <path d={SHIELD} strokeWidth={3} strokeLinejoin="round" className={BODY[look]} />
      {look === 'armed' ? (
        <path
          d="M36 56 L48 68 L70 44"
          fill="none"
          strokeWidth={8}
          strokeLinecap="round"
          strokeLinejoin="round"
          className="stroke-surface"
        />
      ) : null}
      {look === 'triggered' ? (
        <>
          <rect x={47} y={32} width={10} height={36} rx={5} className="fill-surface" />
          <circle cx={52} cy={80} r={6} className="fill-surface" />
        </>
      ) : null}
      {look === 'disarmed' ? (
        <path
          d="M52 34 V74"
          fill="none"
          strokeWidth={6}
          strokeLinecap="round"
          className="stroke-foreground-muted opacity-40"
        />
      ) : null}
    </svg>
  )
}
