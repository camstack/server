import { type LucideIcon } from 'lucide-react'
import { cn } from '../../lib/cn'
import { Badge } from '../../primitives'
import { type JSX } from 'react'

export interface SidebarItemProps {
  label: string
  icon: LucideIcon
  href: string
  badge?: string | number
  active?: boolean
  className?: string
}

export function SidebarItem({
  label,
  icon: Icon,
  href,
  badge,
  active = false,
  className,
}: SidebarItemProps): JSX.Element {
  return (
    <a
      href={href}
      className={cn(
        'flex items-center gap-2 h-7 px-2 text-[11px] transition-colors',
        active
          ? 'border-l-2 border-primary bg-primary/[0.08] text-foreground rounded-r-md'
          : 'text-foreground-subtle hover:bg-surface-hover rounded-md',
        className,
      )}
    >
      <Icon className="h-3.5 w-3.5 shrink-0" />
      <span className="truncate flex-1">{label}</span>
      {badge !== undefined && <Badge className="ml-auto text-[10px] px-1.5 py-0">{badge}</Badge>}
    </a>
  )
}
