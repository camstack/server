import type { ReactElement } from 'react'
import { cn } from '../../../lib/cn'

export interface LevelBarProps {
  /** 0..100. */
  readonly percent: number
  readonly low?: boolean
  readonly ariaLabel: string
  readonly className?: string
}

/** A thin horizontal level (a consumable, a tank, a battery). */
export function LevelBar({ percent, low, ariaLabel, className }: LevelBarProps): ReactElement {
  const p = Math.min(100, Math.max(0, Math.round(percent)))
  return (
    <svg
      viewBox="0 0 100 6"
      preserveAspectRatio="none"
      role="meter"
      aria-label={ariaLabel}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={p}
      className={cn('h-1.5 w-full', low === true ? 'text-danger' : 'text-success', className)}
    >
      <rect width={100} height={6} rx={3} className="fill-surface-hover" />
      <rect width={p} height={6} rx={3} fill="currentColor" />
    </svg>
  )
}
