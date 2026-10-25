import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useOverdueDeadline } from '../useOverdueDeadline'

describe('useOverdueDeadline', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('is not overdue immediately when activated', () => {
    const { result } = renderHook(() => useOverdueDeadline(true, 5_000))
    expect(result.current).toBe(false)
  })

  it('becomes overdue once the deadline elapses while active', () => {
    const { result } = renderHook(() => useOverdueDeadline(true, 5_000))
    act(() => {
      vi.advanceTimersByTime(5_001)
    })
    expect(result.current).toBe(true)
  })

  it('stays not-overdue while inactive, regardless of elapsed time', () => {
    const { result } = renderHook(() => useOverdueDeadline(false, 5_000))
    act(() => {
      vi.advanceTimersByTime(60_000)
    })
    expect(result.current).toBe(false)
  })

  it('resets to not-overdue when it goes inactive again', () => {
    const { result, rerender } = renderHook(
      ({ active }: { active: boolean }) => useOverdueDeadline(active, 5_000),
      { initialProps: { active: true } },
    )
    act(() => {
      vi.advanceTimersByTime(5_001)
    })
    expect(result.current).toBe(true)

    rerender({ active: false })
    expect(result.current).toBe(false)
  })

  it('does not fire after the deadline was cancelled by deactivation', () => {
    const { result, rerender } = renderHook(
      ({ active }: { active: boolean }) => useOverdueDeadline(active, 5_000),
      { initialProps: { active: true } },
    )
    // Deactivate before the deadline, then let plenty of time pass.
    rerender({ active: false })
    act(() => {
      vi.advanceTimersByTime(30_000)
    })
    expect(result.current).toBe(false)
  })
})
