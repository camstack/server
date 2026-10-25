import { useUiText } from '../../contexts/ui-text'
import { type ReactNode, useState, type JSX } from 'react'
import { ChevronRight, Menu } from 'lucide-react'
import { cn } from '../../lib/cn'
import { useIsMobile } from '../../hooks/use-is-mobile'
import { MobileDrawer } from '../../primitives/mobile-drawer'
import { Sidebar, type SidebarProps } from './sidebar'

export interface AppShellProps {
  sidebar: SidebarProps
  header?: {
    breadcrumbs?: { label: string; href?: string }[]
    actions?: ReactNode
  }
  /** Content shown in the center of the mobile top bar (e.g. logo) */
  mobileLogo?: ReactNode
  /** Content shown on the right side of the mobile top bar (e.g. avatar menu) */
  mobileActions?: ReactNode
  children: ReactNode
  className?: string
}

export function AppShell({
  sidebar,
  header,
  mobileLogo,
  mobileActions,
  children,
  className,
}: AppShellProps): JSX.Element {
  const t = useUiText()
  const isMobile = useIsMobile()
  const [drawerOpen, setDrawerOpen] = useState(false)

  return (
    <div className={cn('flex h-screen', className)}>
      {/* Desktop sidebar */}
      {!isMobile && <Sidebar {...sidebar} className={cn('w-44', sidebar.className)} />}

      {/* Mobile drawer */}
      {isMobile && (
        <MobileDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} width="w-64">
          <Sidebar
            {...sidebar}
            onNavigate={() => setDrawerOpen(false)}
            className="w-full border-r-0"
          />
        </MobileDrawer>
      )}

      <div className="flex flex-1 flex-col min-w-0">
        {/* Mobile top bar */}
        {isMobile && (
          <header className="flex items-center h-12 border-b border-border px-3 shrink-0 bg-surface/80 backdrop-blur-sm">
            <button
              onClick={() => setDrawerOpen(true)}
              className="p-1.5 -ml-1.5 rounded-md hover:bg-surface-hover text-foreground-muted transition-colors"
              aria-label={t('uiLibrary.appShell.openMenu', 'Open menu')}
            >
              <Menu className="h-5 w-5" />
            </button>
            {mobileLogo && <div className="flex-1 flex justify-center">{mobileLogo}</div>}
            {mobileActions && <div className="shrink-0">{mobileActions}</div>}
          </header>
        )}

        {/* Desktop breadcrumb header */}
        {!isMobile && header && (
          <header className="flex items-center h-10 border-b border-border px-4 shrink-0">
            {header.breadcrumbs && header.breadcrumbs.length > 0 && (
              <nav className="flex items-center gap-1 text-xs flex-1 min-w-0">
                {header.breadcrumbs.map((crumb, index) => {
                  const isLast = index === header.breadcrumbs!.length - 1
                  return (
                    <span key={index} className="flex items-center gap-1">
                      {index > 0 && (
                        <ChevronRight className="h-3 w-3 text-foreground-subtle shrink-0" />
                      )}
                      {crumb.href && !isLast ? (
                        <a
                          href={crumb.href}
                          className="text-foreground-subtle hover:text-foreground transition-colors truncate"
                        >
                          {crumb.label}
                        </a>
                      ) : (
                        <span className="text-foreground truncate">{crumb.label}</span>
                      )}
                    </span>
                  )
                })}
              </nav>
            )}
            {header.actions && (
              <div className="flex items-center gap-2 ml-auto shrink-0">{header.actions}</div>
            )}
          </header>
        )}

        <main className="flex-1 overflow-auto p-4">{children}</main>
      </div>
    </div>
  )
}
