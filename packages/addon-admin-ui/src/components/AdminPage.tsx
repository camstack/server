/**
 * AdminPage — thin wrapper around library `PageShell` for `/system/*`.
 * Prefer importing `PageShell` from `@camstack/ui-library` in new code.
 */
import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import { PageShell } from '@camstack/ui-library'

interface AdminPageProps {
  readonly icon?: LucideIcon
  readonly title?: string
  readonly subtitle?: ReactNode
  readonly actions?: ReactNode
  /** A selector row rendered inside the header, under the title. */
  readonly nav?: ReactNode
  /**
   * Body-only: no PageShell gutter/title. Use under `SectionedPage` so the
   * section does not stack a second page chrome.
   */
  readonly embedded?: boolean
  readonly children: ReactNode
}

export function AdminPage({
  icon,
  title,
  subtitle,
  actions,
  nav,
  embedded = false,
  children,
}: AdminPageProps) {
  if (embedded) return <>{children}</>
  return (
    <PageShell icon={icon} title={title} subtitle={subtitle} actions={actions} nav={nav}>
      {children}
    </PageShell>
  )
}
