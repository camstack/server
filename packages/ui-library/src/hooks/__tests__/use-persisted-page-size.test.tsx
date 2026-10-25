// @vitest-environment jsdom
/**
 * `usePersistedPageSize` — a per-viewer "rows per page" choice, remembered
 * under the caller's own key. The device list keeps its global key through
 * `useDeviceListPageSize`; a surface with a different default (the exporter
 * table: 25) or a different option set (… · All) gets its own key so neither
 * overwrites the other's choice.
 */
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PAGE_SIZE_ALL, usePersistedPageSize } from '../use-persisted-page-size'

const KEY = 'camstack.test.pageSize'
const OPTIONS = [10, 25, 50, 100, PAGE_SIZE_ALL] as const

function useSubject(storageKey: string | null = KEY) {
  return usePersistedPageSize({ storageKey, options: OPTIONS, defaultSize: 25 })
}

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('usePersistedPageSize', () => {
  it('starts on the default', () => {
    const { result } = renderHook(() => useSubject())
    expect(result.current[0]).toBe(25)
  })

  it('remembers the choice under its own key', () => {
    const { result } = renderHook(() => useSubject())
    act(() => result.current[1](50))
    expect(result.current[0]).toBe(50)
    expect(localStorage.getItem(KEY)).toBe('50')
    const { result: again } = renderHook(() => useSubject())
    expect(again.current[0]).toBe(50)
  })

  it('remembers "All" too', () => {
    const { result } = renderHook(() => useSubject())
    act(() => result.current[1](PAGE_SIZE_ALL))
    expect(result.current[0]).toBe(PAGE_SIZE_ALL)
    const { result: again } = renderHook(() => useSubject())
    expect(again.current[0]).toBe(PAGE_SIZE_ALL)
  })

  it('refuses a size that is not one of the options', () => {
    const { result } = renderHook(() => useSubject())
    act(() => result.current[1](7))
    expect(result.current[0]).toBe(25)
    expect(localStorage.getItem(KEY)).toBeNull()
  })

  it('ignores a stored value that is not an option, or not a number', () => {
    localStorage.setItem(KEY, '200')
    expect(renderHook(() => useSubject()).result.current[0]).toBe(25)
    localStorage.setItem(KEY, 'lots')
    expect(renderHook(() => useSubject()).result.current[0]).toBe(25)
  })

  it('replaces a default that is not an option with the first option', () => {
    const { result } = renderHook(() =>
      usePersistedPageSize({ storageKey: KEY, options: OPTIONS, defaultSize: 33 }),
    )
    expect(result.current[0]).toBe(10)
  })

  it('works without storage: unreadable, unwritable, or no key at all', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    const { result } = renderHook(() => useSubject())
    expect(result.current[0]).toBe(25)
    act(() => result.current[1](100))
    expect(result.current[0]).toBe(100)

    vi.restoreAllMocks()
    const { result: unkeyed } = renderHook(() => useSubject(null))
    act(() => unkeyed.current[1](10))
    expect(unkeyed.current[0]).toBe(10)
    expect(localStorage.length).toBe(0)
  })
})
