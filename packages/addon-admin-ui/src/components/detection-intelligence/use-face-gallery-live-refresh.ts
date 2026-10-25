/**
 * useFaceGalleryLiveRefresh — auto-refresh the Detection Intelligence face
 * gallery when the backend reports a change, instead of the operator
 * having to reload or wait for the `listRecentFaces` poll fallback
 * (`refetchInterval: 30_000` in `UnassignedFaces.tsx`).
 *
 * Subscribes to `EventCategory.PipelineAnalyticsFaceGalleryChanged` via the
 * shared `useLiveEvent` hook (same pattern as `use-cameras-overview.ts`) —
 * it already guards subscribe/unsubscribe lifecycle and no-ops safely when
 * the live channel is unavailable, so this hook doesn't reimplement that.
 * Every event triggers the pure `createDebouncedInvalidate` window
 * (`debounced-invalidate.ts`) so a burst of N events — e.g. the two fired
 * per delete-of-assigned-face (`unassigned` + `deleted`) — collapses into
 * ONE `faceGallery` query invalidation ~2000ms after the first event.
 */
import { useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useLiveEvent } from '@camstack/ui-library'
import { EventCategory, type PipelineAnalyticsFaceGalleryChangedPayload } from '@camstack/types'
import { createDebouncedInvalidate, type DebouncedInvalidate } from './debounced-invalidate.js'

const FACE_GALLERY_KEY = [['faceGallery']]
const DEBOUNCE_MS = 2_000

export function useFaceGalleryLiveRefresh(): void {
  const queryClient = useQueryClient()

  // Latest-queryClient ref so the debouncer (created once) always
  // invalidates against the current client without being recreated.
  const queryClientRef = useRef(queryClient)
  queryClientRef.current = queryClient

  const debouncerRef = useRef<DebouncedInvalidate | undefined>(undefined)
  if (!debouncerRef.current) {
    debouncerRef.current = createDebouncedInvalidate({
      delayMs: DEBOUNCE_MS,
      invalidate: () => {
        void queryClientRef.current.invalidateQueries({ queryKey: FACE_GALLERY_KEY })
      },
    })
  }

  // Cancel any pending window on unmount so a stale debounce never fires
  // an invalidate against an unmounted page.
  useEffect(() => {
    return () => debouncerRef.current?.cancel()
  }, [])

  useLiveEvent<PipelineAnalyticsFaceGalleryChangedPayload>(
    EventCategory.PipelineAnalyticsFaceGalleryChanged,
    () => {
      debouncerRef.current?.trigger()
    },
  )
}
