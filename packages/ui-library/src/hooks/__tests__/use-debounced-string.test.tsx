// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useDebouncedString } from '../use-debounced-string'

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('useDebouncedString', () => {
  it('returns initial value immediately', () => {
    const { result } = renderHook(() => useDebouncedString('initial', 300))
    expect(result.current).toBe('initial')
  })

  it('debounces updates by delay ms', () => {
    const { result, rerender } = renderHook(({ value }) => useDebouncedString(value, 300), {
      initialProps: { value: 'a' },
    })
    expect(result.current).toBe('a')
    rerender({ value: 'ab' })
    expect(result.current).toBe('a') // not yet
    act(() => {
      vi.advanceTimersByTime(150)
    })
    expect(result.current).toBe('a') // still not yet
    act(() => {
      vi.advanceTimersByTime(150)
    })
    expect(result.current).toBe('ab') // delay reached
  })

  it('cancels pending updates if value changes rapidly', () => {
    const { result, rerender } = renderHook(({ value }) => useDebouncedString(value, 300), {
      initialProps: { value: '' },
    })
    rerender({ value: 'a' })
    act(() => {
      vi.advanceTimersByTime(100)
    })
    rerender({ value: 'ab' })
    act(() => {
      vi.advanceTimersByTime(100)
    })
    rerender({ value: 'abc' })
    act(() => {
      vi.advanceTimersByTime(100)
    })
    // 100 + 100 + 100 = 300 ms total but every change reset the timer,
    // so only the last 'abc' is pending; 100 ms of its window has passed.
    expect(result.current).toBe('') // initial still
    act(() => {
      vi.advanceTimersByTime(200)
    })
    expect(result.current).toBe('abc')
  })
})
