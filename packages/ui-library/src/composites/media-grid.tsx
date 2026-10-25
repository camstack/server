/**
 * MediaGrid — responsive grid of media tiles (events, frames, crops).
 * Empty and pending are distinct; never fold unanswered into empty (D315).
 */
import type { ReactNode, JSX, KeyboardEvent } from 'react'
import { cn } from '../lib/cn'
import { GRID_GAP, MEDIA_GRID } from '../lib/responsive'

export interface MediaCardProps {
  readonly children: ReactNode
  readonly selected?: boolean
  readonly onSelect?: () => void
  readonly label?: string
  readonly className?: string
  readonly testId?: string
}

export function MediaCard({
  children,
  selected = false,
  onSelect,
  label,
  className,
  testId,
}: MediaCardProps): JSX.Element {
  const interactive = onSelect !== undefined
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!interactive) return
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      onSelect()
    }
  }
  return (
    <div
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      aria-pressed={interactive ? selected : undefined}
      aria-label={label}
      data-testid={testId}
      onClick={onSelect}
      onKeyDown={onKeyDown}
      className={cn(
        'relative aspect-square min-w-0 overflow-hidden rounded-md border bg-surface',
        selected ? 'border-primary ring-1 ring-primary' : 'border-border',
        interactive && 'cursor-pointer hover:border-foreground-subtle',
        className,
      )}
    >
      {children}
    </div>
  )
}

export type MediaGridStatus = 'pending' | 'ready' | 'empty'

export interface MediaGridProps {
  readonly status: MediaGridStatus
  /** Required when status is `ready`. */
  readonly children?: ReactNode
  /** Shown when status is pending. */
  readonly pendingMessage?: string
  /** Shown when status is empty. */
  readonly emptyMessage?: string
  readonly className?: string
  readonly testId?: string
}

export function MediaGrid({
  status,
  children,
  pendingMessage = 'Loading…',
  emptyMessage = 'Nothing to show',
  className,
  testId,
}: MediaGridProps): JSX.Element {
  if (status === 'pending') {
    return (
      <p
        className="animate-pulse py-8 text-center text-xs text-foreground-subtle"
        data-testid={testId}
      >
        {pendingMessage}
      </p>
    )
  }
  if (status === 'empty') {
    return (
      <p className="py-8 text-center text-xs text-foreground-subtle" data-testid={testId}>
        {emptyMessage}
      </p>
    )
  }
  return (
    <div className={cn(MEDIA_GRID, GRID_GAP, className)} data-testid={testId}>
      {children}
    </div>
  )
}
