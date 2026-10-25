/**
 * useEventsLiveRefresh — auto-refresh the Detection Intelligence Events feed
 * when the backend reports pipeline activity, instead of waiting for the
 * 30s `getKeyEvents` poll fallback (`refetchInterval` in
 * `use-key-events-feed.ts`).
 *
 * Subscribes to the two live categories a key-event can derive from —
 * `PipelineAnalyticsDetectionEvent` (a fresh detection) and
 * `PipelineAnalyticsTrackEnded` (a track summary finalized) — via the shared
 * `useLiveEvent` hook, which already guards subscribe/unsubscribe lifecycle
 * and no-ops when the live channel is unavailable. Every event opens the pure
 * `createDebouncedInvalidate` window (`debounced-invalidate.ts`) so a burst
 * collapses into ONE invalidation of the `['events-feed']` query root ~2000ms
 * after the first event. Invalidating the prefix `['events-feed']`
 * prefix-matches every per-device feed key.
 *
 * ## Why `paused` exists
 *
 * The feed is time-sorted, so an invalidation that lands while the operator is
 * reading a card REORDERS the grid under them: new events go in at the top and
 * everything they were looking at moves down. Refreshing a list is only helpful
 * when nobody is using it.
 *
 * So the caller passes `paused` for "the operator is busy with this list". While
 * paused the subscription and the coalescing window keep running — only the
 * *application* of the result is deferred, and `pending` goes true so the UI can
 * offer it. The moment `paused` goes false the owed refresh flushes
 * automatically; `refreshNow()` applies it on demand.
 *
 * Mirrors `use-face-gallery-live-refresh.ts`, which has no such gate because a
 * gallery grid is keyed and stable rather than time-ordered.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useLiveEvent } from '@camstack/ui-library'
import { EventCategory } from '@camstack/types'
import { createDebouncedInvalidate, type DebouncedInvalidate } from './debounced-invalidate.js'

const EVENTS_FEED_KEY = ['events-feed']
const DEBOUNCE_MS = 2_000

export interface EventsLiveRefreshOptions {
  /**
   * Hold refreshes back — set while the operator is engaged with the feed (a
   * detail panel open, a selection in progress, scrolled into the list).
   */
  readonly paused?: boolean
}

export interface EventsLiveRefresh {
  /** A refresh arrived while paused and has not been applied yet. */
  readonly pending: boolean
  /** Apply an owed refresh now. No-op when nothing is owed. */
  readonly refreshNow: () => void
}

export function useEventsLiveRefresh(options?: EventsLiveRefreshOptions): EventsLiveRefresh {
  const queryClient = useQueryClient()
  const paused = options?.paused === true

  // Latest-queryClient ref so the debouncer (created once) always
  // invalidates against the current client without being recreated.
  const queryClientRef = useRef(queryClient)
  queryClientRef.current = queryClient

  // Read inside the debouncer callback, which was created on the first render
  // and would otherwise close over the initial `paused` forever.
  const pausedRef = useRef(paused)
  pausedRef.current = paused

  const [pending, setPending] = useState(false)

  const invalidate = useCallback((): void => {
    void queryClientRef.current.invalidateQueries({ queryKey: EVENTS_FEED_KEY })
  }, [])

  const debouncerRef = useRef<DebouncedInvalidate | undefined>(undefined)
  if (!debouncerRef.current) {
    debouncerRef.current = createDebouncedInvalidate({
      delayMs: DEBOUNCE_MS,
      invalidate: () => {
        // Paused: remember that a refresh is owed rather than dropping it. The
        // window still closed, so a later burst opens a fresh one and the flag
        // simply stays true — no queue to grow.
        if (pausedRef.current) setPending(true)
        else invalidate()
      },
    })
  }

  // Cancel any pending window on unmount so a stale debounce never fires
  // an invalidate against an unmounted page.
  useEffect(() => {
    return () => debouncerRef.current?.cancel()
  }, [])

  // Flush the moment the operator is done. Deliberately keyed on `paused` only:
  // when it goes false and something is owed, apply it.
  useEffect(() => {
    if (paused || !pending) return
    setPending(false)
    invalidate()
  }, [paused, pending, invalidate])

  const refreshNow = useCallback((): void => {
    setPending(false)
    invalidate()
  }, [invalidate])

  useLiveEvent(EventCategory.PipelineAnalyticsDetectionEvent, () => {
    debouncerRef.current?.trigger()
  })
  useLiveEvent(EventCategory.PipelineAnalyticsTrackEnded, () => {
    debouncerRef.current?.trigger()
  })

  return { pending, refreshNow }
}
