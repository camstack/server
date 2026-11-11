/**
 * The rule editor reads what an event device declares from the device's own
 * `event-emitter` slice — one read per selected device, never a camera's
 * kind list.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const slices = new Map<number, Record<string, unknown> | null>()
const asked: unknown[] = []

const trpcClient = {
  deviceState: {
    getCapSlice: {
      query: async (input: { readonly deviceId: number; readonly capName: string }) => {
        asked.push(input)
        if (!slices.has(input.deviceId)) throw new Error('device did not answer')
        return slices.get(input.deviceId) ?? null
      },
    },
  },
}

vi.mock('@camstack/ui-library', () => ({
  useSystem: () => ({ trpcClient }),
}))

import { useDeclaredEventOptions } from './notification-rule-pickers'

function wrapper({ children }: { readonly children: ReactNode }): ReactNode {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
}

const DEVICES = [
  { deviceId: 7, deviceName: 'Hall button 1' },
  { deviceId: 3, deviceName: 'Front door contact' },
  { deviceId: 9, deviceName: 'Garage remote' },
]

describe('useDeclaredEventOptions', () => {
  beforeEach(() => {
    slices.clear()
    asked.length = 0
  })

  it('offers the declared events of the event devices, and names the one it could not read', async () => {
    slices.set(7, {
      eventTypes: ['PRESS_SHORT', 'PRESS_LONG'],
      vocabulary: [
        { id: 'PRESS_SHORT', label: 'Press', kind: 'press' },
        { id: 'PRESS_LONG', label: 'Long press', kind: 'long-press' },
      ],
      lastEvent: null,
      eventCountSinceStart: 0,
    })
    slices.set(3, null)
    const { result } = renderHook(() => useDeclaredEventOptions(DEVICES), { wrapper })
    expect(result.current.pending).toBe(true)
    await waitFor(() => {
      expect(result.current.pending).toBe(false)
    })
    expect(result.current.options).toEqual([
      { value: 'PRESS_SHORT', label: 'Press' },
      { value: 'PRESS_LONG', label: 'Long press' },
    ])
    expect(result.current.unknownDevices).toEqual(['Garage remote'])
    expect(asked).toEqual([
      { deviceId: 7, capName: 'event-emitter' },
      { deviceId: 3, capName: 'event-emitter' },
      { deviceId: 9, capName: 'event-emitter' },
    ])
  })
})
