/**
 * IconAction — icon-only action button for condensed table action cells.
 *
 * Absorbed from the (now-retired in Phase 5) `device-table/cells.tsx` so the
 * unified `device-list/` table owns its own condensation helpers and does not
 * depend on the skeleton directory.
 *
 * The `label` is accessible via `aria-label` and `title` but is NOT rendered as
 * visible text, keeping the button compact at narrow widths. A `danger` flag
 * applies the `text-danger` token (and matching hover) for destructive actions
 * such as Delete, which keep their red treatment even when condensed to an icon.
 */
import type { ComponentType, ReactNode } from 'react'
import { cn } from '../../lib/cn'

export interface IconActionProps {
  /** Lucide icon component (or any component accepting `className?: string`). */
  readonly icon: ComponentType<{ className?: string }>
  /** Human-readable label — exposed via aria-label + title, NOT as visible text. */
  readonly label: string
  /** Click handler. */
  readonly onClick: () => void
  /**
   * When true, applies a red/destructive accent to the button. Use for Delete
   * and other irreversible actions — Delete keeps red even icon-only.
   */
  readonly danger?: boolean
}

export function IconAction({
  icon: Icon,
  label,
  onClick,
  danger = false,
}: IconActionProps): ReactNode {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        'inline-flex h-6 w-6 items-center justify-center rounded transition-colors flex-shrink-0',
        danger
          ? 'text-danger hover:bg-danger/10'
          : 'text-foreground-subtle hover:text-foreground hover:bg-surface-hover',
      )}
    >
      <Icon className="h-3.5 w-3.5" />
    </button>
  )
}
