// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { act } from 'react'
import type { SystemLiveEvent } from '@camstack/sdk'

/**
 * `useEventsLiveRefresh` coalesces pipeline-activity events into one invalidation
 * of the `['events-feed']` root, and — the part these tests exist for — holds that
 * invalidation back while `paused` is true.
 *
 * The feed is time-sorted, so refreshing it while the operator is reading reorders
 * the grid under them: new events enter at the top and the card being examined
 * moves down. That was the reported bug.
 *
 * Both seams (`useLiveEvent`, `useQueryClient`) are mocked, as in
 * `use-face-gallery-live-refresh.test.tsx`, so the test drives the subscribed
 * callback directly with no live transport or query stack.
 */

const { capturedCallbacks, mockInvalidateQueries } = vi.hoisted(() => ({
  capturedCallbacks: {
    current: [] as ((event: SystemLiveEvent<unknown>) => void)[],
  },
  mockInvalidateQueries: vi.fn(),
}))

vi.mock('@camstack/ui-library', () => ({
  useLiveEvent: (_category: string, cb: (event: SystemLiveEvent<unknown>) => void) => {
    capturedCallbacks.current.push(cb)
  },
}))

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: mockInvalidateQueries }),
}))

import { useEventsLiveRefresh } from '../use-events-live-refresh'

const EVENTS_FEED_KEY = ['events-feed']
const DEBOUNCE_MS = 2_000

/**
 * Advance timers inside `act` so React flushes the state update the debouncer's
 * callback makes. Without it the suppression still works but `pending` is never
 * observed, because the `setPending` happens outside React's batching.
 */
const advance = (ms: number): void => {
  act(() => {
    vi.advanceTimersByTime(ms)
  })
}

/** Fire the first subscribed handler — both categories share one debouncer. */
const fireEvent = (): void => {
  capturedCallbacks.current[0]?.({
    category: 'pipeline.analytics.detection-event',
    data: undefined,
    timestamp: 0,
  } as unknown as SystemLiveEvent<unknown>)
}

beforeEach(() => {
  vi.useFakeTimers()
  mockInvalidateQueries.mockClear()
  capturedCallbacks.current = []
})

afterEach(() => {
  vi.useRealTimers()
})

describe('useEventsLiveRefresh', () => {
  it('invalidates once ~2000ms after an event when not paused', () => {
    renderHook(() => useEventsLiveRefresh())

    fireEvent()
    advance(DEBOUNCE_MS - 1)
    expect(mockInvalidateQueries).not.toHaveBeenCalled()

    advance(1)
    expect(mockInvalidateQueries).toHaveBeenCalledTimes(1)
    expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: EVENTS_FEED_KEY })
  })

  it('does NOT invalidate while paused, and reports the refresh as pending', () => {
    const { result } = renderHook(() => useEventsLiveRefresh({ paused: true }))

    fireEvent()
    advance(DEBOUNCE_MS + 500)

    // This is the whole point: the grid must not reorder under the operator.
    expect(mockInvalidateQueries).not.toHaveBeenCalled()
    expect(result.current.pending).toBe(true)
  })

  it('flushes the owed refresh automatically when paused goes false', () => {
    const { result, rerender } = renderHook(
      ({ paused }: { paused: boolean }) => useEventsLiveRefresh({ paused }),
      { initialProps: { paused: true } },
    )

    fireEvent()
    advance(DEBOUNCE_MS)
    expect(mockInvalidateQueries).not.toHaveBeenCalled()

    act(() => rerender({ paused: false }))

    expect(mockInvalidateQueries).toHaveBeenCalledTimes(1)
    expect(result.current.pending).toBe(false)
  })

  it('does not invalidate on unpause when nothing was owed', () => {
    const { rerender } = renderHook(
      ({ paused }: { paused: boolean }) => useEventsLiveRefresh({ paused }),
      { initialProps: { paused: true } },
    )
    rerender({ paused: false })
    expect(mockInvalidateQueries).not.toHaveBeenCalled()
  })

  it('applies an owed refresh on refreshNow() while still paused', () => {
    const { result } = renderHook(() => useEventsLiveRefresh({ paused: true }))

    fireEvent()
    advance(DEBOUNCE_MS)
    expect(result.current.pending).toBe(true)

    act(() => result.current.refreshNow())

    expect(mockInvalidateQueries).toHaveBeenCalledTimes(1)
    expect(result.current.pending).toBe(false)
  })

  it('reads the CURRENT paused value, not the one captured on first render', () => {
    // The debouncer is created once, on the first render, so a naive closure over
    // `paused` would keep the initial value forever — the hook would refresh while
    // busy, or never refresh again after one busy spell.
    const { rerender } = renderHook(
      ({ paused }: { paused: boolean }) => useEventsLiveRefresh({ paused }),
      { initialProps: { paused: false } },
    )

    rerender({ paused: true })
    fireEvent()
    advance(DEBOUNCE_MS)
    expect(mockInvalidateQueries).not.toHaveBeenCalled()
  })

  it('coalesces a burst into one invalidate', () => {
    renderHook(() => useEventsLiveRefresh())

    fireEvent()
    advance(500)
    fireEvent()
    advance(500)
    fireEvent()
    advance(DEBOUNCE_MS - 1_000)

    expect(mockInvalidateQueries).toHaveBeenCalledTimes(1)
  })

  it('cancels a pending window on unmount', () => {
    const { unmount } = renderHook(() => useEventsLiveRefresh())

    fireEvent()
    advance(1_000)
    unmount()
    advance(DEBOUNCE_MS + 1_000)

    expect(mockInvalidateQueries).not.toHaveBeenCalled()
  })
})
