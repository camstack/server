// @vitest-environment jsdom
/**
 * `usePersistedDisclosure` — an open/closed choice the viewer made, remembered
 * under the caller's key. `null` means "never chosen", so the caller can fall
 * back to a default derived from data (the Consumables section opens itself
 * when an item needs attention) without that default ever being written.
 */
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { usePersistedDisclosure } from '../use-persisted-disclosure'

const KEY = 'camstack.test.open'

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('usePersistedDisclosure', () => {
  it('is null until the viewer chooses — no default is stored', () => {
    const { result } = renderHook(() => usePersistedDisclosure(KEY))
    expect(result.current[0]).toBeNull()
    expect(localStorage.getItem(KEY)).toBeNull()
  })

  it('remembers an open and a closed choice across mounts', () => {
    const { result } = renderHook(() => usePersistedDisclosure(KEY))
    act(() => result.current[1](false))
    expect(result.current[0]).toBe(false)
    expect(renderHook(() => usePersistedDisclosure(KEY)).result.current[0]).toBe(false)
    act(() => result.current[1](true))
    expect(renderHook(() => usePersistedDisclosure(KEY)).result.current[0]).toBe(true)
  })

  it('keeps one key per caller — another key is untouched', () => {
    const { result } = renderHook(() => usePersistedDisclosure(KEY))
    act(() => result.current[1](true))
    expect(
      renderHook(() => usePersistedDisclosure('camstack.test.other')).result.current[0],
    ).toBeNull()
  })

  it('reads the new key when the key changes', () => {
    localStorage.setItem('camstack.test.b', 'open')
    const { result, rerender } = renderHook(({ k }) => usePersistedDisclosure(k), {
      initialProps: { k: KEY },
    })
    expect(result.current[0]).toBeNull()
    rerender({ k: 'camstack.test.b' })
    expect(result.current[0]).toBe(true)
  })

  it('ignores a stored value it did not write', () => {
    localStorage.setItem(KEY, 'banana')
    expect(renderHook(() => usePersistedDisclosure(KEY)).result.current[0]).toBeNull()
  })

  it('a blocked storage still toggles for this page', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    const { result } = renderHook(() => usePersistedDisclosure(KEY))
    expect(result.current[0]).toBeNull()
    act(() => result.current[1](true))
    expect(result.current[0]).toBe(true)
  })

  it('a null key is never stored', () => {
    const { result } = renderHook(() => usePersistedDisclosure(null))
    act(() => result.current[1](true))
    expect(result.current[0]).toBe(true)
    expect(localStorage.length).toBe(0)
  })
})
