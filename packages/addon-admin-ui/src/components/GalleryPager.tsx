/**
 * GalleryPager — numbered-pages-with-ellipsis control for the Detection
 * Intelligence galleries (Faces / Events / Plates).
 *
 * Mirrors the ui-library `<Pagination>` used by the device list, but that
 * component is internal to the `device-list` composite and NOT re-exported from
 * `@camstack/ui-library`, so admin-ui carries its own small copy here rather
 * than widening the library's public surface (which would need a ui-library
 * build + deploy). Returns `null` when everything fits on one page.
 *
 *   Showing 51–100 of 312 faces     [<] 1 … 3 4 [5] 6 7 … 28 [>]
 */
import { type JSX } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@camstack/ui-library'

export interface GalleryPagerProps {
  readonly currentPage: number // 1-indexed
  readonly totalItems: number
  readonly pageSize: number
  readonly onPageChange: (page: number) => void
  /** Singular noun for the showing-info label. Default `'items'`. */
  readonly itemNoun?: string
}

type PageButton =
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

export function GalleryPager({
  currentPage,
  totalItems,
  pageSize,
  onPageChange,
  itemNoun = 'items',
}: GalleryPagerProps): JSX.Element | null {
  const { t } = useTranslation()
  if (totalItems <= pageSize) return null

  const totalPages = Math.ceil(totalItems / pageSize)
  const startIdx = (currentPage - 1) * pageSize + 1
  const endIdx = Math.min(currentPage * pageSize, totalItems)
  const buttons = computePageButtons(currentPage, totalPages)

  const btnBase =
    'inline-flex h-7 min-w-7 items-center justify-center rounded-md px-2 text-[11px] transition-colors disabled:opacity-40'

  return (
    <div className="flex items-center justify-between gap-4 flex-wrap pt-2 text-[11px] text-foreground-subtle">
      <span>
        {t('galleryPager.showing', {
          from: startIdx,
          to: endIdx,
          total: totalItems,
          noun: itemNoun,
        })}
      </span>
      <div className="flex items-center gap-1">
        <Button
          variant="unstyled"
          type="button"
          className={`${btnBase} hover:bg-surface-hover`}
          onClick={() => onPageChange(currentPage - 1)}
          disabled={currentPage <= 1}
          aria-label={t('galleryPager.previousPage', 'Previous page')}
        >
          <ChevronLeft className="h-3.5 w-3.5" />
        </Button>
        {buttons.map((b) =>
          b.kind === 'ellipsis' ? (
            <span key={`ellipsis-${b.side}`} className="px-1 opacity-60">
              …
            </span>
          ) : (
            <Button
              variant="unstyled"
              key={b.n}
              type="button"
              className={`${btnBase} ${
                b.n === currentPage
                  ? 'bg-primary/12 text-primary font-medium'
                  : 'hover:bg-surface-hover hover:text-foreground'
              }`}
              onClick={() => onPageChange(b.n)}
              aria-current={b.n === currentPage ? 'page' : undefined}
            >
              {b.n}
            </Button>
          ),
        )}
        <Button
          variant="unstyled"
          type="button"
          className={`${btnBase} hover:bg-surface-hover`}
          onClick={() => onPageChange(currentPage + 1)}
          disabled={currentPage >= totalPages}
          aria-label={t('galleryPager.nextPage', 'Next page')}
        >
          <ChevronRight className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  )
}
