/**
 * RunningBadge — ring or idle mark around a device lead icon (D933).
 * `null` = unknown (unanswered or cap reported null): children only.
 */
import type { ReactNode } from 'react'
import { useUiText } from '../contexts/ui-text'
import { cn } from '../lib/cn'
import { runningStatusParts } from './running-status'

export interface RunningBadgeProps {
  /** true = running, false = idle, null = unknown. */
  readonly running: boolean | null
  readonly children: ReactNode
  readonly className?: string
}

export function RunningBadge({ running, children, className }: RunningBadgeProps): ReactNode {
  const t = useUiText()
  if (running === null) {
    return (
      <span data-running="unknown" className={cn('inline-flex shrink-0', className)}>
        {children}
      </span>
    )
  }
  if (running === true) {
    return (
      <span
        data-running="running"
        className={cn('relative inline-flex shrink-0 rounded-full p-0.5', className)}
        aria-label={t('uiLibrary.runningBadge.running', 'Running')}
      >
        <span
          className="pointer-events-none absolute inset-0 rounded-full border border-primary animate-pulse"
          aria-hidden
        />
        {children}
      </span>
    )
  }
  return (
    <span
      data-running="idle"
      className={cn('relative inline-flex shrink-0', className)}
      aria-label={t('uiLibrary.runningBadge.idle', 'Idle')}
    >
      {children}
      <span
        className="pointer-events-none absolute -bottom-px -right-px h-1.5 w-1.5 rounded-full bg-foreground-subtle"
        aria-hidden
      />
    </span>
  )
}

export interface RunningStatusLineProps {
  readonly running: boolean | null
  readonly since: number | null
  readonly phase: string | null
  readonly className?: string
  readonly now?: number
}

export function RunningStatusLine({
  running,
  since,
  phase,
  className,
  now = Date.now(),
}: RunningStatusLineProps): ReactNode {
  const t = useUiText()
  const parts = runningStatusParts(running, since, phase, now)
  // No boolean yet (a sensor, a group helper): the badge is absent too.
  // Drawing "Unknown" reads as a failed reading.
  if (parts.key === 'unknown' || (running !== true && running !== false)) return null
  if (parts.key === 'idle') {
    const base = t('uiLibrary.runningStatus.idle', 'Idle')
    const text =
      parts.phase === undefined
        ? base
        : t('uiLibrary.runningStatus.withPhase', '{{state}} · {{phase}}', {
            state: base,
            phase: parts.phase,
          })
    return <p className={cn('text-[11px] text-foreground-muted', className)}>{text}</p>
  }
  let base: string
  if (parts.duration === undefined) {
    base = t('uiLibrary.runningStatus.running', 'Running')
  } else if ('minutes' in parts.duration) {
    base = t('uiLibrary.runningStatus.runningForMinutes', 'Running for {{count}} min', {
      count: parts.duration.minutes,
    })
  } else {
    base = t('uiLibrary.runningStatus.runningForHours', 'Running for {{count}} h', {
      count: parts.duration.hours,
    })
  }
  const text =
    parts.phase === undefined
      ? base
      : t('uiLibrary.runningStatus.withPhase', '{{state}} · {{phase}}', {
          state: base,
          phase: parts.phase,
        })
  return <p className={cn('text-[11px] text-foreground-muted', className)}>{text}</p>
}
