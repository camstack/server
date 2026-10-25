// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useItemFormUrl } from '../use-item-form-url'

describe('useItemFormUrl', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', '/page')
  })

  it('opens new and clears edit', () => {
    const { result } = renderHook(() => useItemFormUrl())
    act(() => result.current.openEdit('abc'))
    expect(result.current.state).toEqual({ mode: 'edit', id: 'abc' })
    act(() => result.current.openNew())
    expect(result.current.state).toEqual({ mode: 'new' })
    expect(window.location.search).toContain('new=1')
    expect(window.location.search).not.toContain('edit=')
  })

  it('closes both params', () => {
    const { result } = renderHook(() => useItemFormUrl())
    act(() => result.current.openNew())
    act(() => result.current.close())
    expect(result.current.state).toEqual({ mode: 'closed' })
    expect(window.location.search).toBe('')
  })
})
