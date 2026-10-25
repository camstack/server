// @vitest-environment jsdom
/**
 * The coalesce window on useEventInvalidation.
 *
 * The stream-broker emits metrics-snapshot at ~1 Hz PER BROKER — 60-80
 * events/s on this fleet — and the hook invalidated (→ refetched) once per
 * event: ~70 refetches/s of listClients while the panel was open. Warm, the
 * runner answers in ms and it merely wasted cycles; during a boot it cannot
 * answer, every refetch parked 60 s server-side, and one open admin tab
 * produced 2 028 UDS timeouts in 5 minutes (measured, 2026-08-19 11:24 boot)
 * — a self-feeding storm that also queued the notification center's own
 * store reads for 131 s. N events inside the window must cost ONE
 * invalidation, trailing so the last event still lands.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import React from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import { useEventInvalidation } from '../use-event-invalidation.js'
import { SystemProvider } from '../../contexts/system-context.js'

type Handler = () => void

function makeSystem() {
  const handlers = new Map<string, Handler[]>()
  return {
    connectionVersion: 1,
    subscribeConnectionEvents: () => () => {},
    subscribeEvent: (category: string, cb: Handler) => {
      const list = handlers.get(category) ?? []
      list.push(cb)
      handlers.set(category, list)
      return () => {}
    },
    fire(category: string) {
      for (const cb of handlers.get(category) ?? []) cb()
    },
  }
}

describe('useEventInvalidation coalesces event bursts', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  function mount(system: ReturnType<typeof makeSystem>) {
    const client = new QueryClient()
    const spy = vi.spyOn(client, 'invalidateQueries')
    renderHook(
      () =>
        useEventInvalidation(['streamBroker', 'listClients'], ['stream-broker.metrics-snapshot']),
      {
        wrapper: ({ children }: { children: React.ReactNode }) => (
          <QueryClientProvider client={client}>
            <SystemProvider system={system as never}>{children}</SystemProvider>
          </QueryClientProvider>
        ),
      },
    )
    return spy
  }

  it('70 events in one second cost ONE invalidation, not 70', () => {
    const system = makeSystem()
    const spy = mount(system)
    spy.mockClear() // drop the initial mount invalidation
    for (let i = 0; i < 70; i++) system.fire('stream-broker.metrics-snapshot')
    vi.advanceTimersByTime(2_000)
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('is trailing — the last event of a burst still lands after the window', () => {
    const system = makeSystem()
    const spy = mount(system)
    spy.mockClear()
    system.fire('stream-broker.metrics-snapshot')
    expect(spy).toHaveBeenCalledTimes(0) // not synchronous
    vi.advanceTimersByTime(2_000)
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('two bursts separated by more than the window cost two invalidations', () => {
    const system = makeSystem()
    const spy = mount(system)
    spy.mockClear()
    system.fire('stream-broker.metrics-snapshot')
    vi.advanceTimersByTime(2_000)
    system.fire('stream-broker.metrics-snapshot')
    vi.advanceTimersByTime(2_000)
    expect(spy).toHaveBeenCalledTimes(2)
  })
})
