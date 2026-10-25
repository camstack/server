/**
 * <ChildSectionAccordion> — a reusable collapsible section for the CARD/LIST
 * context (device-detail children list). Renders a header button (chevron +
 * title + count badge) that toggles a local open state, and the body (the
 * section's children) when open.
 *
 * Open by default. Styling mirrors `children-accordion.tsx` (uppercase
 * text-[10px] section headers, `hover:bg-surface-hover`, subtle dividers) so
 * the device-detail accordions read consistently with the rest of the list.
 *
 * The TABLE context can't reuse this component (rows must be `<tr>`/`<td>`),
 * so it shares the `groupChildrenByLayout` helper + its own section-header
 * `<tr>` instead — see `device-list/table-layout.tsx`.
 */
import { useState, type ReactNode } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { cn } from '../../lib/cn'

interface ChildSectionAccordionProps {
  readonly title: string
  readonly count: number
  readonly children: ReactNode
  readonly defaultOpen?: boolean
}

export function ChildSectionAccordion({
  title,
  count,
  children,
  defaultOpen = true,
}: ChildSectionAccordionProps): ReactNode {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="rounded-md border border-border-subtle/50">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'w-full flex items-center gap-1.5 px-2 py-1.5 text-left transition-colors',
          'hover:bg-surface-hover',
        )}
        aria-expanded={open}
      >
        {open ? (
          <ChevronDown className="h-3 w-3 text-foreground-subtle flex-shrink-0" />
        ) : (
          <ChevronRight className="h-3 w-3 text-foreground-subtle flex-shrink-0" />
        )}
        <span className="text-[10px] font-semibold uppercase tracking-wide text-foreground-subtle flex-1 truncate">
          {title}
        </span>
        <span className="text-[10px] font-medium text-foreground-subtle/70 tabular-nums">
          {count}
        </span>
      </button>
      {open && <div className="space-y-1 px-1 pb-1.5">{children}</div>}
    </div>
  )
}
