/**
 * The boot gate must wait for the TRANSPORT PROBE, never for the fleet.
 *
 * ## The failure this pins
 *
 * `AppShell` refused to mount a single child until `system.init()` resolved.
 * `System.init()` is `awaitConnected()` (one `auth.me`) followed by
 * `SystemMirror.init()`, which is THREE whole-fleet round-trips —
 * `getAllBindings` + `getAllSnapshots` + `listAll`. On the reference hub
 * (1 019 devices) `deviceManager.listAll` alone answers in 5.6 s, against
 * `/health` at 0.18 s. Every one of those seconds was a blank "Connecting…"
 * splash.
 *
 * The gate's own docblock says what it is FOR: queries must not fire in the
 * window between "WS open" and "addon services registered server-side". That
 * window is closed by `awaitConnected` — the `auth.me` probe — and by nothing
 * the mirror does. The mirror is a device cache, and no admin-UI component
 * reads it: the admin tree gets its devices from React Query
 * (`useDeviceManagerListAll` / `hooks/useDevice.ts`), never from
 * `System.getDeviceInfo` / `listDeviceInfos` / `listDevices`.
 *
 * So the mirror warm-boot is work the tree does not consume, on the tree's
 * critical path.
 *
 * ## What is asserted, and why it is the request shape
 *
 * Not wall clock — ordering. `init()` is handed a promise that NEVER settles,
 * and the gate is required to open anyway. A gate that still awaits the mirror
 * can only fail this. And `init()` must still be CALLED: the REPL terminal and
 * any future mirror consumer need the warm-boot to happen, just not in front
 * of the operator.
 */
import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { type BootGateSystem, useBootGate } from '../useBootGate'

interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
  readonly reject: (reason: Error) => void
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined
  let reject: (reason: Error) => void = () => undefined
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** The authenticated principal the gate keys off. Only presence matters here. */
const USER: { readonly username: string } = { username: 'admin' }

describe('useBootGate', () => {
  it('opens the tree on the transport probe while the mirror warm-boot is still in flight', async () => {
    const probe = deferred<void>()
    // The mirror never finishes. A gate that awaits it can never open.
    const init = vi.fn((): Promise<void> => new Promise<void>(() => undefined))
    const system: BootGateSystem = {
      awaitConnected: () => probe.promise,
      init,
    }

    const logout = vi.fn()
    const { result } = renderHook(() => useBootGate(system, USER, logout))
    expect(result.current.bootReady).toBe(false)

    await act(async () => {
      probe.resolve()
      await probe.promise
    })

    await waitFor(() => expect(result.current.bootReady).toBe(true))
    expect(result.current.bootError).toBeNull()
    // Still warmed — just not in front of the operator.
    expect(init).toHaveBeenCalledTimes(1)
  })

  it('does not gate on the mirror even when the mirror fails', async () => {
    const mirror = deferred<void>()
    const system: BootGateSystem = {
      awaitConnected: () => Promise.resolve(),
      init: () => mirror.promise,
    }

    const logout = vi.fn()
    const { result } = renderHook(() => useBootGate(system, USER, logout))
    await waitFor(() => expect(result.current.bootReady).toBe(true))

    await act(async () => {
      mirror.reject(new Error('getAllBindings timed out'))
      await mirror.promise.catch(() => undefined)
    })

    // A cold mirror is a degraded cache, not a broken app: the tree stays up
    // and the banner stays silent, because nothing the operator sees reads it.
    expect(result.current.bootReady).toBe(true)
    expect(result.current.bootError).toBeNull()
  })

  it('logs out when the probe reports the session is gone', async () => {
    const logout = vi.fn()
    const unauthorized: Error & { data?: { code?: string } } = Object.assign(
      new Error('UNAUTHORIZED'),
      { data: { code: 'UNAUTHORIZED' } },
    )
    const system: BootGateSystem = {
      awaitConnected: () => Promise.reject(unauthorized),
      init: vi.fn((): Promise<void> => Promise.resolve()),
    }

    renderHook(() => useBootGate(system, USER, logout))
    await waitFor(() => expect(logout).toHaveBeenCalledTimes(1))
  })

  it('one UNAUTHORIZED probe followed by a successful refresh does not log out', async () => {
    const logout = vi.fn()
    const unauthorized = Object.assign(new Error('UNAUTHORIZED'), {
      data: { code: 'UNAUTHORIZED' },
    })
    const awaitConnected = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(unauthorized)
      .mockResolvedValue(undefined)
    const system: BootGateSystem = {
      awaitConnected,
      init: vi.fn((): Promise<void> => Promise.resolve()),
    }
    const recover = vi.fn((): Promise<boolean> => Promise.resolve(true))

    const { result } = renderHook(() => useBootGate(system, USER, logout, recover))
    await waitFor(() => expect(result.current.bootReady).toBe(true))
    expect(recover).toHaveBeenCalledTimes(1)
    expect(awaitConnected).toHaveBeenCalledTimes(2)
    expect(logout).not.toHaveBeenCalled()
  })

  it('logs out when the refresh is refused, and when it recovers but the probe is still UNAUTHORIZED', async () => {
    const unauthorized = Object.assign(new Error('UNAUTHORIZED'), {
      data: { code: 'UNAUTHORIZED' },
    })
    const system: BootGateSystem = {
      awaitConnected: () => Promise.reject(unauthorized),
      init: vi.fn((): Promise<void> => Promise.resolve()),
    }
    const refused = vi.fn((): Promise<boolean> => Promise.resolve(false))
    const logoutA = vi.fn()
    renderHook(() => useBootGate(system, USER, logoutA, refused))
    await waitFor(() => expect(logoutA).toHaveBeenCalledTimes(1))

    const alive = vi.fn((): Promise<boolean> => Promise.resolve(true))
    const logoutB = vi.fn()
    renderHook(() => useBootGate(system, USER, logoutB, alive))
    await waitFor(() => expect(logoutB).toHaveBeenCalledTimes(1))
    expect(alive).toHaveBeenCalledTimes(1)
  })

  it('surfaces a non-auth probe failure but still unblocks the tree', async () => {
    const system: BootGateSystem = {
      awaitConnected: () => Promise.reject(new Error('socket hang up')),
      init: vi.fn((): Promise<void> => Promise.resolve()),
    }

    const logout = vi.fn()
    const { result } = renderHook(() => useBootGate(system, USER, logout))
    await waitFor(() => expect(result.current.bootReady).toBe(true))
    expect(result.current.bootError).toBe('socket hang up')
  })

  it('never probes when there is no authenticated user', async () => {
    const awaitConnected = vi.fn((): Promise<void> => Promise.resolve())
    const init = vi.fn((): Promise<void> => Promise.resolve())
    const logout = vi.fn()
    const system: BootGateSystem = { awaitConnected, init }
    const { result } = renderHook(() => useBootGate(system, null, logout))

    await waitFor(() => expect(result.current.bootReady).toBe(true))
    expect(awaitConnected).not.toHaveBeenCalled()
    expect(init).not.toHaveBeenCalled()
  })
})
