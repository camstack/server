// @vitest-environment jsdom
/**
 * The unsaved-changes guard as the editor uses it: a dirty frame asks before an
 * action that would drop the edits and before the browser unloads; a clean one
 * never asks.
 */
import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useUnsavedGuard } from '../use-unsaved-guard'

const confirm = vi.fn<(options: { readonly title: string }) => Promise<boolean>>()

vi.mock('@camstack/ui-library', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@camstack/ui-library')>()),
  useConfirm: () => confirm,
}))

afterEach(() => {
  confirm.mockReset()
})

describe('useUnsavedGuard', () => {
  it('runs the action straight away when the frame is clean', async () => {
    const proceed = vi.fn()
    const { result } = renderHook(() => useUnsavedGuard(false))
    await act(async () => {
      await result.current(proceed)
    })
    expect(confirm).not.toHaveBeenCalled()
    expect(proceed).toHaveBeenCalledOnce()
  })

  it('asks first when dirty, and keeps the edits if the operator says no', async () => {
    confirm.mockResolvedValue(false)
    const proceed = vi.fn()
    const { result } = renderHook(() => useUnsavedGuard(true))
    await act(async () => {
      await result.current(proceed)
    })
    expect(confirm).toHaveBeenCalledOnce()
    expect(confirm.mock.calls[0]?.[0].title).toMatch(/unsaved/i)
    expect(proceed).not.toHaveBeenCalled()
  })

  it('drops the edits only once the operator agrees', async () => {
    confirm.mockResolvedValue(true)
    const proceed = vi.fn()
    const { result } = renderHook(() => useUnsavedGuard(true))
    await act(async () => {
      await result.current(proceed)
    })
    expect(proceed).toHaveBeenCalledOnce()
  })

  it('asks the browser before a reload only while dirty', () => {
    const attempt = (): boolean => {
      const event = new Event('beforeunload', { cancelable: true })
      window.dispatchEvent(event)
      return event.defaultPrevented
    }
    const clean = renderHook(() => useUnsavedGuard(false))
    expect(attempt()).toBe(false)
    clean.unmount()
    const dirty = renderHook(() => useUnsavedGuard(true))
    expect(attempt()).toBe(true)
    dirty.unmount()
    expect(attempt()).toBe(false)
  })
})
