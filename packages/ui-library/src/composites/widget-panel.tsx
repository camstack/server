import { type ReactNode, useState, type JSX } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'

// ---------------------------------------------------------------------------
// WidgetPanel — the single shared container for device-detail widgets.
//
// Encapsulates the canonical panel chrome (card frame, bordered header with an
// uppercase title + optional icon/right-slot, padded body) so every widget
// renders consistent fonts/padding/spacing WITHOUT re-deriving them. Mirrors
// the `OccupancyPanel` live-stats look so recording, occupancy, and future
// widgets share one visual language. Set `collapsible` for an accordion header.
// ---------------------------------------------------------------------------

interface WidgetPanelProps {
  /** Header title — rendered uppercase, letter-spaced, foreground. */
  readonly title: string
  /** Optional leading icon node (size it `h-3.5 w-3.5` for alignment). */
  readonly icon?: ReactNode
  /** Optional right-aligned header slot (timestamp, live badge, …). On a
   *  `collapsible` panel it sits before the chevron — e.g. a one-line summary
   *  shown only while the body is closed. */
  readonly headerRight?: ReactNode
  /** Render the header as a toggle that shows/hides the body. */
  readonly collapsible?: boolean
  /** Initial open state for an uncontrolled collapsible panel (default open). */
  readonly defaultOpen?: boolean
  /** Controlled open state; pair with `onOpenChange`. Overrides `defaultOpen`. */
  readonly open?: boolean
  /** Called with the next open state when the header is toggled. */
  readonly onOpenChange?: (open: boolean) => void
  /** Body padding/utility override (default `p-3`). */
  readonly bodyClassName?: string
  readonly children: ReactNode
}

export function WidgetPanel({
  title,
  icon,
  headerRight,
  collapsible = false,
  defaultOpen = true,
  open: openProp,
  onOpenChange,
  bodyClassName = 'p-3',
  children,
}: WidgetPanelProps): JSX.Element {
  const [openState, setOpenState] = useState(defaultOpen)
  const open = openProp ?? openState
  const toggle = (): void => {
    const next = !open
    if (openProp === undefined) setOpenState(next)
    onOpenChange?.(next)
  }
  const showBody = !collapsible || open

  const headerInner = (
    <>
      <span className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-foreground">
        {icon}
        {title}
      </span>
      {collapsible ? (
        <span className="flex min-w-0 items-center gap-2">
          {headerRight}
          {open ? (
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-foreground-subtle" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-foreground-subtle" />
          )}
        </span>
      ) : (
        headerRight
      )}
    </>
  )

  const headerClass = `px-4 py-2 flex items-center justify-between ${showBody ? 'border-b border-border' : ''}`

  return (
    <div className="rounded-lg border border-border bg-surface overflow-hidden">
      {collapsible ? (
        <button // ui-check-ok: full-width collapse header; Button chrome breaks the panel strip
          type="button"
          aria-expanded={open}
          onClick={toggle}
          className={`w-full gap-2 text-left ${headerClass}`}
        >
          {headerInner}
        </button>
      ) : (
        <div className={headerClass}>{headerInner}</div>
      )}
      {showBody ? <div className={bodyClassName}>{children}</div> : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// WidgetMetricCard — the canonical metric block inside a WidgetPanel body
// (matches the OccupancyPanel "FRAME TOTAL" stat card): light bordered card,
// uppercase label with an optional icon, a value, and an optional footer line.
// ---------------------------------------------------------------------------

interface WidgetMetricCardProps {
  readonly label: string
  readonly icon?: ReactNode
  /** The metric value (text or node). */
  readonly children: ReactNode
  /** Optional sub-line under the value (e.g. "3 segment ranges"). */
  readonly footer?: ReactNode
}

export function WidgetMetricCard({
  label,
  icon,
  children,
  footer,
}: WidgetMetricCardProps): JSX.Element {
  // Same geometry as `StatCard` (page KPI) — one metric language.
  return (
    <div className="min-w-0 rounded-lg border border-border bg-surface p-2 sm:p-2.5">
      <div className="mb-0.5 flex min-w-0 items-center gap-1.5 text-[10px] uppercase tracking-wider text-foreground-subtle">
        {icon}
        <span className="min-w-0 truncate">{label}</span>
      </div>
      <div className="truncate text-lg font-semibold leading-tight text-foreground">{children}</div>
      {footer != null ? (
        <div className="mt-0.5 truncate text-[10px] text-foreground-subtle">{footer}</div>
      ) : null}
    </div>
  )
}
