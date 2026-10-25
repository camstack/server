/**
 * usePlateGalleryLiveRefresh — auto-refresh the Plates/Vehicles gallery when
 * the backend reports a change, instead of the operator having to reload or
 * wait for the `listPlates` poll fallback (`refetchInterval: 30_000` in
 * `RecentPlates.tsx`).
 *
 * Subscribes to `EventCategory.PipelineAnalyticsPlateGalleryChanged` via the
 * shared `useLiveEvent` hook (same pattern as `useFaceGalleryLiveRefresh`) —
 * it already guards subscribe/unsubscribe lifecycle and no-ops safely when the
 * live channel is unavailable. Every event triggers the pure debounced window
 * so a burst of N events collapses into ONE `plateGallery` query invalidation
 * ~2000ms after the first event.
 */
import { useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useLiveEvent } from '@camstack/ui-library'
import { EventCategory, type PipelineAnalyticsPlateGalleryChangedPayload } from '@camstack/types'
import { createDebouncedInvalidate, type DebouncedInvalidate } from './debounced-invalidate.js'

const PLATE_GALLERY_KEY = [['plateGallery']]
const DEBOUNCE_MS = 2_000

export function usePlateGalleryLiveRefresh(): void {
  const queryClient = useQueryClient()

  // Latest-queryClient ref so the debouncer (created once) always invalidates
  // against the current client without being recreated.
  const queryClientRef = useRef(queryClient)
  queryClientRef.current = queryClient

  const debouncerRef = useRef<DebouncedInvalidate | undefined>(undefined)
  if (!debouncerRef.current) {
    debouncerRef.current = createDebouncedInvalidate({
      delayMs: DEBOUNCE_MS,
      invalidate: () => {
        void queryClientRef.current.invalidateQueries({ queryKey: PLATE_GALLERY_KEY })
      },
    })
  }

  // Cancel any pending window on unmount so a stale debounce never fires an
  // invalidate against an unmounted page.
  useEffect(() => {
    return () => debouncerRef.current?.cancel()
  }, [])

  useLiveEvent<PipelineAnalyticsPlateGalleryChangedPayload>(
    EventCategory.PipelineAnalyticsPlateGalleryChanged,
    () => {
      debouncerRef.current?.trigger()
    },
  )
}
