import { type ReactNode, type JSX } from 'react'
import { type LucideIcon } from 'lucide-react'
import { cn } from '../lib/cn'

export interface EmptyStateProps {
  icon?: LucideIcon
  title: string
  description?: string
  action?: ReactNode
  className?: string
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: EmptyStateProps): JSX.Element {
  return (
    <div className={cn('flex flex-col items-center justify-center gap-3 py-12', className)}>
      {Icon && <Icon className="h-12 w-12 text-foreground-subtle" aria-hidden="true" />}
      <div className="flex flex-col items-center gap-1 text-center">
        <p className="text-foreground-muted text-sm font-medium">{title}</p>
        {description && <p className="text-foreground-subtle text-xs max-w-xs">{description}</p>}
      </div>
      {action && <div className="mt-1">{action}</div>}
    </div>
  )
}
