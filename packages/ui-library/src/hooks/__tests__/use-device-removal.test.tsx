// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useDeviceRemoval } from '../use-device-removal'

interface Deferred {
  readonly promise: Promise<void>
  readonly resolve: () => void
  readonly reject: (error: Error) => void
}

function deferred(): Deferred {
  let resolve: () => void = () => undefined
  let reject: (error: Error) => void = () => undefined
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('useDeviceRemoval', () => {
  it('keeps the row pending from the confirm until the removal completed', async () => {
    const hub = deferred()
    const remove = vi.fn(() => hub.promise)
    const { result } = renderHook(() => useDeviceRemoval({ remove }))

    expect(result.current.rowOperation({ id: 7 })).toBeUndefined()
    act(() => result.current.remove({ deviceId: 7 }))
    expect(remove).toHaveBeenCalledWith({ deviceId: 7 })
    expect(result.current.rowOperation({ id: 7 })).toEqual({ kind: 'pending' })

    await act(async () => {
      hub.resolve()
      await hub.promise
    })
    expect(result.current.rowOperation({ id: 7 })).toBeUndefined()
  })

  it('stays pending until the list refetch has answered, not just the mutation', async () => {
    const hub = deferred()
    const list = deferred()
    const { result } = renderHook(() =>
      useDeviceRemoval({ remove: () => hub.promise, refresh: () => list.promise }),
    )
    act(() => result.current.remove({ deviceId: 3 }))
    await act(async () => {
      hub.resolve()
      await hub.promise
    })
    // The cascade is done but the table still holds the row: still pending.
    expect(result.current.rowOperation({ id: 3 })).toEqual({ kind: 'pending' })
    await act(async () => {
      list.resolve()
      await list.promise
    })
    expect(result.current.rowOperation({ id: 3 })).toBeUndefined()
  })

  it('restores the row and reports the error when the removal fails', async () => {
    const hub = deferred()
    const onError = vi.fn()
    const refresh = vi.fn(() => Promise.resolve())
    const { result } = renderHook(() =>
      useDeviceRemoval({ remove: () => hub.promise, refresh, onError }),
    )
    act(() => result.current.remove({ deviceId: 9 }))
    await act(async () => {
      hub.reject(new Error('provider offline'))
      await hub.promise.catch(() => undefined)
    })
    expect(result.current.rowOperation({ id: 9 })).toEqual({
      kind: 'failed',
      message: 'provider offline',
    })
    expect(onError).toHaveBeenCalledWith(9, 'provider offline')
    expect(refresh).not.toHaveBeenCalled()
  })

  it('tracks two concurrent deletes independently', async () => {
    const first = deferred()
    const second = deferred()
    const byId = new Map<number, Deferred>([
      [1, first],
      [2, second],
    ])
    const remove = (input: { deviceId: number }): Promise<void> => {
      const pending = byId.get(input.deviceId)
      return pending === undefined ? Promise.resolve() : pending.promise
    }
    const { result } = renderHook(() => useDeviceRemoval({ remove }))
    act(() => {
      result.current.remove({ deviceId: 1 })
      result.current.remove({ deviceId: 2 })
    })
    expect(result.current.rowOperation({ id: 1 })).toEqual({ kind: 'pending' })
    expect(result.current.rowOperation({ id: 2 })).toEqual({ kind: 'pending' })

    await act(async () => {
      second.reject(new Error('boom'))
      await second.promise.catch(() => undefined)
    })
    // #2 failed and is restored; #1 is untouched and still pending.
    expect(result.current.rowOperation({ id: 2 })).toEqual({ kind: 'failed', message: 'boom' })
    expect(result.current.rowOperation({ id: 1 })).toEqual({ kind: 'pending' })

    await act(async () => {
      first.resolve()
      await first.promise
    })
    expect(result.current.rowOperation({ id: 1 })).toBeUndefined()
    expect(result.current.rowOperation({ id: 2 })).toEqual({ kind: 'failed', message: 'boom' })
  })

  it('does not start a second removal for a device already being removed', () => {
    const hub = deferred()
    const remove = vi.fn(() => hub.promise)
    const { result } = renderHook(() => useDeviceRemoval({ remove }))
    act(() => {
      result.current.remove({ deviceId: 5 })
      result.current.remove({ deviceId: 5 })
    })
    expect(remove).toHaveBeenCalledTimes(1)
  })
})
