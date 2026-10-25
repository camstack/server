import { useUiText } from '../contexts/ui-text'
import { cn } from '../lib/cn'
import { type JSX } from 'react'

export type StatusBadgeStatus =
  | 'online'
  | 'offline'
  | 'degraded'
  | 'unknown'
  | 'running'
  | 'stopped'
  | 'error'
  | 'idle'
  | 'enabled'
  | 'disabled'

export interface StatusBadgeProps {
  status: StatusBadgeStatus
  /** Overrides the default label of `status` (e.g. a raw process state). */
  label?: string
  showDot?: boolean
  showLabel?: boolean
  size?: 'sm' | 'md'
  className?: string
}

const statusConfig: Record<
  StatusBadgeStatus,
  { colorClass: string; labelKey: string; labelFallback: string }
> = {
  online: {
    colorClass: 'bg-success',
    labelKey: 'uiLibrary.statusBadge.online',
    labelFallback: 'Online',
  },
  offline: {
    colorClass: 'bg-danger',
    labelKey: 'uiLibrary.statusBadge.offline',
    labelFallback: 'Offline',
  },
  degraded: {
    colorClass: 'bg-warning',
    labelKey: 'uiLibrary.statusBadge.degraded',
    labelFallback: 'Degraded',
  },
  unknown: {
    colorClass: 'bg-foreground-subtle',
    labelKey: 'uiLibrary.statusBadge.unknown',
    labelFallback: 'Unknown',
  },
  running: {
    colorClass: 'bg-success',
    labelKey: 'uiLibrary.statusBadge.running',
    labelFallback: 'Running',
  },
  stopped: {
    colorClass: 'bg-foreground-subtle',
    labelKey: 'uiLibrary.statusBadge.stopped',
    labelFallback: 'Stopped',
  },
  error: {
    colorClass: 'bg-danger',
    labelKey: 'uiLibrary.statusBadge.error',
    labelFallback: 'Error',
  },
  idle: { colorClass: 'bg-info', labelKey: 'uiLibrary.statusBadge.idle', labelFallback: 'Idle' },
  enabled: {
    colorClass: 'bg-success',
    labelKey: 'uiLibrary.statusBadge.enabled',
    labelFallback: 'Enabled',
  },
  disabled: {
    colorClass: 'bg-warning',
    labelKey: 'uiLibrary.statusBadge.disabled',
    labelFallback: 'Disabled',
  },
}

export function StatusBadge({
  status,
  label,
  showDot = true,
  showLabel = true,
  size = 'sm',
  className,
}: StatusBadgeProps): JSX.Element {
  const t = useUiText()
  const config = statusConfig[status]

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5',
        size === 'sm' ? 'text-xs' : 'text-sm',
        className,
      )}
    >
      {showDot && (
        <span
          className={cn('h-1.5 w-1.5 shrink-0 rounded-full', config.colorClass)}
          aria-hidden="true"
        />
      )}
      {showLabel && (
        <span className="text-foreground">{label ?? t(config.labelKey, config.labelFallback)}</span>
      )}
    </span>
  )
}
