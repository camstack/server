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

describe('useItemFormUrl with push', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', '/page?tab=x')
  })

  it('opening adds ONE history entry and closing goes back to the list', async () => {
    const start = window.history.length
    const { result } = renderHook(() => useItemFormUrl({ push: true, editKey: 'block' }))
    act(() => result.current.openEdit('abc'))
    expect(window.history.length).toBe(start + 1)
    expect(window.location.search).toContain('block=abc')
    expect(window.location.search).toContain('tab=x')
    act(() => result.current.openNew())
    expect(window.history.length).toBe(start + 2)
    expect(window.location.search).not.toContain('block=')
    const popped = new Promise<void>((resolve) =>
      window.addEventListener('popstate', () => resolve(), { once: true }),
    )
    act(() => result.current.close())
    await popped
    expect(window.location.search).toContain('block=abc')
  })

  it('a replace-mode hook never adds entries', () => {
    const start = window.history.length
    const { result } = renderHook(() => useItemFormUrl())
    act(() => result.current.openEdit('abc'))
    expect(window.history.length).toBe(start)
  })
})
