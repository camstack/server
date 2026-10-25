/**
 * Shared pill chrome for page-header selectors (IntegrationHub providers,
 * Build-your-self sections). Links, not `role="tab"`: choosing one changes
 * the address; `nav` + `aria-current="page"` is the honest pattern.
 *
 * Pills WRAP — same rule as the Nodes fleet strip and IntegrationPills.
 */
import type { ReactElement, ReactNode } from 'react'
import { Link } from 'react-router-dom'

export const PILL_BASE =
  'inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-full border py-1 pl-1 pr-2.5 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40'

export const PILL_CURRENT = 'border-primary bg-primary/10 text-primary font-medium'
export const PILL_OTHER =
  'border-border bg-surface text-foreground-subtle hover:bg-surface-hover hover:text-foreground'

export interface HeaderPillItem {
  readonly id: string
  readonly label: ReactNode
  readonly href: string
  readonly current: boolean
  readonly testId?: string
}

export interface HeaderPillsProps {
  /** Names the selector for assistive tech. */
  readonly label: string
  readonly items: readonly HeaderPillItem[]
  /** When true, left-click replaces history (filter-style tab switches). */
  readonly replace?: boolean
}

export function HeaderPills({ label, items, replace = false }: HeaderPillsProps): ReactElement {
  return (
    <nav aria-label={label} className="flex min-w-0 flex-wrap items-center gap-1.5">
      {items.map((item) => (
        <Link
          key={item.id}
          to={item.href}
          replace={replace}
          aria-current={item.current ? 'page' : undefined}
          className={`${PILL_BASE} ${item.current ? PILL_CURRENT : PILL_OTHER} pl-2.5`}
          data-testid={item.testId ?? `header-pill-${item.id}`}
        >
          <span className="truncate">{item.label}</span>
        </Link>
      ))}
    </nav>
  )
}
