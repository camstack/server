// @vitest-environment jsdom
/**
 * useDragValue is input smoothing, not optimism (D1061): the thumb follows the
 * hand while it moves and until the hub has answered the one command sent on
 * release; after that the control shows the served slice again.
 */
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DRAG_SETTLE_MS, useDragValue } from '../use-drag-value'

interface Props {
  readonly served: number
}

function setup(served: number) {
  const onCommit = vi.fn<(value: number) => void>()
  const hook = renderHook(({ served: s }: Props) => useDragValue({ served: s, onCommit }), {
    initialProps: { served },
  })
  return { ...hook, onCommit }
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('useDragValue', () => {
  it('shows the served value when nothing is moving', () => {
    const { result, rerender } = setup(40)
    expect(result.current.shown).toBe(40)
    rerender({ served: 55 })
    expect(result.current.shown).toBe(55)
  })

  it('follows the hand while it moves and sends nothing until release', () => {
    const { result, rerender, onCommit } = setup(40)
    act(() => result.current.move(60))
    act(() => result.current.move(75))
    // A served update mid-drag (a poll) does not pull the thumb back.
    rerender({ served: 41 })
    expect(result.current.shown).toBe(75)
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('sends once on release and keeps the value until the hub answers', () => {
    const { result, rerender, onCommit } = setup(40)
    act(() => result.current.move(75))
    act(() => result.current.commit())
    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(onCommit).toHaveBeenCalledWith(75)
    // The served slice has not moved yet: no snap back to 40.
    expect(result.current.shown).toBe(75)
    rerender({ served: 40 })
    expect(result.current.shown).toBe(75)
    // The hub answers (the held value): the served slice takes over.
    rerender({ served: 75 })
    expect(result.current.shown).toBe(75)
    rerender({ served: 30 })
    expect(result.current.shown).toBe(30)
  })

  it('takes the device answer when it differs from what was sent', () => {
    const { result, rerender } = setup(40)
    act(() => result.current.move(37))
    act(() => result.current.commit())
    rerender({ served: 36 })
    expect(result.current.shown).toBe(36)
  })

  it('falls back to the served value when the hub never answers', () => {
    const { result, onCommit } = setup(40)
    act(() => result.current.move(80))
    act(() => result.current.commit())
    act(() => {
      vi.advanceTimersByTime(DRAG_SETTLE_MS)
    })
    expect(result.current.shown).toBe(40)
    expect(onCommit).toHaveBeenCalledTimes(1)
  })

  it('a release without a move sends nothing', () => {
    const { result, onCommit } = setup(40)
    act(() => result.current.commit())
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('a second release (blur after pointerup) sends nothing more', () => {
    const { result, onCommit } = setup(40)
    act(() => result.current.move(70))
    act(() => result.current.commit())
    act(() => result.current.commit())
    expect(onCommit).toHaveBeenCalledTimes(1)
  })

  it('clears its timer on unmount', () => {
    const { result, unmount } = setup(40)
    act(() => result.current.move(70))
    act(() => result.current.commit())
    expect(vi.getTimerCount()).toBe(1)
    unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('hands a range input its value and release handlers', () => {
    const { result, onCommit } = setup(40)
    const props = result.current.sliderProps
    expect(props.value).toBe(40)
    act(() => {
      props.onChange({ currentTarget: { value: '66' } })
    })
    expect(result.current.sliderProps.value).toBe(66)
    act(() => {
      result.current.sliderProps.onPointerUp()
    })
    expect(onCommit).toHaveBeenCalledWith(66)
  })
})
