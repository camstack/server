// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { DeviceBinding } from '@camstack/types'
import { useDeviceProxy, useDeviceStateSlice } from '../use-device-proxy'

/**
 * A device list mounts several proxies per row. The hooks of a device share
 * one `getBindings` fetch, and every proxy of the client shares ONE
 * `binding-changed` and ONE `device.state-changed` subscription.
 */

type EventPayload = unknown
type Handler = (evt: { data: EventPayload }) => void

function bindingOf(deviceId: number, capName: string): DeviceBinding {
  return {
    deviceId,
    entries: [
      {
        capName,
        kind: 'native',
        providerAddonId: 'fake',
        providerNodeId: 'hub',
        nativeAddonId: 'fake',
      },
    ],
  }
}

function makeTrpc() {
  const handlers = new Map<string, Set<Handler>>()
  const subscribeCalls: string[] = []
  const getBindings = vi.fn(
    async ({ deviceId }: { deviceId: number }): Promise<DeviceBinding> =>
      bindingOf(deviceId, 'old'),
  )
  const getCapSlice = vi.fn(
    async (_input: {
      deviceId: number
      capName: string
    }): Promise<Record<string, unknown> | null> => null,
  )
  const trpc = {
    deviceManager: { getBindings: { query: getBindings } },
    deviceState: {
      getCapSlice: { query: getCapSlice },
      setCapSlice: { mutate: vi.fn(async () => undefined) },
    },
    live: {
      onEvent: {
        subscribe(input: { category: string }, opts: { onData: Handler }) {
          subscribeCalls.push(input.category)
          const set = handlers.get(input.category) ?? new Set<Handler>()
          set.add(opts.onData)
          handlers.set(input.category, set)
          return { unsubscribe: () => set.delete(opts.onData) }
        },
      },
    },
  }
  const emit = (category: string, data: EventPayload): void => {
    for (const h of handlers.get(category) ?? []) h({ data })
  }
  return { trpc, getBindings, getCapSlice, subscribeCalls, emit }
}

type Fake = ReturnType<typeof makeTrpc>

const IDS = [1, 2, 3, 4, 5]
const HOOKS_PER_ROW = 4

function mountRows(trpc: Fake['trpc']) {
  return renderHook(() =>
    IDS.map((id) => Array.from({ length: HOOKS_PER_ROW }, () => useDeviceProxy(trpc, id))),
  )
}

function allResolved(rows: ReadonlyArray<ReadonlyArray<unknown>>): boolean {
  return rows.every((row) => row.every((p) => p !== null))
}

describe('useDeviceProxy — shared plumbing', () => {
  it('N rows x M hooks: one getBindings per device and a constant number of subscriptions', async () => {
    const { trpc, getBindings, subscribeCalls } = makeTrpc()
    const { result } = mountRows(trpc)
    await waitFor(() => expect(allResolved(result.current)).toBe(true))
    expect(getBindings).toHaveBeenCalledTimes(IDS.length)
    expect(subscribeCalls.filter((c) => c === 'capability.binding-changed')).toHaveLength(1)
    const handles = result.current.flat().map((p) => p?.state.battery)
    renderHook(() => handles.map((h) => useDeviceStateSlice(h)))
    expect(subscribeCalls.filter((c) => c === 'device.state-changed')).toHaveLength(1)
    expect(subscribeCalls).toHaveLength(2)
  })

  it('a state event for device A reaches A and not B', async () => {
    const { trpc, emit } = makeTrpc()
    const { result } = mountRows(trpc)
    await waitFor(() => expect(allResolved(result.current)).toBe(true))
    const a = renderHook(() => useDeviceStateSlice(result.current[0]?.[0]?.state.battery))
    const b = renderHook(() => useDeviceStateSlice(result.current[1]?.[0]?.state.battery))
    act(() =>
      emit('device.state-changed', { deviceId: 1, capName: 'battery', slice: { level: 42 } }),
    )
    expect(a.result.current).toEqual({ level: 42 })
    expect(b.result.current).toBeUndefined()
  })

  it('a binding change refetches only the device it names', async () => {
    const { trpc, getBindings, emit } = makeTrpc()
    const { result } = mountRows(trpc)
    await waitFor(() => expect(allResolved(result.current)).toBe(true))
    getBindings.mockClear()
    act(() => emit('capability.binding-changed', { source: { type: 'device', id: 3 } }))
    await waitFor(() => expect(getBindings).toHaveBeenCalledTimes(1))
    expect(getBindings).toHaveBeenCalledWith({ deviceId: 3 })
  })

  it('a binding change without a source refetches every observed device', async () => {
    const { trpc, getBindings, emit } = makeTrpc()
    const { result } = mountRows(trpc)
    await waitFor(() => expect(allResolved(result.current)).toBe(true))
    getBindings.mockClear()
    act(() => emit('capability.binding-changed', {}))
    await waitFor(() => expect(getBindings).toHaveBeenCalledTimes(IDS.length))
  })

  it('an event that lands during the first fetch triggers a second fetch and the new binding wins', async () => {
    const { trpc, getBindings, emit } = makeTrpc()
    let releaseFirst: (b: DeviceBinding) => void = () => undefined
    getBindings.mockImplementationOnce(
      () =>
        new Promise<DeviceBinding>((resolve) => {
          releaseFirst = resolve
        }),
    )
    getBindings.mockImplementation(async ({ deviceId }) => bindingOf(deviceId, 'new'))
    const { result } = renderHook(() => useDeviceProxy(trpc, 7))
    expect(getBindings).toHaveBeenCalledTimes(1)
    // The change arrives while the (stale) first read is still in flight.
    act(() => emit('capability.binding-changed', { source: { type: 'device', id: 7 } }))
    await act(async () => {
      releaseFirst(bindingOf(7, 'old'))
    })
    await waitFor(() => expect(getBindings).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(result.current?.binding?.entries[0]?.capName).toBe('new'))
  })

  it('a failed first fetch leaves the proxy null and a later event recovers it', async () => {
    const { trpc, getBindings, emit } = makeTrpc()
    getBindings.mockRejectedValueOnce(new Error('transient'))
    const { result } = renderHook(() => useDeviceProxy(trpc, 9))
    await waitFor(() => expect(getBindings).toHaveBeenCalledTimes(1))
    expect(result.current).toBeNull()
    act(() => emit('capability.binding-changed', { source: { type: 'device', id: 9 } }))
    await waitFor(() => expect(result.current).not.toBeNull())
  })

  it('stops refetching once every proxy unmounts, and a remount fetches afresh', async () => {
    const { trpc, getBindings, emit } = makeTrpc()
    const first = mountRows(trpc)
    await waitFor(() => expect(allResolved(first.result.current)).toBe(true))
    first.unmount()
    getBindings.mockClear()
    emit('capability.binding-changed', {})
    expect(getBindings).not.toHaveBeenCalled()
    const second = mountRows(trpc)
    await waitFor(() => expect(allResolved(second.result.current)).toBe(true))
    expect(getBindings).toHaveBeenCalledTimes(IDS.length)
  })

  it('a slice pushed while nothing is mounted is not served stale after a remount', async () => {
    const { trpc, getCapSlice, emit } = makeTrpc()
    const proxy = renderHook(() => useDeviceProxy(trpc, 1))
    await waitFor(() => expect(proxy.result.current).not.toBeNull())
    const handle = proxy.result.current?.state.battery
    const first = renderHook(() => useDeviceStateSlice(handle))
    act(() =>
      emit('device.state-changed', { deviceId: 1, capName: 'battery', slice: { level: 10 } }),
    )
    expect(first.result.current).toEqual({ level: 10 })
    first.unmount()
    // Nothing watches now; the server moves on (no event reaches us).
    getCapSlice.mockResolvedValue({ level: 99 })
    const second = renderHook(() => useDeviceStateSlice(handle))
    // Cold start: no stale { level: 10 } seed, the refresh brings the new value.
    expect(second.result.current).toBeUndefined()
    await waitFor(() => expect(second.result.current).toEqual({ level: 99 }))
  })
})
