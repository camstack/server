import { type ReactNode, type JSX } from 'react'
import { cn } from '../lib/cn'

export interface DeviceCardBadge {
  /** Badge label text */
  label: string
  /** Optional icon rendered before the label */
  icon?: ReactNode
  /** Click handler — makes the badge interactive */
  onClick?: () => void
}

export interface DeviceCardAction {
  /** Icon to render */
  icon: ReactNode
  /** Tooltip / aria-label */
  label: string
  /** Click handler */
  onClick: () => void
}

export interface DeviceCardProps {
  /** Primary title (e.g., device name) */
  title: string
  /** Secondary text (e.g., model, IP) */
  subtitle?: string
  /** Status: determines the color of the status dot */
  status?: 'online' | 'offline' | 'warning' | 'unknown'
  /** Whether this card is currently selected */
  selected?: boolean
  /** Click handler for the card body */
  onClick?: () => void
  /** Clickable badges (e.g., stream profiles) */
  badges?: DeviceCardBadge[]
  /** Action icons shown at the bottom (e.g., PTZ, events) */
  actions?: DeviceCardAction[]
  /** Content rendered at the bottom when status is offline (e.g., Connect button) */
  offlineAction?: ReactNode
  /** Additional CSS classes */
  className?: string
}

const STATUS_COLORS = {
  online: 'bg-success',
  offline: 'bg-danger',
  warning: 'bg-warning',
  unknown: 'bg-foreground-subtle',
} as const

export function DeviceCard({
  title,
  subtitle,
  status,
  selected,
  onClick,
  badges,
  actions,
  offlineAction,
  className,
}: DeviceCardProps): JSX.Element {
  const isOffline = status === 'offline'

  return (
    <div
      onClick={onClick}
      className={cn(
        'w-full rounded-lg border p-3 text-left transition-colors',
        onClick && 'cursor-pointer',
        selected
          ? 'border-primary bg-primary/10'
          : 'border-border bg-surface hover:bg-surface-hover',
        isOffline && !selected && 'opacity-50',
        className,
      )}
    >
      {/* Header: title + status dot */}
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-medium truncate">{title}</span>
        {status && <span className={cn('h-2 w-2 rounded-full shrink-0', STATUS_COLORS[status])} />}
      </div>

      {/* Subtitle */}
      {subtitle && <div className="text-[11px] text-foreground-muted">{subtitle}</div>}

      {/* Badges */}
      {badges && badges.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-2">
          {badges.map((badge, i) => {
            const cls = cn(
              'rounded px-1.5 py-0.5 text-[10px] flex items-center gap-0.5',
              selected ? 'bg-primary/20' : 'bg-surface-hover',
              badge.onClick && 'hover:opacity-80 transition-opacity cursor-pointer',
            )
            return badge.onClick ? (
              <button
                key={i}
                onClick={(e) => {
                  e.stopPropagation()
                  badge.onClick!()
                }}
                className={cls}
              >
                {badge.icon}
                {badge.label}
              </button>
            ) : (
              <span key={i} className={cls}>
                {badge.icon}
                {badge.label}
              </span>
            )
          })}
        </div>
      )}

      {/* Actions (online) or offline action */}
      {!isOffline && actions && actions.length > 0 && (
        <div className="flex items-center gap-0.5 mt-2 -mb-1">
          {actions.map((action, i) => (
            <button
              key={i}
              onClick={(e) => {
                e.stopPropagation()
                action.onClick()
              }}
              className="p-1 rounded hover:bg-surface-hover text-foreground-subtle hover:text-foreground transition-colors"
              title={action.label}
              aria-label={action.label}
            >
              {action.icon}
            </button>
          ))}
        </div>
      )}

      {isOffline && offlineAction && (
        <div className="mt-2" onClick={(e) => e.stopPropagation()}>
          {offlineAction}
        </div>
      )}
    </div>
  )
}
