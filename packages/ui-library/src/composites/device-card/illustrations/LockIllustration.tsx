import type { ReactElement } from 'react'
import { cn } from '../../../lib/cn'

export type LockLook = 'locked' | 'unlocked' | 'jammed' | 'moving'

export interface LockIllustrationProps {
  readonly look: LockLook
  readonly className?: string
}

const BODY: Readonly<Record<LockLook, string>> = {
  locked: 'fill-success',
  unlocked: 'fill-warning',
  jammed: 'fill-danger',
  moving: 'fill-warning',
}

/**
 * A padlock: green locked, amber unlocked (the shackle lifts), red jammed; it
 * rocks while it moves (still under reduced motion).
 */
export function LockIllustration({ look, className }: LockIllustrationProps): ReactElement {
  const open = look === 'unlocked'
  return (
    <svg
      viewBox="0 0 104 112"
      aria-hidden
      data-look={look}
      className={cn('overflow-visible', look === 'moving' && 'dc-lock-moving', className)}
    >
      <path
        d="M30 52 V34 a22 22 0 0 1 44 0 V52"
        fill="none"
        strokeWidth={9}
        strokeLinecap="round"
        className={cn(
          'stroke-foreground-muted transition-transform duration-500 [transform-origin:72px_54px]',
          open && '-translate-x-4 -translate-y-3 -rotate-[18deg]',
        )}
      />
      <rect x={16} y={50} width={72} height={56} rx={12} className={BODY[look]} />
      <circle cx={52} cy={72} r={7} className="fill-surface" />
      <rect x={48.5} y={74} width={7} height={16} rx={3} className="fill-surface" />
    </svg>
  )
}
