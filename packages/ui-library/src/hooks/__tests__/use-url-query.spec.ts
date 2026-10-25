import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { useUrlQueryParam } from '../use-url-query'

describe('useUrlQueryParam', () => {
  afterEach(() => {
    window.history.replaceState(null, '', window.location.pathname)
  })

  it('reads the current query param', () => {
    window.history.replaceState(null, '', '/addon/osd-manager?device=101&slot=text-2')
    const { result } = renderHook(() => useUrlQueryParam('slot'))
    expect(result.current[0]).toBe('text-2')
  })

  it('writes and deletes with replaceState', () => {
    window.history.replaceState(null, '', '/addon/osd-manager')
    const { result } = renderHook(() => useUrlQueryParam('device'))
    act(() => {
      result.current[1]('42')
    })
    expect(new URLSearchParams(window.location.search).get('device')).toBe('42')
    act(() => {
      result.current[1](null)
    })
    expect(new URLSearchParams(window.location.search).has('device')).toBe(false)
  })

  it('keeps a second mount in sync when another instance writes the same key', () => {
    window.history.replaceState(null, '', '/system/notifications?tab=rules')
    const writer = renderHook(() => useUrlQueryParam('section'))
    const reader = renderHook(() => useUrlQueryParam('section'))
    expect(reader.result.current[0]).toBeNull()
    act(() => {
      writer.result.current[1]('detection')
    })
    expect(reader.result.current[0]).toBe('detection')
    act(() => {
      writer.result.current[1](null)
    })
    expect(reader.result.current[0]).toBeNull()
  })

  it('re-reads when an external replaceState changes the query', () => {
    act(() => {
      window.history.replaceState(null, '', '/system/notifications?tab=rules&section=sensor')
    })
    const { result } = renderHook(() => useUrlQueryParam('section'))
    expect(result.current[0]).toBe('sensor')
    act(() => {
      window.history.replaceState(null, '', '/system/notifications?tab=rules')
    })
    expect(result.current[0]).toBeNull()
  })
})
