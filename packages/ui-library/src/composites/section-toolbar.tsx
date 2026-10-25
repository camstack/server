/**
 * SectionToolbar — filters / node on the left, Add (or other actions) on the
 * right, inside a SectionCard body. Owns no data.
 */
import type { ReactNode, JSX } from 'react'
import { cn } from '../lib/cn'

export interface SectionToolbarProps {
  /** Filters, NodePicker, search, … */
  readonly start?: ReactNode
  /** Add button or other primary actions. */
  readonly end?: ReactNode
  readonly className?: string
  readonly testId?: string
}

export function SectionToolbar({
  start,
  end,
  className,
  testId,
}: SectionToolbarProps): JSX.Element {
  return (
    <div
      className={cn(
        'flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between',
        className,
      )}
      data-testid={testId}
    >
      {start != null && (
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">{start}</div>
      )}
      {end != null && (
        <div className="flex shrink-0 flex-wrap items-center gap-2 sm:justify-end">{end}</div>
      )}
    </div>
  )
}
