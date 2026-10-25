/**
 * `<SortHeaderButton>` — the clickable inner control of a sortable column
 * `<th>`, shared by `DataTable` and the device list.
 *
 * Renders the column label plus a sort-direction indicator (`ChevronUp` for
 * asc, `ChevronDown` for desc, a faint placeholder that appears on hover
 * otherwise) and calls `onSort()` on click.
 *
 * The owning `<th>` keeps its own sizing/visibility classes AND carries
 * `aria-sort` — WAI-ARIA scopes `aria-sort` to `<th>`/`<td>`, never to an
 * inner control. This component renders only the interactive label and the
 * visual indicator.
 *
 * Non-sortable columns keep their plain static `<th>` text and never mount
 * this: a header that looks clickable and does nothing is worse than a header
 * that never invited the click.
 */
import type { ReactNode } from 'react'
import { ChevronUp, ChevronDown } from 'lucide-react'
import { cn } from '../lib/cn'
import type { TableSortDirection } from './table-sort'

export interface SortHeaderButtonProps {
  readonly label: ReactNode
  /** True when THIS column is the table's single sorted column. */
  readonly active: boolean
  /** Direction while `active`; ignored otherwise. */
  readonly dir: TableSortDirection
  readonly onSort: () => void
}

export function SortHeaderButton({ label, active, dir, onSort }: SortHeaderButtonProps): ReactNode {
  return (
    <button
      type="button"
      onClick={onSort}
      className="group/sort inline-flex items-center gap-0.5 hover:text-foreground transition-colors"
    >
      <span>{label}</span>
      {active ? (
        dir === 'asc' ? (
          <ChevronUp className="h-3 w-3 flex-shrink-0" />
        ) : (
          <ChevronDown className="h-3 w-3 flex-shrink-0" />
        )
      ) : (
        <ChevronUp
          className={cn(
            'h-3 w-3 flex-shrink-0 opacity-0 transition-opacity',
            'group-hover/sort:opacity-30',
          )}
        />
      )}
    </button>
  )
}
