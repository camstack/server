/**
 * usePagedList — client-side pagination over an already-fetched, already-filtered
 * list. The Detection Intelligence galleries (Faces, Events, and a future Plates
 * page) fetch a capped window from their cap (`listRecentFaces` limit 500,
 * `getKeyEvents` limit 200/camera) and render EVERY row into one grid. This hook
 * slices that in-memory list into pages so the DOM holds only `pageSize` cards.
 *
 * It is a pure VIEW concern — no cap change, no extra fetch. Going BEYOND the
 * fetch cap (true server-side paging) needs an offset/keyset cap change; this
 * hook only pages what is already loaded.
 *
 * Reset semantics: pass a `resetKey` derived from the active filter/sort state
 * (e.g. `JSON.stringify([filter, dateRange, sortMode])`). When it changes the
 * page snaps back to 1 so the operator never lands on an out-of-range page after
 * narrowing the list. The page also auto-clamps when the list shrinks under it.
 */
import { useEffect, useMemo, useState } from 'react'

export interface PagedList<T> {
  /** 1-indexed current page. */
  readonly page: number
  readonly setPage: (page: number) => void
  /** The slice of `items` for the current page. */
  readonly pageItems: readonly T[]
  /** Total pages (>= 1). */
  readonly totalPages: number
  /** Total items across all pages (== items.length). */
  readonly totalItems: number
  readonly pageSize: number
}

export function usePagedList<T>(
  items: readonly T[],
  pageSize: number,
  resetKey: string,
): PagedList<T> {
  const [page, setPage] = useState(1)

  // Snap to page 1 whenever the filter/sort signature changes.
  useEffect(() => {
    setPage(1)
  }, [resetKey])

  const totalItems = items.length
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize))
  const safePage = Math.min(page, totalPages)

  // Auto-clamp when the list shrinks below the current page.
  useEffect(() => {
    if (safePage !== page) setPage(safePage)
  }, [safePage, page])

  const pageItems = useMemo(() => {
    const start = (safePage - 1) * pageSize
    return items.slice(start, start + pageSize)
  }, [items, safePage, pageSize])

  return { page: safePage, setPage, pageItems, totalPages, totalItems, pageSize }
}
