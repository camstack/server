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

type Handler = (evt: { data?: unknown }) => void

function bindingOf(deviceId: number): DeviceBinding {
  return { deviceId, entries: [] } as unknown as DeviceBinding
}

function makeTrpc() {
  const handlers = new Map<string, Set<Handler>>()
  const subscribeCalls: string[] = []
  const getBindings = vi.fn(async ({ deviceId }: { deviceId: number }) => bindingOf(deviceId))
  const trpc = {
    deviceManager: { getBindings: { query: getBindings } },
    deviceState: {
      getCapSlice: { query: vi.fn(async () => null) },
      setCapSlice: { mutate: vi.fn(async () => undefined) },
    },
    live: {
      onEvent: {
        subscribe: (input: { category: string }, opts: { onData: Handler }) => {
          subscribeCalls.push(input.category)
          const set = handlers.get(input.category) ?? new Set<Handler>()
          set.add(opts.onData)
          handlers.set(input.category, set)
          return { unsubscribe: () => set.delete(opts.onData) }
        },
      },
    },
  }
  const emit = (category: string, data: unknown): void => {
    for (const h of handlers.get(category) ?? []) h({ data })
  }
  return { trpc, getBindings, subscribeCalls, emit }
}

const IDS = [1, 2, 3, 4, 5]
const HOOKS_PER_ROW = 4

function mountRows(trpc: ReturnType<typeof makeTrpc>['trpc']) {
  return renderHook(() =>
    IDS.map((id) => Array.from({ length: HOOKS_PER_ROW }, () => useDeviceProxy(trpc as never, id))),
  )
}

describe('useDeviceProxy — shared plumbing', () => {
  it('N rows x M hooks: one getBindings per device and a constant number of subscriptions', async () => {
    const { trpc, getBindings, subscribeCalls } = makeTrpc()
    const { result } = mountRows(trpc)
    await waitFor(() =>
      expect(result.current.every((row) => row.every((p) => p !== null))).toBe(true),
    )
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
    await waitFor(() => expect(result.current.every((row) => row[0] !== null)).toBe(true))
    const a = renderHook(() => useDeviceStateSlice(result.current[0]![0]!.state.battery))
    const b = renderHook(() => useDeviceStateSlice(result.current[1]![0]!.state.battery))
    act(() =>
      emit('device.state-changed', { deviceId: 1, capName: 'battery', slice: { level: 42 } }),
    )
    expect(a.result.current).toEqual({ level: 42 })
    expect(b.result.current).toBeUndefined()
  })

  it('a binding change refetches only the device it names', async () => {
    const { trpc, getBindings, emit } = makeTrpc()
    const { result } = mountRows(trpc)
    await waitFor(() => expect(result.current.every((row) => row[0] !== null)).toBe(true))
    getBindings.mockClear()
    act(() => emit('capability.binding-changed', { source: { type: 'device', id: 3 } }))
    await waitFor(() => expect(getBindings).toHaveBeenCalledTimes(1))
    expect(getBindings).toHaveBeenCalledWith({ deviceId: 3 })
  })

  it('stops refetching once every proxy unmounts', async () => {
    const { trpc, getBindings, emit } = makeTrpc()
    const { result, unmount } = mountRows(trpc)
    await waitFor(() => expect(result.current[0]![0]).not.toBeNull())
    unmount()
    getBindings.mockClear()
    emit('capability.binding-changed', {})
    expect(getBindings).not.toHaveBeenCalled()
  })
})
