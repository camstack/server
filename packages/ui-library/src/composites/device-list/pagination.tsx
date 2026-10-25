/**
 * <Pagination> — numbered-pages-with-ellipsis control.
 *
 * Layout:  Showing 51–100 of 312 devices       [<] 1 … 3 4 [5] 6 7 … 28 [>]
 *
 * Returns `null` when totalItems <= pageSize (single page — no nav).
 */
import { type ReactNode } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useUiText } from '../../contexts/ui-text'
import { cn } from '../../lib/cn'

export interface PaginationProps {
  readonly currentPage: number // 1-indexed
  readonly totalItems: number
  readonly pageSize: number
  readonly onPageChange: (page: number) => void
  /** Singular noun for the showing-info label. Default `'devices'`. */
  readonly itemNoun?: string
}

export type PageButton =
  | { readonly kind: 'page'; readonly n: number }
  | { readonly kind: 'ellipsis'; readonly side: 'left' | 'right' }

const NEIGHBORS = 2 // pages either side of current

export function computePageButtons(currentPage: number, totalPages: number): readonly PageButton[] {
  if (totalPages <= 1) return [{ kind: 'page', n: 1 }]
  if (totalPages <= 7) {
    const all: PageButton[] = []
    for (let i = 1; i <= totalPages; i++) all.push({ kind: 'page', n: i })
    return all
  }
  const result: PageButton[] = []
  const leftBound = Math.max(2, currentPage - NEIGHBORS)
  const rightBound = Math.min(totalPages - 1, currentPage + NEIGHBORS)

  result.push({ kind: 'page', n: 1 })
  if (leftBound > 2) result.push({ kind: 'ellipsis', side: 'left' })
  for (let i = leftBound; i <= rightBound; i++) result.push({ kind: 'page', n: i })
  if (rightBound < totalPages - 1) result.push({ kind: 'ellipsis', side: 'right' })
  result.push({ kind: 'page', n: totalPages })
  return result
}

export function Pagination({
  currentPage,
  totalItems,
  pageSize,
  onPageChange,
  itemNoun,
}: PaginationProps): ReactNode {
  const t = useUiText()
  if (totalItems <= pageSize) return null

  const totalPages = Math.ceil(totalItems / pageSize)
  const startIdx = (currentPage - 1) * pageSize + 1
  const endIdx = Math.min(currentPage * pageSize, totalItems)
  const buttons = computePageButtons(currentPage, totalPages)

  return (
    <div className="flex items-center justify-between gap-4 flex-wrap pt-2 text-[11px] text-foreground-subtle">
      <span>
        {t('uiLibrary.pagination.showing', 'Showing {{start}}–{{end}} of {{total}} {{noun}}', {
          start: startIdx,
          end: endIdx,
          total: totalItems,
          noun: itemNoun ?? t('uiLibrary.pagination.devices', 'devices'),
        })}
      </span>
      <span className="inline-flex items-center gap-1">
        <button
          type="button"
          aria-label={t('uiLibrary.pagination.previous', 'Previous page')}
          disabled={currentPage === 1}
          onClick={() => onPageChange(currentPage - 1)}
          className={cn(
            'inline-flex items-center justify-center h-7 w-7 rounded border border-border bg-surface text-foreground-subtle',
            'hover:text-foreground hover:bg-surface-hover transition-colors',
            'disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-surface',
          )}
        >
          <ChevronLeft className="h-3 w-3" />
        </button>
        {buttons.map((b, i) => {
          if (b.kind === 'ellipsis') {
            return (
              <span key={`e-${i}`} className="px-1 text-foreground-subtle/60 select-none">
                …
              </span>
            )
          }
          const active = b.n === currentPage
          return (
            <button
              key={`p-${b.n}`}
              type="button"
              onClick={() => onPageChange(b.n)}
              className={cn(
                'inline-flex items-center justify-center h-7 min-w-7 px-1.5 rounded border text-[10.5px] font-medium transition-colors',
                active
                  ? 'border-primary/40 bg-primary/10 text-primary'
                  : 'border-border bg-surface text-foreground-subtle hover:text-foreground hover:bg-surface-hover',
              )}
            >
              {b.n}
            </button>
          )
        })}
        <button
          type="button"
          aria-label={t('uiLibrary.pagination.next', 'Next page')}
          disabled={currentPage === totalPages}
          onClick={() => onPageChange(currentPage + 1)}
          className={cn(
            'inline-flex items-center justify-center h-7 w-7 rounded border border-border bg-surface text-foreground-subtle',
            'hover:text-foreground hover:bg-surface-hover transition-colors',
            'disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-surface',
          )}
        >
          <ChevronRight className="h-3 w-3" />
        </button>
      </span>
    </div>
  )
}
