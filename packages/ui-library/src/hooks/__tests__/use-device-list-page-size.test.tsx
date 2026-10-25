// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import {
  useDeviceListPageSize,
  DEVICE_LIST_PAGE_SIZE_KEY,
  DEVICE_LIST_PAGE_SIZE_OPTIONS,
} from '../use-device-list-page-size'

beforeEach(() => {
  localStorage.clear()
})

describe('useDeviceListPageSize', () => {
  it('returns the default when nothing is stored', () => {
    const { result } = renderHook(() => useDeviceListPageSize(50))
    expect(result.current[0]).toBe(50)
  })

  it('persists a valid option and reads it back', () => {
    const { result } = renderHook(() => useDeviceListPageSize(50))
    act(() => result.current[1](100))
    expect(result.current[0]).toBe(100)
    expect(localStorage.getItem(DEVICE_LIST_PAGE_SIZE_KEY)).toBe('100')

    // A fresh mount rehydrates from the persisted global key.
    const { result: result2 } = renderHook(() => useDeviceListPageSize(50))
    expect(result2.current[0]).toBe(100)
  })

  it('ignores an attempt to set a value outside the allowed options', () => {
    const { result } = renderHook(() => useDeviceListPageSize(50))
    act(() => result.current[1](999))
    expect(result.current[0]).toBe(50)
    expect(localStorage.getItem(DEVICE_LIST_PAGE_SIZE_KEY)).toBeNull()
  })

  it('falls back to the default when the stored value is out of range', () => {
    localStorage.setItem(DEVICE_LIST_PAGE_SIZE_KEY, '7')
    const { result } = renderHook(() => useDeviceListPageSize(50))
    expect(result.current[0]).toBe(50)
  })

  it('falls back to the default when the stored value is garbage', () => {
    localStorage.setItem(DEVICE_LIST_PAGE_SIZE_KEY, 'not-a-number')
    const { result } = renderHook(() => useDeviceListPageSize(50))
    expect(result.current[0]).toBe(50)
  })

  it('exposes the expected option set', () => {
    expect([...DEVICE_LIST_PAGE_SIZE_OPTIONS]).toEqual([25, 50, 100, 200])
  })

  it('is storage-safe: returns the default when localStorage access throws', () => {
    // jsdom keeps `window` for React, so the realistic non-browser / unavailable
    // -storage path is the try/catch guard: make getItem throw and assert the
    // hook degrades to the default instead of propagating.
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage unavailable')
    })
    try {
      const { result } = renderHook(() => useDeviceListPageSize(25))
      expect(result.current[0]).toBe(25)
    } finally {
      spy.mockRestore()
    }
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })
})
