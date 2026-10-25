/**
 * The pager under a paginated {@link DataTable}: the range ("26–50 of 167")
 * and previous / next. A `<nav>` named after its table, because two paged
 * tables on one page are otherwise two identical landmarks.
 *
 * The range is a polite live region: a screen-reader user who pressed "Next"
 * hears where they landed without having to hunt for it.
 */
import { ChevronLeft, ChevronRight } from 'lucide-react'
import type { ReactNode } from 'react'
import { IconButton } from '../primitives/icon-button'
import type { DataTablePage, DataTablePaginationLabels } from './data-table-pagination'

export interface DataTablePagerProps {
  readonly page: DataTablePage<unknown>
  readonly labels: DataTablePaginationLabels
  readonly onPageChange: (page: number) => void
}

export function DataTablePager({ page, labels, onPageChange }: DataTablePagerProps): ReactNode {
  const atStart = page.page === 0
  const atEnd = page.page >= page.pageCount - 1
  return (
    <nav aria-label={labels.navLabel} className="flex items-center justify-end gap-2 pt-2">
      <span aria-live="polite" className="text-[11px] tabular-nums text-foreground-subtle">
        {labels.range(page.from, page.to, page.total)}
      </span>
      <IconButton
        type="button"
        variant="outline"
        size="sm"
        icon={ChevronLeft}
        aria-label={labels.previous}
        title={labels.previous}
        disabled={atStart}
        onClick={() => onPageChange(page.page - 1)}
      />
      <IconButton
        type="button"
        variant="outline"
        size="sm"
        icon={ChevronRight}
        aria-label={labels.next}
        title={labels.next}
        disabled={atEnd}
        onClick={() => onPageChange(page.page + 1)}
      />
    </nav>
  )
}
