// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import type { SystemLiveEvent } from '@camstack/sdk'

/**
 * useFaceGalleryLiveRefresh subscribes to the face-gallery-changed event
 * via `useLiveEvent` (from `@camstack/ui-library`) and, on the trailing
 * edge of a `createDebouncedInvalidate` window, invalidates the
 * `faceGallery` query on the ambient `useQueryClient()`. We mock both
 * seams so the test drives the subscribed callback directly and asserts
 * on the query-client invalidation without a real live-event transport
 * or a real tRPC/query-client stack.
 */

const { capturedCallback, mockInvalidateQueries } = vi.hoisted(() => ({
  capturedCallback: {
    current: undefined as ((event: SystemLiveEvent<unknown>) => void) | undefined,
  },
  mockInvalidateQueries: vi.fn(),
}))

vi.mock('@camstack/ui-library', () => ({
  useLiveEvent: (_category: string, cb: (event: SystemLiveEvent<unknown>) => void) => {
    capturedCallback.current = cb
  },
}))

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({
    invalidateQueries: mockInvalidateQueries,
  }),
}))

import { useFaceGalleryLiveRefresh } from '../use-face-gallery-live-refresh'

const FACE_GALLERY_KEY = [['faceGallery']]
const DEBOUNCE_MS = 2_000

const fireEvent = (): void => {
  capturedCallback.current?.({
    category: 'pipeline.analytics.face-gallery-changed',
    data: undefined,
    timestamp: Date.now(),
  } as unknown as SystemLiveEvent<unknown>)
}

beforeEach(() => {
  vi.useFakeTimers()
  mockInvalidateQueries.mockClear()
  capturedCallback.current = undefined
})

afterEach(() => {
  vi.useRealTimers()
})

describe('useFaceGalleryLiveRefresh', () => {
  it('invalidates the faceGallery query exactly once, ~2000ms after a single event', () => {
    renderHook(() => useFaceGalleryLiveRefresh())

    fireEvent()

    vi.advanceTimersByTime(DEBOUNCE_MS - 1)
    expect(mockInvalidateQueries).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(mockInvalidateQueries).toHaveBeenCalledTimes(1)
    expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: FACE_GALLERY_KEY })
  })

  it('coalesces a burst of 3 events within the window into exactly one invalidate', () => {
    renderHook(() => useFaceGalleryLiveRefresh())

    fireEvent() // t=0 — opens the window
    vi.advanceTimersByTime(500)
    fireEvent() // t=500 — coalesced
    vi.advanceTimersByTime(500)
    fireEvent() // t=1000 — coalesced

    vi.advanceTimersByTime(DEBOUNCE_MS - 1000 - 1)
    expect(mockInvalidateQueries).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(mockInvalidateQueries).toHaveBeenCalledTimes(1)
    expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: FACE_GALLERY_KEY })
  })

  it('cancels a pending window on unmount so no invalidate fires afterward', () => {
    const { unmount } = renderHook(() => useFaceGalleryLiveRefresh())

    fireEvent() // opens a pending window
    vi.advanceTimersByTime(1_000) // still inside the window when we unmount

    unmount()

    vi.advanceTimersByTime(DEBOUNCE_MS + 1_000) // well past the original deadline
    expect(mockInvalidateQueries).not.toHaveBeenCalled()
  })
})
