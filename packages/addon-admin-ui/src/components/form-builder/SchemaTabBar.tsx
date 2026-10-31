import { Button } from '@camstack/ui-library'
/**
 * SchemaTabBar — shared tab bar for any FormBuilder-backed surface with
 * multiple tabs. Renders the button row; callers own the active state
 * and the tab discovery (schema-derived, extras, or both).
 *
 * Two optional badges appear next to each tab label:
 *  - `countByTab`   → neutral "(N)" hint (section count or similar)
 *  - `pendingByTab` → primary-colored dot signalling unsaved changes
 *    under that tab, drawing the operator back to the tab that still
 *    needs attention when navigating with dirty state across tabs.
 *
 * Intentionally passive: no store knowledge, no save routing, no schema
 * parsing. Purely a bar + active-state handoff.
 *
 * The bar WRAPS at every width and is never a scroll container. It used to be
 * `flex-nowrap overflow-x-auto` below `md`, which produced a scrollbar even when
 * the tabs fitted on one row:
 *
 *   `overflow-x: auto` with `overflow-y` left at `visible` promotes overflow-y to
 *   `auto` too (CSS spec: `visible` is not combinable with `auto`). The buttons
 *   carry `-mb-px` + `border-b-2`, so they extend a pixel past the content box —
 *   enough vertical overflow to raise a vertical scrollbar, which narrows the
 *   available width, which then overflows horizontally. A one-row bar with two
 *   scrollbars.
 *
 * Wrapping also beats horizontal scroll on a phone on its own merits: a tab you
 * cannot see is a tab you do not know exists. And a scroll container here would
 * silently disable `position: sticky` for anything inside it.
 */

export interface SchemaTabBarTab {
  readonly id: string
  readonly label: string
}

interface SchemaTabBarProps {
  readonly tabs: readonly SchemaTabBarTab[]
  readonly activeId: string | null
  readonly onChange: (id: string) => void
  /** Optional neutral count next to each tab (e.g. section count). */
  readonly countByTab?: ReadonlyMap<string, number>
  /** Optional unsaved-change counter per tab — renders a dot when > 0. */
  readonly pendingByTab?: ReadonlyMap<string, number>
}

export function SchemaTabBar({
  tabs,
  activeId,
  onChange,
  countByTab,
  pendingByTab,
}: SchemaTabBarProps) {
  if (tabs.length === 0) return null
  return (
    <div className="flex flex-wrap items-center gap-1 border-b border-border shrink-0">
      {tabs.map((t) => {
        const isActive = t.id === activeId
        const count = countByTab?.get(t.id) ?? 0
        const pending = pendingByTab?.get(t.id) ?? 0
        return (
          <Button
            variant="unstyled"
            key={t.id}
            type="button"
            onClick={() => onChange(t.id)}
            className={`relative shrink-0 px-3 py-1.5 text-xs font-medium rounded-t-md transition-colors -mb-px border-b-2 whitespace-nowrap ${
              isActive
                ? 'text-primary border-primary bg-primary/5'
                : 'text-foreground-subtle border-transparent hover:text-foreground hover:bg-surface-hover'
            }`}
          >
            {t.label}
            {count > 0 && <span className="ml-1.5 text-[10px] opacity-60">({count})</span>}
            {pending > 0 && (
              <span className="ml-1.5 inline-flex h-1.5 w-1.5 rounded-full bg-primary" />
            )}
          </Button>
        )
      })}
    </div>
  )
}
