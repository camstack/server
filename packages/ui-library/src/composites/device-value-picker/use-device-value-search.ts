import type { DeviceSearchInput, DeviceSearchItem, DeviceSearchResult } from '@camstack/types'
import { useEffect, useMemo, useState } from 'react'
import { useDeviceManagerSearch } from '../../generated/system-hooks'
import { trpc } from '../../trpc-react'
import { mergePages } from './device-value-picker-model'

/** The text the server is asked about trails the keystrokes by this much. */
export const SEARCH_DEBOUNCE_MS = 250

export function useDebouncedValue<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const handle = setTimeout(() => setDebounced(value), ms)
    return () => clearTimeout(handle)
  }, [value, ms])
  return debounced
}

/** The query minus the cursor, which the paging owns. */
export type SearchQuery = Omit<DeviceSearchInput, 'cursor' | 'ids'>

export interface DeviceValueSearch {
  readonly first: DeviceSearchResult | undefined
  readonly items: readonly DeviceSearchItem[]
  readonly isPending: boolean
  readonly isError: boolean
  readonly isFetching: boolean
  readonly isFetchingNextPage: boolean
  readonly hasNextPage: boolean
  readonly fetchNextPage: () => void
  readonly refetch: () => void
}

/**
 * The picker's list: `deviceManager.search`, one cursor page at a time.
 * The first page carries the facets, the totals and the suggestions; later
 * pages only add items. `enabled` keeps a closed picker from asking.
 */
export function useDeviceValueSearch(query: SearchQuery, enabled: boolean): DeviceValueSearch {
  const q = trpc.deviceManager.search.useInfiniteQuery(query, {
    enabled,
    getNextPageParam: (last: DeviceSearchResult) => last.nextCursor ?? undefined,
    // The previous answer stays on screen while a keystroke's answer loads.
    placeholderData: (previous) => previous,
  })
  const pages = q.data?.pages
  const first = pages?.[0]
  const items = useMemo(() => mergePages(pages ?? []), [pages])
  return {
    first,
    items,
    isPending: q.isPending,
    isError: q.isError,
    isFetching: q.isFetching,
    isFetchingNextPage: q.isFetchingNextPage,
    hasNextPage: q.hasNextPage,
    fetchNextPage: () => {
      if (q.hasNextPage && !q.isFetchingNextPage) void q.fetchNextPage()
    },
    refetch: () => void q.refetch(),
  }
}

export interface ResolvedDevices {
  readonly result: DeviceSearchResult | undefined
  readonly isError: boolean
  readonly isPending: boolean
}

/**
 * Resolve exactly these devices (picked values, recents) regardless of any
 * filter. `requires` is passed so each item carries its readings.
 */
export function useResolvedDevices(
  ids: readonly number[],
  requires: DeviceSearchInput['requires'],
): ResolvedDevices {
  const q = useDeviceManagerSearch(
    { ids, requires, limit: Math.min(Math.max(ids.length, 1), 200) },
    { enabled: ids.length > 0 },
  )
  return { result: q.data, isError: q.isError, isPending: q.isPending && ids.length > 0 }
}
