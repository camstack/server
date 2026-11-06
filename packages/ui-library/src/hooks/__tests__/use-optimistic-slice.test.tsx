// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useOptimisticSlice } from '../use-optimistic-slice'

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

interface MockSlice {
  on: boolean
  lastChangedAt: number
}

interface MockSliceNoTimestamp {
  value: number
}

describe('useOptimisticSlice', () => {
  it('returns the real slice as display when no override is active', () => {
    const slice: MockSlice = { on: false, lastChangedAt: 1000 }
    const { result } = renderHook(() => useOptimisticSlice(slice))
    expect(result.current.display).toBe(slice)
  })

  it('applyOptimistic shows the patched value immediately', () => {
    const slice: MockSlice = { on: false, lastChangedAt: 1000 }
    const { result } = renderHook(() => useOptimisticSlice(slice))
    act(() => {
      result.current.applyOptimistic({ on: true })
    })
    expect(result.current.display?.on).toBe(true)
  })

  it('merges the patch onto the current slice fields', () => {
    const slice: MockSlice = { on: false, lastChangedAt: 1000 }
    const { result } = renderHook(() => useOptimisticSlice(slice))
    act(() => {
      result.current.applyOptimistic({ on: true })
    })
    // lastChangedAt from original slice must be preserved in override
    expect(result.current.display?.lastChangedAt).toBe(1000)
  })

  it('reconciles to the real slice when lastChangedAt advances', () => {
    let slice: MockSlice = { on: false, lastChangedAt: 1000 }
    const { result, rerender } = renderHook(({ s }) => useOptimisticSlice(s), {
      initialProps: { s: slice },
    })
    act(() => {
      result.current.applyOptimistic({ on: true })
    })
    expect(result.current.display?.on).toBe(true)

    // Simulate server push: new slice with advanced timestamp
    slice = { on: true, lastChangedAt: 2000 }
    rerender({ s: slice })

    expect(result.current.display?.on).toBe(true)
    // display should now equal the real (non-override) slice
    expect(result.current.display).toBe(slice)
  })

  it('does NOT clear override when real slice reference changes but lastChangedAt has not advanced', () => {
    const slice: MockSlice = { on: false, lastChangedAt: 1000 }
    const { result, rerender } = renderHook(({ s }) => useOptimisticSlice(s), {
      initialProps: { s: slice },
    })
    act(() => {
      result.current.applyOptimistic({ on: true })
    })
    // New reference, same timestamp — should NOT reconcile
    const newRef: MockSlice = { on: false, lastChangedAt: 1000 }
    rerender({ s: newRef })
    expect(result.current.display?.on).toBe(true)
  })

  it('falls back to reconcile on referential change when slice has no lastChangedAt', () => {
    const slice: MockSliceNoTimestamp = { value: 10 }
    const { result, rerender } = renderHook(({ s }) => useOptimisticSlice(s), {
      initialProps: { s: slice },
    })
    act(() => {
      result.current.applyOptimistic({ value: 20 })
    })
    expect(result.current.display?.value).toBe(20)

    // New reference — reconciles
    const newSlice: MockSliceNoTimestamp = { value: 20 }
    rerender({ s: newSlice })
    expect(result.current.display).toBe(newSlice)
  })

  it('clears the stale override after the fallback timeout', () => {
    const slice: MockSlice = { on: false, lastChangedAt: 1000 }
    const { result } = renderHook(() => useOptimisticSlice(slice, { timeoutMs: 3000 }))
    act(() => {
      result.current.applyOptimistic({ on: true })
    })
    expect(result.current.display?.on).toBe(true)

    act(() => {
      vi.advanceTimersByTime(2999)
    })
    expect(result.current.display?.on).toBe(true) // not yet cleared

    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(result.current.display?.on).toBe(false) // cleared → falls back to real slice
  })

  it('is a passthrough (no override) when enabled:false', () => {
    const slice: MockSlice = { on: false, lastChangedAt: 1000 }
    const { result } = renderHook(() => useOptimisticSlice(slice, { enabled: false }))
    act(() => {
      result.current.applyOptimistic({ on: true })
    })
    // Still shows real slice
    expect(result.current.display).toBe(slice)
  })

  it('display is undefined when realSlice is undefined and no override', () => {
    const { result } = renderHook(() => useOptimisticSlice<MockSlice>(undefined))
    expect(result.current.display).toBeUndefined()
  })

  it('accumulates patches on rapid successive applies', () => {
    const slice = { a: 1, b: 2, lastChangedAt: 0 }
    const { result } = renderHook(() => useOptimisticSlice(slice))
    act(() => {
      result.current.applyOptimistic({ a: 10 })
    })
    act(() => {
      result.current.applyOptimistic({ b: 20 })
    })
    expect(result.current.display?.a).toBe(10)
    expect(result.current.display?.b).toBe(20)
  })
})

describe('useOptimisticSlice — applyOptimisticAction', () => {
  const slice: MockSlice = { on: false, lastChangedAt: 1000 }

  it('rolls back at once and reports the error when the command is refused', async () => {
    const onError = vi.fn()
    const { result } = renderHook(() => useOptimisticSlice(slice))
    await act(async () => {
      result.current.applyOptimisticAction(
        { on: true },
        () => Promise.reject(new Error('refused')),
        onError,
      )
    })
    expect(result.current.display).toBe(slice)
    expect(onError).toHaveBeenCalledOnce()
  })

  it('treats a synchronous throw as a refusal', async () => {
    const { result } = renderHook(() => useOptimisticSlice(slice))
    await act(async () => {
      result.current.applyOptimisticAction({ on: true }, () => {
        throw new Error('boom')
      })
    })
    expect(result.current.display).toBe(slice)
  })

  it('keeps the new value after a successful command', async () => {
    const { result } = renderHook(() => useOptimisticSlice(slice))
    await act(async () => {
      result.current.applyOptimisticAction({ on: true }, () => Promise.resolve())
    })
    expect(result.current.display?.on).toBe(true)
  })

  it('does not drop the value on the timer while the command is still pending', async () => {
    let finish: () => void = () => undefined
    const pending = new Promise<void>((resolve) => {
      finish = resolve
    })
    const { result } = renderHook(() => useOptimisticSlice(slice, { timeoutMs: 4000 }))
    await act(async () => {
      result.current.applyOptimisticAction({ on: true }, () => pending)
    })
    act(() => {
      vi.advanceTimersByTime(10_000)
    })
    expect(result.current.display?.on).toBe(true)
    await act(async () => {
      finish()
    })
    // The safety net starts once the command settled.
    act(() => {
      vi.advanceTimersByTime(4000)
    })
    expect(result.current.display).toBe(slice)
  })

  it('clears the override when the slice caught up while the command was pending', async () => {
    let finish: () => void = () => undefined
    const pending = new Promise<void>((resolve) => {
      finish = resolve
    })
    let current: MockSlice = slice
    const { result, rerender } = renderHook(() => useOptimisticSlice(current))
    await act(async () => {
      result.current.applyOptimisticAction({ on: true }, () => pending)
    })
    current = { on: true, lastChangedAt: 2000 }
    rerender()
    await act(async () => {
      finish()
    })
    expect(result.current.display).toBe(current)
  })
})
