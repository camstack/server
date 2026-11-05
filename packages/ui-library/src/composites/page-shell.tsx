/**
 * PageShell — the one page chrome for admin-ui and addon pages.
 *
 * Gutter `p-2 sm:p-4`, `overflow-x-clip` (never `hidden` — that kills sticky
 * descendants). Optional title row (icon + title + subtitle | actions) and a
 * `nav` slot under it for hub pills / selectors.
 */
import type { LucideIcon } from 'lucide-react'
import { createContext, useContext, useState, type ReactNode, type JSX } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '../lib/cn'

/**
 * The header's actions container, or `undefined` outside a PageShell title row. `null` means the
 * shell exists but has not mounted the container yet.
 */
const HeaderActionsSlot = createContext<HTMLElement | null | undefined>(undefined)

/**
 * Put `children` in the actions area of the enclosing PageShell header, from any depth of the
 * page body (a table that owns its own Add button). Outside a shell with a title row there is no
 * header to join, so it renders inline in a right-aligned row instead.
 */
export function PageHeaderActions({
  children,
}: {
  readonly children: ReactNode
}): JSX.Element | null {
  const slot = useContext(HeaderActionsSlot)
  if (slot === undefined) {
    return <div className="flex flex-wrap items-center justify-end gap-2 px-3 pt-2">{children}</div>
  }
  // Mounted a beat after the shell: nothing is drawn meanwhile, so the button never flashes inline.
  if (slot === null) return null
  return createPortal(children, slot)
}

export interface PageShellProps {
  readonly icon?: LucideIcon
  readonly title?: string
  readonly subtitle?: ReactNode
  readonly actions?: ReactNode
  /** Selector row inside the header, under the title (hub pills, …). */
  readonly nav?: ReactNode
  /**
   * Fill the parent height (`h-full`) as a column. Header stays put; children
   * sit in a `flex-1 min-h-0` region so an inner DataTable can own the scroll.
   * Parent must own the viewport height (`FULL_HEIGHT_ROUTES` / `h-full` chain).
   */
  readonly fill?: boolean
  readonly className?: string
  readonly children: ReactNode
}

export function PageShell({
  icon: Icon,
  title,
  subtitle,
  actions,
  nav,
  fill = false,
  className,
  children,
}: PageShellProps): JSX.Element {
  const hasTitleRow = Boolean(title) || subtitle != null || actions != null
  const hasHeader = hasTitleRow || nav != null
  const [slot, setSlot] = useState<HTMLElement | null>(null)
  return (
    <HeaderActionsSlot.Provider value={hasTitleRow ? slot : undefined}>
      <div
        className={cn(
          'overflow-x-clip p-2 sm:p-4',
          fill ? 'flex h-full min-h-0 flex-col gap-4' : 'space-y-4',
          className,
        )}
      >
        {hasHeader && (
          <div className="shrink-0 space-y-3">
            {hasTitleRow && (
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                <div className="min-w-0">
                  {title !== undefined && title !== '' && (
                    <h1 className="flex items-center gap-2 text-lg font-semibold text-foreground">
                      {Icon !== undefined && (
                        <Icon className="h-4 w-4 shrink-0 text-foreground-subtle" aria-hidden />
                      )}
                      {title}
                    </h1>
                  )}
                  {subtitle != null && (
                    <p className="mt-0.5 text-xs text-foreground-subtle">{subtitle}</p>
                  )}
                </div>
                <div
                  ref={setSlot}
                  className="flex shrink-0 flex-wrap items-center gap-2 empty:hidden"
                >
                  {actions}
                </div>
              </div>
            )}
            {nav}
          </div>
        )}
        {fill ? <div className="flex min-h-0 flex-1 flex-col gap-3">{children}</div> : children}
      </div>
    </HeaderActionsSlot.Provider>
  )
}
