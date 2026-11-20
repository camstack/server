/**
 * `/system/logs?tab=events` — the cluster-wide system event stream.
 *
 * The categories the stream follows live in the URL (`?categories=a,b.*`,
 * exact ids and `prefix.*` patterns) so a view survives a reload and can be
 * shared; no parameter means the stream's default set.
 */
import { EventStream } from '@camstack/ui-library'
import { useCallback, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { AdminPage } from '../../components/AdminPage'

export const EVENTS_CATEGORIES_PARAM = 'categories'

/** The `?categories=` value as a list; `undefined` when absent or empty. */
export function parseCategoriesParam(raw: string | null): readonly string[] | undefined {
  const list = (raw ?? '')
    .split(',')
    .map((c) => c.trim())
    .filter((c) => c !== '')
  return list.length > 0 ? list : undefined
}

export function LogEventsTab() {
  const [searchParams, setSearchParams] = useSearchParams()
  // Read once: the stream owns the selection after mount and reports changes back.
  const [initial] = useState(() => parseCategoriesParam(searchParams.get(EVENTS_CATEGORIES_PARAM)))
  const onCategoriesChange = useCallback(
    (next: readonly string[]) => {
      setSearchParams(
        (prev) => {
          const params = new URLSearchParams(prev)
          if (next.length > 0) params.set(EVENTS_CATEGORIES_PARAM, next.join(','))
          else params.delete(EVENTS_CATEGORIES_PARAM)
          return params
        },
        { replace: true },
      )
    },
    [setSearchParams],
  )
  return (
    <AdminPage embedded>
      <div className="rounded-lg border border-border bg-surface">
        <EventStream
          {...(initial ? { defaultCategories: initial } : {})}
          limit={200}
          maxHeight="max-h-[calc(100vh-310px)]"
          onCategoriesChange={onCategoriesChange}
        />
      </div>
    </AdminPage>
  )
}
