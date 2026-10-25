import { type ReactNode, type JSX } from 'react'
import { cn } from '../../lib/cn'
import { Separator } from '../../primitives'
import { SidebarItem, type SidebarItemProps } from './sidebar-item'

export interface SidebarSection {
  label?: string
  items: SidebarItemProps[]
}

export interface SidebarProps {
  logo?: ReactNode
  sections: SidebarSection[]
  footer?: SidebarItemProps[]
  onNavigate?: () => void
  className?: string
}

export function Sidebar({
  logo,
  sections,
  footer,
  onNavigate,
  className,
}: SidebarProps): JSX.Element {
  return (
    <nav className={cn('bg-surface border-r border-border h-full flex flex-col', className)}>
      {logo && <div className="px-3 py-2 shrink-0">{logo}</div>}

      <div className="flex-1 overflow-auto px-1 py-1">
        {sections.map((section, sectionIndex) => (
          <div key={sectionIndex} className={cn(sectionIndex > 0 ? 'mt-3' : '')}>
            {section.label && (
              <span className="text-[10px] text-foreground-disabled uppercase tracking-wider px-2 mb-1 block">
                {section.label}
              </span>
            )}
            <div className="flex flex-col gap-0.5" onClick={onNavigate}>
              {section.items.map((item) => (
                <SidebarItem key={item.href} {...item} />
              ))}
            </div>
          </div>
        ))}
      </div>

      {footer && footer.length > 0 && (
        <div className="shrink-0 px-1 pb-1">
          <Separator className="mb-1" />
          <div className="flex flex-col gap-0.5" onClick={onNavigate}>
            {footer.map((item) => (
              <SidebarItem key={item.href} {...item} />
            ))}
          </div>
        </div>
      )}
    </nav>
  )
}
