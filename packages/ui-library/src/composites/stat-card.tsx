import { type ComponentType, type JSX } from 'react'
import { TrendingUp, TrendingDown } from 'lucide-react'
import { cn } from '../lib/cn'

export interface StatCardProps {
  value: string | number
  label: string
  /** Optional leading icon in the label row. */
  icon?: ComponentType<{ className?: string }>
  /** Secondary line under the value (units, targets, …). */
  subtext?: string
  /**
   * Token utility for the value colour (e.g. `text-success`). Prefer a
   * semantic token — never a palette class or hex.
   */
  valueClassName?: string
  trend?: { value: number; direction: 'up' | 'down' }
  className?: string
}

export function StatCard({
  value,
  label,
  icon: Icon,
  subtext,
  valueClassName,
  trend,
  className,
}: StatCardProps): JSX.Element {
  return (
    <div
      className={cn('rounded-lg border border-border bg-surface p-2 sm:p-2.5 min-w-0', className)}
    >
      <div className="flex items-center gap-1.5 mb-0.5 min-w-0">
        {Icon && <Icon className="h-3 w-3 text-foreground-subtle flex-shrink-0" />}
        <span
          className="text-[10px] text-foreground-subtle uppercase tracking-wider whitespace-nowrap overflow-hidden text-ellipsis min-w-0"
          title={label}
        >
          {label}
        </span>
      </div>
      <div className="flex items-baseline gap-2 min-w-0">
        <p
          className={cn(
            'text-lg font-semibold leading-tight whitespace-nowrap overflow-hidden text-ellipsis min-w-0',
            valueClassName ?? 'text-foreground',
          )}
          title={String(value)}
        >
          {value}
        </p>
        {trend && (
          <span
            className={cn(
              'inline-flex items-center gap-0.5 text-xs font-medium shrink-0',
              trend.direction === 'up' ? 'text-success' : 'text-danger',
            )}
          >
            {trend.direction === 'up' ? (
              <TrendingUp className="h-3 w-3" />
            ) : (
              <TrendingDown className="h-3 w-3" />
            )}
            {trend.value}%
          </span>
        )}
      </div>
      {subtext && (
        <p className="text-[10px] text-foreground-subtle mt-0.5 truncate" title={subtext}>
          {subtext}
        </p>
      )}
    </div>
  )
}
