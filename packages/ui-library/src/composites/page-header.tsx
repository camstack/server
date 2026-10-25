/**
 * @deprecated Prefer `PageShell` for the full page frame (gutter + optional nav).
 * Kept for title-row-only call sites that already pad themselves.
 */
import { type ReactNode, type JSX } from 'react'
import { cn } from '../lib/cn'

export interface PageHeaderProps {
  title: string
  subtitle?: string
  actions?: ReactNode
  className?: string
}

export function PageHeader({ title, subtitle, actions, className }: PageHeaderProps): JSX.Element {
  return (
    <div
      className={cn(
        'mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between',
        className,
      )}
    >
      <div className="min-w-0">
        <h1 className="text-lg font-semibold text-foreground">{title}</h1>
        {subtitle !== undefined && subtitle !== '' && (
          <p className="mt-0.5 text-xs text-foreground-subtle">{subtitle}</p>
        )}
      </div>
      {actions !== undefined && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}
