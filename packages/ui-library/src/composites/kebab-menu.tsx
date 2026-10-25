/**
 * KebabMenu — vertical-dots dropdown for secondary device actions.
 *
 * Wraps `Popover` with a curated MenuItem API so call sites read like:
 *
 *   <KebabMenu items={[
 *     { id: 'snapshot', label: 'Take snapshot', icon: Camera, onClick: ... },
 *     { id: 'reboot',   label: 'Reboot device', icon: RotateCw, hidden: !canReboot },
 *     { id: 'delete',   label: 'Delete',        icon: Trash2,  danger: true, onClick: ... },
 *   ]} />
 *
 * Each item handles its own click; the menu auto-closes after invoking
 * the handler. Disabled / hidden items are skipped without rendering
 * a row, so the menu height matches the visible action set.
 *
 * Mobile fallback inherits from Popover: a bottom-sheet drops in for
 * touch devices, no extra wiring needed.
 */
import { type ComponentType, type ReactNode, useState, type JSX } from 'react'
import { MoreVertical } from 'lucide-react'
import { Popover, PopoverTrigger, PopoverContent } from '../primitives/popover'
import { cn } from '../lib/cn'

export interface KebabMenuItem {
  /** Stable id for React keys + analytics. */
  readonly id: string
  /** Visible label. */
  readonly label: string
  /** Icon component (lucide-react etc.). */
  readonly icon?: ComponentType<{ className?: string }>
  /** Render an inline subtitle / hint under the label. */
  readonly description?: string
  /** Click handler — menu auto-closes after invocation. */
  readonly onClick: () => void
  /** When true, the item is hidden entirely (gated by feature etc.). */
  readonly hidden?: boolean
  /** When true, the item is rendered greyed out and non-clickable. */
  readonly disabled?: boolean
  /** Renders the item with the destructive accent (red text + hover). */
  readonly danger?: boolean
  /**
   * Optional separator BEFORE this item — useful to group destructive
   * actions visually at the bottom of the menu.
   */
  readonly separatorBefore?: boolean
}

export interface KebabMenuProps {
  readonly items: readonly KebabMenuItem[]
  /**
   * Optional content rendered ABOVE the items (e.g. an explanatory
   * label or a status line). Hidden when no header is provided.
   */
  readonly header?: ReactNode
  /** Optional class on the trigger button (sizing, alignment). */
  readonly triggerClassName?: string
  /** Tooltip text on the trigger (defaults to "More actions"). */
  readonly title?: string
}

export function KebabMenu({
  items,
  header,
  triggerClassName,
  title = 'More actions',
}: KebabMenuProps): JSX.Element | null {
  const [open, setOpen] = useState(false)
  const visible = items.filter((i) => !i.hidden)
  if (visible.length === 0) return null

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        title={title}
        className={cn(
          'inline-flex items-center justify-center rounded-lg p-2',
          'text-foreground-subtle hover:text-foreground hover:bg-surface-hover',
          'border border-transparent transition-colors',
          triggerClassName,
        )}
      >
        <MoreVertical className="h-4 w-4" />
      </PopoverTrigger>
      <PopoverContent align="end" className="min-w-[200px] p-1">
        {header && (
          <div className="px-2 py-1 text-[10px] uppercase tracking-wider text-foreground-subtle">
            {header}
          </div>
        )}
        <ul className="space-y-0.5">
          {visible.map((item, idx) => (
            <li key={item.id}>
              {item.separatorBefore && idx > 0 && <div className="my-1 h-px bg-border" />}
              <button
                type="button"
                disabled={item.disabled}
                onClick={() => {
                  if (item.disabled) return
                  item.onClick()
                  setOpen(false)
                }}
                className={cn(
                  'flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-[12px]',
                  'transition-colors disabled:opacity-40 disabled:cursor-not-allowed',
                  item.danger
                    ? 'text-foreground hover:bg-danger/10 hover:text-danger'
                    : 'text-foreground hover:bg-surface-hover',
                )}
              >
                {item.icon && (
                  <item.icon
                    className={cn('h-3.5 w-3.5 shrink-0 mt-0.5', item.danger && 'text-danger/80')}
                  />
                )}
                <span className="flex-1 min-w-0">
                  <span className="block leading-tight">{item.label}</span>
                  {item.description && (
                    <span className="block mt-0.5 text-[10px] text-foreground-subtle leading-tight">
                      {item.description}
                    </span>
                  )}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  )
}
